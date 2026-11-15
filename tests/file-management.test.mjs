import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LanzouClient } from '../src/lanzou.mjs';
import { TransferEngine } from '../src/transfer.mjs';
import { FolderRecognition } from '../src/folder-recognition.mjs';
import { CloudFiles } from '../src/cloud-files.mjs';
import { startMockLanzou } from './mock-lanzou.mjs';

async function fixture(t, options) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lanzou-management-'));
  const mock = await startMockLanzou(options), client = new LanzouClient({ pcOrigin: mock.origin, accountOrigin: mock.origin });
  await client.login('test', 'only-for-fixture');
  const dataDir = path.join(dir, 'data'), engine = new TransferEngine({ client, dataDir }); await engine.init();
  const recognition = new FolderRecognition({ dataDir, identify: async () => ({ status: 'ordinary' }) });
  const manager = new CloudFiles({ client, engine, recognition });
  t.after(async () => { await engine.pauseAll(); await mock.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, mock, client, engine, manager, recognition, dataDir };
}
async function finish(engine, id) {
  await engine.active.get(id)?.promise;
  const task = engine.tasks.get(id); assert.equal(task.state, 'completed', task.error); return task;
}

test('YunX cloud management uses separate file/folder ids, supports nested folders, rename and recursive deletion', async t => {
  const { client, mock, manager, recognition } = await fixture(t);
  const parent = (await manager.change('create', { parentId: '-1', name: 'Parent' })).id;
  const child = (await manager.change('create', { parentId: parent, name: 'Child' })).id;
  assert.equal(mock.parents.get(child), parent);
  mock.files.set('901', { id: '901', folderId: child, name: 'old.txt', data: Buffer.from('data') });
  recognition.remember(client.uid, child, { status: 'ordinary' });
  await manager.change('rename', { parentId: child, id: '901', isFolder: false, name: '新名 &+.txt' });
  assert.equal(mock.files.get('901').name, '新名 &+.txt'); assert.equal(recognition.get(client.uid, child), null);
  assert.deepEqual(mock.requests.find(request => request.task === '46').fields, { task: '46', file_id: '901', file_name: '新名 &+.txt', type: '2' });
  await manager.change('rename', { parentId: parent, id: child, isFolder: true, name: 'Renamed' });
  assert.equal(mock.folders.get(child), 'Renamed');
  await manager.change('delete', { parentId: child, id: '901', isFolder: false });
  assert.equal(mock.files.has('901'), false);
  mock.files.set('902', { id: '902', folderId: child, name: 'inside.txt', data: Buffer.from('keep locally') });
  await manager.change('delete', { parentId: '-1', id: parent, isFolder: true });
  assert.equal(mock.folders.has(parent), false); assert.equal(mock.folders.has(child), false); assert.equal(mock.files.has('902'), false);
  assert.deepEqual(mock.requests.filter(request => ['3','6'].includes(request.task)).map(request => request.fields), [{ task: '6', file_id: '901' }, { task: '3', folder_id: parent }]);
});

test('management rejects root, missing/wrong-kind targets, bad names and expired accounts without sending mutations', async t => {
  const { manager, mock, client } = await fixture(t);
  mock.folders.set('700', 'Folder');
  for (const payload of [{ id: '-1', isFolder: true }, { id: '700', isFolder: false }, { id: '999', isFolder: true }]) {
    await assert.rejects(() => manager.change('delete', { parentId: '-1', ...payload }));
  }
  for (const name of ['', 'bad/name', '..', 'x'.repeat(256)]) await assert.rejects(() => manager.change('create', { parentId: '-1', name }));
  assert.equal(mock.requests.some(request => ['2','3','6','4','46'].includes(request.task)), false);
  client.uid = null;
  await assert.rejects(() => manager.change('delete', { parentId: '-1', id: '700', isFolder: true }), /登录/);
});

test('account switches during target lookup and server failures cannot delete or evict a valid cached folder', async t => {
  let rejectDelete = false;
  const { client, mock, engine, recognition } = await fixture(t, { pageReply({ url, fields }) {
    if (rejectDelete && url.pathname === '/doupload.php' && fields.get('task') === '3') return { json: { zt: 4 } };
  } });
  mock.folders.set('700', 'Folder'); recognition.remember(client.uid, '700', { status: 'ordinary' });
  let version = 0;
  const manager = new CloudFiles({ client, engine, recognition, version: () => version });
  const list = client.list.bind(client);
  client.list = async (...args) => { const result = await list(...args); version++; return result; };
  await assert.rejects(() => manager.change('delete', { parentId: '-1', id: '700', isFolder: true }), /账号已变化/);
  assert.equal(mock.folders.has('700'), true);
  client.list = list; rejectDelete = true;
  await assert.rejects(() => manager.change('delete', { parentId: '-1', id: '700', isFolder: true }), /频率/);
  assert.ok(recognition.get(client.uid, '700')); assert.equal(mock.folders.has('700'), true);
});

test('management blocks duplicate submissions and operations that can alter a running transfer', async t => {
  const { manager, client, engine, mock } = await fixture(t);
  mock.folders.set('700', 'Folder');
  engine.tasks.set('active', { ownerUid: client.uid, folderId: '700' }); engine.active.set('active', {});
  try { await assert.rejects(() => manager.change('delete', { parentId: '-1', id: '700', isFolder: true }), /暂停/); }
  finally { engine.tasks.delete('active'); engine.active.delete('active'); }
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const rename = client.renameEntry.bind(client);
  client.renameEntry = async (...args) => { entered(); await gate; return rename(...args); };
  const first = manager.change('rename', { parentId: '-1', id: '700', isFolder: true, name: 'New' }); await started;
  await assert.rejects(() => manager.change('delete', { parentId: '-1', id: '700', isFolder: true }), /正在处理/);
  release(); await first; assert.equal(mock.folders.get('700'), 'New');
});

