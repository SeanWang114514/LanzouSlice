import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes, readFile, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { TransferEngine } from '../src/transfer.mjs';
import { SyncManager, nextSyncTime, syncSchedule } from '../src/sync.mjs';
import { LanzouClient } from '../src/lanzou.mjs';
import { startMockLanzou } from './mock-lanzou.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lanzou-sync-'));
  const source = path.join(directory, 'source'); await mkdir(source);
  const mock = await startMockLanzou(options), client = new LanzouClient({ pcOrigin: mock.origin, accountOrigin: mock.origin });
  const engine = new TransferEngine({ client, dataDir: path.join(directory, 'data'), maxPartBytes: 8192 }); await engine.init(); await client.login('test', 'only-for-fixture');
  const sync = new SyncManager({ engine }); await sync.init();
  t.after(async () => { await sync.close(); await engine.pauseAll(); await mock.close(); await rm(directory, { recursive: true, force: true }); });
  const put = (overrides = {}) => sync.put({ sourcePath: source, schedule: { kind: 'interval', minutes: 5 }, ...overrides });
  return { directory, source, mock, client, engine, sync, put };
}
async function run(sync, id) {
  const rule = sync.own(id); rule.requested = true; await sync.tick();
  assert.equal(rule.state, 'idle', rule.error); return rule;
}

