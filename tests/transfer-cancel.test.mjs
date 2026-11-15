import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TransferEngine } from '../src/transfer.mjs';
import { LanzouClient } from '../src/lanzou.mjs';
import { startMockLanzou } from './mock-lanzou.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error('Transfer did not reach the expected state'); await delay(5); } }
async function fixture(t, options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lanzou-cancel-'));
  const mock = await startMockLanzou(options), client = new LanzouClient({ pcOrigin: mock.origin, accountOrigin: mock.origin });
  await client.login('test', 'only-for-fixture');
  const dataDir = path.join(directory, 'data'), engine = new TransferEngine({ client, dataDir, maxPartBytes: 8192 }); await engine.init();
  const source = path.join(directory, 'original.bin'); await writeFile(source, Buffer.alloc(32000, 23));
  t.after(async () => { await engine.pauseAll(); await mock.close(); await rm(directory, { recursive: true, force: true }); });
  return { engine, source, directory, dataDir, client, mock };
}

test('cancels selected running and queued uploads before the next worker starts, retaining unselected FIFO work', async t => {
  const { engine, source } = await fixture(t); engine.syncOwner = 'hold';
  const ids = (await engine.createUploadBatch([source])).ids;
  ids.push(await engine.createUpload(source), await engine.createUpload(source));
  const ready = gate(), started = [];
  engine.runUpload = async (task, signal) => {
    started.push(task.id);
    if (task.id === ids[0]) { ready.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
  };
  engine.syncOwner = null; engine.startNextDownload(); await ready.promise;
  const result = await engine.cancel(ids.slice(0, 2));
  await until(() => engine.tasks.get(ids[2]).state === 'completed');
  await engine.active.get(ids[2])?.promise;
  assert.deepEqual(started, [ids[0], ids[2]]); assert.equal(result.canceled, 2); assert.deepEqual(result.failures, []);
  assert.deepEqual(ids.map(id => engine.tasks.get(id).state), ['canceled', 'canceled', 'completed']);
  assert.equal((await readFile(source)).length, 32000); assert.equal(engine.tick, null);
});

test('cancels real HTTP upload without deleting already uploaded cloud members or original source', async t => {
  const { engine, source, mock } = await fixture(t, { uploadDelay: 60 });
  const id = await engine.createUpload(source);
  await until(() => [...mock.files.values()].some(file => file.name.startsWith('part-')));
  const remote = [...mock.files.keys()]; const result = await engine.cancel([id]);
  assert.equal(result.canceled, 1); assert.equal(engine.active.size, 0);
  for (const key of remote) assert.ok(mock.files.has(key));
  assert.equal((await readFile(source)).length, 32000);
  assert.deepEqual((await readdir(engine.tasks.get(id).cachePath)).filter(name => name !== '.lanzou-cache.json'), []);
});

test('cancels real ordinary download, removes only temporary bytes and keeps an unrelated output', async t => {
  const { engine, mock, directory } = await fixture(t, { slowDownloads: true });
  mock.files.set('901', { id: '901', name: 'download.bin', folderId: '-1', data: Buffer.alloc(1024 * 1024, 65) });
  const output = path.join(directory, 'output');
  const id = await engine.createFileDownload({ id: '901', name: 'download.bin', parentId: '-1', isFolder: false }, output);
  const task = engine.tasks.get(id);
  await until(() => (task.bytes || 0) > 0);
  const unrelated = path.join(output, 'keep.txt'); await writeFile(unrelated, 'keep');
  assert.equal((await engine.cancel([id])).canceled, 1); assert.equal(task.state, 'canceled');
  await assert.rejects(stat(path.join(task.cachePath, 'file-download.partial')), { code: 'ENOENT' });
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
  await assert.rejects(stat(path.join(output, 'download.bin')), { code: 'ENOENT' });
});

test('cancels a real slice download and preserves the completed upload and published manifest', async t => {
  const { engine, source, mock } = await fixture(t, { slowDownloads: true });
  const uploadId = await engine.createUpload(source); await engine.active.get(uploadId)?.promise;
  const upload = engine.tasks.get(uploadId); assert.equal(upload.state, 'completed');
  const bundle = await engine.inspectFolder(upload.folderId), id = await engine.createDownload(bundle);
  const task = engine.tasks.get(id); await until(() => task.phase === 'downloading');
  const cloudIds = [...mock.files.keys()]; assert.equal((await engine.cancel([id])).canceled, 1);
  assert.equal(task.state, 'canceled'); assert.equal(upload.state, 'completed');
  for (const key of cloudIds) assert.ok(mock.files.has(key));
  assert.equal((await readFile(source)).length, 32000);
});

test('canceled tasks remain terminal across restart and can only be removed as ended history', async t => {
  const { engine, source, client, dataDir } = await fixture(t); engine.syncOwner = 'hold'; const id = await engine.createUpload(source);
  assert.equal((await engine.cancel([id])).canceled, 1);
  const restored = new TransferEngine({ client, dataDir }); await restored.init();
  assert.equal(restored.tasks.get(id).state, 'canceled'); assert.equal(restored.active.size, 0);
  await assert.rejects(restored.resume(id), /无法继续/); await assert.rejects(restored.enqueue(restored.tasks.get(id)), /已取消/);
  assert.deepEqual(await restored.clearHistory(), { removed: 0, retained: 1 });
  assert.deepEqual(await restored.clearHistory({ scope: 'all', id }), { removed: 1, retained: 0 });
  assert.equal((await readFile(source)).length, 32000);
});

test('cancel cleanup preserves source/result-looking cache files, unknown files and other tasks cache', async t => {
  const { engine, source } = await fixture(t); engine.syncOwner = 'hold';
  const first = engine.tasks.get(await engine.createUpload(source)), second = engine.tasks.get(await engine.createUpload(source));
  const recovery = path.join(second.cachePath, 'part-000001.zip.partial'); await writeFile(recovery, 'keep recovery');
  const protectedSource = path.join(first.cachePath, 'part-999999.zip'), result = path.join(first.cachePath, 'file-download.partial'), unknown = path.join(first.cachePath, 'notes.txt'), temp = path.join(first.cachePath, 'part-000001.zip.partial');
  for (const file of [protectedSource, result, unknown, temp]) await writeFile(file, file);
  first.sourcePath = protectedSource; first.resultPath = result;
  assert.equal((await engine.cancel([first.id])).canceled, 1);
  for (const file of [protectedSource, result, unknown, recovery]) assert.ok((await readFile(file)).length);
  await assert.rejects(stat(temp), { code: 'ENOENT' });
  await engine.cleanCache(); await engine.clearHistory({ scope: 'all' });
  for (const file of [protectedSource, result, unknown, recovery]) assert.ok((await readFile(file)).length);
});

test('cancel rejects invalid selections atomically and refuses sync rule tasks without pausing manual work', async t => {
  const { engine, source } = await fixture(t); engine.syncOwner = 'hold'; const id = await engine.createUpload(source);
  for (const ids of [null, [], ['../'], [id, id], Array(201).fill(id), [3]]) await assert.rejects(engine.cancel(ids), /1–200/);
  const syncId = randomUUID(); engine.tasks.set(syncId, { id: syncId, type: 'upload', state: 'paused', syncRuleId: 'rule' });
  await assert.rejects(engine.cancel([id, syncId]), /自动同步/); assert.equal(engine.tasks.get(id).state, 'queued');
  engine.tasks.delete(syncId); engine.syncPendingIds = new Set([id]); await assert.rejects(engine.cancel([id]), /自动同步/);
});

test('cancel skips completed, previously canceled and missing tasks without deleting a final result', async t => {
  const { engine, source } = await fixture(t); const id = await engine.createUpload(source); await engine.active.get(id)?.promise;
  engine.syncOwner = 'hold'; const canceled = await engine.createUpload(source); await engine.cancel([canceled]);
  assert.deepEqual(await engine.cancel([id, canceled, randomUUID()]), { canceled: 0, skipped: 3, failures: [] });
  assert.equal(engine.tasks.get(id).state, 'completed');
});

test('cancel prevents competing resume, queue, duplicate cancel and history cleanup until persistence/cleanup settles', async t => {
  const { engine, source } = await fixture(t); engine.syncOwner = 'hold'; const id = await engine.createUpload(source);
  const ready = gate(), release = gate(), clean = engine.storage.clean.bind(engine.storage);
  engine.storage.clean = async (...args) => { ready.resolve(); await release.promise; return clean(...args); };
  const cancel = engine.cancel([id]); await ready.promise;
  await assert.rejects(engine.createUpload(source), /稍候/); await assert.rejects(engine.resume(id), /无法继续/);
  await assert.rejects(engine.cancel([id]), /稍候/); await assert.rejects(engine.clearHistory({ scope: 'all' }), /稍候/);
  release.resolve(); await cancel; assert.equal(engine.canceling, false);
});

test('preparing work cannot be canceled or resurrected by a late enqueue write', async t => {
  const { engine, source } = await fixture(t); const ready = gate(), release = gate(), allocate = engine.storage.allocate.bind(engine.storage);
  engine.storage.allocate = async (...args) => { ready.resolve(); await release.promise; return allocate(...args); };
  const creating = engine.createUpload(source); await ready.promise; const id = [...engine.tasks.keys()][0];
  await assert.rejects(engine.cancel([id]), /准备/); release.resolve(); await creating;
  await engine.cancel([id]); assert.equal(engine.tasks.get(id).state, 'canceled');
  assert.equal(JSON.parse(await readFile(path.join(engine.taskDir(id), 'task.json'), 'utf8')).state, 'canceled');
});

test('journal failure retains paused task and cache for retry while other selections are canceled', async t => {
  const { engine, source } = await fixture(t); engine.syncOwner = 'hold'; const ids = [await engine.createUpload(source), await engine.createUpload(source)];
  const task = engine.tasks.get(ids[0]), cached = path.join(task.cachePath, 'part-000001.zip.partial'); await writeFile(cached, 'recoverable');
  const persist = engine.persist.bind(engine); engine.persist = task => task.id === ids[0] && task.state === 'canceled' ? Promise.reject(new Error('disk full')) : persist(task);
  const result = await engine.cancel(ids); assert.equal(result.canceled, 1); assert.deepEqual(result.failures.map(x => x.id), [ids[0]]);
  assert.equal(task.state, 'paused'); assert.equal(await readFile(cached, 'utf8'), 'recoverable');
  engine.persist = persist; assert.equal((await engine.cancel([task.id])).canceled, 1);
});

test('cache cleanup failure leaves a durable canceled journal and can be retried without resuming', async t => {
  const { engine, source } = await fixture(t); engine.syncOwner = 'hold'; const id = await engine.createUpload(source), clean = engine.storage.clean.bind(engine.storage);
  engine.storage.clean = async () => { throw new Error('cache busy'); };
  const result = await engine.cancel([id]); assert.equal(result.canceled, 1); assert.equal(result.failures.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(engine.taskDir(id), 'task.json'), 'utf8')).state, 'canceled');
  engine.storage.clean = clean; await engine.cleanCache(); await assert.rejects(engine.resume(id), /无法继续/);
});

