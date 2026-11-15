import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, stat, rm, rename, readdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LanzouClient, challengeCookie, dataObjects, parseDisplaySize } from '../src/lanzou.mjs';
import { TransferEngine, planParts, validateManifest, MAX_PART_BYTES, ZIP_RESERVE, sha256, createPartZip, mergeArchives, downloadPart, safeName, localFileName } from '../src/transfer.mjs';
import { startMockLanzou } from './mock-lanzou.mjs';
import { createIndexName, parseIndexName, readSliceIndex } from '../src/slice-index.mjs';
import { FolderRecognition } from '../src/folder-recognition.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lanzou-slice-test-'));
  const mock = await startMockLanzou(options);
  const client = new LanzouClient({ pcOrigin: mock.origin, accountOrigin: mock.origin });
  const engine = new TransferEngine({ client, dataDir: path.join(dir, 'data'), maxPartBytes: 8192 }); await engine.init();
  t.after(async () => { await engine.pauseAll(); await mock.close(); await rm(dir, { recursive: true, force: true }); });
  await client.login('test', 'only-for-fixture');
  return { dir, mock, client, engine };
}
async function completed(engine, id) {
  const promise = engine.active.get(id)?.promise; if (promise) await promise;
  const task = engine.tasks.get(id); assert.equal(task.state, 'completed', task.error || task.message); return task;
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('等待传输状态超时'); await delay(5); }
}

test('warm and restarted recognition use zero child requests while download still validates the remote manifest', async t => {
  const { dir, engine, mock, client } = await fixture(t);
  const input = path.join(dir, '即时原名 &+💾.exe'); await writeFile(input, 'instant');
  const upload = await completed(engine, await engine.createUpload(input));
  const identify = async id => { const { index } = await engine.identifyFolder(id); return { status: 'preview', ...index }; };
  const dataDir = path.join(dir, 'recognition');
  const cache = new FolderRecognition({ dataDir, identify }); await cache.init();
  const folders = [{ id: upload.folderId, name: upload.folderName }];
  let before = mock.requests.length; await cache.scan(client.uid, folders); const cold = mock.requests.length - before;
  before = mock.requests.length; const warm = await cache.scan(client.uid, folders); const warmRequests = mock.requests.length - before;
  const recovered = new FolderRecognition({ dataDir, identify }); await recovered.init();
  before = mock.requests.length; await recovered.scan(client.uid, folders); const restart = mock.requests.length - before;
  assert.equal(warm[0].originalName, path.basename(input)); assert.equal(warm[0].key, undefined);
  assert.equal(cold, 3); assert.equal(warmRequests, 0); assert.equal(restart, 0);
  mock.files.delete(upload.manifestId);
  assert.equal(recovered.get(client.uid, upload.folderId).originalName, path.basename(input));
  await assert.rejects(() => engine.inspectFolder(upload.folderId), /尚无正式清单/);
  t.diagnostic(`INSTANT_RECOGNITION_REQUESTS ${JSON.stringify({ cold, warm: warmRequests, restart })}`);
});

test('empty and nested ordinary folders remain ordinary; incomplete slice folders cannot masquerade as normal', async t => {
  const { mock, engine } = await fixture(t, { directoryReply({ task, folderId }) {
    if (task === '47' && folderId === '888') return { zt: 1, text: [{ fol_id: '777', name: '普通子目录' }] };
  } });
  assert.deepEqual(await engine.identifyFolder('888'), { ordinary: true });
  mock.files.set('901', { id: '901', folderId: '888', name: '说明.txt', data: Buffer.from('normal') });
  assert.deepEqual(await engine.identifyFolder('888'), { ordinary: true });
  assert.deepEqual(await engine.identifyFolder('777'), { ordinary: true });
  mock.files.set('902', { id: '902', folderId: '888', name: 'part-000001.zip', data: Buffer.from('incomplete') });
  await assert.rejects(() => engine.identifyFolder('888'), /尚无正式清单/);
});

test('first directory page reads folders and files concurrently and preserves folder-first ordering', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const { client } = await fixture(t, { async directoryReply({ task }) {
    if (task === '47') { started(); await gate; return { zt: 1, text: [{ fol_id: '10', name: '目录' }] }; }
    if (task === '5') { release(); return { zt: 2, text: [{ id: '11', name: '文档.txt', size: 3 }] }; }
  } });
  const page = client.listPage('-1'); await ready;
  let timedOut = false;
  const fallback = setTimeout(() => { timedOut = true; release(); }, 1500);
  try { assert.deepEqual((await page).entries.map(entry => entry.name), ['目录', '文档.txt']); assert.equal(timedOut, false); }
  finally { clearTimeout(fallback); }
});

test('upload/download concurrency settings persist independently and reject invalid limits', async t => {
  const { engine, client } = await fixture(t);
  await Promise.all([engine.storage.configure({ uploadConcurrency: 3 }), engine.storage.configure({ downloadConcurrency: 5 })]);
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir }); await recovered.init();
  assert.equal(recovered.storage.settings.uploadConcurrency, 3); assert.equal(recovered.storage.settings.downloadConcurrency, 5);
  for (const key of ['uploadConcurrency', 'downloadConcurrency']) for (const value of [0, 9, -1, 1.5, '3', null]) await assert.rejects(() => recovered.storage.configure({ [key]: value }), /1–8/);
  assert.equal(recovered.storage.settings.uploadConcurrency, 3); assert.equal(recovered.storage.settings.downloadConcurrency, 5);
});

test('filename indexes preserve exact Unicode, validate checksums and bound decoding and name length', () => {
  for (const originalName of ['工具 [安装包] &+💾.exe', 'empty.bin', 'CON?.zip', '名'.repeat(250) + '.bin']) {
    const name = createIndexName({ originalName, originalSize: 0, parts: [{}] }, '987');
    assert.ok(name && name.length <= 240); assert.match(name, /^sliceindex1[a-f0-9]+\.txt$/);
    assert.deepEqual(parseIndexName(name), { originalName, originalSize: 0, totalParts: 1, manifestId: '987', indexName: name });
    assert.equal(parseIndexName(name.slice(0, -5) + (name.at(-5) === '0' ? '1' : '0') + '.txt'), null);
  }
  assert.equal(createIndexName({ originalName: randomBytes(200).toString('hex'), originalSize: 1, parts: [{}] }, '1'), null);
  assert.equal(parseIndexName(createIndexName({ originalName: 'a'.repeat(20000), originalSize: 1, parts: [{}] }, '1')), null);
  for (const value of [null, '', 'sliceindex1abcd.txt', '../manifest.lanzou.txt']) assert.equal(parseIndexName(value), null);
});

test('fast identification uses directory requests only without local history; full selection still reads the manifest', async t => {
  const { dir, mock, client, engine } = await fixture(t);
  const input = path.join(dir, '极速识别 &+💾.bin'); await writeFile(input, randomBytes(18000));
  const upload = await completed(engine, await engine.createUpload(input));
  assert.equal(mock.uploadOrder.at(-2), 'manifest.lanzou.txt'); assert.equal(mock.uploadOrder.at(-1), upload.indexName);
  const reader = new TransferEngine({ client, dataDir: path.join(dir, 'new-machine'), maxPartBytes: 8192 }); await reader.init();
  t.after(() => reader.pauseAll());
  const before = mock.requests.length;
  const result = await reader.identifyFolder(upload.folderId);
  const fastRequests = mock.requests.slice(before);
  assert.equal(result.index.originalName, path.basename(input)); assert.equal(result.bundle, undefined);
  assert.ok(fastRequests.length > 0 && fastRequests.every(request => request.path === '/doupload.php'));
  const fullBefore = mock.requests.length;
  const bundle = await reader.inspectFolder(upload.folderId);
  const fullRequests = mock.requests.slice(fullBefore);
  assert.ok(fullRequests.length > fastRequests.length); assert.ok(fullRequests.some(request => request.path === `/file/${upload.manifestId}`));
  t.diagnostic(`FAST_INDEX_REQUESTS ${JSON.stringify({ fast: fastRequests.length, full: fullRequests.length, fastManifestDownloads: 0, fullManifestDownloads: fullRequests.filter(request => request.path === `/file/${upload.manifestId}` && request.method === 'GET').length })}`);
  assert.deepEqual(bundle.indexNames, [upload.indexName]);
  const download = await completed(reader, await reader.createDownload(bundle));
  assert.equal(await sha256(download.resultPath), await sha256(input));
});