test('schedule validates independent intervals and multiple local daily times', () => {
  assert.deepEqual(syncSchedule({ kind: 'daily', times: ['23:00', '08:30', '08:30'] }).times, ['08:30', '23:00']);
  for (const schedule of [{ kind: 'interval', minutes: 0 }, { kind: 'daily', times: ['24:00'] }, { kind: 'daily', times: [] }]) assert.throws(() => syncSchedule(schedule));
  const now = new Date(2026, 10, 15, 10, 0).getTime();
  assert.equal(nextSyncTime({ kind: 'interval', minutes: 5 }, now), now + 300000);
  assert.equal(nextSyncTime({ kind: 'daily', times: ['08:00', '18:00'] }, now), new Date(2026, 10, 15, 18, 0).getTime());
  assert.equal(nextSyncTime({ kind: 'daily', times: ['08:00'] }, now), new Date(2026, 10, 16, 8, 0).getTime());
});
test('unchanged content and mtime-only changes upload nothing; one change updates only that file', async t => {
  const { source, sync, mock, put } = await fixture(t);
  await mkdir(path.join(source, 'child')); await writeFile(path.join(source, 'a.txt'), 'first'); await writeFile(path.join(source, 'child', 'a.txt'), 'second');
  const id = await put(); const rule = await run(sync, id); assert.equal(rule.stats.added, 2);
  const count = mock.uploadOrder.length, old = rule.entries['a.txt'].id, untouched = rule.entries['child/a.txt'].id;
  const nestedTask = [...sync.engine.tasks.values()].find(task => task.syncRelativePath === 'child/a.txt');
  assert.equal(nestedTask.manifest.naming.relativePath, 'child/a.txt');
  await run(sync, id); assert.equal(rule.stats.skipped, 2); assert.equal(mock.uploadOrder.length, count);
  await utimes(path.join(source, 'a.txt'), new Date(), new Date(Date.now() + 5000));
  await run(sync, id); assert.equal(mock.uploadOrder.length, count);
  await writeFile(path.join(source, 'a.txt'), 'changed'); await run(sync, id);
  assert.equal(rule.stats.updated, 1); assert.equal(rule.stats.skipped, 1); assert.equal(rule.entries['child/a.txt'].id, untouched); assert.equal(mock.folders.has(old), false);
});
test('restart and clearing completed history preserve independent baseline; missing cloud version is repaired', async t => {
  const { source, sync, mock, put, engine } = await fixture(t); await writeFile(path.join(source, 'a'), 'data');
  const id = await put(), rule = await run(sync, id), count = mock.uploadOrder.length;
  await engine.clearHistory(); assert.equal(engine.tasks.size, 0);
  const restarted = new SyncManager({ engine }); await restarted.init(); await run(restarted, id); assert.equal(mock.uploadOrder.length, count);
  mock.files.delete(rule.entries.a.manifestId); await run(restarted, id); assert.equal(restarted.own(id).stats.updated, 1);
  assert.ok(mock.uploadOrder.length > count); await restarted.close();
});
test('deletion defaults off, only tracked entries are deleted, missing source never deletes', async t => {
  const { source, sync, mock, put } = await fixture(t); const file = path.join(source, 'a'); await writeFile(file, 'data');
  const id = await put(), rule = await run(sync, id), old = rule.entries.a.id;
  mock.folders.set('99999', 'unrelated'); mock.parents.set('99999', rule.rootId);
  await rm(file); await run(sync, id); assert.equal(mock.folders.has(old), true);
  await sync.put({ id, sourcePath: source, schedule: rule.schedule, deleteRemoved: true });
  await rename(source, `${source}-moved`); rule.requested = true; await sync.tick(); assert.equal(rule.state, 'error'); assert.equal(mock.folders.has(old), true);
  await rename(`${source}-moved`, source); await run(sync, id); assert.equal(mock.folders.has(old), false); assert.equal(mock.folders.has('99999'), true);
});
test('failed replacement retains old version, pending receipts survive history cleanup and retry', async t => {
  let fail = false;
  const { source, sync, mock, put, engine } = await fixture(t, { pageReply({ url }) { if (fail && url.pathname === '/html5up.php') return { json: { zt: 9 } }; } });
  const file = path.join(source, 'a'); await writeFile(file, 'old'); const id = await put(), rule = await run(sync, id), old = rule.entries.a.id;
  await writeFile(file, 'new'); fail = true; rule.requested = true; await sync.tick(); assert.equal(rule.state, 'error'); assert.equal(rule.entries.a.id, old); assert.equal(mock.folders.has(old), true);
  const pending = rule.pending.id; await engine.clearHistory({ scope: 'all' }); assert.ok(engine.tasks.has(pending));
  fail = false; await sync.client.login('test', 'only-for-fixture');
  const restarted = new SyncManager({ engine }); await restarted.init(); await run(restarted, id); assert.equal(restarted.own(id).pending, null); assert.equal(mock.folders.has(old), false); await restarted.close();
});
test('lost create and upload replies resume the same version without duplicate content', async t => {
  const { source, sync, mock, put } = await fixture(t, { uncertainFolderCreate: true, uncertainUpload: true }); await writeFile(path.join(source, 'a'), 'same');
  const id = await put(), rule = sync.own(id); rule.requested = true; await sync.tick(); assert.equal(rule.state, 'error');
  await run(sync, id); assert.equal(mock.folders.size, 2); assert.equal(mock.uploads.get('part-000001.zip'), 1);
});
test('overlap is rejected and foreign accounts cannot run or remove rules', async t => {
  const { source, sync, put, client } = await fixture(t); await writeFile(path.join(source, 'a'), 'x'); const id = await put();
  await assert.rejects(put({ sourcePath: path.join(source, 'a') }), /重叠/);
  const uid = client.uid; client.uid = 'another'; assert.equal(sync.publicState().rules.length, 0); await assert.rejects(sync.remove(id), /当前账号/); await assert.rejects(sync.request(id), /当前账号/); client.uid = uid;
});
test('manual transfers and management are excluded during scan, multiple triggers do not reenter', async t => {
  const { source, sync, put, engine } = await fixture(t); const file = path.join(source, 'a'); await writeFile(file, 'x'); const id = await put();
  let release; const gate = new Promise(resolve => { release = resolve; }), original = sync.scan.bind(sync);
  sync.scan = async (...args) => { await gate; return original(...args); };
  sync.own(id).requested = true; const running = sync.tick(); assert.equal(engine.syncOwner, id);
  await assert.rejects(engine.createUpload(file), /自动同步/); await sync.tick(); release(); await running; assert.equal(engine.tasks.size, 1);
});
test('overdue plans coalesce once and disabled rules stay stopped', async t => {
  const { source, sync, put } = await fixture(t); await writeFile(path.join(source, 'a'), 'x'); const id = await put();
  let now = Date.now(); sync.now = () => now; const rule = sync.own(id); rule.nextRun = now - 86400000;
  await sync.tick(); const last = rule.lastRun; assert.equal(rule.stats.added, 1); now += 1000; await sync.tick(); assert.equal(rule.lastRun, last);
  await sync.toggle(id, false); now += 86400000; await sync.tick(); assert.equal(rule.lastRun, last);
});
test('a file changed during transfer cannot commit a new successful baseline', async t => {
  const { source, sync, mock, put } = await fixture(t, { uploadDelay: 200 }); const file = path.join(source, 'a'); await writeFile(file, 'before'); const id = await put();
  sync.own(id).requested = true; const running = sync.tick();
  for (let i = 0; i < 200 && !mock.requests.some(request => request.path === '/html5up.php'); i++) await delay(10);
  await writeFile(file, 'after has different size'); await running; const rule = sync.own(id); assert.equal(rule.state, 'error'); assert.equal(Object.keys(rule.entries).length, 0);
  await run(sync, id); assert.equal(rule.stats.added, 1);
});
test('malformed sync journal fails closed and is never overwritten', async t => {
  const { sync, engine } = await fixture(t); await writeFile(sync.file, '{broken'); const recovered = new SyncManager({ engine }); await recovered.init();
  assert.match(recovered.publicState().warning, /停止自动同步/); await assert.rejects(recovered.save()); assert.equal(await readFile(sync.file, 'utf8'), '{broken'); await recovered.close();
});
test('file rules work with a selected cloud parent and do not manage neighboring folders', async t => {
  const { source, sync, mock, put } = await fixture(t); const file = path.join(source, 'single.txt'); await writeFile(file, 'file');
  mock.folders.set('222', 'target'); const id = await put({ sourcePath: file, parentId: '222' }), rule = await run(sync, id);
  assert.equal(mock.parents.get(rule.rootId), '222'); assert.equal(mock.parents.get(rule.entries['single.txt'].id), rule.rootId);
  const root = rule.rootId; await sync.remove(id); assert.equal(mock.folders.has(root), true);
});
test('missing cloud root or a missing part repairs only the affected version', async t => {
  const { source, sync, mock, put, client } = await fixture(t); await writeFile(path.join(source, 'a'), 'file'); const id = await put(), rule = await run(sync, id);
  mock.files.delete(rule.entries.a.partIds[0]); await run(sync, id); assert.equal(rule.stats.updated, 1);
  const oldRoot = rule.rootId; await client.deleteEntry(oldRoot, true); await run(sync, id); assert.notEqual(rule.rootId, oldRoot); assert.ok(mock.folders.has(rule.entries.a.id));
});
test('pending task snapshot alone can recover after its task journal is lost', async t => {
  let fail = true;
  const { source, sync, mock, put, engine } = await fixture(t, { pageReply({ url }) { if (fail && url.pathname === '/html5up.php') return { json: { zt: 9 } }; } });
  await writeFile(path.join(source, 'a'), 'data'); const id = await put(), rule = sync.own(id); rule.requested = true; await sync.tick(); const pending = rule.pending;
  await rm(engine.taskDir(pending.id), { recursive: true, force: true }); engine.tasks.delete(pending.id); fail = false; await sync.client.login('test', 'only-for-fixture');
  const recovered = new SyncManager({ engine }); await recovered.init(); await run(recovered, id); assert.equal(mock.uploads.get('part-000001.zip'), 1); await recovered.close();
});
test('pause stops a rule and resumes without duplicate acknowledged parts', async t => {
  const { source, sync, mock, put } = await fixture(t, { uploadDelay: 180 }); await writeFile(path.join(source, 'a'), Buffer.alloc(20000, 1)); const id = await put();
  sync.own(id).requested = true; const running = sync.tick();
  for (let i = 0; i < 300 && !mock.uploads.has('part-000001.zip'); i++) await delay(10);
  await sync.toggle(id, false); await running; const rule = sync.own(id); assert.equal(rule.enabled, false); assert.equal(rule.state, 'paused'); assert.ok(rule.pending);
  await utimes(path.join(source, 'a'), new Date(), new Date(Date.now() + 5000));
  sync.suspended = false; await run(sync, id); assert.equal(mock.uploads.get('part-000001.zip'), 1);
});
test('turning deletion off after a failed delete preserves baseline and remote content', async t => {
  let failDelete = false;
  const { source, sync, mock, put } = await fixture(t, { pageReply({ url, fields }) { if (failDelete && url.pathname === '/doupload.php' && fields.get('task') === '3') return { json: { zt: 4 } }; } });
  const file = path.join(source, 'a'); await writeFile(file, 'x'); const id = await put({ deleteRemoved: true }), rule = await run(sync, id), old = rule.entries.a.id;
  await rm(file); failDelete = true; rule.requested = true; await sync.tick(); assert.equal(rule.state, 'error'); assert.ok(rule.entries.a);
  rule.deleteRemoved = false; failDelete = false; await run(sync, id); assert.ok(mock.folders.has(old)); assert.ok(rule.entries.a); assert.equal(rule.garbage.length, 0);
});
test('linked subdirectories are skipped and a replaced source link cannot trigger deletion', async t => {
  const { directory, source, sync, mock, put } = await fixture(t); const other = path.join(directory, 'other'); await mkdir(other); await writeFile(path.join(other, 'outside'), 'outside');
  await symlink(other, path.join(source, 'link'), 'junction'); await writeFile(path.join(source, 'a'), 'x'); const id = await put({ deleteRemoved: true }), rule = await run(sync, id);
  assert.deepEqual(Object.keys(rule.entries), ['a']); const old = rule.entries.a.id;
  await rename(source, `${source}-old`); await symlink(other, source, 'junction'); rule.requested = true; await sync.tick(); assert.equal(rule.state, 'error'); assert.ok(mock.folders.has(old));
});
test('two rules serialize with independent schedules while a manual task makes them wait', async t => {
  const { source, directory, sync, put, engine } = await fixture(t, { uploadDelay: 100 });
  const file = path.join(source, 'a'), other = path.join(directory, 'b'); await writeFile(file, 'x'); await writeFile(other, 'y');
  const first = await put(), second = await put({ sourcePath: other, schedule: { kind: 'daily', times: ['08:00', '19:00'] } });
  const manual = await engine.createUpload(file); sync.own(first).requested = sync.own(second).requested = true; await sync.tick(); assert.equal(sync.active, undefined);
  await engine.active.get(manual)?.promise; await sync.tick(); assert.equal(sync.own(first).stats.added, 1); assert.equal(sync.own(second).lastRun, undefined);
  await sync.tick(); assert.equal(sync.own(second).stats.added, 1);
});
test('a managed subtree replaced with a junction is not interpreted as deleted', async t => {
  const { directory, source, sync, mock, put } = await fixture(t); const child = path.join(source, 'child'), other = path.join(directory, 'other'); await mkdir(child); await mkdir(other); await writeFile(path.join(child, 'a'), 'safe');
  const id = await put({ deleteRemoved: true }), rule = await run(sync, id), old = rule.entries['child/a'].id;
  await rename(child, path.join(directory, 'old-child')); await symlink(other, child, 'junction'); rule.requested = true; await sync.tick(); assert.equal(rule.state, 'error'); assert.match(rule.error, /路径变为链接/); assert.ok(mock.folders.has(old));
});
test('account changes while a rule is being created cannot save a cross-account rule', async t => {
  const { source, sync, client } = await fixture(t); const uid = client.uid;
  const pending = sync.put({ sourcePath: source, schedule: { kind: 'interval', minutes: 10 } }); client.uid = 'other';
  await assert.rejects(pending, /账号已变化/); assert.equal(sync.rules.length, 0); client.uid = uid;
});
