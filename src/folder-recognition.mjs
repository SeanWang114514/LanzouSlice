import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_ENTRIES = 1000, MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const ttl = status => status === 'ordinary' ? 60_000 : 300_000;
const validId = value => /^\d+$/.test(String(value));

// Display hints only. These records never create a downloadable bundle.
export class FolderRecognition {
  constructor({ dataDir, identify, now = Date.now }) {
    this.file = path.join(dataDir, 'folder-recognition.json');
    this.identify = identify; this.now = now; this.entries = new Map(); this.queue = Promise.resolve();
  }
  async init() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.entries)) return;
      for (const entry of saved.entries.slice(-MAX_ENTRIES)) {
        if (!entry || typeof entry !== 'object') continue;
        if (!validId(entry.ownerUid) || !validId(entry.id) || !Number.isFinite(entry.checkedAt)) continue;
        this.remember(entry.ownerUid, entry.id, entry, entry.cloudName, entry.checkedAt);
      }
    } catch { /* A missing or damaged display cache must not block cloud browsing. */ }
  }
  remember(ownerUid, id, result, cloudName, checkedAt = this.now()) {
    if (!validId(ownerUid) || !validId(id) || !['ordinary', 'preview', 'ready'].includes(result.status)) return;
    if (result.status !== 'ordinary' && (typeof result.originalName !== 'string' || !result.originalName.length || result.originalName.length > 4096 || !Number.isSafeInteger(result.originalSize) || result.originalSize < 0 || !Number.isSafeInteger(result.totalParts) || result.totalParts < 1 || result.totalParts > 1_000_000)) return;
    const key = `${ownerUid}:${id}`;
    cloudName ??= this.entries.get(key)?.cloudName;
    const entry = { ownerUid: String(ownerUid), id: String(id), status: result.status === 'ordinary' ? 'ordinary' : 'preview', checkedAt,
      ...(typeof cloudName === 'string' ? { cloudName: cloudName.slice(0, 4096) } : {}),
      ...(result.status === 'ordinary' ? {} : { originalName: result.originalName, originalSize: result.originalSize, totalParts: result.totalParts }) };
    this.entries.delete(key); this.entries.set(key, entry);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
  }
  get(ownerUid, id, cloudName) {
    const key = `${ownerUid}:${id}`, entry = this.entries.get(key);
    if (!entry) return null;
    const age = this.now() - entry.checkedAt;
    if (age < 0 || age > MAX_AGE || (entry.cloudName !== undefined && cloudName !== undefined && entry.cloudName !== cloudName)) { this.entries.delete(key); return null; }
    const { ownerUid: _owner, cloudName: _name, ...result } = entry;
    return { ...result, cached: true, stale: age >= ttl(entry.status) };
  }
  forget(ownerUid, id) { this.entries.delete(`${ownerUid}:${id}`); }
  save() {
    const snapshot = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    this.queue = this.queue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot); await rename(temp, this.file);
    });
    return this.queue;
  }
  async scan(ownerUid, folders, { signal, force = false, onResult = () => {} } = {}) {
    let next = 0; const results = [];
    const controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const workers = await Promise.allSettled(Array.from({ length: Math.min(2, folders.length) }, async () => {
        while (next < folders.length) {
          signal?.throwIfAborted();
          const { id, name } = folders[next++];
          let result = force ? null : this.get(ownerUid, id, name);
          if (!result || result.stale) {
            try {
              result = { ...await this.identify(String(id), signal), id: String(id) };
              signal?.throwIfAborted();
              this.forget(ownerUid, id); this.remember(ownerUid, id, result, name);
            } catch (error) {
              if (signal.aborted || error.code === 'AUTH_EXPIRED') { controller.abort(error); throw error; }
              this.forget(ownerUid, id);
              result = { id: String(id), status: 'unavailable', message: error.message };
            }
          }
          signal?.throwIfAborted();
          results.push(result); onResult(result);
        }
      }));
      const failed = workers.find(worker => worker.status === 'rejected');
      if (failed) throw failed.reason;
      return results;
    } finally { await this.save().catch(() => {}); }
  }
}