test('missing, damaged, duplicate and stale indexes fall back to the authoritative legacy manifest', async t => {
  const { dir, mock, engine } = await fixture(t);
  const input = path.join(dir, '兼容.bin'); await writeFile(input, 'legacy');
  const upload = await completed(engine, await engine.createUpload(input));
  const marker = mock.files.get(upload.indexId);
  const fallback = async () => {
    const before = mock.requests.length, result = await engine.identifyFolder(upload.folderId);
    assert.equal(result.index, undefined); assert.equal(result.bundle.manifest.originalName, path.basename(input));
    assert.ok(mock.requests.slice(before).some(request => request.path === `/file/${upload.manifestId}`));
  };
  mock.files.delete(upload.indexId); await fallback(); mock.files.set(upload.indexId, marker);
  const original = marker.name; marker.name = 'sliceindex1broken.txt'; await fallback(); marker.name = original;
  mock.files.set('99999', { ...marker, id: '99999' }); await fallback(); mock.files.delete('99999');
  marker.name = createIndexName(upload.manifest, '999999'); await fallback(); marker.name = original;
  const part = mock.files.get(upload.manifest.parts[0].remoteId); mock.files.delete(part.id);
  await assert.rejects(() => engine.identifyFolder(upload.folderId), /切片缺失/); mock.files.set(part.id, part);
  mock.files.delete(upload.manifestId); await assert.rejects(() => engine.identifyFolder(upload.folderId), /尚无正式清单/);
});

test('forged display hints cannot supply a download identity or bypass full manifest validation', async t => {
  const { dir, mock, engine } = await fixture(t);
  const input = path.join(dir, '真实名称.bin'); await writeFile(input, 'authoritative');
  const upload = await completed(engine, await engine.createUpload(input));
  mock.files.get(upload.indexId).name = createIndexName({ ...upload.manifest, originalName: '伪造名称.exe', originalSize: 999 }, upload.manifestId);
  assert.equal((await engine.identifyFolder(upload.folderId)).index.originalName, '伪造名称.exe');
  const bundle = await engine.inspectFolder(upload.folderId);
  assert.equal(bundle.manifest.originalName, path.basename(input)); assert.deepEqual(bundle.indexNames, []);
  mock.files.get(upload.manifestId).data = Buffer.from('{broken');
  await assert.rejects(() => engine.inspectFolder(upload.folderId), /清单无法读取/);
});

test('index publication failure keeps the committed file downloadable and does not publish before the manifest', async t => {
  const { dir, mock, client, engine } = await fixture(t);
  const input = path.join(dir, 'index-failure.bin'); await writeFile(input, 'index failure');
  const original = client.upload.bind(client);
  client.upload = async (...args) => {
    if (args[1].startsWith('sliceindex1')) { assert.equal(mock.uploads.get('manifest.lanzou.txt'), 1); throw new Error('索引上传失败（测试）'); }
    return original(...args);
  };
  const upload = await completed(engine, await engine.createUpload(input));
  assert.match(upload.indexWarning, /快速索引未确认/); assert.equal(upload.indexId, undefined);
  const result = await engine.identifyFolder(upload.folderId); assert.ok(result.bundle);
  const download = await completed(engine, await engine.createDownload(result.bundle));
  assert.equal(await sha256(download.resultPath), await sha256(input));
});

test('an index acknowledgement lost during pause is reused on restart without reuploading committed files', async t => {
  const { dir, mock, client, engine } = await fixture(t);
  const input = path.join(dir, 'index-resume.bin'); await writeFile(input, 'resume index');
  const original = client.upload.bind(client); let interrupted = false;
  client.upload = async (...args) => {
    const id = await original(...args);
    if (!interrupted && args[1].startsWith('sliceindex1')) {
      interrupted = true; const controller = [...engine.active.values()][0]; controller.abort(); throw controller.signal.reason;
    }
    return id;
  };
  const id = await engine.createUpload(input); await engine.active.get(id)?.promise;
  assert.equal(engine.tasks.get(id).state, 'paused');
  client.upload = original;
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir, maxPartBytes: 8192 }); await recovered.init(); t.after(() => recovered.pauseAll());
  const upload = await completed(recovered, await recovered.resume(id));
  assert.equal(mock.folders.size, 1); assert.equal(mock.uploads.get(upload.indexName), 1); assert.equal(mock.uploads.get('manifest.lanzou.txt'), 1);
  assert.equal(mock.uploads.get('part-000001.zip'), 1); assert.ok((await recovered.identifyFolder(upload.folderId)).index);
});

test('empty uploads have one indexed part and metadata-only markers never identify unfinished or duplicate files', async t => {
  const { dir, mock, engine } = await fixture(t);
  const input = path.join(dir, 'empty.bin'); await writeFile(input, '');
  const upload = await completed(engine, await engine.createUpload(input));
  const files = [...mock.files.values()]; assert.equal(readSliceIndex(files).totalParts, 1); assert.equal(readSliceIndex(files).originalSize, 0);
  assert.equal(readSliceIndex(files.filter(file => file.name !== 'manifest.lanzou.txt')), null);
  const part = files.find(file => file.name === 'part-000001.zip'); assert.equal(readSliceIndex([...files, { ...part, id: '99999' }]), null);
  const download = await completed(engine, await engine.createDownload(await engine.inspectFolder(upload.folderId)));
  assert.equal((await stat(download.resultPath)).size, 0);
});

test('long incompressible names skip the optional index and retain exact manifest download names', async t => {
  const { dir, engine, mock } = await fixture(t);
  const name = randomBytes(100).toString('hex') + '.bin';
  assert.equal(createIndexName({ originalName: name, originalSize: 4, parts: [{}] }, '12'), null);
  const input = path.join(dir, name); await writeFile(input, 'long');
  const upload = await completed(engine, await engine.createUpload(input));
  assert.match(upload.indexWarning, /长度限制/); assert.equal(upload.indexId, undefined);
  assert.equal(mock.uploadOrder.at(-1), 'manifest.lanzou.txt');
  const { bundle } = await engine.identifyFolder(upload.folderId); assert.equal(bundle.manifest.originalName, name);
  const download = await completed(engine, await engine.createDownload(bundle));
  assert.equal(path.basename(download.resultPath), name); assert.equal(await readFile(download.resultPath, 'utf8'), 'long');
});

test('legacy or invalid persisted concurrency settings use safe defaults', async t => {
  const { engine, client } = await fixture(t);
  await writeFile(path.join(engine.dataDir, 'settings.json'), JSON.stringify({ autoCleanCache: false, uploadConcurrency: 99, downloadConcurrency: '4' }));
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir }); await recovered.init();
  assert.equal(recovered.storage.settings.autoCleanCache, false);
  assert.equal(recovered.storage.settings.uploadConcurrency, 2); assert.equal(recovered.storage.settings.downloadConcurrency, 4);
});

test('browser display modes persist independently and old settings default to smart recognition', async t => {
  const { engine, client } = await fixture(t);
  assert.equal(engine.storage.settings.browserView, 'smart');
  await engine.storage.configure({ browserView: 'raw' });
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir }); await recovered.init();
  assert.equal(recovered.storage.settings.browserView, 'raw');
  await assert.rejects(() => recovered.storage.configure({ browserView: 'unknown' }), /显示模式/);
  await writeFile(recovered.storage.file, JSON.stringify({ browserView: 'invalid', uploadConcurrency: 3 }));
  const legacy = new TransferEngine({ client, dataDir: engine.dataDir }); await legacy.init();
  assert.equal(legacy.storage.settings.browserView, 'smart'); assert.equal(legacy.storage.settings.uploadConcurrency, 3);
});

