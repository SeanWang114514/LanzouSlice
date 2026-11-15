import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LanzouClient, LanzouError } from '../src/lanzou.mjs';
import { TransferEngine } from '../src/transfer.mjs';
import { CloudFiles } from '../src/cloud-files.mjs';
import { FolderRecognition } from '../src/folder-recognition.mjs';
import { startMockLanzou } from './mock-lanzou.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lanzou-batch-'));
  const mock = await startMockLanzou(options), client = new LanzouClient({ pcOrigin: mock.origin, accountOrigin: mock.origin });
  await client.login('test', 'only-for-fixture');
  const dataDir = path.join(directory, 'data'), outputDir = path.join(directory, 'out');
  const engine = new TransferEngine({ client, dataDir, defaultDownloadDir: outputDir, maxPartBytes: 8192 }); await engine.init();
  const recognition = new FolderRecognition({ dataDir, identify: async () => ({ status: 'ordinary' }) }); await recognition.init();
  const manager = new CloudFiles({ client, engine, recognition });
  for (const [id, name, value] of [['901', '普通资料 &+.txt', 61], ['902', '另一份文件.zip', 62]]) mock.files.set(id, { id, name, folderId: '-1', data: Buffer.alloc(128 * 1024, value) });
  t.after(async () => { await engine.pauseAll(); await mock.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, dataDir, outputDir, mock, client, engine, manager, recognition };
}
const fileItem = id => ({ id, parentId: '-1', isFolder: false });
async function settled(engine, ids) {
  const deadline = Date.now() + 10000;
  while (ids.some(id => engine.active.has(id) || ['running', 'queued'].includes(engine.tasks.get(id)?.state))) { if (Date.now() > deadline) throw new Error('Batch did not settle'); await delay(10); }
  return ids.map(id => engine.tasks.get(id));
}

test('batch lookup groups parent reads, retains input order and distinguishes same-numbered files/folders', async t => {
  const { manager, client, mock } = await fixture(t);
  mock.folders.set('901', 'same numeric id');
  let calls = 0; const list = client.list.bind(client); client.list = async (...args) => { calls++; return list(...args); };
  const entries = await manager.downloadSelection([fileItem('902'), { id: '901', parentId: '-1', isFolder: true }, fileItem('901')]);
  assert.equal(calls, 1); assert.deepEqual(entries.map(file => [file.id, file.isFolder]), [['902', false], ['901', true], ['901', false]]);
});

test('batch lookup rejects empty, oversized, duplicate, wrong-kind and missing selections before creating tasks', async t => {
  const { manager, engine } = await fixture(t);
  for (const items of [[], null, Array.from({ length: 201 }, () => fileItem('901')), [fileItem('901'), fileItem('901')], [{ ...fileItem('901'), parentId: '../' }], [{ ...fileItem('901'), isFolder: true }], [fileItem('999')]]) await assert.rejects(manager.downloadSelection(items));
  assert.equal(engine.tasks.size, 0);
});

test('batch lookup rejects a changed account instead of returning a stale selection', async t => {
  const { manager, client } = await fixture(t); let version = 0; manager.version = () => version;
  const list = client.list.bind(client); client.list = async (...args) => { const files = await list(...args); version++; return files; };
  await assert.rejects(manager.downloadSelection([fileItem('901')]), /账号已变化/);
});

test('mixed batches download sequentially, validate slice manifests and restore exact names and bytes', async t => {
  const { directory, outputDir, engine, manager, recognition, client, mock } = await fixture(t, { slowDownloads: true });
  const source = path.join(directory, '切片 [安装包] &+💾.exe'); await writeFile(source, Buffer.alloc(20000, 29));
  const uploadId = await engine.createUpload(source); await engine.active.get(uploadId).promise;
  const upload = engine.tasks.get(uploadId); assert.equal(upload.state, 'completed');
  recognition.remember(client.uid, upload.folderId, { status: 'preview', originalName: path.basename(source), originalSize: 20000, totalParts: upload.totalParts }, upload.folderName);
  const files = await manager.downloadSelection([{ id: upload.folderId, parentId: '-1', isFolder: true }, fileItem('901'), fileItem('902')]);
  const starts = []; engine.on('change', tasks => { assert.ok(tasks.filter(task => task.state === 'running').length <= 1); const active = tasks.find(task => task.state === 'running'); if (active && starts.at(-1) !== active.id) starts.push(active.id); });
  const { ids } = await engine.createDownloadBatch(files, outputDir, 2);
  assert.ok(ids.slice(1).every(id => engine.tasks.get(id).state === 'queued'));
  const tasks = await settled(engine, ids);
  assert.deepEqual(tasks.map(task => task.state), ['completed', 'completed', 'completed']); assert.deepEqual(starts, ids);
  assert.equal(tasks[0].manifest.originalName, path.basename(source)); assert.equal(tasks[0].concurrency, 2); assert.equal(tasks[1].concurrency, 1);
  assert.deepEqual(await readFile(tasks[0].resultPath), await readFile(source));
  assert.deepEqual(await readFile(tasks[1].resultPath), mock.files.get('901').data); assert.deepEqual(await readFile(tasks[2].resultPath), mock.files.get('902').data);
});