test('pause-all used at exit waits for an in-flight cancellation and prevents later queued starts', async t => {
  const { engine, source } = await fixture(t); engine.syncOwner = 'hold'; const first = await engine.createUpload(source), next = await engine.createUpload(source);
  const ready = gate(), release = gate(), clean = engine.storage.clean.bind(engine.storage);
  engine.storage.clean = async (...args) => { ready.resolve(); await release.promise; return clean(...args); };
  const cancel = engine.cancel([first]); await ready.promise;
  let stopped = false; const pause = engine.pauseAll().then(() => { stopped = true; });
  await delay(10); assert.equal(stopped, false); release.resolve(); await Promise.all([pause, cancel]);
  assert.equal(engine.tasks.get(first).state, 'canceled'); assert.equal(engine.tasks.get(next).state, 'paused');
  assert.equal(engine.cancelPromise, null); assert.equal(engine.pausePromise, null);
});

test('a worker that finished publishing before cancellation remains completed with its output intact', async t => {
  const { engine, source, directory } = await fixture(t); engine.syncOwner = 'hold'; const id = await engine.createUpload(source);
  const ready = gate(), release = gate(), resultPath = path.join(directory, 'finished.bin');
  engine.runUpload = async task => { await writeFile(resultPath, 'finished'); task.resultPath = resultPath; ready.resolve(); await release.promise; };
  engine.syncOwner = null; engine.startNextDownload(); await ready.promise;
  const cancel = engine.cancel([id]); release.resolve(); const result = await cancel;
  assert.equal(result.canceled, 0); assert.equal(result.skipped, 1); assert.equal(engine.tasks.get(id).state, 'completed');
  assert.equal(await readFile(resultPath, 'utf8'), 'finished');
});