test('real multipart uploads obey the configured limit, commit out of order, then publish one ordered manifest', async t => {
  // Two 4 KiB blocks must overlap long enough to measure both configured workers.
  const { dir, engine, mock } = await fixture(t, { uploadDelay: name => name === 'part-000001.zip' ? 140 : 35, slowDownloads: 40 });
  await engine.storage.configure({ uploadConcurrency: 3, downloadConcurrency: 2 });
  const input = path.join(dir, '三路并发 &+.bin'); await writeFile(input, randomBytes(55000));
  const progress = []; engine.on('change', tasks => { const task = tasks.find(task => task.type === 'upload'); if (task?.phase === 'uploading') progress.push({ bytes: task.bytes, total: task.totalBytes }); });
  const upload = await completed(engine, await engine.createUpload(input));
  assert.equal(upload.concurrency, 3); assert.equal(mock.maxUploads, 3);
  assert.notEqual(mock.uploadOrder[0], 'part-000001.zip'); assert.equal(mock.uploadOrder.at(-2), 'manifest.lanzou.txt'); assert.equal(mock.uploadOrder.at(-1), upload.indexName);
  assert.ok(progress.length && progress.every(item => item.bytes >= 0 && item.bytes <= item.total));
  for (const [index, part] of upload.manifest.parts.entries()) {
    assert.equal(part.index, index); assert.equal(mock.uploads.get(part.name), 1);
    assert.equal(mock.files.get(part.remoteId).name, part.name);
  }
  assert.equal(mock.uploads.get('manifest.lanzou.txt'), 1);
  const download = await completed(engine, await engine.createDownload(await engine.inspectFolder(upload.folderId)));
  assert.equal(download.concurrency, 2); assert.equal(mock.maxDownloads, 2);
  assert.equal(await sha256(input), await sha256(download.resultPath));
});

test('pausing parallel upload drains all workers and resume adopts the new limit without repeating receipts', async t => {
  const { dir, engine, mock, client } = await fixture(t, { uploadDelay: name => name === 'part-000001.zip' ? 15 : 220 });
  await engine.storage.configure({ uploadConcurrency: 3 });
  const input = path.join(dir, 'parallel-pause.bin'); await writeFile(input, randomBytes(55000));
  const id = await engine.createUpload(input), task = engine.tasks.get(id);
  await until(() => task.receipts[0]?.remoteId && mock.activeUploads >= 2);
  await engine.pause(id); await until(() => mock.activeUploads === 0);
  assert.equal(task.state, 'paused'); assert.equal(engine.active.size, 0); assert.equal(mock.uploads.get('manifest.lanzou.txt'), undefined);
  const confirmed = Object.values(task.receipts).filter(part => part.remoteId).map(part => part.name); assert.ok(confirmed.length);
  await engine.storage.configure({ uploadConcurrency: 1 }); mock.resetUploadPeak();
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir, maxPartBytes: 8192 }); await recovered.init();
  const upload = await completed(recovered, await recovered.resume(id));
  assert.equal(upload.concurrency, 1); assert.equal(mock.maxUploads, 1);
  for (const name of confirmed) assert.equal(mock.uploads.get(name), 1);
  assert.equal(mock.folders.size, 1); assert.equal(mock.uploads.get('manifest.lanzou.txt'), 1);
});

test('a fatal parallel upload error cancels sibling workers and never publishes an incomplete manifest', async t => {
  const { dir, engine, mock, client } = await fixture(t, { uploadDelay: 120 });
  await engine.storage.configure({ uploadConcurrency: 3 });
  const input = path.join(dir, 'parallel-failure.bin'); await writeFile(input, randomBytes(40000));
  const original = client.upload.bind(client); let active = 0;
  client.upload = async (...args) => {
    active++;
    try {
      if (args[1] === 'part-000002.zip') { await until(() => mock.activeUploads > 0); const error = new Error('离线测试：需要验证'); error.code = 'VERIFY_REQUIRED'; throw error; }
      return await original(...args);
    } finally { active--; }
  };
  const id = await engine.createUpload(input); await engine.active.get(id)?.promise;
  assert.equal(active, 0); assert.equal(engine.active.size, 0); assert.equal(engine.tasks.get(id).state, 'failed');
  assert.match(engine.tasks.get(id).error, /需要验证/); assert.equal(mock.uploads.get('manifest.lanzou.txt'), undefined);
  assert.equal([...mock.uploads.keys()].some(name => name.startsWith('sliceindex1')), false);
  await until(() => mock.activeUploads === 0); client.upload = original;
  const upload = await completed(engine, await engine.resume(id)); assert.equal(mock.uploads.get('manifest.lanzou.txt'), 1);
  const download = await completed(engine, await engine.createDownload(await engine.inspectFolder(upload.folderId)));
  assert.equal(await sha256(download.resultPath), await sha256(input));
});

test('running transfers retain their captured limit and download resume uses the saved default', async t => {
  const { dir, engine, mock, client } = await fixture(t, { uploadDelay: 65 });
  await engine.storage.configure({ uploadConcurrency: 2, downloadConcurrency: 2 });
  const input = path.join(dir, 'captured-concurrency.bin'); await writeFile(input, randomBytes(30000));
  const id = await engine.createUpload(input); await until(() => mock.activeUploads === 2);
  await engine.storage.configure({ uploadConcurrency: 1, downloadConcurrency: 3 });
  assert.equal(engine.tasks.get(id).concurrency, 2);
  const upload = await completed(engine, id); assert.equal(upload.concurrency, 2); assert.equal(mock.maxUploads, 2);
  const bundle = await engine.inspectFolder(upload.folderId);
  await assert.rejects(() => engine.createDownload(bundle, dir, 9), /1–8/);
  const downloadId = await engine.createDownload(bundle, dir); await engine.active.get(downloadId)?.promise;
  const task = engine.tasks.get(downloadId); assert.equal(task.state, 'failed'); assert.equal(task.concurrency, 3);
  task.outputDir = path.join(dir, 'resumed'); delete task.concurrency; await engine.persist(task);
  await engine.storage.configure({ downloadConcurrency: 1 });
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir }); await recovered.init();
  const download = await completed(recovered, await recovered.resume(downloadId));
  assert.equal(download.concurrency, 1); assert.equal(await sha256(download.resultPath), await sha256(input));
});

test('download/cache directories and auto-clean settings persist with serialized updates', async t => {
  const { dir, engine, client } = await fixture(t);
  const downloadDir = path.join(dir, '下载 [中文] &+'), cacheDir = path.join(dir, '缓存', 'LanzouSliceCache');
  await Promise.all([engine.storage.configure({ downloadDir }), engine.storage.configure({ cacheDir, autoCleanCache: false })]);
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir }); await recovered.init();
  assert.deepEqual(recovered.storage.settings, { downloadDir, cacheDir, autoCleanCache: false, uploadConcurrency: 2, downloadConcurrency: 4, browserView: 'smart' });
  await assert.rejects(() => recovered.storage.configure({ cacheDir: '../unsafe' }), /绝对路径/);
  await assert.rejects(() => recovered.storage.configure({ autoCleanCache: 'yes' }), /无效/);
  assert.deepEqual(recovered.storage.settings, engine.storage.settings);
});

test('a fresh task history reads the original cloud name and downloads without a share link or code', async t => {
  const { dir, engine, client, mock } = await fixture(t);
  const input = path.join(dir, '真正原名 [正式] &+💾.exe'); await writeFile(input, randomBytes(15000));
  const upload = await completed(engine, await engine.createUpload(input));
  await engine.clearHistory();
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir }); await recovered.init();
  assert.equal(recovered.tasks.size, 0);
  const folder = (await client.list('-1')).find(file => file.isFolder);
  assert.equal(folder.name, upload.folderName);
  const bundle = await recovered.inspectFolder(folder.id);
  assert.equal(bundle.manifest.originalName, path.basename(input));
  const before = mock.requests.length;
  const download = await completed(recovered, await recovered.createDownload(bundle));
  assert.equal(path.dirname(download.resultPath), recovered.storage.settings.downloadDir);
  assert.equal(await sha256(download.resultPath), await sha256(input));
  assert.ok(!mock.requests.slice(before).some(request => request.path.startsWith('/folder') || request.path === '/filemoreajax.php'));
});

