import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TransferEngine } from '../src/transfer.mjs';
import { SyncManager } from '../src/sync.mjs';

test('display snapshots omit transfer internals; progress notifications build no unused task lists', () => {
  const engine = new TransferEngine({ client: {}, dataDir: os.tmpdir() });
  engine.tasks.set('one', { id: 'one', state: 'running', originalName: 'a', originalSize: 42, bytes: 21, progress: 0.5,
    sourcePath: 'private', source: { url: 'private' }, password: 'private', receipts: { '0': { sha256: 'private' } }, files: [{ id: 1 }],
    manifest: { originalName: '原名', originalSize: 42, parts: [1] }, cachePath: 'cache' });
  const task = engine.publicTasks()[0];
  for (const key of ['sourcePath', 'password', 'receipts', 'files', 'manifest']) assert.equal(Object.hasOwn(task, key), false);
  assert.equal(task.source.url, undefined);
  assert.equal(task.originalName, '原名'); assert.equal(task.bytes, 21); assert.equal(task.totalParts, 1); assert.equal(task.cachePath, 'cache');
  let snapshots = 0, updates = 0;
  const original = engine.publicTasks.bind(engine); engine.publicTasks = () => { snapshots++; return original(); };
  engine.on('update', () => updates++); engine.notify(true); engine.notify();
  assert.equal(updates, 1); assert.equal(snapshots, 0);
  let change; engine.on('change', tasks => { change = tasks; }); engine.notify(true);
  assert.equal(updates, 2); assert.equal(snapshots, 1); assert.equal(change[0].id, 'one');
});

test('serialized task writes release finished promises and retain the newest journal', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slice-perf-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new TransferEngine({ client: {}, dataDir: directory }), task = { id: randomUUID(), state: 'paused', bytes: 1 };
  const first = engine.persist(task); task.bytes = 2; const second = engine.persist(task);
  await Promise.all([first, second]);
  assert.equal(engine.persistQueue.size, 0);
  assert.equal(JSON.parse(await readFile(path.join(engine.taskDir(task.id), 'task.json'), 'utf8')).bytes, 2);
});

test('sync scheduling sleeps without eligible rules and rearms after manual work', async t => {
  const client = { loggedIn: true, uid: 'owner' }, engine = new TransferEngine({ client, dataDir: os.tmpdir() });
  let busy = false, runs = 0;
  const sync = new SyncManager({ engine, busy: () => busy }); t.after(() => sync.close());
  sync.start(); assert.equal(sync.timer, null);
  const rule = { id: randomUUID(), ownerUid: 'owner', enabled: true, pending: [], nextRun: Date.now() + 100000 };
  sync.rules.push(rule); sync.schedule(); assert.ok(sync.timer);
  client.loggedIn = false; sync.schedule(); assert.equal(sync.timer, null);
  client.loggedIn = true; busy = true; rule.nextRun = Date.now() - 1; sync.schedule(); assert.equal(sync.timer, null);
  sync.run = async () => { runs++; rule.enabled = false; sync.active = null; engine.syncOwner = null; };
  busy = false; engine.notify(true); await delay(30);
  assert.equal(runs, 1); assert.equal(sync.timer, null);
  rule.requested = true; sync.run = async () => { runs++; rule.requested = false; sync.active = null; engine.syncOwner = null; };
  sync.schedule(); await delay(30); assert.equal(runs, 2); assert.equal(sync.timer, null);
  await sync.close(); assert.equal(engine.listenerCount('update'), 0);
});

test('restoring a session rearms future sync plans without an engine event', async t => {
  const client = { loggedIn: false, uid: 'owner' }, engine = new TransferEngine({ client, dataDir: os.tmpdir() });
  const sync = new SyncManager({ engine }); t.after(() => sync.close());
  sync.rules.push({ id: randomUUID(), ownerUid: 'owner', enabled: true, pending: [], nextRun: Date.now() + 100000 });
  sync.start(); assert.equal(sync.timer, null);
  client.loggedIn = true; sync.wake(); await delay(20); assert.ok(sync.timer);
  await sync.pauseAll(); assert.equal(sync.timer, null);
  sync.wake(); await delay(20); assert.ok(sync.timer);
});