test('cancellation does not interrupt further uploads owned by an already active sync rule', async t => {
  const { engine, source } = await fixture(t); engine.syncOwner = 'hold'; const id = await engine.createUpload(source);
  const ready = gate(), release = gate(), clean = engine.storage.clean.bind(engine.storage);
  engine.storage.clean = async (...args) => { ready.resolve(); await release.promise; return clean(...args); };
  const cancel = engine.cancel([id]); await ready.promise;
  const syncId = randomUUID(), task = { id: syncId, type: 'upload', state: 'paused', syncRuleId: 'hold', sourcePath: source, cachePath: await engine.storage.allocate(syncId) };
  engine.tasks.set(syncId, task); engine.start(task, async () => {});
  release.resolve(); await cancel; await engine.active.get(syncId)?.promise;
  assert.equal(task.state, 'completed');
});

test('concurrent cache cleanup cannot reclaim selected bytes before terminal cancellation is durable', async t => {
  const { engine, source } = await fixture(t); engine.syncOwner = 'hold'; const id = await engine.createUpload(source), task = engine.tasks.get(id);
  const cached = path.join(task.cachePath, 'part-000001.zip.partial'); await writeFile(cached, 'recoverable');
  const ready = gate(), release = gate(), persist = engine.persist.bind(engine);
  engine.persist = async snapshot => { if (snapshot.state === 'canceled') { ready.resolve(); await release.promise; throw new Error('disk full'); } return persist(snapshot); };
  const cancel = engine.cancel([id]); await ready.promise;
  assert.equal(task.state, 'paused'); await engine.cleanCache(); assert.equal(await readFile(cached, 'utf8'), 'recoverable');
  release.resolve(); assert.equal((await cancel).canceled, 0); assert.equal(await readFile(cached, 'utf8'), 'recoverable');
});