test('manual cache and history cleanup preserve unfinished tasks, originals, results, credentials and unknown files', async t => {
  const { dir, engine, client } = await fixture(t);
  await engine.storage.configure({ autoCleanCache: false });
  const input = path.join(dir, '保留原文件.bin'); await writeFile(input, randomBytes(15000));
  const upload = await completed(engine, await engine.createUpload(input));
  const download = await completed(engine, await engine.createDownload(await engine.inspectFolder(upload.folderId)));
  const credential = path.join(engine.dataDir, 'session.bin'); await writeFile(credential, 'keep encrypted session');
  const unknown = path.join(download.cachePath, '用户笔记.txt'); await writeFile(unknown, 'keep unknown');
  const create = client.createFolder.bind(client); client.createFolder = async () => { throw new Error('offline test'); };
  const failedId = await engine.createUpload(input); await engine.active.get(failedId)?.promise; client.createFolder = create;
  const failed = engine.tasks.get(failedId); assert.equal(failed.state, 'failed');
  const recovery = path.join(failed.cachePath, 'part-000001.zip.partial'); await writeFile(recovery, 'keep recovery');
  // Also protect an actual source/result path even if its basename resembles a cache file.
  const protectedOriginal = path.join(upload.cachePath, 'part-999999.zip'); await writeFile(protectedOriginal, 'keep original');
  failed.sourcePath = protectedOriginal; await engine.persist(failed);
  const info = await engine.cacheInfo(); assert.ok(info.cleanableBytes > 15000); assert.ok(info.protectedBytes > 0);
  const cleaned = await engine.cleanCache(); assert.ok(cleaned.files >= 3); assert.ok(cleaned.bytes > 15000);
  assert.equal(await readFile(recovery, 'utf8'), 'keep recovery');
  assert.equal(await readFile(protectedOriginal, 'utf8'), 'keep original');
  assert.equal(await readFile(unknown, 'utf8'), 'keep unknown');
  assert.equal(await readFile(credential, 'utf8'), 'keep encrypted session');
  assert.equal(await sha256(download.resultPath), await sha256(input));
  assert.deepEqual(await engine.clearHistory(), { removed: 2, retained: 1 });
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir }); await recovered.init();
  assert.deepEqual([...recovered.tasks.keys()], [failedId]);
  assert.equal(await readFile(recovery, 'utf8'), 'keep recovery');
  assert.equal(await sha256(download.resultPath), await sha256(input));
});

test('all history cleanup removes completed and failed journals but protects paused, running, originals and results', async t => {
  const { dir, engine, client } = await fixture(t);
  await engine.storage.configure({ autoCleanCache: false });
  const input = path.join(dir, 'all-history.bin'); await writeFile(input, randomBytes(9000));
  const upload = await completed(engine, await engine.createUpload(input));
  const download = await completed(engine, await engine.createDownload(await engine.inspectFolder(upload.folderId)));
  const original = client.createFolder.bind(client); client.createFolder = async () => { throw new Error('failed history fixture'); };
  const failedId = await engine.createUpload(input); await engine.active.get(failedId)?.promise;
  const pausedId = await engine.createUpload(input); await engine.active.get(pausedId)?.promise;
  client.createFolder = original;
  const failed = engine.tasks.get(failedId), paused = engine.tasks.get(pausedId); paused.state = 'paused'; await engine.persist(paused);
  const failedCache = path.join(failed.cachePath, 'part-000001.zip.partial'), pausedCache = path.join(paused.cachePath, 'part-000001.zip.partial');
  await writeFile(failedCache, 'remove failed cache'); await writeFile(pausedCache, 'keep paused cache');
  const unknown = path.join(failed.cachePath, '用户笔记.txt'); await writeFile(unknown, 'keep unknown');
  const runningId = randomUUID(), cachePath = await engine.storage.allocate(runningId);
  const running = { id: runningId, type: 'upload', state: 'running', cachePath, sourcePath: input }; engine.tasks.set(runningId, running); engine.active.set(runningId, new AbortController()); await engine.persist(running);
  assert.deepEqual(await engine.clearHistory({ scope: 'all' }), { removed: 3, retained: 2 });
  engine.active.delete(runningId); running.state = 'paused'; await engine.persist(running);
  await assert.rejects(() => stat(failedCache), { code: 'ENOENT' }); assert.equal(await readFile(pausedCache, 'utf8'), 'keep paused cache');
  assert.equal(await readFile(unknown, 'utf8'), 'keep unknown'); assert.equal(await sha256(download.resultPath), await sha256(input));
  const reader = new TransferEngine({ client, dataDir: engine.dataDir }); await reader.init();
  assert.deepEqual(new Set(reader.tasks.keys()), new Set([pausedId, runningId]));
  assert.ok(!engine.tasks.has(upload.id));
});

test('single history removal validates scope and protects other records and resume during cleanup', async t => {
  const { dir, engine } = await fixture(t);
  const input = path.join(dir, 'single-record.bin'); await writeFile(input, 'history');
  const upload = await completed(engine, await engine.createUpload(input));
  const download = await completed(engine, await engine.createDownload(await engine.inspectFolder(upload.folderId)));
  for (const options of [{ scope: 'unknown' }, { id: '../tasks' }]) await assert.rejects(() => engine.clearHistory(options), /清理参数/);
  engine.clearingHistory = true;
  await assert.rejects(() => engine.createUpload(input), /正在清理/);
  await assert.rejects(() => engine.createDownload({ manifest: upload.manifest }), /正在清理/);
  engine.clearingHistory = false;
  assert.deepEqual(await engine.clearHistory({ scope: 'all', id: upload.id }), { removed: 1, retained: 1 });
  assert.ok(engine.tasks.has(download.id)); assert.equal(await sha256(download.resultPath), await sha256(input));
});

test('transfer elapsed time persists across pause and restart while stopped time is excluded', async t => {
  const { dir, engine, mock, client } = await fixture(t, { uploadDelay: 700 });
  const input = path.join(dir, 'elapsed.bin'); await writeFile(input, randomBytes(16000));
  let updates = 0; engine.on('change', () => updates++);
  const id = await engine.createUpload(input); await until(() => mock.activeUploads > 0); await delay(550); await engine.pause(id);
  const stopped = engine.publicTasks().find(task => task.id === id);
  assert.ok(stopped.elapsedMs >= 500); assert.equal(stopped.speedBytesPerSecond, 0); assert.equal(stopped.remainingSeconds, null); assert.ok(updates >= 2);
  assert.equal(engine.tick, null); await delay(80); assert.equal(engine.publicTasks().find(task => task.id === id).elapsedMs, stopped.elapsedMs);
  const reader = new TransferEngine({ client, dataDir: engine.dataDir, maxPartBytes: 8192 }); await reader.init(); t.after(() => reader.pauseAll());
  assert.equal(reader.publicTasks()[0].elapsedMs, stopped.elapsedMs);
  const result = await completed(reader, await reader.resume(id)); assert.ok(result.elapsedMs > stopped.elapsedMs);
  assert.equal(reader.publicTasks()[0].speedBytesPerSecond, 0); assert.equal(reader.tick, null);
});

test('download traffic counters exclude validated cached bytes and count only resumed HTTP body bytes', async t => {
  const { dir, engine, client } = await fixture(t);
  const input = path.join(dir, 'traffic.bin'); await writeFile(input, randomBytes(9000));
  const upload = await completed(engine, await engine.createUpload(input)); const part = upload.manifest.parts[0];
  const destination = path.join(dir, 'traffic.zip'); let bytes = 0;
  const getLink = () => client.downloadLink({ id: part.remoteId, name: part.name });
  await downloadPart(client, getLink, destination, part, { onTraffic: value => { bytes += value; } }); assert.equal(bytes, part.uploadSize);
  bytes = 0; await downloadPart(client, getLink, destination, part, { onTraffic: value => { bytes += value; } }); assert.equal(bytes, 0);
  const data = await readFile(destination); await rm(destination); await writeFile(`${destination}.partial`, data.subarray(0, 123));
  await downloadPart(client, getLink, destination, part, { onTraffic: value => { bytes += value; } }); assert.equal(bytes, part.uploadSize - 123);
});

test('auto cleanup runs on completion and startup but preserves failed recovery data', async t => {
  const { dir, engine, client } = await fixture(t);
  const input = path.join(dir, 'auto.bin'); await writeFile(input, randomBytes(12000));
  const upload = await completed(engine, await engine.createUpload(input));
  assert.equal((await engine.storage.files(upload, engine.taskDir(upload.id))).length, 0);
  const download = await completed(engine, await engine.createDownload(await engine.inspectFolder(upload.folderId)));
  assert.equal((await engine.storage.files(download, engine.taskDir(download.id))).length, 0);
  await writeFile(path.join(download.cachePath, 'part-000001.zip.partial'), 'completed residue');
  upload.state = 'failed'; await engine.persist(upload);
  const recovery = path.join(upload.cachePath, 'part-000001.zip.partial'); await writeFile(recovery, 'unfinished');
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir }); await recovered.init();
  await assert.rejects(() => stat(path.join(download.cachePath, 'part-000001.zip.partial')), { code: 'ENOENT' });
  assert.equal(await readFile(recovery, 'utf8'), 'unfinished');
  assert.equal(await sha256(download.resultPath), await sha256(input));
});

