import { access, mkdir, readFile, writeFile, rename, readdir, lstat, rm, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const cacheFile = name => /^part-\d{6}\.zip(?:\.partial|\.verify|\.verify\.partial)?$/.test(name) || name === 'manifest.lanzou.txt' || name === 'slice-index.txt' || name === 'file-download.partial';
export const diskKey = filename => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);
export const isConcurrency = value => Number.isInteger(value) && value >= 1 && value <= 8;
export class LocalStorage {
  constructor(dataDir, downloadDir = path.join(dataDir, 'downloads')) {
    this.file = path.join(dataDir, 'settings.json');
    this.settings = { downloadDir, cacheDir: path.join(dataDir, 'cache'), autoCleanCache: true, uploadConcurrency: 2, downloadConcurrency: 4, browserView: 'smart' };
    this.queue = Promise.resolve();
  }
  async init() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      for (const key of ['downloadDir', 'cacheDir']) if (typeof saved[key] === 'string' && path.isAbsolute(saved[key])) this.settings[key] = saved[key];
      if (typeof saved.autoCleanCache === 'boolean') this.settings.autoCleanCache = saved.autoCleanCache;
      for (const key of ['uploadConcurrency', 'downloadConcurrency']) if (isConcurrency(saved[key])) this.settings[key] = saved[key];
      if (['raw', 'smart'].includes(saved.browserView)) this.settings.browserView = saved.browserView;
    } catch (error) { if (error.code !== 'ENOENT') this.warning = '设置文件无法读取，已使用默认目录；任务恢复记录仍保留。'; }
  }
  configure(patch) {
    const work = this.queue.catch(() => {}).then(async () => {
      const next = { ...this.settings };
      for (const key of Object.keys(patch)) {
        if (!['downloadDir', 'cacheDir', 'autoCleanCache', 'uploadConcurrency', 'downloadConcurrency', 'browserView'].includes(key)) throw new Error('未知设置');
        if (key === 'browserView') {
          if (!['raw', 'smart'].includes(patch[key])) throw new Error('网盘显示模式无效');
        } else if (['uploadConcurrency', 'downloadConcurrency'].includes(key)) {
          if (!isConcurrency(patch[key])) throw new Error('并发数必须为 1–8 的整数');
        } else if (key === 'autoCleanCache') {
          if (typeof patch[key] !== 'boolean') throw new Error('自动清理设置无效');
        } else {
          if (typeof patch[key] !== 'string' || !path.isAbsolute(patch[key])) throw new Error('目录必须为绝对路径');
          await mkdir(patch[key], { recursive: true });
          await access(patch[key], constants.W_OK);
        }
        next[key] = patch[key];
      }
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(next, null, 2));
      await rename(temp, this.file);
      this.settings = next; this.warning = ''; return { ...next };
    });
    this.queue = work; return work;
  }
  async allocate(id) {
    const directory = path.join(this.settings.cacheDir, id);
    // Exclusive creation avoids claiming or cleaning an existing user directory.
    await mkdir(this.settings.cacheDir, { recursive: true });
    await mkdir(directory);
    await writeFile(path.join(directory, '.lanzou-cache.json'), JSON.stringify({ format: 'lanzou-slice-cache', taskId: id }), { flag: 'wx' });
    return directory;
  }
  directory(task, taskDir) {
    return task.cachePath || (task.type === 'upload' ? taskDir : path.join(task.outputDir, `.lanzou-${task.manifest.taskId}`));
  }
  async files(task, taskDir) {
    const directory = this.directory(task, taskDir);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return [];
      if (task.cachePath) {
        if (path.basename(directory) !== task.id) return [];
        const marker = JSON.parse(await readFile(path.join(directory, '.lanzou-cache.json'), 'utf8'));
        if (marker.format !== 'lanzou-slice-cache' || marker.taskId !== task.id) return [];
      }
      const files = [];
      for (const name of await readdir(directory)) {
        if (!cacheFile(name)) continue;
        const filename = path.join(directory, name), info = await lstat(filename);
        if (info.isFile() && !info.isSymbolicLink()) files.push({ path: filename, bytes: info.size });
      }
      return files;
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return []; throw error; }
  }
  async clean(task, taskDir, protectedPaths = new Set(), protectedFiles = new Set()) {
    const directory = this.directory(task, taskDir);
    if (protectedPaths.has(diskKey(directory))) return { files: 0, bytes: 0 };
    const files = await this.files(task, taskDir); let bytes = 0, count = 0;
    for (const file of files) {
      if (protectedFiles.has(diskKey(file.path))) continue;
      try { await rm(file.path); bytes += file.bytes; count++; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Journals, unknown files and the cache ownership marker are never deleted here.
    return { files: count, bytes };
  }
  async retire(task, taskDir, protectedPaths) {
    const directory = this.directory(task, taskDir);
    if (protectedPaths.has(diskKey(directory)) || (await lstat(directory)).isSymbolicLink()) return;
    const entries = await readdir(directory);
    if (task.cachePath && path.basename(directory) === task.id && entries.length === 1 && entries[0] === '.lanzou-cache.json') {
      const markerPath = path.join(directory, entries[0]), marker = JSON.parse(await readFile(markerPath, 'utf8'));
      if (marker.format !== 'lanzou-slice-cache' || marker.taskId !== task.id) return;
      await rm(markerPath); await rmdir(directory);
    } else if (!task.cachePath && task.type === 'download' && entries.length === 0) await rmdir(directory);
  }
}
