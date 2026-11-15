import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat, rm, readdir, open, link, unlink, statfs, rmdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { MANIFEST_NAME, LanzouError, readBounded } from './lanzou.mjs';
import { LocalStorage, diskKey, isConcurrency } from './storage.mjs';
import { createIndexName, readSliceIndex } from './slice-index.mjs';
import { TransferMeter } from './transfer-meter.mjs';

export const MAX_PART_BYTES = 80 * 1024 * 1024;
export const ZIP_RESERVE = 512;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[\d¹²³]|lpt[\d¹²³]) *(\.|$)/i;
const ABORT = () => new DOMException('任务已暂停', 'AbortError');
export function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 255 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || WINDOWS_DEVICE_NAME.test(name) || name === '.' || name === '..') throw new Error('文件名无效或不适用于 Windows');
  return name;
}
export function localFileName(originalName) {
  if (typeof originalName !== 'string' || !originalName || originalName.length > 4096) throw new Error('清单中的原文件名无效');
  // Metadata keeps the exact original. Never treat an untrusted name as a path.
  const escape = character => `~${character.charCodeAt(0).toString(16).padStart(4, '0')}~`;
  let name = originalName.replace(/[<>:"/\\|?*\x00-\x1f]/g, escape).replace(/[. ]+$/, tail => [...tail].map(escape).join(''));
  if (WINDOWS_DEVICE_NAME.test(name)) name = `_${name}`;
  if (name.length > 255) {
    const extension = path.extname(name).slice(0, 20).replace(/[. ]+$/, '');
    const suffix = `-${createHash('sha256').update(originalName).digest('hex').slice(0, 12)}${extension}`;
    name = [...name.slice(0, 255 - suffix.length)].filter(c => !/^[\ud800-\udfff]$/.test(c)).join('') + suffix;
  }
  return safeName(name);
}
export async function atomicJSON(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.lanzou-${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' }); await rename(temporary, filePath); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
export async function sha256(filePath, { signal, onProgress = () => {} } = {}) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(filePath, { signal })) { hash.update(chunk); bytes += chunk.length; onProgress(bytes); }
  return hash.digest('hex');
}
export function planParts(size, maxBytes = MAX_PART_BYTES) {
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= ZIP_RESERVE || maxBytes > MAX_PART_BYTES) throw new Error('分片尺寸无效');
  const payloadLimit = maxBytes - ZIP_RESERVE;
  const count = Math.max(1, Math.ceil(size / payloadLimit));
  if (count > 20000) throw new Error('文件超过单任务 20,000 个切片的上限');
  return Array.from({ length: count }, (_, index) => ({ index, name: `part-${String(index + 1).padStart(6, '0')}.zip`, offset: index * payloadLimit, payloadSize: Math.max(0, Math.min(payloadLimit, size - index * payloadLimit)) }));
}
export function validateManifest(value) {
  if (!value || value.format !== 'lanzou-slice' || value.version !== 1 || !/^[a-f\d-]{36}$/.test(value.taskId) || !Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 20000) throw new Error('清单格式不正确或版本不支持');
  localFileName(value.originalName);
  if (!Number.isSafeInteger(value.originalSize) || value.originalSize < 0 || !SHA256.test(value.sha256) || !Number.isSafeInteger(value.maxPartBytes) || value.maxPartBytes > MAX_PART_BYTES || value.maxPartBytes <= ZIP_RESERVE) throw new Error('清单的文件信息无效');
  const expected = planParts(value.originalSize, value.maxPartBytes);
  if (expected.length !== value.parts.length) throw new Error('清单中的切片数量不一致');
  for (let i = 0; i < expected.length; i++) {
    const part = value.parts[i]; const want = expected[i];
    if (!part || part.index !== i || part.name !== want.name || part.offset !== want.offset || part.payloadSize !== want.payloadSize || !Number.isSafeInteger(part.uploadSize) || part.uploadSize < part.payloadSize || part.uploadSize > value.maxPartBytes || !SHA256.test(part.sha256) || !/^\d+$/.test(String(part.remoteId))) throw new Error(`第 ${i + 1} 片清单信息无效`);
  }
  return value;
}

export async function createPartZip(sourcePath, part, destination, signal) {
  signal?.throwIfAborted();
  const zip = new yazl.ZipFile();
  const input = part.payloadSize ? createReadStream(sourcePath, { start: part.offset, end: part.offset + part.payloadSize - 1, signal }) : Readable.from([]);
  const output = createWriteStream(destination, { flags: 'w' });
  const aborted = () => { input.destroy(ABORT()); zip.outputStream.destroy(ABORT()); };
  const failed = error => zip.outputStream.destroy(error);
  signal?.addEventListener('abort', aborted, { once: true });
  input.on('error', failed); zip.on('error', failed);
  try {
    const done = pipeline(zip.outputStream, output, { signal });
    zip.addReadStream(input, 'payload.bin', { size: part.payloadSize, compress: false, mtime: new Date('2000-01-01T00:00:00Z'), forceDosTimestamp: true, mode: 0o100644 });
    zip.end();
    await done;
    return { uploadSize: (await stat(destination)).size, sha256: await sha256(destination, { signal }) };
  } catch (error) { await rm(destination, { force: true }).catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', aborted); }
}

async function zipPayload(filePath, expectedSize) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(new Error(`切片 ZIP 无法读取：${error.message}`));
      let found = false;
      zip.on('error', error => { zip.close(); reject(error); });
      zip.on('end', () => { if (!found) { zip.close(); reject(new Error('切片 ZIP 缺少 payload.bin')); } });
      zip.on('entry', entry => {
        if (found || zip.entryCount !== 1 || entry.fileName !== 'payload.bin' || entry.compressionMethod !== 0 || entry.uncompressedSize !== expectedSize || entry.generalPurposeBitFlag & 1) { zip.close(); return reject(new Error('切片 ZIP 结构或有效载荷长度不正确')); }
        found = true;
        zip.openReadStream(entry, (error, stream) => { if (error) { zip.close(); reject(error); } else resolve({ stream, close: () => zip.close() }); });
      });
      zip.readEntry();
    });
  });
}