test('changing cache directory leaves paused tasks resumable at the old location and isolates new tasks', async t => {
  const { dir, engine, client } = await fixture(t);
  const input = path.join(dir, 'cache-change.bin'); await writeFile(input, randomBytes(14000));
  const original = client.createFolder.bind(client); client.createFolder = async () => { throw new Error('paused fixture'); };
  const id = await engine.createUpload(input); await engine.active.get(id)?.promise; client.createFolder = original;
  const oldPath = engine.tasks.get(id).cachePath;
  engine.tasks.get(id).state = 'paused'; await engine.persist(engine.tasks.get(id));
  const cacheDir = path.join(dir, 'new-cache', 'LanzouSliceCache'); await engine.storage.configure({ cacheDir });
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir, maxPartBytes: 8192 }); await recovered.init();
  const upload = await completed(recovered, await recovered.resume(id)); assert.equal(upload.cachePath, oldPath);
  const next = await completed(recovered, await recovered.createDownload(await recovered.inspectFolder(upload.folderId)));
  assert.equal(path.dirname(next.cachePath), cacheDir); assert.notEqual(next.cachePath, oldPath);
  assert.equal(await sha256(next.resultPath), await sha256(input));
});

test('legacy journals retain their old upload and download cache paths during cleanup and recovery', async t => {
  const { dir, engine, client } = await fixture(t);
  await engine.storage.configure({ autoCleanCache: false });
  const input = path.join(dir, 'legacy-cache.bin'); await writeFile(input, randomBytes(12000));
  const upload = await completed(engine, await engine.createUpload(input));
  const download = await completed(engine, await engine.createDownload(await engine.inspectFolder(upload.folderId)));
  const legacy = path.join(download.outputDir, `.lanzou-${download.manifest.taskId}`); await mkdir(legacy);
  for (const file of await engine.storage.files(download, engine.taskDir(download.id))) await rename(file.path, path.join(legacy, path.basename(file.path)));
  delete download.cachePath; download.state = 'paused'; await engine.persist(download); await rm(download.resultPath);
  const oldUploadCache = path.join(engine.taskDir(upload.id), 'part-000001.zip.partial'); await writeFile(oldUploadCache, 'old completed residue');
  delete upload.cachePath; await engine.persist(upload);
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir }); await recovered.init();
  await recovered.cleanCache(); await assert.rejects(() => stat(oldUploadCache), { code: 'ENOENT' });
  assert.ok((await readdir(legacy)).some(name => name.endsWith('.zip')));
  const result = await completed(recovered, await recovered.resume(download.id));
  assert.equal(await sha256(result.resultPath), await sha256(input));
});

test('cache cleanup ignores unowned directories and directory junctions', async t => {
  const { dir, engine } = await fixture(t);
  await engine.storage.configure({ autoCleanCache: false });
  const input = path.join(dir, 'ownership.bin'); await writeFile(input, 'content');
  const upload = await completed(engine, await engine.createUpload(input));
  const marker = path.join(upload.cachePath, '.lanzou-cache.json'); await rm(marker);
  const unknown = path.join(upload.cachePath, 'part-000001.zip'); await writeFile(unknown, 'not owned');
  await engine.cleanCache(); assert.equal(await readFile(unknown, 'utf8'), 'not owned');
  const external = path.join(dir, 'user-files'); await mkdir(external); await writeFile(path.join(external, 'manifest.lanzou.txt'), 'keep external');
  const junction = path.join(dir, upload.id); await symlink(external, junction, process.platform === 'win32' ? 'junction' : 'dir');
  upload.cachePath = junction; await engine.cleanCache();
  assert.equal(await readFile(path.join(external, 'manifest.lanzou.txt'), 'utf8'), 'keep external');
});

test('account tasks cannot resume against a different signed-in account', async t => {
  const { dir, engine, client } = await fixture(t);
  const input = path.join(dir, 'account.bin'); await writeFile(input, 'owner');
  const upload = await completed(engine, await engine.createUpload(input));
  const bundle = await engine.inspectFolder(upload.folderId);
  const id = await engine.createDownload(bundle, dir); await engine.active.get(id)?.promise;
  const task = engine.tasks.get(id); assert.equal(task.state, 'failed'); // Existing source is protected.
  client.uid = 'different'; await engine.resume(id); await engine.active.get(id)?.promise;
  assert.match(task.error, /创建此任务的蓝奏云账号/);
});

test('80 MiB boundaries reserve container overhead, including empty files', () => {
  const payload = MAX_PART_BYTES - ZIP_RESERVE;
  assert.deepEqual(planParts(0).map(p => p.payloadSize), [0]);
  assert.deepEqual(planParts(payload).map(p => p.payloadSize), [payload]);
  assert.deepEqual(planParts(payload + 1).map(p => p.payloadSize), [payload,1]);
  assert.equal(planParts(160 * 1024 * 1024 + 1).length, 3);
  assert.throws(() => planParts(-1));
  for (const name of ['../x','CON.txt','file.','a/b','a\\b']) assert.throws(() => safeName(name));
});
test('ported download object parser resolves variables without executing scripts', () => {
  assert.deepEqual(dataObjects("var sign='abc';var key='xyz';data:{action:'downprocess',sign:sign,websignkey:key,kd:1}"), [{ action:'downprocess',sign:'abc',websignkey:'xyz',kd:'1' }]);
  // An all-zero input stays zero after permutation, so XOR must equal the upstream mask.
  assert.equal(challengeCookie("arg1='0000000000000000000000000000000000000000'"), '3000176000856006061501533003690027800375');
});

test('download data parser supports quoted data keys, aliases, escaped strings and encoded forms without evaluating code', () => {
  const scope = String.raw`var prefix='si';const $token=prefix+'gned';let key='k\x65\u0079';`;
  for (const template of [
    `'data':{'action':'downprocess','sign':$token,'websignkey':key}`,
    `const requestData={action:'downprocess',sign:($token),websignkey:key};"data":requestData`,
    `data:'action=downprocess&sign=signed&websignkey=key'`
  ]) assert.deepEqual(dataObjects(scope + template), [{ action:'downprocess', sign:'signed', websignkey:'key' }]);
  assert.deepEqual(dataObjects("data:{action:'downprocess',sign:process.exit(),websignkey:'key'}"), [{ action:'downprocess', websignkey:'key' }]);
  assert.deepEqual(dataObjects("var a=b;var b=a;data:{action:'downprocess',sign:a}"), [{ action:'downprocess' }]);
});

test('quoted, aliased and form download templates read real remote manifests and merge without local upload history', async t => {
  let template = 'quoted';
  const { dir, engine, client, mock } = await fixture(t, { pageReply({ url }) {
    const id = url.pathname.match(/^\/i(\d+)$/)?.[1]; if (!id) return;
    const data = template === 'quoted' ? `'data':{'action':'downprocess','sign':$token,'websignkey':key}`
      : template === 'alias' ? `data:requestData` : `data:'action=downprocess&sign=signed&websignkey=key'`;
    return String.raw`<script>var prefix='si';const $token=prefix+'gned';let key='k\x65y';const requestData={action:'downprocess',sign:$token,websignkey:key};$.ajax({url:'/ajaxm.php?file=${id}',${data}});</script>`;
  } });
  const input = path.join(dir, '真实名称 [安装包] &+.bin'); await writeFile(input, randomBytes(18000));
  const upload = await completed(engine, await engine.createUpload(input));
  const recovered = new TransferEngine({ client, dataDir: path.join(dir, 'fresh-account'), maxPartBytes:8192 }); await recovered.init();
  for (template of ['quoted','alias','form']) {
    const bundle = await recovered.inspectFolder(upload.folderId);
    assert.equal(bundle.manifest.originalName, path.basename(input)); assert.equal(bundle.manifest.sha256, await sha256(input));
    const result = await completed(recovered, await recovered.createDownload(bundle, path.join(dir, template)));
    assert.deepEqual(await readFile(result.resultPath), await readFile(input));
  }
  assert.ok(mock.requests.filter(request => request.path === '/ajaxm.php').length > 6);
});

