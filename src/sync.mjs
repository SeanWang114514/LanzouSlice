import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicJSON, sha256 } from './transfer.mjs';
import { TransferMeter } from './transfer-meter.mjs';

export function syncSchedule(value) {
  if (value?.kind === 'interval' && Number.isInteger(value.minutes) && value.minutes >= 1 && value.minutes <= 10080) return { kind: 'interval', minutes: value.minutes };
  if (value?.kind === 'daily' && Array.isArray(value.times) && value.times.length >= 1 && value.times.length <= 24 && value.times.every(time => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) return { kind: 'daily', times: [...new Set(value.times)].sort() };
  throw new Error('请设置 1–10080 分钟的间隔，或每天 1–24 个 HH:mm 时间点');
}
export function nextSyncTime(schedule, now) {
  if (schedule.kind === 'interval') return now + schedule.minutes * 60000;
  const candidates = [];
  for (let day = 0; day <= 2; day++) for (const time of schedule.times) {
    const date = new Date(now), [hours, minutes] = time.split(':').map(Number);
    date.setDate(date.getDate() + day); date.setHours(hours, minutes, 0, 0);
    if (date.getTime() > now) candidates.push(date.getTime());
  }
  return Math.min(...candidates);
}
function overlaps(a, b) {
  const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  return inside(a, b) || inside(b, a);
}
const emptyStats = () => ({ added: 0, updated: 0, skipped: 0, deleted: 0, failed: 0 });

// A rule owns only the exact version folders recorded here. Task history is not a baseline.
export class SyncManager extends EventEmitter {
  constructor({ engine, dataDir = engine.dataDir, now = Date.now, busy = () => false, version = () => engine.client.uid }) {
    super(); this.engine = engine; this.client = engine.client; this.file = path.join(dataDir, 'sync-rules.json');
    this.now = now; this.busy = busy; this.version = version; this.rules = []; this.writes = Promise.resolve(); this.suspended = false;
    this.progress = new Map(); engine.syncPendingIds = new Set();
    engine.syncTraffic = (task, bytes) => this.progress.get(task.syncRuleId)?.meter.add(bytes);
    engine.persistSyncTask = async task => {
      const rule = this.rules.find(rule => rule.id === task.syncRuleId);
      const pending = rule?.pending.find(pending => pending.id === task.id);
      if (pending) { pending.task = task; await this.save(); }
    };
  }
  async init() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.format !== 'lanzou-sync' || ![1, 2].includes(data.version) || !Array.isArray(data.rules)) throw new Error('同步状态格式不支持');
      for (const rule of data.rules) {
        if (!/^[a-f\d-]{36}$/.test(rule.id) || !rule.ownerUid || !path.isAbsolute(rule.sourcePath) || !rule.entries || !Array.isArray(rule.garbage)) throw new Error('同步规则记录损坏');
        rule.pending = Array.isArray(rule.pending) ? rule.pending : rule.pending ? [rule.pending] : [];
        syncSchedule(rule.schedule); rule.entries = Object.assign(Object.create(null), rule.entries); rule.state = 'idle'; rule.requested = Boolean(rule.requested || rule.enabled && rule.pending.length);
        for (const pending of rule.pending) this.engine.syncPendingIds.add(pending.id);
      }
      this.rules = data.rules;
    } catch (error) { if (error.code !== 'ENOENT') this.warning = `同步记录读取失败，已停止自动同步以保护基线：${error.message}`; }
    return this.publicState();
  }
  save() {
    if (this.warning) return Promise.reject(new Error(this.warning));
    const snapshot = { format: 'lanzou-sync', version: 2, rules: JSON.parse(JSON.stringify(this.rules)) };
    const write = this.writes.catch(() => {}).then(() => atomicJSON(this.file, snapshot)); this.writes = write; return write;
  }
  changed(urgent = true) { this.emit('change', urgent); this.schedule(); }
  publicState() {
    return { busy: Boolean(this.active), warning: this.warning || '', rules: this.rules.filter(rule => this.client.loggedIn && String(rule.ownerUid) === String(this.client.uid)).map(({ entries, pending, garbage, ...rule }) => ({ ...rule, managedFiles: Object.keys(entries).length, cleanupCount: garbage.length, pendingFile: pending[0]?.relativePath || '', progress: this.publicProgress(rule) })) };
  }
  publicProgress(rule) {
    const current = this.progress.get(rule.id); if (!current) return rule.progress || null;
    if (current.result) return current.result;
    let bytes = current.processedBytes;
    for (const file of current.tasks.values()) {
      const task = this.engine.tasks.get(file.id);
      if (task && ['uploading', 'manifest', 'done'].includes(task.phase)) file.bytes = Math.max(file.bytes, Math.min(file.size, task.bytes || 0));
      bytes += file.bytes;
    }
    const meter = current.meter.read({ state: this.active?.id === rule.id ? 'running' : 'paused', phase: rule.state === 'uploading' ? 'uploading' : rule.state });
    const remaining = Math.max(0, current.uploadBytes - (bytes - current.skippedBytes));
    return { totalKnown: current.totalKnown, totalFiles: current.totalFiles, totalBytes: current.totalBytes, scannedFiles: current.scannedFiles, scannedBytes: current.scannedBytes,
      processedFiles: current.processedFiles, processedBytes: bytes, uploadBytes: current.uploadBytes, skippedBytes: current.skippedBytes,
      ratio: Math.min(0.99, current.totalBytes ? bytes / current.totalBytes : current.totalFiles ? current.processedFiles / current.totalFiles : 0),
      activeFiles: current.tasks.size, concurrency: current.concurrency, ...meter,
      remainingSeconds: rule.state === 'uploading' && current.planKnown && remaining > 0 && meter.speedBytesPerSecond > 0 ? remaining / meter.speedBytesPerSecond : null };
  }
  own(id) {
    if (!this.client.loggedIn) throw new Error('请先登录蓝奏云');
    const rule = this.rules.find(rule => rule.id === id && String(rule.ownerUid) === String(this.client.uid));
    if (!rule) throw new Error('当前账号没有此同步规则');
    return rule;
  }
  async put(payload) {
    if (!this.client.loggedIn) throw new Error('请先登录蓝奏云');
    if (this.warning) throw new Error(this.warning);
    const ownerUid = this.client.uid, version = this.version();
    const current = payload.id ? this.own(payload.id) : null;
    if (current && this.active?.id === current.id) throw new Error('请先暂停此同步规则，再修改设置');
    const sourcePath = String(payload.sourcePath || '').trim(), name = String(payload.name || '').trim();
    if (!path.isAbsolute(sourcePath)) throw new Error('请填写文件或文件夹的绝对路径');
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error('请选择普通文件或文件夹，不支持链接');
    const canonical = await realpath(sourcePath);
    if (!this.client.loggedIn || version !== this.version() || String(ownerUid) !== String(this.client.uid)) throw new Error('账号已变化，请重新保存规则');
    if (current && canonical !== current.sourcePath) throw new Error('源路径不能修改，请另建规则；原规则可移除并保留云端内容');
    if (this.rules.some(rule => rule.id !== current?.id && String(rule.ownerUid) === String(ownerUid) && overlaps(rule.sourcePath, canonical))) throw new Error('源路径与已有规则重叠，请编辑原规则或选择其他路径');
    for (const directory of [this.engine.dataDir, this.engine.storage.settings.cacheDir]) if (directory && overlaps(canonical, path.resolve(directory))) throw new Error('同步源不能包含或位于本软件的任务、缓存目录');
    const parentId = String(payload.parentId ?? '-1');
    if (!/^(?:-1|\d+)$/.test(parentId) || name.length > 100) throw new Error('云端目录或规则名称无效');
    if (current && parentId !== current.parentId) throw new Error('云端目标不能修改，请另建规则');
    const schedule = syncSchedule(payload.schedule);
    if (current && this.active?.id === current.id) throw new Error('规则已开始同步，请先暂停后再修改');
    const rule = current || { id: randomUUID(), ownerUid, sourcePath: canonical, sourceKind: info.isDirectory() ? 'directory' : 'file', parentId, entries: Object.create(null), garbage: [], pending: [], state: 'idle', createdAt: this.now() };
    Object.assign(rule, { name: name || path.basename(canonical), schedule, enabled: payload.enabled !== false, deleteRemoved: payload.deleteRemoved === true, nextRun: nextSyncTime(schedule, this.now()) });
    if (!current) this.rules.push(rule);
    await this.save(); this.changed(); return rule.id;
  }
  async request(id) { const rule = this.own(id); if (this.active?.id === id) return; this.suspended = false; rule.requested = true; rule.state = 'queued'; await this.save(); this.changed(); void this.tick().catch(error => this.report(error)); }
  async toggle(id, enabled) {
    const rule = this.own(id); rule.enabled = Boolean(enabled);
    if (!rule.enabled) { rule.requested = false; if (this.active?.id === id) { this.active.controller.abort(); await this.active.promise; } rule.state = 'paused'; }
    else { this.suspended = false; rule.nextRun = nextSyncTime(rule.schedule, this.now()); if (this.active?.id !== id) rule.state = 'idle'; }
    await this.save(); this.changed();
  }
  async remove(id) {
    this.own(id); if (this.active?.id === id) throw new Error('请先暂停规则再移除');
    const rule = this.own(id);
    for (const pending of rule.pending) this.engine.syncPendingIds.delete(pending.id);
    this.progress.delete(id);
    this.rules = this.rules.filter(rule => rule.id !== id); await this.save(); this.changed();
  }
  start() {
    if (this.started) return;
    this.started = true; this.onEngineUpdate = () => this.schedule();
    this.engine.on('update', this.onEngineUpdate); this.schedule();
  }
  schedule() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.started || this.warning || this.suspended || this.active || !this.client.loggedIn || this.busy() || this.engine.active.size || this.engine.creatingTasks || this.engine.creatingBatch || this.engine.pausingAll || this.engine.clearingHistory || this.engine.canceling) return;
    if ([...this.engine.tasks.values()].some(task => task.state === 'queued' && String(task.ownerUid) === String(this.client.uid))) return;
    const times = this.rules.filter(rule => String(rule.ownerUid) === String(this.client.uid) && (rule.requested || rule.enabled)).map(rule => rule.requested ? this.now() : rule.nextRun);
    if (!times.length) return;
    // Recheck the clock at most once a minute while a rule exists (clock changes/sleep).
    this.timer = setTimeout(() => { this.timer = null; void this.tick().catch(error => this.report(error)).finally(() => this.schedule()); }, Math.max(0, Math.min(60000, Math.min(...times) - this.now())));
    this.timer.unref();
  }
  report(error) { this.lastError = error.message; this.changed(); }
  wake() { this.suspended = false; for (const rule of this.rules) if (rule.enabled && rule.pending.length && String(rule.ownerUid) === String(this.client.uid)) rule.requested = true; void this.tick().catch(error => this.report(error)).finally(() => this.schedule()); }
  async pauseAll() { this.suspended = true; this.schedule(); if (this.active) { this.active.controller.abort(); await this.active.promise; } await this.writes; }
  async close() { this.started = false; if (this.onEngineUpdate) this.engine.off('update', this.onEngineUpdate); await this.pauseAll(); }
  async tick() {
    if (this.warning || this.suspended || this.active || !this.client.loggedIn || this.busy() || this.engine.active.size || this.engine.creatingTasks || this.engine.creatingBatch || this.engine.pausingAll || this.engine.clearingHistory || this.engine.canceling) return;
    if ([...this.engine.tasks.values()].some(task => task.state === 'queued' && String(task.ownerUid) === String(this.client.uid))) return;
    const rule = this.rules.find(rule => String(rule.ownerUid) === String(this.client.uid) && (rule.requested || rule.enabled && rule.nextRun <= this.now()));
    if (!rule) return;
    const controller = new AbortController();
    this.engine.syncOwner = rule.id;
    this.engine.syncUploadLimit = this.engine.storage.settings.uploadConcurrency;
    this.active = { id: rule.id, controller };
    this.active.promise = this.run(rule, controller.signal);
    await this.active.promise;
  }
  check(rule, signal, version) {
    signal.throwIfAborted();
    if (!this.client.loggedIn || String(this.client.uid) !== String(rule.ownerUid) || version !== this.version()) throw new Error('账号已变化或登录过期，请重新登录后同步');
  }
  async scan(rule, signal, onFile) {
    const files = [], walk = async (source, relativePath) => {
      signal.throwIfAborted(); const info = await lstat(source);
      if (info.isSymbolicLink()) {
        if (rule.deleteRemoved && Object.keys(rule.entries).some(key => key === relativePath || key.startsWith(`${relativePath}/`))) throw new Error(`原同步路径变为链接：${relativePath}，本轮停止以保护云端内容`);
        return;
      }
      if (info.isDirectory()) for (const entry of await readdir(source)) await walk(path.join(source, entry), relativePath ? `${relativePath}/${entry}` : entry);
      else if (info.isFile()) {
        const digest = await sha256(source, { signal }), after = await stat(source);
        if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error(`扫描期间文件变化：${relativePath}，下次重试`);
        files.push({ sourcePath: source, relativePath: relativePath || path.basename(source), sha256: digest, size: after.size, mtime: after.mtimeMs });
        onFile?.(files.at(-1));
      } else throw new Error(`无法扫描特殊文件：${relativePath}`);
    };
    const root = await lstat(rule.sourcePath);
    if (await realpath(rule.sourcePath) !== rule.sourcePath) throw new Error('源路径的实际位置已变化，请检查上级目录链接');
    if (root.isSymbolicLink() || (rule.sourceKind === 'directory' ? !root.isDirectory() : !root.isFile())) throw new Error('同步源类型已变化或变成链接，请检查路径');
    await walk(rule.sourcePath, ''); return files;
  }
  async root(rule, signal) {
    const siblings = await this.client.list(rule.parentId, signal);
    const name = `sync${rule.id.replaceAll('-', '')}`;
    if (rule.rootId && siblings.some(entry => entry.isFolder && entry.id === rule.rootId)) return;
    const matches = siblings.filter(entry => entry.isFolder && entry.name === name);
    if (matches.length > 1) throw new Error('云端出现重复的同步目录，请先在官网核实');
    rule.rootId = matches[0]?.id || await this.client.createFolder(name, signal, rule.parentId); await this.save();
  }
  async discardPending(rule, signal, pending) {
    if (!pending) return;
    const task = pending.task || this.engine.tasks.get(pending.id);
    // Name was journaled before creation; reconcile a lost create acknowledgement too.
    if (task?.folderName) {
      const items = await this.client.list(task.parentFolderId, signal);
      const matches = items.filter(entry => entry.isFolder && (task.folderId ? entry.id === task.folderId : entry.name === task.folderName));
      if (matches.length > 1) throw new Error('未完成版本目录重复，请在官网核实');
      if (matches[0]) rule.garbage.push({ id: matches[0].id, parentId: task.parentFolderId, name: matches[0].name });
    }
    rule.pending = rule.pending.filter(file => file.id !== pending.id); await this.save(); this.engine.syncPendingIds.delete(pending.id);
    const previousTask = this.engine.tasks.get(pending.id);
    if (previousTask && previousTask.state !== 'completed') { previousTask.state = 'failed'; previousTask.error = previousTask.message = '此未完成版本已被后续同步替代，可移除记录'; await this.engine.persist(previousTask); }
  }
  async cleanup(rule, signal, version) {
    while (rule.garbage.length) {
      this.check(rule, signal, version); const old = rule.garbage[0];
      if (old.reason === 'removed') {
        const root = await lstat(rule.sourcePath);
        if (await realpath(rule.sourcePath) !== rule.sourcePath) throw new Error('源路径实际位置变化，停止删除');
        if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('同步源路径已变化，停止删除');
        const present = await lstat(path.join(rule.sourcePath, ...old.relativePath.split('/'))).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (!rule.deleteRemoved || present) { rule.garbage.shift(); await this.save(); continue; }
      }
      if (Object.values(rule.entries).some(entry => entry.id === old.id) && !(old.reason === 'removed' && rule.entries[old.relativePath]?.id === old.id)) throw new Error('拒绝清理仍在使用的版本');
      const entries = await this.client.list(old.parentId, signal); this.check(rule, signal, version);
      const found = entries.find(entry => entry.isFolder && entry.id === old.id);
      if (found) {
        if (found.name !== old.name || !/^slice[a-f\d]{32}$/.test(found.name)) throw new Error('旧版本目录名称已变化，停止清理以保护云端内容');
        await this.client.deleteEntry(old.id, true, signal);
      }
      if (old.reason === 'removed' && rule.entries[old.relativePath]?.id === old.id) { delete rule.entries[old.relativePath]; rule.stats.deleted++; }
      rule.garbage.shift(); await this.save();
    }
  }
  async upload(rule, file, signal, version) {
    this.check(rule, signal, version);
    let pending = rule.pending.find(pending => pending.relativePath === file.relativePath);
    if (pending && (pending.sha256 !== file.sha256 || pending.task?.parentFolderId && pending.task.parentFolderId !== rule.rootId)) { await this.discardPending(rule, signal, pending); pending = null; }
    if (!pending) { pending = { id: randomUUID(), relativePath: file.relativePath, sha256: file.sha256 }; rule.pending.push(pending); this.engine.syncPendingIds.add(pending.id); await this.save(); }
    this.check(rule, signal, version);
    this.progress.get(rule.id).tasks.set(file.relativePath, { id: pending.id, size: file.size, bytes: 0 });
    let task = pending.task || this.engine.tasks.get(pending.id);
    if (task) {
      task.sourceMtime = file.mtime;
      if (task.state === 'completed') {
        const content = await this.client.list(task.folderId, signal);
        if (!content.some(entry => !entry.isFolder && entry.id === task.manifestId) || task.manifest.parts.some(part => !content.some(entry => !entry.isFolder && entry.id === String(part.remoteId)))) {
          await this.discardPending(rule, signal, pending); return this.upload(rule, file, signal, version);
        }
      }
      if (task.folderId && !(await this.client.list(rule.rootId, signal)).some(entry => entry.isFolder && entry.id === task.folderId)) {
        for (const key of ['folderId', 'manifestId', 'manifest', 'indexId']) delete task[key]; task.receipts = {}; task.state = 'paused';
      }
      this.engine.tasks.set(task.id, task);
      task.concurrency = this.engine.syncUploadLimit;
      if (task.state !== 'completed') { task.phase = 'prepare'; task.bytes = 0; task.progress = 0; this.engine.start(task, uploadSignal => this.engine.runUpload(task, uploadSignal)); }
    } else {
      await this.engine.createUpload(file.sourcePath, { id: pending.id, syncRuleId: rule.id, parentFolderId: rule.rootId, relativePath: file.relativePath, sha256: file.sha256 }); task = this.engine.tasks.get(pending.id);
    }
    const abort = () => { void this.engine.pause(task.id); }; signal.addEventListener('abort', abort, { once: true });
    try { if (signal.aborted) abort(); await this.engine.active.get(task.id)?.promise; }
    finally { signal.removeEventListener('abort', abort); }
    this.check(rule, signal, version);
    if (task.state !== 'completed' || !task.manifestId || task.manifest?.sha256 !== file.sha256) throw new Error(task.error || task.message || '上传未完成，将在下次同步恢复');
    const previous = rule.entries[file.relativePath];
    rule.entries[file.relativePath] = { id: task.folderId, name: task.folderName, parentId: rule.rootId, sha256: file.sha256, manifestId: task.manifestId, partIds: task.manifest.parts.map(part => String(part.remoteId)), taskId: task.id, size: file.size };
    if (previous && previous.id !== task.folderId) rule.garbage.push(previous);
    rule.pending = rule.pending.filter(file => file.id !== task.id);
    // Publish the successful baseline durably before deleting its predecessor.
    await this.save(); this.engine.syncPendingIds.delete(task.id);
    rule.stats[previous ? 'updated' : 'added']++;
    const progress = this.progress.get(rule.id); progress.tasks.delete(file.relativePath); progress.processedFiles++; progress.processedBytes += file.size; this.changed(false);
  }
  async run(rule, signal) {
    const progress = { meter: new TransferMeter(), tasks: new Map(), totalKnown: false, totalFiles: 0, totalBytes: 0, scannedFiles: 0, scannedBytes: 0, processedFiles: 0, processedBytes: 0, skippedBytes: 0, uploadBytes: 0, concurrency: this.engine.syncUploadLimit };
    this.progress.set(rule.id, progress);
    const timer = setInterval(() => this.changed(false), 1000); timer.unref();
    const version = this.version(); rule.state = 'scanning'; rule.progress = null; rule.requested = false; rule.lastRun = this.now(); rule.error = ''; rule.stats = emptyStats(); this.changed();
    try {
      await this.save(); this.check(rule, signal, version);
      const files = await this.scan(rule, signal, file => { progress.scannedFiles++; progress.scannedBytes += file.size; rule.currentFile = file.relativePath; this.engine.notify(); }); this.check(rule, signal, version);
      progress.totalKnown = true; progress.totalFiles = files.length; progress.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      await this.root(rule, signal); this.check(rule, signal, version);
      const remote = await this.client.list(rule.rootId, signal); this.check(rule, signal, version);
      const present = new Set(files.map(file => file.relativePath));
      for (const pending of [...rule.pending]) if (!present.has(pending.relativePath)) await this.discardPending(rule, signal, pending);
      // Resume the in-flight file first, even if directory enumeration order changed.
      const pendingPaths = new Set(rule.pending.map(file => file.relativePath));
      files.sort((a, b) => Number(pendingPaths.has(b.relativePath)) - Number(pendingPaths.has(a.relativePath)));
      const uploads = [];
      for (const file of files) {
        this.check(rule, signal, version); rule.currentFile = file.relativePath;
        const previous = rule.entries[file.relativePath];
        const exists = previous && previous.parentId === rule.rootId && remote.some(entry => entry.isFolder && entry.id === previous.id);
        if (previous?.sha256 === file.sha256 && exists && !pendingPaths.has(file.relativePath)) {
          const content = await this.client.list(previous.id, signal); this.check(rule, signal, version);
          if (content.some(entry => !entry.isFolder && entry.id === previous.manifestId) && previous.partIds?.every(id => content.some(entry => !entry.isFolder && entry.id === id))) { rule.stats.skipped++; progress.processedFiles++; progress.processedBytes += file.size; progress.skippedBytes += file.size; this.changed(false); continue; }
        }
        uploads.push(file); progress.uploadBytes += file.size;
      }
      progress.planKnown = true;
      rule.state = 'uploading'; this.changed();
      let next = 0, firstError;
      const workers = new AbortController(), combined = AbortSignal.any([signal, workers.signal]);
      const worker = async () => {
        while (next < uploads.length && !combined.aborted) {
          const file = uploads[next++]; rule.currentFile = file.relativePath;
          try { await this.upload(rule, file, combined, version); }
          catch (error) { firstError ||= error; workers.abort(error); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(progress.concurrency, uploads.length) }, worker));
      if (firstError) throw firstError;
      this.check(rule, signal, version);
      if (rule.deleteRemoved) {
        // A second full scan protects against a root being removed during this run.
        const confirmed = new Set((await this.scan(rule, signal)).map(file => file.relativePath));
        for (const [relative, entry] of Object.entries(rule.entries)) if (!present.has(relative) && !confirmed.has(relative) && !rule.garbage.some(old => old.id === entry.id)) rule.garbage.push({ ...entry, reason: 'removed', relativePath: relative });
        await this.save();
      }
      rule.state = 'cleaning'; rule.currentFile = ''; this.changed(); await this.cleanup(rule, signal, version);
      rule.state = 'idle'; rule.lastSuccess = this.now();
    } catch (error) {
      rule.state = signal.aborted ? 'paused' : 'error'; rule.error = signal.aborted ? '已暂停，下次同步将从回执恢复' : error.message; if (!signal.aborted) rule.stats.failed++;
    } finally {
      clearInterval(timer);
      rule.progress = { ...this.publicProgress(rule), activeFiles: 0, speedBytesPerSecond: 0, remainingSeconds: rule.state === 'idle' ? 0 : null, ...(rule.state === 'idle' ? { ratio: 1, finished: true } : {}) };
      progress.result = rule.progress;
      rule.currentFile = ''; rule.lastFinished = this.now(); if (!signal.aborted) rule.nextRun = nextSyncTime(rule.schedule, this.now());
      try { await this.save(); } catch (error) { rule.state = 'error'; rule.error = `同步状态保存失败：${error.message}`; rule.progress.finished = false; rule.progress.ratio = Math.min(0.99, rule.progress.ratio); rule.progress.remainingSeconds = null; }
      this.engine.syncOwner = null; this.active = null; this.changed(); this.engine.startNextDownload();
    }
  }
}