export async function mergeArchives(manifest, paths, destination, { signal, onProgress = () => {} } = {}) {
  validateManifest(manifest);
  if (paths.length !== manifest.parts.length) throw new Error('分片数量不完整');
  const temporary = path.join(path.dirname(destination), `.lanzou-${randomUUID()}.merging`);
  const file = await open(temporary, 'wx'); const fullHash = createHash('sha256'); let bytes = 0;
  let committed = false;
  try {
    for (let i = 0; i < paths.length; i++) {
      signal?.throwIfAborted(); const part = manifest.parts[i];
      if ((await stat(paths[i])).size !== part.uploadSize || await sha256(paths[i], { signal }) !== part.sha256) throw new Error(`第 ${i + 1} 片内容校验失败`);
      const payload = await zipPayload(paths[i], part.payloadSize); let partBytes = 0;
      const abort = () => payload.stream.destroy(ABORT()); signal?.addEventListener('abort', abort, { once: true });
      try {
        for await (const chunk of payload.stream) {
          signal?.throwIfAborted(); partBytes += chunk.length;
          if (partBytes > part.payloadSize) throw new Error('分片有效载荷超出清单长度');
          await file.writeFile(chunk); fullHash.update(chunk); bytes += chunk.length;
          onProgress(bytes, manifest.originalSize);
        }
        if (partBytes !== part.payloadSize) throw new Error(`第 ${i + 1} 片有效载荷不完整`);
      } finally { signal?.removeEventListener('abort', abort); payload.close(); }
    }
    if (bytes !== manifest.originalSize || fullHash.digest('hex') !== manifest.sha256) throw new Error('合并结果 SHA-256 校验失败');
    await file.sync(); await file.close();
    // Hard-link commits atomically without overwriting an existing destination.
    try { await link(temporary, destination); }
    catch (error) {
      if (!['ENOTSUP','EPERM','EXDEV','EOPNOTSUPP','ENOSYS'].includes(error.code)) throw error;
      // exFAT/removable volumes may not support hard links; exclusive copy still prevents overwrite.
      await copyFile(temporary, destination, constants.COPYFILE_EXCL);
    }
    committed = true; await unlink(temporary);
    return { path: destination, bytes, sha256: manifest.sha256 };
  } catch (error) {
    await file.close().catch(() => {});
    if (!committed) await rm(temporary, { force: true }).catch(() => {});
    if (error.code === 'EEXIST') throw new Error('目标文件已存在，请更换目录或移走同名文件后继续');
    throw error;
  }
}

export async function downloadPart(client, getLink, destination, expected, { signal, onProgress = () => {}, onTraffic = () => {}, retries = 3 } = {}) {
  const temporary = `${destination}.partial`;
  if (await stat(destination).then(s => s.size === expected.uploadSize).catch(() => false)) {
    if (await sha256(destination, { signal }) === expected.sha256) { onProgress(expected.uploadSize); return; }
    await rm(destination, { force: true });
  }
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    signal?.throwIfAborted();
    try {
      const link = await getLink();
      let offset = await stat(temporary).then(s => s.size).catch(() => 0);
      if (offset > expected.uploadSize) { await rm(temporary, { force: true }); offset = 0; }
      if (offset < expected.uploadSize) {
        const headers = { ...link.headers, ...(offset ? { Range: `bytes=${offset}-` } : {}) };
        const response = await client.request(link.url, { signal, headers });
        if ([403,404,410].includes(response.status)) { await response.body?.cancel(); throw new LanzouError('下载链接已过期，正在重新取链', 'LINK_EXPIRED'); }
        if (response.status === 429) { await response.body?.cancel(); throw new LanzouError('下载频率受限', 'RATE_LIMIT'); }
        if (!response.ok || (response.headers.get('content-type') || '').includes('text/html')) { await response.body?.cancel(); throw new Error('下载节点没有返回文件内容'); }
        if (response.status === 206) {
          const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          if (!range || Number(range[1]) !== offset || Number(range[2]) !== expected.uploadSize - 1 || Number(range[3]) !== expected.uploadSize) { await response.body?.cancel(); throw new Error('服务器返回了不匹配的续传区间'); }
        } else if (response.status === 200) offset = 0;
        else { await response.body?.cancel(); throw new Error(`无效下载状态 ${response.status}`); }
        const output = await open(temporary, offset ? 'a' : 'w');
        let received = offset; onProgress(received);
        try {
          for await (const chunk of response.body ?? []) {
            signal?.throwIfAborted(); received += chunk.byteLength;
            if (received > expected.uploadSize) throw new Error('下载文件长度超过清单');
            await output.writeFile(chunk); onTraffic(chunk.byteLength); onProgress(received);
          }
          await output.sync();
        } finally { await output.close(); }
        if (received !== expected.uploadSize) throw new Error('下载连接提前中断');
      }
      if (await sha256(temporary, { signal }) !== expected.sha256) { await rm(temporary, { force: true }); throw new Error('切片 SHA-256 不匹配，正在重新下载'); }
      await rename(temporary, destination); return;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || ABORT();
      lastError = error;
      if (error.code === 'AUTH_EXPIRED' || error.code === 'VERIFY_REQUIRED') throw error;
      if (attempt + 1 < retries) await delay((error.code === 'RATE_LIMIT' ? 2500 : 500) * 2 ** attempt, undefined, { signal });
    }
  }
  throw lastError;
}

async function freeSpace(directory, required) {
  const fs = await statfs(directory);
  if (Number(fs.bavail) * Number(fs.bsize) < required + 16 * 1024 * 1024) throw new Error('目标磁盘空间不足，请清理空间或更换目录');
}