test('download follows final landing URL and relevant nested same-origin iframes with correct relative endpoint and referer', async t => {
  const { client, mock } = await fixture(t, { pageReply({ url, fields, headers }) {
    if (url.pathname === '/i900') return { redirect:'/landing/member?file=900' };
    if (url.pathname === '/landing/member') return `<iframe src="https://ads.invalid/frame"></iframe><iframe id="fn" src="../fn/outer?file=900&amp;token=ok"></iframe>`;
    if (url.pathname === '/fn/outer') { assert.equal(url.searchParams.get('token'), 'ok'); return `<iframe id='download' src='inner?file=900'></iframe>`; }
    if (url.pathname === '/fn/inner') return `<script>var token='signed';var key='key';$.ajax({url:'../ajaxm.php?file=900',"data":{action:'downprocess',sign:token,websignkey:key}});</script>`;
    if (url.pathname === '/ajaxm.php') { assert.equal(fields.get('sign'), 'signed'); assert.match(headers.referer, /\/fn\/inner\?file=900$/); }
  } });
  mock.files.set('900', { id:'900', name:'manifest.lanzou.txt', folderId:'-1', data:Buffer.from('test') });
  const landing = await client.sharePage(`${mock.origin}/i900`); assert.equal(landing.url, `${mock.origin}/landing/member?file=900`);
  const link = await client.downloadLink({ id:'900' }); assert.equal(link.url, `${mock.origin}/file/900`);
  assert.ok(!mock.requests.some(request => request.path === '/frame'));
});

test('download refuses unsupported executable signatures, verification pages and foreign download frames without empty posts', async t => {
  let html = `<script>var key='key';$.ajax({url:'/ajaxm.php?file=900',data:{action:'downprocess',sign:process.exit(),websignkey:key}});</script>`;
  const { client, mock } = await fixture(t, { pageReply({ url }) { if (url.pathname === '/i900') return html; } });
  await assert.rejects(() => client.downloadLink({ id:'900' }), error => error.code === 'DOWNLOAD_PARAMS');
  html = `<p>请完成人机验证</p><iframe src='/captcha'></iframe>`;
  await assert.rejects(() => client.downloadLink({ id:'900' }), error => error.code === 'VERIFY_REQUIRED');
  html = `<iframe id='download' src='https://unknown.invalid/fn?file=900'></iframe>`;
  await assert.rejects(() => client.downloadLink({ id:'900' }), /来源异常/);
  assert.ok(!mock.requests.some(request => request.path === '/ajaxm.php' || request.path === '/captcha'));
});

test('YunX directory reading normalizes folders, files, size and time while first-page loading stays bounded', async t => {
  const calls = [];
  const { client } = await fixture(t, { directoryReply({ task, folderId, page }) {
    calls.push({ task, folderId, page });
    if (task === '47') return { zt:1, text:[null, {}, {fol_id:' ', id:'901', name:' ', name_all:'目录 &+'}, {fol_id:'901', name:'duplicate'}] };
    if (page === 1) return { zt:1, text:[null, {}, {id:'901', name_all:' ', name:'安装包 [x].exe', size:'1.5 M', time:'2026-11-14'}] };
    if (page === 2) return { zt:1, text:[{id:'901', name:'duplicate'}, {id:902, name_all:'manifest.lanzou.txt', size:'512 B'}] };
    return { zt:2, text:[] };
  } });
  const first = await client.listPage('d:123', 1);
  assert.equal(calls.length, 2); assert.deepEqual(calls.map(c => c.task).sort(), ['47','5']);
  assert.equal(first.entries.length, 2); assert.equal(first.hasMore, true);
  assert.equal(first.entries[0].name, '目录 &+'); assert.equal(first.entries[0].id, '901');
  assert.equal(first.entries[1].name, '安装包 [x].exe'); assert.equal(first.entries[1].size, 1572864);
  assert.equal(first.entries[1].modifiedTime, '2026-11-14'); assert.equal(first.entries[1].parentId, '123');
  calls.length = 0;
  const all = await client.list('123');
  assert.equal(all.length, 3); assert.deepEqual(all.map(file => file.id), ['901','901','902']);
  assert.equal(all[2].size, 512);
  assert.deepEqual(calls.filter(c => c.task === '47').map(c => c.page), [1]);
  assert.deepEqual(calls.filter(c => c.task === '5').map(c => c.page), [1,2,3]);
});

test('directory read rate limits retry the same page and never skip a file page', async t => {
  const pages = []; let limited = false;
  const { client } = await fixture(t, { directoryReply({ task, page }) {
    if (task === '47') return {zt:1,text:[]};
    pages.push(page);
    if (page === 2 && !limited) { limited = true; return {zt:4}; }
    return page < 3 ? {zt:1,text:[{id:String(page),name:`file-${page}.zip`}]} : {zt:2,text:[]};
  } });
  const files = await client.list();
  assert.deepEqual(files.map(file => file.id), ['1','2']); assert.deepEqual(pages, [1,2,2,3]);
});

test('directory end status, repeated pages and invalid entries do not trigger unbounded reads', async t => {
  let mode = 'end', calls = 0;
  const { client } = await fixture(t, { directoryReply({ task }) {
    if (task === '47') return {zt:1,text:[]};
    calls++;
    if (mode === 'end') return {zt:2,text:[{id:'1',name:'last.bin'}]};
    if (mode === 'invalid') return {zt:1,text:[null, {}]};
    return {zt:1,text:[{id:'1',name:'same.bin'}]};
  } });
  assert.equal((await client.list()).length, 1); assert.equal(calls, 1);
  mode = 'repeat'; calls = 0; await assert.rejects(() => client.list(), /重复/); assert.equal(calls, 2);
  mode = 'invalid'; await assert.rejects(() => client.listPage(), /有效条目/);
  for (const [folder, page] of [['../x',1],['-1',0],['-1',1001],['-1',1.5]]) await assert.rejects(() => client.listPage(folder,page), /无效/);
});

test('directory retry can be aborted and expired authentication is never retried', async t => {
  let mode = 'rate', calls = [];
  const { client } = await fixture(t, { directoryReply({ task }) { calls.push(task); return {zt:mode === 'rate' ? 4 : 9}; } });
  const abort = new AbortController(); const pending = client.listPage('-1',1,abort.signal);
  const timer = setTimeout(() => abort.abort(), 80);
  await assert.rejects(pending, {name:'AbortError'}); clearTimeout(timer); assert.deepEqual(calls.sort(), ['47','5']);
  mode = 'auth'; calls = [];
  await assert.rejects(() => client.listPage(), {code:'AUTH_EXPIRED'});
  assert.ok(calls.length >= 1 && calls.length <= 2); assert.equal(new Set(calls).size, calls.length); assert.equal(client.loggedIn, false);
});

test('YunX display sizes accept raw bytes, fractional units and empty metadata', () => {
  for (const [value, expected] of [[512,512], ['512 B',512], ['1.5 M',1572864], ['2KB',2048], ['1 GiB',1073741824], ['',0], [null,0], ['bad',0]]) assert.equal(parseDisplaySize(value),expected);
});
test('real HTTP login, challenge handling, multipart upload and 4-worker automatic download/merge', async t => {
  const { dir, mock, engine } = await fixture(t, { challengeLogin: true, slowDownloads: true });
  const input = path.join(dir, '测试 安装包.exe'); const data = randomBytes(26000); await writeFile(input, data);
  const upload = await completed(engine, await engine.createUpload(input));
  assert.equal(upload.manifest.parts.length, 4); assert.equal(mock.folders.size, 1);
  assert.ok(upload.manifest.parts.every(p => p.uploadSize <= 8192));
  assert.equal(mock.uploads.get('manifest.lanzou.txt'), 1);
  assert.ok(mock.requests.some(r => r.path === '/accounts.php' && r.cookie?.includes('acw_sc__v2=')));
  const bundle = await engine.inspectFolder(upload.folderId);
  const output = path.join(dir, 'out'); await mkdir(output);
  const download = await completed(engine, await engine.createDownload(bundle, output, 4));
  assert.deepEqual(await readFile(download.resultPath), data);
  assert.ok(mock.maxDownloads >= 2, `expected concurrency, observed ${mock.maxDownloads}`);
  assert.ok(mock.maxDownloads <= 4);
  assert.equal(await sha256(download.resultPath), upload.manifest.sha256);
});