test('ordinary download uses signed links, real response length, task progress and safe cache/history cleanup', async t => {
  const { dir, engine, mock, manager } = await fixture(t);
  const bytes = Buffer.alloc(17000, 23);
  mock.files.set('901', { id: '901', folderId: '-1', name: '普通文件 &+💾.txt', data: bytes });
  const file = await manager.entry({ parentId: '-1', id: '901', isFolder: false }); file.size = 16000;
  const task = await finish(engine, await engine.createFileDownload(file, path.join(dir, 'output')));
  assert.equal(task.originalSize, bytes.length); assert.equal(task.bytes, bytes.length); assert.equal(task.concurrency, 1); assert.equal(task.manifest, undefined);
  assert.deepEqual(await readFile(task.resultPath), bytes);
  assert.ok(mock.requests.some(request => request.path === '/ajaxm.php'));
  assert.equal(await stat(path.join(task.cachePath, 'file-download.partial')).catch(() => null), null);
  await engine.clearHistory({ scope: 'all' }); assert.deepEqual(await readFile(task.resultPath), bytes);
});

test('ordinary download survives restart, restarts safely on resume and never mixes changed remote bytes', async t => {
  const { dir, mock, engine, client, manager, dataDir } = await fixture(t, { slowDownloads: true });
  mock.files.set('901', { id: '901', folderId: '-1', name: 'resume.bin', data: Buffer.alloc(1024 * 1024, 7) });
  const file = await manager.entry({ parentId: '-1', id: '901', isFolder: false });
  const id = await engine.createFileDownload(file, path.join(dir, 'output'));
  const deadline = Date.now() + 5000;
  while (!(engine.tasks.get(id).bytes > 0)) { assert.ok(Date.now() < deadline); await delay(5); }
  await engine.pause(id); assert.equal(engine.tasks.get(id).state, 'paused');
  const replacement = Buffer.alloc(1024 * 1024 + 1, 8); mock.files.get('901').data = replacement;
  const restarted = new TransferEngine({ client, dataDir }); await restarted.init();
  t.after(() => restarted.pauseAll());
  await restarted.storage.configure({ downloadConcurrency: 8 });
  const task = await finish(restarted, await restarted.resume(id));
  assert.equal(task.concurrency, 1); assert.deepEqual(await readFile(task.resultPath), replacement);
  assert.ok(mock.requests.filter(request => request.path === '/file/901').every(request => !request.range));
});

test('ordinary downloads reject account mismatch, refuse overwrites, preserve results and support empty files', async t => {
  const { dir, mock, manager, engine, client } = await fixture(t);
  mock.files.set('901', { id: '901', folderId: '-1', name: 'empty.txt', data: Buffer.alloc(0) });
  const file = await manager.entry({ parentId: '-1', id: '901', isFolder: false }), output = path.join(dir, 'output');
  const empty = await finish(engine, await engine.createFileDownload(file, output));
  assert.equal((await stat(empty.resultPath)).size, 0);
  const duplicate = await engine.createFileDownload(file, output); await engine.active.get(duplicate)?.promise;
  assert.equal(engine.tasks.get(duplicate).state, 'failed'); assert.match(engine.tasks.get(duplicate).error, /已存在/);
  assert.equal((await stat(empty.resultPath)).size, 0);
  client.uid = '456';
  await assert.rejects(engine.resume(duplicate), /创建此任务的蓝奏云账号/);
  assert.equal(engine.active.has(duplicate), false);
  client.uid = '123'; await engine.clearHistory({ scope: 'all' }); assert.equal((await stat(empty.resultPath)).size, 0);
});

test('ordinary downloads reject truncated bodies and verification HTML, and accept bodies without Content-Length', async t => {
  const { dir, engine, client } = await fixture(t);
  client.downloadLink = async () => ({ url: 'http://127.0.0.1/file', headers: {} });
  client.request = async () => new Response('short', { headers: { 'content-length': '10', 'content-type': 'application/octet-stream' } });
  const file = { id: '901', name: 'broken.bin', isFolder: false, parentId: '-1', size: 10 };
  let id = await engine.createFileDownload(file, path.join(dir, 'output')); await engine.active.get(id)?.promise;
  assert.equal(engine.tasks.get(id).state, 'failed'); assert.match(engine.tasks.get(id).error, /提前中断/);
  assert.equal(await stat(path.join(dir, 'output', file.name)).catch(() => null), null);
  client.request = async () => new Response('<html>verify</html>', { headers: { 'content-type': 'text/html' } });
  id = await engine.createFileDownload(file, path.join(dir, 'output')); await engine.active.get(id)?.promise;
  assert.equal(engine.tasks.get(id).state, 'failed'); assert.equal(engine.tasks.get(id).resultPath, undefined);
  client.request = async () => new Response('unknown length', { headers: { 'content-type': 'application/octet-stream' } });
  const complete = await finish(engine, await engine.createFileDownload(file, path.join(dir, 'output')));
  assert.equal(complete.totalKnown, false); assert.equal(complete.originalSize, 14);
  assert.equal(await readFile(complete.resultPath, 'utf8'), 'unknown length');
});