export class TransferEngine extends EventEmitter {
  constructor({ client, dataDir, defaultDownloadDir, maxPartBytes = MAX_PART_BYTES }) {
    super(); this.client = client; this.dataDir = dataDir; this.maxPartBytes = maxPartBytes;
    this.tasks = new Map(); this.active = new Map(); this.persistQueue = new Map(); this.lastEmit = 0; this.meters = new Map(); this.tick = null;
    this.storage = new LocalStorage(dataDir, defaultDownloadDir);
  }
  taskDir(id) { if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('无效任务 ID'); return path.join(this.dataDir, 'tasks', id); }
  publicTasks() { return [...this.tasks.values()].map(({ sourcePath, password, manifest, ...task }) => ({ ...task, originalSize: manifest?.originalSize ?? task.originalSize, originalName: manifest?.originalName ?? task.originalName, totalParts: manifest?.parts.length ?? task.totalParts, ...(this.meters.get(task.id)?.read(task) || { elapsedMs: task.elapsedMs || 0, speedBytesPerSecond: 0, remainingSeconds: null, transferredBytes: 0 }) })); }
  notify(force = false) {
    if (!force && Date.now() - this.lastEmit < 180) return;
    this.lastEmit = Date.now(); this.emit('change', this.publicTasks());
  }
  async persist(task) {
    const previous = this.persistQueue.get(task.id) || Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(task));
    if (this.meters.has(task.id)) snapshot.elapsedMs = this.meters.get(task.id).read(task).elapsedMs;
    // Never write account passwords or share passcodes into task journals.
    delete snapshot.password;
    const next = previous.catch(() => {}).then(() => atomicJSON(path.join(this.taskDir(task.id), 'task.json'), snapshot));
    this.persistQueue.set(task.id, next); await next;
  }
  async init() {
    const root = path.join(this.dataDir, 'tasks'); await mkdir(root, { recursive: true });
    await this.storage.init();
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[a-f\d-]{36}$/.test(item.name)) continue;
      try {
        const task = JSON.parse(await readFile(path.join(root, item.name, 'task.json'), 'utf8'));
        if (task.id !== item.name || !['upload','download'].includes(task.type)) continue;
        if (!['completed','failed','paused'].includes(task.state)) { task.state = 'paused'; task.message = '程序关闭前未完成，可继续任务'; }
        this.tasks.set(task.id, task);
      } catch { /* A damaged journal does not prevent other tasks from opening. */ }
    }
    if (this.storage.settings.autoCleanCache) await this.cleanCache().catch(error => { this.storage.warning = `缓存清理未完成：${error.message}`; });
    return this.publicTasks();
  }
  protectedCachePaths(exceptId) {
    return new Set([...this.tasks.values()].filter(task => task.id !== exceptId && (task.state !== 'completed' || this.active.has(task.id))).map(task => diskKey(this.storage.directory(task, this.taskDir(task.id)))));
  }
  protectedFiles() { return new Set([...this.tasks.values()].flatMap(task => [task.sourcePath, task.resultPath]).filter(Boolean).map(diskKey)); }
  async cacheInfo() {
    let cleanableBytes = 0, protectedBytes = 0, files = 0;
    const protectedPaths = this.protectedCachePaths(), protectedFiles = this.protectedFiles(), seen = new Set();
    for (const task of this.tasks.values()) for (const file of await this.storage.files(task, this.taskDir(task.id))) {
      if (seen.has(file.path)) continue; seen.add(file.path); files++;
      if (protectedPaths.has(diskKey(path.dirname(file.path))) || protectedFiles.has(diskKey(file.path))) protectedBytes += file.bytes; else cleanableBytes += file.bytes;
    }
    return { cleanableBytes, protectedBytes, files };
  }
  async cleanCache() {
    let files = 0, bytes = 0;
    const protectedPaths = this.protectedCachePaths();
    for (const task of this.tasks.values()) if (task.state === 'completed' && !this.active.has(task.id)) {
      const result = await this.storage.clean(task, this.taskDir(task.id), protectedPaths, this.protectedFiles()); files += result.files; bytes += result.bytes;
    }
    return { files, bytes };
  }
  async clearHistory({ scope = 'completed', id } = {}) {
    if (!['completed', 'all'].includes(scope) || id !== undefined && !/^[a-f\d-]{36}$/.test(id)) throw new Error('历史清理参数无效');
    if (this.clearingHistory) throw new Error('正在清空历史，请稍候');
    this.clearingHistory = true;
    let removed = 0;
    try {
      const selected = [...this.tasks.values()].filter(task => (!id || task.id === id) && (task.state === 'completed' || scope === 'all' && task.state === 'failed') && !this.active.has(task.id));
      const ids = new Set(selected.map(task => task.id));
      const protectedPaths = new Set([...this.tasks.values()].filter(task => !ids.has(task.id)).map(task => diskKey(this.storage.directory(task, this.taskDir(task.id))))), protectedFiles = this.protectedFiles();
      for (const task of selected) {
        await this.persistQueue.get(task.id);
        await this.storage.clean(task, this.taskDir(task.id), protectedPaths, protectedFiles);
        await rm(path.join(this.taskDir(task.id), 'task.json'), { force: true });
        await this.storage.retire(task, this.taskDir(task.id), protectedPaths).catch(() => {});
        await rmdir(this.taskDir(task.id)).catch(() => {});
        this.tasks.delete(task.id); this.persistQueue.delete(task.id); removed++;
      }
      return { removed, retained: this.tasks.size };
    } finally { this.clearingHistory = false; this.notify(true); this.startNextDownload(); }
  }
  start(task, work) {
    if (this.clearingHistory) throw new Error('正在清理历史，请稍后开始任务');
    if (this.creatingBatch || this.pausingAll) throw new Error('正在准备或暂停批量任务，请稍候');
    if (this.active.has(task.id)) throw new Error('任务已经在运行');
    // A single active transfer keeps global request concurrency bounded.
    if (this.active.size) throw new Error('请等待当前任务完成，或先暂停当前任务');
    const controller = new AbortController(); this.active.set(task.id, controller);
    task.state = 'running'; task.error = ''; this.meters.set(task.id, new TransferMeter(task.elapsedMs));
    if (!this.tick) { this.tick = setInterval(() => this.notify(), 500); this.tick.unref(); }
    this.notify(true);
    const promise = (async () => {
      try {
        await this.persist(task); await work(controller.signal); task.state = 'completed'; task.phase = 'done'; task.progress = 1;
        if (this.storage.settings.autoCleanCache) await this.storage.clean(task, this.taskDir(task.id), this.protectedCachePaths(task.id), this.protectedFiles()).catch(error => { task.message += `；缓存待清理：${error.message}`; });
      }
      catch (error) {
        task.state = controller.signal.aborted ? 'paused' : 'failed';
        task.error = controller.signal.aborted ? '' : (error.message || '任务失败');
        task.message = controller.signal.aborted ? '已暂停，可继续' : task.error;
        if (error.code === 'AUTH_EXPIRED') { task.message = '登录已过期，请重新登录后继续'; await this.pauseQueued(task.message).catch(error => { task.message += `；排队记录保存失败：${error.message}`; }); }
      } finally {
        task.elapsedMs = this.meters.get(task.id).read(task).elapsedMs; this.meters.delete(task.id);
        task.lastStoppedAt = new Date().toISOString();
        this.active.delete(task.id);
        if (!this.active.size) { clearInterval(this.tick); this.tick = null; }
        try { await this.persist(task); }
        catch (error) { task.state = 'failed'; task.error = `任务记录保存失败：${error.message}`; task.message = task.error; }
        this.notify(true);
        this.startNextDownload();
      }
      return task;
    })();
    this.active.get(task.id).promise = promise;
    return task.id;
  }
  startNextDownload() {
    if (this.active.size || this.creatingBatch || this.pausingAll || this.clearingHistory || !this.client.loggedIn) return;
    const task = [...this.tasks.values()].find(task => task.state === 'queued' && task.ownerUid === this.client.uid);
    if (task) this.start(task, signal => this.runDownload(task, signal));
  }
  async pauseQueued(message = '已暂停，可继续') {
    const queued = [...this.tasks.values()].filter(task => task.state === 'queued');
    for (const task of queued) { task.state = 'paused'; task.message = message; }
    await Promise.all(queued.map(task => this.persist(task))); this.notify(true);
  }
  async pause(id) {
    const task = this.tasks.get(id);
    if (task?.state === 'queued') { task.state = 'paused'; task.message = '已暂停，可继续'; await this.persist(task); this.notify(true); }
    const active = this.active.get(id); if (active) { active.abort(ABORT()); await active.promise; }
  }
  async pauseAll() {
    if (this.pausePromise) return this.pausePromise;
    this.queueEpoch = (this.queueEpoch || 0) + 1; this.pausingAll = true;
    this.pausePromise = Promise.all([this.pauseQueued(), ...[...this.active.keys()].map(id => this.pause(id))]);
    try { await this.pausePromise; }
    finally { this.pausingAll = false; this.pausePromise = null; this.notify(true); }
  }
  async createUpload(sourcePath) {
    if (this.clearingHistory) throw new Error('正在清理历史，请稍后开始任务');
    if (this.active.size) throw new Error('请先完成或暂停当前任务');
    const info = await stat(sourcePath); if (!info.isFile()) throw new Error('请选择文件');
    localFileName(path.basename(sourcePath));
    const id = randomUUID();
    const task = { id, type: 'upload', sourcePath, originalName: path.basename(sourcePath), originalSize: info.size, sourceMtime: info.mtimeMs, totalParts: planParts(info.size, this.maxPartBytes).length, concurrency: this.storage.settings.uploadConcurrency, createdAt: new Date().toISOString(), state: 'paused', progress: 0, phase: 'prepare', message: '准备上传', receipts: {} };
    task.ownerUid = this.client.uid; task.cachePath = await this.storage.allocate(id);
    this.tasks.set(id, task); await this.persist(task);
    return this.start(task, signal => this.runUpload(task, signal));
  }
  progress(task, phase, bytes, total, message) {
    task.phase = phase; task.bytes = bytes; task.totalBytes = total; task.progress = total ? bytes / total : 0;
    task.message = message; this.notify();
  }
  async runUpload(task, signal) {
    if (!this.client.loggedIn) throw new LanzouError('请先登录', 'AUTH_EXPIRED');
    if (task.ownerUid && String(task.ownerUid) !== String(this.client.uid)) throw new Error('请登录创建此任务的蓝奏云账号后继续');
    const source = await stat(task.sourcePath);
    if (source.size !== task.originalSize || source.mtimeMs !== task.sourceMtime) throw new Error('源文件已修改，不能继续旧任务，请重新上传');
    task.concurrency = isConcurrency(task.concurrency) ? task.concurrency : this.storage.settings.uploadConcurrency;
    const parts = planParts(source.size, this.maxPartBytes);
    const dir = this.storage.directory(task, this.taskDir(task.id)); await mkdir(dir, { recursive: true });
    await freeSpace(dir, parts.slice(0, task.concurrency).reduce((sum, part) => sum + part.payloadSize + ZIP_RESERVE, 0));
    const digest = await sha256(task.sourcePath, { signal, onProgress: bytes => this.progress(task, 'hashing', bytes, source.size, '正在计算原文件 SHA-256') });
    if (task.sourceSha256 && task.sourceSha256 !== digest) throw new Error('源文件内容已变化，请重新上传');
    task.sourceSha256 = digest; await this.persist(task);
    if (!task.folderId) {
      const root = await this.client.list('-1', signal);
      const previousName = task.folderName;
      const compatibleName = `slice${task.id.replaceAll('-', '')}`;
      // Reuse a legacy directory if an earlier create succeeded without an acknowledgement.
      const legacy = previousName && previousName !== compatibleName ? root.filter(x => x.isFolder && x.name === previousName) : [];
      if (legacy.length > 1) throw new Error('发现多个同名任务目录，请在官网核实后继续');
      task.folderName = legacy.length ? previousName : compatibleName;
      task.naming = { ...task.naming, strategy: legacy.length ? 'legacy-folder' : 'ascii-task-id-v1', originalName: task.originalName, cloudFolderName: task.folderName, ...(previousName && previousName !== task.folderName ? { previousCloudFolderName: previousName } : {}) };
      // Persist the mapping before sending the create request, including when its response is lost.
      await this.persist(task);
      const matches = root.filter(x => x.isFolder && x.name === task.folderName);
      if (matches.length > 1) throw new Error('发现多个同名任务目录，请在官网核实后继续');
      task.folderId = matches[0]?.id || await this.client.createFolder(task.folderName, signal); await this.persist(task);
    }
    const remote = await this.client.list(task.folderId, signal);
    const confirmed = new Set(parts.filter(part => {
      const receipt = task.receipts[part.index];
      return receipt?.remoteId && remote.some(file => String(file.id) === String(receipt.remoteId) && file.name === part.name);
    }).map(part => part.index));
    const counts = parts.map(part => confirmed.has(part.index) ? part.payloadSize : 0);
    let sentBytes = counts.reduce((sum, bytes) => sum + bytes, 0), next = 0, firstError;
    const workers = new AbortController(), combined = AbortSignal.any([signal, workers.signal]);
    const report = (index, bytes) => {
      const value = Math.min(bytes, parts[index].payloadSize); sentBytes += value - counts[index]; counts[index] = value;
      this.progress(task, 'uploading', sentBytes, source.size, `正在并发上传：${confirmed.size}/${parts.length} 片已确认（${task.concurrency} 路）`);
    };
    const transferPart = async part => {
      const signal = combined;
      signal.throwIfAborted();
      if (confirmed.has(part.index)) return;
      const existing = task.receipts[part.index];
      const zipPath = path.join(dir, part.name);
      report(part.index, 0);
      const packed = await createPartZip(task.sourcePath, part, zipPath, signal);
      if (packed.uploadSize > this.maxPartBytes) throw new Error('分片封装后超过 80 MiB 上限');
      const record = { ...part, ...packed }; task.receipts[part.index] = record;
      const upload = async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          signal.throwIfAborted();
          try {
            if (attempt || existing || remote.some(f => f.name === part.name)) {
              const matches = (await this.client.list(task.folderId, signal)).filter(f => f.name === part.name && !f.isFolder);
              if (matches.length > 1) throw new Error(`存在重复切片 ${part.name}，请先核实远程目录`);
              if (matches.length === 1) {
                const check = `${zipPath}.verify`;
                try {
                  await downloadPart(this.client, () => this.client.downloadLink(matches[0], { signal }), check, record, { signal, retries: 1 });
                  return String(matches[0].id);
                } finally { await rm(check, { force: true }).catch(() => {}); }
              }
            }
            record.attempted = true; await this.persist(task);
            report(part.index, 0);
            let previous = 0;
            return await this.client.upload(zipPath, part.name, task.folderId, { signal, onProgress: bytes => { this.meters.get(task.id)?.add(bytes - previous); previous = bytes; report(part.index, bytes); } });
          } catch (error) {
            if (signal.aborted || ['AUTH_EXPIRED','VERIFY_REQUIRED'].includes(error.code) || /重复切片|校验|不匹配/.test(error.message) || attempt === 2) throw error;
            await delay((error.code === 'RATE_LIMIT' ? 3000 : 1000) * 2 ** attempt, undefined, { signal });
          }
        }
      };
      record.remoteId = await upload(); delete record.attempted; confirmed.add(part.index); report(part.index, part.payloadSize); await this.persist(task);
      await rm(zipPath, { force: true });
    };
    const worker = async () => {
      while (next < parts.length && !combined.aborted) {
        const part = parts[next++];
        try { await transferPart(part); }
        catch (error) { firstError ||= error; workers.abort(error); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(task.concurrency, parts.length) }, worker));
    if (firstError) throw firstError;
    signal.throwIfAborted();
    const after = await stat(task.sourcePath);
    if (after.size !== source.size || after.mtimeMs !== source.mtimeMs) throw new Error('上传期间源文件发生变化，未提交清单，请重新上传');
    // Do not add fields to a legacy manifest when resuming an already committed upload.
    const naming = task.manifest ? task.manifest.naming : task.naming;
    const manifest = validateManifest({ format: 'lanzou-slice', version: 1, taskId: task.id, originalName: task.originalName, ...(naming ? { naming } : {}), originalSize: source.size, sha256: digest, maxPartBytes: this.maxPartBytes, createdAt: task.createdAt, parts: parts.map(p => {
      const { index, name, offset, payloadSize, uploadSize, sha256: digest, remoteId } = task.receipts[p.index];
      return { index, name, offset, payloadSize, uploadSize, sha256: digest, remoteId };
    }) });
    const manifestPath = path.join(dir, MANIFEST_NAME); await atomicJSON(manifestPath, manifest); task.manifest = manifest;
    this.progress(task, 'manifest', source.size, source.size, '切片已上传，正在提交文件清单');
    if (!task.manifestId) {
      const candidate = (await this.client.list(task.folderId, signal)).filter(f => f.name === MANIFEST_NAME && !f.isFolder);
      if (candidate.length > 1) throw new Error('目录存在重复清单，请在官网核实');
      if (candidate.length) {
        const remoteManifest = await this.readRemoteManifest(candidate[0], { signal });
        if (JSON.stringify(remoteManifest) !== JSON.stringify(manifest)) throw new Error('远程清单与当前任务冲突');
        task.manifestId = candidate[0].id;
      } else task.manifestId = await this.client.upload(manifestPath, MANIFEST_NAME, task.folderId, { signal });
      await this.persist(task);
    }
    // Publish only after the authoritative manifest has been committed. Failure is optional.
    const indexName = createIndexName(manifest, task.manifestId);
    delete task.indexWarning;
    if (!indexName) task.indexWarning = '文件名编码后超过快速索引长度限制，将使用完整清单识别。';
    else if (!task.indexId) {
      try {
        const indexes = (await this.client.list(task.folderId, signal)).filter(file => !file.isFolder && file.name === indexName);
        if (indexes.length > 1) throw new Error('存在重复快速索引');
        const indexPath = path.join(dir, 'slice-index.txt');
        await atomicJSON(indexPath, { format: 'lanzou-slice-index', version: 1, originalName: manifest.originalName, originalSize: manifest.originalSize, totalParts: parts.length, manifestId: String(task.manifestId), sha256: manifest.sha256 });
        task.indexName = indexName;
        task.indexId = indexes[0]?.id || await this.client.upload(indexPath, indexName, task.folderId, { signal });
        await this.persist(task);
      } catch (error) {
        if (signal.aborted) throw error;
        task.indexWarning = `快速索引未确认：${error.message}；文件已上传，仍可通过完整清单识别和下载。`;
      }
    }
    try { task.share = await this.client.share(task.folderId, true, signal); }
    catch (error) { if (signal.aborted) throw error; task.shareWarning = '上传已完成，分享链接未获取，可在账号文件列表中选择该目录下载'; }
    task.message = `已上传 ${parts.length} 片并提交清单`;
  }
  async readRemoteManifest(file, { page, password, signal } = {}) {
    const link = await this.client.downloadLink(file, { page, password, signal });
    const response = await this.client.request(link.url, { headers: link.headers, signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error('无法下载文件清单'); }
    let manifest;
    try { manifest = JSON.parse(await readBounded(response, MAX_MANIFEST_BYTES)); }
    catch (error) { throw new Error(`文件清单无法读取：${error.message}`); }
    return validateManifest(manifest);
  }
  async inspectFolder(folderId, signal) {
    const files = await this.client.list(String(folderId), signal);
    return this.inspectFiles(files, { kind: 'account', folderId: String(folderId) }, { signal });
  }
  async identifyFolder(folderId, signal) {
    const files = await this.client.list(String(folderId), signal);
    if (!files.some(file => !file.isFolder && (file.name === MANIFEST_NAME || /^part-\d{6}\.zip$/.test(file.name) || file.name.startsWith('sliceindex1')))) return { ordinary: true };
    const index = readSliceIndex(files);
    if (index) return { index: { ...index, folderId: String(folderId) } };
    return { bundle: await this.inspectFiles(files, { kind: 'account', folderId: String(folderId) }, { signal }) };
  }
  async inspectShare(url, password = '', signal) {
    const page = await this.client.sharePage(url, password, signal);
    const files = await this.client.shareFiles(page, password, signal);
    return this.inspectFiles(files, { kind: 'share', url: page.url }, { page, password, signal });
  }
  async inspectFiles(files, source, options) {
    const candidates = files.filter(f => f.name === MANIFEST_NAME && !f.isFolder);
    if (candidates.length !== 1) throw new Error(candidates.length ? '目录有多份清单，无法确定文件身份' : '目录尚无正式清单：上传未完成，或不是本软件创建的分片任务');
    const manifest = await this.readRemoteManifest(candidates[0], options);
    const resolved = manifest.parts.map(p => {
      const matches = files.filter(f => f.name === p.name && !f.isFolder && (source.kind !== 'account' || String(f.id) === String(p.remoteId)));
      if (matches.length !== 1) throw new Error(`切片缺失或重名：${p.name}`);
      return matches[0];
    });
    const index = source.kind === 'account' ? readSliceIndex(files) : null;
    const indexNames = index && index.originalName === manifest.originalName && index.originalSize === manifest.originalSize && index.totalParts === manifest.parts.length ? [index.indexName] : [];
    return { manifest, source, files: resolved, password: options.password || '', indexNames };
  }
  async createDownload(bundle, outputDir = this.storage.settings.downloadDir, concurrency = this.storage.settings.downloadConcurrency) {
    if (this.clearingHistory) throw new Error('正在清理历史，请稍后开始任务');
    if (this.active.size) throw new Error('请先完成或暂停当前任务');
    validateManifest(bundle.manifest);
    if (!path.isAbsolute(outputDir)) throw new Error('请选择有效的下载目录');
    if (!isConcurrency(concurrency)) throw new Error('并发数必须为 1–8 的整数');
    const task = { id: randomUUID(), type: 'download', createdAt: new Date().toISOString(), state: 'paused', progress: 0, phase: 'prepare', message: '准备下载', manifest: bundle.manifest, source: bundle.source, files: bundle.files, password: bundle.password || '', outputDir, concurrency };
    if (task.source.kind === 'account') task.ownerUid = this.client.uid;
    task.cachePath = await this.storage.allocate(task.id);
    this.tasks.set(task.id, task); await this.persist(task);
    return this.start(task, signal => this.runDownload(task, signal));
  }
  async createDownloadBatch(files, outputDir = this.storage.settings.downloadDir, concurrency = this.storage.settings.downloadConcurrency) {
    if (this.creatingBatch || this.pausingAll || this.clearingHistory) throw new Error('正在处理任务，请稍候');
    if (!this.client.loggedIn) throw new LanzouError('请先登录蓝奏云', 'AUTH_EXPIRED');
    if (!Array.isArray(files) || !files.length || files.length > 200 || !path.isAbsolute(outputDir) || !isConcurrency(concurrency)) throw new Error('批量下载参数无效');
    const keys = new Set();
    for (const file of files) {
      if (!file || !/^\d+$/.test(String(file.id)) || !/^(?:-1|\d+)$/.test(String(file.parentId)) || typeof file.isFolder !== 'boolean' || typeof file.name !== 'string' || !file.name) throw new Error('批量文件参数无效');
      const key = `${file.parentId}:${file.isFolder}:${file.id}`;
      if (keys.has(key)) throw new Error('批量文件重复'); keys.add(key);
    }
    const ownerUid = this.client.uid, epoch = this.queueEpoch || 0, tasks = [];
    const check = () => { if (!this.client.loggedIn || ownerUid !== this.client.uid || epoch !== (this.queueEpoch || 0)) throw new Error('账号或任务状态已变化，批量创建已停止'); };
    this.creatingBatch = true;
    try {
      for (const file of files) {
        check();
        const task = { id: randomUUID(), type: 'download', state: 'queued', phase: 'prepare', progress: 0, createdAt: new Date().toISOString(), ownerUid, outputDir,
          originalName: file.isFolder ? file.slice?.originalName || file.name : file.name, originalSize: file.isFolder ? file.slice?.originalSize || 0 : file.size || 0,
          source: { kind: 'account', folderId: file.isFolder ? String(file.id) : String(file.parentId), ...(!file.isFolder ? { file: { id: String(file.id), name: file.name } } : {}) },
          ...(file.isFolder ? { deferredManifest: true, concurrency, totalParts: file.slice?.totalParts || 0 } : { downloadKind: 'file', concurrency: 1 }),
          message: file.isFolder ? '排队等待下载，开始前校验切片清单' : '排队等待下载普通文件' };
        task.cachePath = await this.storage.allocate(task.id); check();
        tasks.push(task); this.tasks.set(task.id, task); await this.persist(task);
      }
      check(); return { ids: tasks.map(task => task.id) };
    } catch (error) {
      for (const task of tasks) { task.state = 'paused'; task.message = `批量创建未全部完成，请检查后继续：${error.message}`; await this.persist(task).catch(() => {}); }
      throw error;
    } finally { this.creatingBatch = false; this.notify(true); this.startNextDownload(); }
  }
  async runDownload(task, signal) {
    if (task.downloadKind === 'file') return this.runFileDownload(task, signal);
    if (task.deferredManifest) {
      if (!this.client.loggedIn) throw new LanzouError('请登录后继续下载', 'AUTH_EXPIRED');
      if (task.ownerUid !== this.client.uid) throw new Error('请登录创建此任务的蓝奏云账号后继续');
      this.progress(task, 'manifest', 0, 0, '正在读取并校验切片清单');
      const bundle = await this.inspectFolder(task.source.folderId, signal);
      task.manifest = bundle.manifest; task.files = bundle.files; task.source = bundle.source; task.deferredManifest = false;
      await this.persist(task);
    }
    const manifest = validateManifest(task.manifest);
    task.concurrency = isConcurrency(task.concurrency) ? task.concurrency : this.storage.settings.downloadConcurrency;
    if (task.source.kind === 'account' && !this.client.loggedIn) throw new LanzouError('请登录后继续下载', 'AUTH_EXPIRED');
    if (task.ownerUid && String(task.ownerUid) !== String(this.client.uid)) throw new Error('请登录创建此任务的蓝奏云账号后继续');
    await mkdir(task.outputDir, { recursive: true });
    const directory = this.storage.directory(task, this.taskDir(task.id)); await mkdir(directory, { recursive: true });
    task.savedName = localFileName(manifest.originalName);
    task.nameRestoration = { originalName: manifest.originalName, savedName: task.savedName, exact: task.savedName === manifest.originalName };
    await this.persist(task);
    const destination = path.join(task.outputDir, task.savedName);
    if (await stat(destination).then(() => true).catch(() => false)) throw new Error('目标文件已存在，请更换保存目录或移走同名文件');
    let cachedBytes = 0;
    for (const item of await readdir(directory, { withFileTypes: true })) if (item.isFile() && /^part-\d{6}\.zip(?:\.partial)?$/.test(item.name)) cachedBytes += (await stat(path.join(directory, item.name))).size;
    const downloadBytes = manifest.parts.reduce((sum, p) => sum + p.uploadSize, 0);
    const cacheFs = await stat(directory), outputFs = await stat(task.outputDir);
    await freeSpace(directory, Math.max(0, downloadBytes - cachedBytes) + (cacheFs.dev === outputFs.dev ? manifest.originalSize : 0));
    if (cacheFs.dev !== outputFs.dev) await freeSpace(task.outputDir, manifest.originalSize);
    const counts = manifest.parts.map(() => 0); let next = 0; let firstError;
    const workers = new AbortController(); const combined = AbortSignal.any([signal, workers.signal]);
    const page = task.source.kind === 'share' ? await this.client.sharePage(task.source.url, task.password || '', combined) : undefined;
    if (page) {
      const current = await this.client.shareFiles(page, task.password || '', combined);
      task.files = manifest.parts.map(part => {
        const matches = current.filter(file => file.name === part.name && !file.isFolder);
        if (matches.length !== 1) throw new Error(`切片缺失或重名：${part.name}`);
        return matches[0];
      });
    }
    const worker = async () => {
      while (next < manifest.parts.length && !combined.aborted) {
        const i = next++; const part = manifest.parts[i];
        try {
          await downloadPart(this.client, () => this.client.downloadLink(task.files[i], { page, password: task.password, signal: combined }), path.join(directory, part.name), part, {
            signal: combined, onTraffic: bytes => this.meters.get(task.id)?.add(bytes), onProgress: bytes => { counts[i] = bytes; this.progress(task, 'downloading', counts.reduce((a,b) => a+b, 0), downloadBytes, `正在并发下载 ${manifest.parts.length} 个切片（${task.concurrency} 路）`); }
          });
        } catch (error) { firstError ||= error; workers.abort(error); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(task.concurrency, manifest.parts.length) }, worker));
    if (firstError) throw firstError; signal.throwIfAborted();
    const result = await mergeArchives(manifest, manifest.parts.map(p => path.join(directory, p.name)), destination, { signal, onProgress: bytes => this.progress(task, 'merging', bytes, manifest.originalSize, '下载完成，正在校验并合并原文件') });
    task.resultPath = result.path; task.message = '下载、合并及 SHA-256 校验完成';
  }
  async createFileDownload(file, outputDir = this.storage.settings.downloadDir) {
    if (this.clearingHistory) throw new Error('正在清理历史，请稍后开始任务');
    if (this.active.size) throw new Error('请先完成或暂停当前任务');
    if (!this.client.loggedIn) throw new LanzouError('请先登录蓝奏云', 'AUTH_EXPIRED');
    if (file.isFolder || !/^\d+$/.test(String(file.id)) || typeof file.name !== 'string' || !file.name || !path.isAbsolute(outputDir)) throw new Error('文件或下载目录无效');
    const task = { id: randomUUID(), type: 'download', downloadKind: 'file', originalName: file.name, originalSize: file.size || 0, source: { kind: 'account', folderId: file.parentId, file: { id: file.id, name: file.name } }, ownerUid: this.client.uid,
      outputDir, concurrency: 1, createdAt: new Date().toISOString(), state: 'paused', phase: 'prepare', progress: 0, message: '准备下载普通文件' };
    task.cachePath = await this.storage.allocate(task.id);
    this.tasks.set(task.id, task); await this.persist(task);
    return this.start(task, signal => this.runFileDownload(task, signal));
  }
  async runFileDownload(task, signal) {
    if (!this.client.loggedIn) throw new LanzouError('请登录后继续下载', 'AUTH_EXPIRED');
    if (String(task.ownerUid) !== String(this.client.uid)) throw new Error('请登录创建此任务的蓝奏云账号后继续');
    task.concurrency = 1; task.savedName = localFileName(task.originalName);
    task.nameRestoration = { originalName: task.originalName, savedName: task.savedName, exact: task.savedName === task.originalName };
    await mkdir(task.outputDir, { recursive: true });
    const directory = this.storage.directory(task, this.taskDir(task.id)), destination = path.join(task.outputDir, task.savedName);
    await mkdir(directory, { recursive: true });
    if (await stat(destination).then(() => true).catch(() => false)) throw new Error('目标文件已存在，请更换保存目录或移走同名文件');
    const cached = path.join(directory, 'file-download.partial');
    this.progress(task, 'prepare', 0, 0, '正在获取普通文件下载链接');
    const linkInfo = await this.client.downloadLink(task.source.file, { signal });
    const response = await this.client.request(linkInfo.url, { signal, headers: linkInfo.headers });
    try {
      if (response.status !== 200 || (response.headers.get('content-type') || '').includes('text/html')) throw new Error('下载节点未返回完整文件，请刷新或完成官网验证后重试');
      const length = response.headers.get('content-length');
      const total = length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null;
      task.totalKnown = total !== null; task.originalSize = total ?? 0;
      if (total !== null) {
        const sameDisk = (await stat(directory)).dev === (await stat(task.outputDir)).dev;
        const cachedBytes = await stat(cached).then(info => info.size).catch(() => 0);
        await freeSpace(directory, Math.max(0, total - cachedBytes) + (sameDisk ? total : 0));
        if (!sameDisk) await freeSpace(task.outputDir, total);
      }
      await this.persist(task);
      // Normal files have no trusted slice hash/validator. Restart safely on resume.
      const output = await open(cached, 'w'); let received = 0;
      try {
        for await (const chunk of response.body ?? []) {
          signal.throwIfAborted(); received += chunk.byteLength;
          if (total !== null && received > total) throw new Error('下载文件长度超过服务器声明');
          await output.writeFile(chunk); this.meters.get(task.id)?.add(chunk.byteLength);
          this.progress(task, 'downloading', received, total ?? 0, '正在下载普通文件');
        }
        if (total !== null && received !== total) throw new Error('下载连接提前中断，请继续任务重新下载');
        await output.sync(); task.originalSize = received;
      } finally { await output.close(); }
    } finally { await response.body?.cancel().catch(() => {}); }
    signal.throwIfAborted();
    this.progress(task, 'saving', task.originalSize, task.originalSize, '下载完成，正在保存文件');
    const temporary = path.join(task.outputDir, `.lanzou-${randomUUID()}.downloading`); let temporaryCreated = false;
    try {
      await copyFile(cached, temporary, constants.COPYFILE_EXCL); temporaryCreated = true; signal.throwIfAborted();
      try { await link(temporary, destination); }
      catch (error) {
        if (!['ENOTSUP','EPERM','EXDEV','EOPNOTSUPP','ENOSYS'].includes(error.code)) throw error;
        await freeSpace(task.outputDir, task.originalSize);
        await copyFile(temporary, destination, constants.COPYFILE_EXCL);
      }
      task.resultPath = destination; task.message = '普通文件下载完成';
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('目标文件已存在，请更换保存目录或移走同名文件后继续');
      throw error;
    } finally { if (temporaryCreated) await rm(temporary, { force: true }).catch(() => {}); }
  }
  async resume(id, password = '') {
    const task = this.tasks.get(id); if (!task || task.state === 'completed') throw new Error('此任务无法继续');
    if (this.active.has(id)) throw new Error('任务已经在运行');
    task.concurrency = task.downloadKind === 'file' ? 1 : this.storage.settings[task.type === 'upload' ? 'uploadConcurrency' : 'downloadConcurrency'];
    if (password) task.password = password;
    return this.start(task, signal => task.type === 'upload' ? this.runUpload(task, signal) : this.runDownload(task, signal));
  }
  async exportManifest(id, destination) {
    const task = this.tasks.get(id); if (!task?.manifest) throw new Error('任务尚未生成正式清单');
    await atomicJSON(destination, task.manifest);
  }
}