test('special symbols use a compatible cloud folder and restore the exact original name after restart and shared download', async t => {
  const { dir, mock, client, engine } = await fixture(t, { rejectSpecialFolderNames: true });
  const originalName = '测试 [正式版] (x64) &+＃！💾.exe';
  await assert.rejects(() => client.createFolder(originalName), /名称含有特殊字符/);
  mock.folderAttempts.length = 0;
  const input = path.join(dir, originalName); const data = randomBytes(18000); await writeFile(input, data);
  const upload = await completed(engine, await engine.createUpload(input));
  assert.match(upload.folderName, /^slice[a-f0-9]{32}$/);
  assert.deepEqual(mock.folderAttempts, [upload.folderName]);
  const cloudManifest = JSON.parse(mock.files.get(upload.manifestId).data.toString('utf8'));
  assert.equal(cloudManifest.originalName, originalName);
  assert.deepEqual(cloudManifest.naming, { strategy:'ascii-task-id-v1', originalName, cloudFolderName:upload.folderName });
  assert.deepEqual(await readFile(input), data);
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir, maxPartBytes:8192 }); await recovered.init();
  assert.deepEqual(recovered.tasks.get(upload.id).naming, cloudManifest.naming);
  client.uid = client.vei = null;
  const bundle = await recovered.inspectShare(upload.share.url);
  const output = path.join(dir, 'special-out');
  const download = await completed(recovered, await recovered.createDownload(bundle, output, 4));
  assert.equal(path.basename(download.resultPath), originalName);
  assert.deepEqual(await readFile(download.resultPath), data);
  assert.equal(download.nameRestoration.exact, true);
  const exported = path.join(dir, 'exported.json'); await recovered.exportManifest(download.id, exported);
  assert.deepEqual(JSON.parse(await readFile(exported, 'utf8')), cloudManifest);
});

test('a legacy rejected folder name is repaired on resume and its previous name is recorded', async t => {
  const { dir, mock, engine, client } = await fixture(t, { rejectSpecialFolderNames:true });
  const input = path.join(dir, '旧任务 [安装包] &+.exe'); await writeFile(input, randomBytes(9000));
  const originalCreate = client.createFolder.bind(client);
  client.createFolder = async () => { throw new Error('名称含有特殊字符'); };
  const id = await engine.createUpload(input); await engine.active.get(id)?.promise;
  const task = engine.tasks.get(id); assert.equal(task.state, 'failed');
  const previousName = '旧任务 [安装包] &+-old12345';
  task.folderName = previousName; delete task.naming; await engine.persist(task);
  client.createFolder = originalCreate;
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir, maxPartBytes:8192 }); await recovered.init();
  const upload = await completed(recovered, await recovered.resume(id));
  assert.deepEqual(mock.folderAttempts, [upload.folderName]);
  assert.equal(upload.manifest.naming.previousCloudFolderName, previousName);
  assert.equal(mock.folders.size, 1);
  assert.equal(upload.manifest.originalName, path.basename(input));
});

test('an unacknowledged legacy folder is reused and an old committed manifest remains unchanged', async t => {
  const { dir, mock, engine, client } = await fixture(t);
  const input = path.join(dir, 'legacy [v1].bin'); await writeFile(input, randomBytes(9000));
  const create = client.createFolder.bind(client); client.createFolder = async () => { throw new Error('interrupted'); };
  const id = await engine.createUpload(input); await engine.active.get(id)?.promise;
  const task = engine.tasks.get(id); task.folderName = 'legacy [v1]-old12345'; delete task.naming;
  mock.folders.set('999', task.folderName); await engine.persist(task); client.createFolder = create;
  const upload = await completed(engine, await engine.resume(id));
  assert.equal(upload.folderId, '999'); assert.equal(mock.folders.size, 1); assert.equal(mock.folderAttempts.length, 0);
  // Simulate a pre-fix v1 manifest with no naming field, then continue the saved task.
  delete upload.manifest.naming; delete upload.naming;
  const remote = mock.files.get(upload.manifestId); remote.data = Buffer.from(JSON.stringify(upload.manifest));
  const original = structuredClone(upload.manifest); upload.manifestId = null; upload.state = 'paused'; await engine.persist(upload);
  const recovered = new TransferEngine({ client, dataDir:engine.dataDir, maxPartBytes:8192 }); await recovered.init();
  await completed(recovered, await recovered.resume(id));
  assert.deepEqual(recovered.tasks.get(id).manifest, original);
  assert.equal(mock.uploads.get('manifest.lanzou.txt'), 1);
  const download = await completed(recovered, await recovered.createDownload(await recovered.inspectFolder('999'), path.join(dir, 'legacy-out')));
  assert.equal(path.basename(download.resultPath), path.basename(input));
});

test('a compatible folder with a lost response is reconciled without creating duplicates', async t => {
  const { dir, mock, engine } = await fixture(t, { rejectSpecialFolderNames:true, uncertainFolderCreate:true });
  const input = path.join(dir, 'uncertain [+].bin'); await writeFile(input, randomBytes(1000));
  const id = await engine.createUpload(input); await engine.active.get(id)?.promise;
  const task = engine.tasks.get(id); assert.equal(task.state, 'failed');
  const journal = JSON.parse(await readFile(path.join(engine.taskDir(id), 'task.json'), 'utf8'));
  assert.equal(journal.naming.cloudFolderName, mock.folderAttempts[0]);
  await completed(engine, await engine.resume(id));
  assert.equal(mock.folders.size, 1); assert.equal(mock.folderAttempts.length, 1);
});

test('Windows-incompatible metadata names are safely encoded while the complete original stays in the manifest', async t => {
  const { dir, engine } = await fixture(t);
  const input = path.join(dir, 'foreign.bin'); const data = randomBytes(1000); await writeFile(input, data);
  const upload = await completed(engine, await engine.createUpload(input));
  const bundle = await engine.inspectFolder(upload.folderId);
  bundle.manifest = structuredClone(bundle.manifest); bundle.manifest.originalName = '../目录\\程序:测试?*.bin';
  const originalName = bundle.manifest.originalName;
  const download = await completed(engine, await engine.createDownload(bundle, path.join(dir, 'encoded-out')));
  assert.equal(path.dirname(download.resultPath), path.join(dir, 'encoded-out'));
  assert.equal(path.basename(download.resultPath), localFileName(originalName));
  assert.deepEqual(await readFile(download.resultPath), data);
  assert.equal(download.nameRestoration.exact, false);
  const journal = JSON.parse(await readFile(path.join(engine.taskDir(download.id), 'task.json'), 'utf8'));
  assert.equal(journal.manifest.originalName, originalName);
  assert.deepEqual(journal.nameRestoration, { originalName, savedName: localFileName(originalName), exact:false });
  const id = await engine.createDownload(bundle, path.join(dir, 'encoded-out')); await engine.active.get(id)?.promise;
  assert.equal(engine.tasks.get(id).state, 'failed'); assert.match(engine.tasks.get(id).error, /已存在/);
  assert.deepEqual(await readFile(download.resultPath), data);
});

test('automatic local naming preserves valid symbols and bounds reserved, trailing, long and traversal names', () => {
  assert.equal(localFileName('中文 ()[] &+＃ 💾.exe'), '中文 ()[] &+＃ 💾.exe');
  for (const name of ['CON.txt', 'CON .txt', 'COM¹.txt', 'CONOUT$', 'a/b', 'a\\b', 'a:stream', '../x', '..', 'file. ', 'file\u0000.txt', '💾'.repeat(130) + '.exe', 'a'.repeat(300) + '.ext with space      tail']) {
    const converted = localFileName(name); assert.equal(safeName(converted), converted);
    assert.equal(path.win32.basename(converted), converted); assert.ok(converted.length <= 255);
    assert.notEqual(converted, name);
  }
  assert.notEqual(localFileName('a'.repeat(300) + '.exe'), localFileName('a'.repeat(299) + 'b.exe'));
  for (const name of ['', null, 123, 'a'.repeat(4097)]) assert.throws(() => localFileName(name));
});