test('a failed batch member does not overwrite an existing file or block subsequent downloads', async t => {
  const { manager, engine, outputDir, mock } = await fixture(t);
  const { mkdir } = await import('node:fs/promises'); await mkdir(outputDir, { recursive: true });
  const existing = path.join(outputDir, mock.files.get('901').name); await writeFile(existing, 'keep existing');
  const { ids } = await engine.createDownloadBatch(await manager.downloadSelection([fileItem('901'), fileItem('902')]));
  const tasks = await settled(engine, ids); assert.deepEqual(tasks.map(task => task.state), ['failed', 'completed']);
  assert.equal(await readFile(existing, 'utf8'), 'keep existing'); assert.deepEqual(await readFile(tasks[1].resultPath), mock.files.get('902').data);
});

test('a folder without a trusted manifest fails safely and the next file still downloads', async t => {
  const { manager, engine, mock } = await fixture(t); mock.folders.set('800', 'ordinary folder');
  const { ids } = await engine.createDownloadBatch(await manager.downloadSelection([{ id: '800', parentId: '-1', isFolder: true }, fileItem('901')]));
  const tasks = await settled(engine, ids); assert.equal(tasks[0].state, 'failed'); assert.match(tasks[0].error, /正式清单/); assert.equal(tasks[1].state, 'completed');
});

test('pause-all stops the running download and every queued task, and journals resume as paused after restart', async t => {
  const { manager, engine, dataDir, client } = await fixture(t, { slowDownloads: true });
  const { ids } = await engine.createDownloadBatch(await manager.downloadSelection([fileItem('901'), fileItem('902')]));
  await engine.pauseAll(); await delay(40);
  assert.equal(engine.active.size, 0); assert.ok(ids.every(id => engine.tasks.get(id).state === 'paused'));
  const restored = new TransferEngine({ client, dataDir }); await restored.init();
  assert.ok(ids.every(id => restored.tasks.get(id).state === 'paused'));
  for (const id of ids) { await restored.resume(id); await restored.active.get(id).promise; assert.equal(restored.tasks.get(id).state, 'completed'); }
});

test('pausing one queued task preserves it while the remaining queue continues and history clearing protects it', async t => {
  const { manager, engine } = await fixture(t, { slowDownloads: true });
  const { ids } = await engine.createDownloadBatch(await manager.downloadSelection([fileItem('901'), fileItem('902')]));
  await engine.pause(ids[1]); assert.equal(engine.tasks.get(ids[1]).state, 'paused');
  await settled(engine, [ids[0]]); await engine.clearHistory({ scope: 'all' });
  assert.equal(engine.tasks.has(ids[0]), false); assert.equal(engine.tasks.get(ids[1]).state, 'paused');
});

test('authentication expiry pauses the rest of the queue without attempting downloads under another account', async t => {
  const { manager, engine, client } = await fixture(t);
  const entries = await manager.downloadSelection([fileItem('901'), fileItem('902')]); let links = 0;
  client.downloadLink = async () => { links++; throw new LanzouError('expired', 'AUTH_EXPIRED'); };
  const { ids } = await engine.createDownloadBatch(entries); const tasks = await settled(engine, ids);
  assert.deepEqual(tasks.map(task => task.state), ['failed', 'paused']); assert.equal(links, 1);
  client.uid = 'different'; await assert.rejects(engine.resume(ids[1]).then(async () => { await engine.active.get(ids[1]).promise; if (engine.tasks.get(ids[1]).state === 'failed') throw new Error(engine.tasks.get(ids[1]).error); }), /创建此任务/);
  assert.equal(links, 1);
});

test('a pause during batch creation prevents late tasks from starting and rejects a duplicate in-flight submission', async t => {
  const { manager, engine } = await fixture(t);
  const entries = await manager.downloadSelection([fileItem('901'), fileItem('902')]);
  let release, entered; const blocked = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const allocate = engine.storage.allocate.bind(engine.storage); let calls = 0;
  engine.storage.allocate = async (...args) => { if (++calls === 2) { entered(); await gate; } return allocate(...args); };
  const pending = engine.createDownloadBatch(entries); await blocked;
  await assert.rejects(engine.createDownloadBatch(entries), /请稍候/); await engine.pauseAll(); release();
  await assert.rejects(pending, /状态已变化/); assert.equal(engine.active.size, 0); assert.ok([...engine.tasks.values()].every(task => task.state === 'paused'));
});

test('a batch can wait behind an existing transfer without increasing global transfer concurrency', async t => {
  const { manager, engine } = await fixture(t, { slowDownloads: true });
  const first = (await manager.downloadSelection([fileItem('901')]))[0];
  const activeId = await engine.createFileDownload(first);
  const { ids } = await engine.createDownloadBatch(await manager.downloadSelection([fileItem('902')]));
  assert.equal(engine.tasks.get(ids[0]).state, 'queued'); assert.equal(engine.active.size, 1);
  const tasks = await settled(engine, [activeId, ...ids]); assert.ok(tasks.every(task => task.state === 'completed'));
});

test('queued journals recover as paused without automatically downloading when the program restarts', async t => {
  const { manager, engine, dataDir, client } = await fixture(t, { slowDownloads: true });
  const { ids } = await engine.createDownloadBatch(await manager.downloadSelection([fileItem('901'), fileItem('902')]));
  assert.equal(engine.tasks.get(ids[1]).state, 'queued');
  const restored = new TransferEngine({ client, dataDir }); await restored.init();
  assert.equal(restored.tasks.get(ids[1]).state, 'paused'); assert.equal(restored.active.size, 0);
});