test('a long valid Windows name is restored exactly without overflowing the merge temporary filename', async t => {
  const { dir, engine } = await fixture(t, { rejectSpecialFolderNames:true });
  const name = '文'.repeat(240) + ' &+[x].exe'; assert.ok(name.length > 240 && name.length <= 255);
  const input = path.join(dir, name); const data = randomBytes(100); await writeFile(input, data);
  const upload = await completed(engine, await engine.createUpload(input));
  const download = await completed(engine, await engine.createDownload(await engine.inspectFolder(upload.folderId), path.join(dir, 'long-name-out')));
  assert.equal(path.basename(download.resultPath), name);
  assert.deepEqual(await readFile(download.resultPath), data);
  assert.equal(download.nameRestoration.exact, true);
  const exported = path.join(dir, localFileName(`${name}.lanzou.txt`));
  await engine.exportManifest(download.id, exported);
  assert.equal(JSON.parse(await readFile(exported, 'utf8')).originalName, name);
});
test('uncertain upload response is reconciled by downloading and hashing the existing remote file', async t => {
  const { dir, engine, mock } = await fixture(t, { uncertainUpload: true });
  const input = path.join(dir, 'uncertain.bin'); await writeFile(input, randomBytes(10000));
  const upload = await completed(engine, await engine.createUpload(input));
  assert.equal(upload.manifest.parts.length, 2);
  assert.equal(mock.uploads.get('part-000001.zip'), 1);
});
test('share folder members are resolved individually and restored without an account session', async t => {
  const { dir, engine, client } = await fixture(t);
  const input = path.join(dir, 'shared.dat'); await writeFile(input, randomBytes(18000));
  const upload = await completed(engine, await engine.createUpload(input));
  client.uid = client.vei = null;
  const bundle = await engine.inspectShare(upload.share.url);
  const out = path.join(dir, 'guest'); await mkdir(out);
  const download = await completed(engine, await engine.createDownload(bundle, out, 3));
  assert.equal(await sha256(input), await sha256(download.resultPath));
});
test('ignored Range restarts a partial file instead of appending duplicate bytes', async t => {
  const { dir, engine, client, mock } = await fixture(t, { ignoreRange: true });
  const input = path.join(dir, 'range.dat'); await writeFile(input, randomBytes(6000));
  const upload = await completed(engine, await engine.createUpload(input)); const part = upload.manifest.parts[0];
  const remote = mock.files.get(part.remoteId); const destination = path.join(dir, 'download.zip');
  await writeFile(`${destination}.partial`, remote.data.subarray(0, 1700));
  await downloadPart(client, () => client.downloadLink({ id: part.remoteId }), destination, part);
  assert.equal(await sha256(destination), part.sha256);
  assert.ok(mock.requests.some(r => r.range === 'bytes=1700-'));
});
test('valid Range resumes missing bytes and damaged completed cache is redownloaded', async t => {
  const { dir, engine, client, mock } = await fixture(t);
  const input = path.join(dir, 'resume.dat'); await writeFile(input, randomBytes(6000));
  const upload = await completed(engine, await engine.createUpload(input)); const part = upload.manifest.parts[0];
  const remote = mock.files.get(part.remoteId); const destination = path.join(dir, 'resume.zip');
  await writeFile(`${destination}.partial`, remote.data.subarray(0, 500));
  await downloadPart(client, () => client.downloadLink({ id: part.remoteId }), destination, part);
  assert.equal(await sha256(destination), part.sha256);
  assert.ok(mock.requests.some(r => r.range === 'bytes=500-'));
  await writeFile(destination, Buffer.alloc(part.uploadSize));
  await downloadPart(client, () => client.downloadLink({ id: part.remoteId }), destination, part);
  assert.equal(await sha256(destination), part.sha256);
});
test('empty file uploads a valid ZIP and reconstructs a zero-byte result', async t => {
  const { dir, engine } = await fixture(t);
  const input = path.join(dir, 'empty.txt'); await writeFile(input, '');
  const upload = await completed(engine, await engine.createUpload(input));
  const out = path.join(dir, 'empty-out'); await mkdir(out);
  const result = await completed(engine, await engine.createDownload(await engine.inspectFolder(upload.folderId), out));
  assert.equal((await stat(result.resultPath)).size, 0);
});
test('manifest tampering, missing parts and an existing result never silently succeed', async t => {
  const { dir, engine, mock } = await fixture(t);
  const input = path.join(dir, 'valid.bin'); await writeFile(input, randomBytes(12000));
  const upload = await completed(engine, await engine.createUpload(input));
  const bad = structuredClone(upload.manifest); bad.parts[0].name = '../evil.zip'; assert.throws(() => validateManifest(bad));
  const bundle = await engine.inspectFolder(upload.folderId); const out = path.join(dir, 'exists'); await mkdir(out); await writeFile(path.join(out, 'valid.bin'), 'keep');
  const id = await engine.createDownload(bundle, out); await engine.active.get(id)?.promise;
  assert.equal(engine.tasks.get(id).state, 'failed'); assert.equal(await readFile(path.join(out, 'valid.bin'), 'utf8'), 'keep');
  mock.files.delete(upload.manifest.parts[0].remoteId);
  await assert.rejects(() => engine.inspectFolder(upload.folderId), /缺失/);
});
test('persisted upload recovery does not retransmit acknowledged parts', async t => {
  const { dir, engine, client, mock } = await fixture(t);
  const input = path.join(dir, 'restart.bin'); await writeFile(input, randomBytes(17000));
  const task = await completed(engine, await engine.createUpload(input));
  task.state = 'paused'; task.manifestId = null; await engine.persist(task);
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir, maxPartBytes: 8192 }); await recovered.init();
  await completed(recovered, await recovered.resume(task.id));
  assert.equal(mock.uploads.get('part-000001.zip'), 1); assert.equal(mock.uploads.get('manifest.lanzou.txt'), 1);
  const journal = await readFile(path.join(engine.taskDir(task.id), 'task.json'), 'utf8');
  assert.ok(!journal.includes('only-for-fixture')); assert.ok(!journal.includes('phpdisk_info'));
});
test('pause aborts an active download and a new engine resumes its saved task', async t => {
  const { dir, engine, client } = await fixture(t, { slowDownloads: true });
  const input = path.join(dir, 'paused.dat'); await writeFile(input, randomBytes(24000));
  const upload = await completed(engine, await engine.createUpload(input));
  const bundle = await engine.inspectFolder(upload.folderId); const out = path.join(dir, 'paused-out'); await mkdir(out);
  const original = client.request.bind(client); let stopped = false;
  client.request = async (url, options = {}) => {
    const response = await original(url, options);
    if (!stopped && options.method !== 'HEAD' && new URL(url).pathname.startsWith('/file/')) {
      const active = [...engine.tasks.values()].find(t => t.type === 'download' && t.state === 'running');
      if (active) { stopped = true; queueMicrotask(() => { void engine.pause(active.id); }); }
    }
    return response;
  };
  const id = await engine.createDownload(bundle, out, 2); await engine.active.get(id)?.promise;
  assert.equal(engine.tasks.get(id).state, 'paused'); assert.ok(stopped);
  client.request = original;
  const recovered = new TransferEngine({ client, dataDir: engine.dataDir, maxPartBytes: 8192 }); await recovered.init();
  const result = await completed(recovered, await recovered.resume(id));
  assert.equal(await sha256(input), await sha256(result.resultPath));
});
test('a source modified after upload is rejected when the old task is resumed', async t => {
  const { dir, engine } = await fixture(t);
  const input = path.join(dir, 'changed.dat'); await writeFile(input, randomBytes(10000));
  const task = await completed(engine, await engine.createUpload(input)); task.state = 'paused';
  await writeFile(input, randomBytes(12000));
  await engine.resume(task.id); await engine.active.get(task.id)?.promise;
  assert.equal(task.state, 'failed'); assert.match(task.error, /源文件已修改/);
});
test('merge refuses corrupted archives and preserves an existing destination', async t => {
  const { dir } = await fixture(t);
  const source = path.join(dir, 'source.bin'); await writeFile(source, randomBytes(6000));
  const part = planParts(6000, 8192)[0]; const zip = path.join(dir, part.name);
  const packed = await createPartZip(source, part, zip);
  const manifest = { format:'lanzou-slice',version:1,taskId:randomUUID(),originalName:'output.bin',originalSize:6000,maxPartBytes:8192,sha256:await sha256(source),parts:[{...part,...packed,remoteId:'123'}] };
  const destination = path.join(dir, 'output.bin'); await writeFile(destination, 'existing');
  await assert.rejects(() => mergeArchives(manifest, [zip], destination), /已存在/);
  assert.equal(await readFile(destination, 'utf8'), 'existing'); await rm(destination);
  const temporaryName = path.join(dir, `.lanzou-${manifest.taskId}.merging`); await writeFile(temporaryName, 'keep this file');
  await assert.rejects(() => mergeArchives(manifest, [zip], temporaryName), /已存在/);
  assert.equal(await readFile(temporaryName, 'utf8'), 'keep this file');
  const damaged = await readFile(zip); damaged[60] ^= 1; await writeFile(zip, damaged);
  await assert.rejects(() => mergeArchives(manifest, [zip], destination), /校验失败/);
  await assert.rejects(() => stat(destination), { code:'ENOENT' });
});
