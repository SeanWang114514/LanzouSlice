import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FolderRecognition } from '../src/folder-recognition.mjs';

const preview = name => ({ status: 'preview', originalName: name, originalSize: 100, totalParts: 2 });
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lanzou-recognition-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cache = new FolderRecognition({ dataDir, identify: async () => preview('软件 &+💾.exe'), ...options });
  await cache.init(); return cache;
}

test('recognition persists account-scoped display hints, with no download keys or credentials', async t => {
  const cache = await fixture(t);
  cache.remember('123', '10', { ...preview('安装 [版本] &+💾.exe'), key: 'not-a-bundle', password: 'secret', url: 'https://temporary.invalid' }, 'sliceabc');
  await cache.save();
  const recovered = new FolderRecognition({ dataDir: path.dirname(cache.file) }); await recovered.init();
  assert.equal(recovered.get('123', '10', 'sliceabc').originalName, '安装 [版本] &+💾.exe');
  assert.equal(recovered.get('456', '10', 'sliceabc'), null);
  assert.equal(recovered.get('123', '10').key, undefined);
  const contents = await readFile(cache.file, 'utf8');
  for (const secret of ['not-a-bundle', 'secret', 'temporary.invalid']) assert.equal(contents.includes(secret), false);
});

test('fresh recognition avoids scans; stale hints display immediately and refresh in the background', async t => {
  let now = 1_000_000, calls = 0;
  const cache = await fixture(t, { now: () => now, identify: async () => { calls++; return preview('新原名.exe'); } });
  cache.remember('123', '10', preview('旧原名.exe'), 'sliceabc');
  const folders = [{ id: '10', name: 'sliceabc' }];
  assert.equal((await cache.scan('123', folders))[0].cached, true); assert.equal(calls, 0);
  now += 300_000;
  assert.equal(cache.get('123', '10').originalName, '旧原名.exe'); assert.equal(cache.get('123', '10').stale, true);
  await cache.scan('123', folders);
  assert.equal(calls, 1); assert.equal(cache.get('123', '10').originalName, '新原名.exe');
  await cache.scan('123', folders, { force: true }); assert.equal(calls, 2);
  now += 7 * 24 * 60 * 60 * 1000 + 1; assert.equal(cache.get('123', '10'), null);
});

test('ordinary folders are cached briefly and can later become slice folders', async t => {
  let now = 1_000_000, calls = 0;
  const cache = await fixture(t, { now: () => now, identify: async () => { calls++; return preview('新增文件.exe'); } });
  cache.remember('123', '10', { status: 'ordinary' }, '资料');
  assert.equal((await cache.scan('123', [{ id: '10', name: '资料' }]))[0].status, 'ordinary'); assert.equal(calls, 0);
  now += 60_000; assert.equal(cache.get('123', '10').stale, true);
  await cache.scan('123', [{ id: '10', name: '资料' }]); assert.equal(calls, 1); assert.equal(cache.get('123', '10').status, 'preview');
  cache.remember('123', '10', { status: 'ordinary' }, '资料');
  assert.equal(cache.get('123', '10').originalName, undefined);
  assert.equal(cache.get('123', '10', '改名后的资料'), null);
});

test('fast results stream before a slow sibling; folder scanning stays bounded at two workers', async t => {
  let releaseSlow, active = 0, peak = 0;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  let firstResult; const streamed = new Promise(resolve => { firstResult = resolve; });
  const seen = [];
  const cache = await fixture(t, { identify: async id => {
    active++; peak = Math.max(peak, active);
    try { if (id === '10') await slow; return id === '11' ? { status: 'ordinary' } : preview(`原名${id}.exe`); }
    finally { active--; }
  } });
  let settled = false;
  const scan = cache.scan('123', ['10', '11', '12', '13'].map(id => ({ id })), { onResult(result) { seen.push(result.id); firstResult(result); } }).then(results => { settled = true; return results; });
  try {
    assert.equal((await streamed).id, '11'); assert.equal(settled, false); assert.equal(seen.includes('10'), false);
  } finally { releaseSlow(); }
  assert.equal((await scan).length, 4); assert.equal(peak, 2);
});

test('cancelled navigation never publishes or caches a late recognition result', async t => {
  let release, started; const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const cache = await fixture(t, { identify: async () => { started(); await gate; return preview('迟到.exe'); } });
  const controller = new AbortController(), results = [];
  const scan = cache.scan('123', [{ id: '10' }], { signal: controller.signal, onResult: result => results.push(result) });
  await ready; controller.abort(); release();
  await assert.rejects(scan, { name: 'AbortError' }); assert.equal(results.length, 0); assert.equal(cache.get('123', '10'), null);
});

test('failed refresh removes stale slice hints and remains retryable; expired authentication cancels siblings', async t => {
  const cache = await fixture(t, { identify: async () => { throw new Error('切片缺失'); } });
  cache.remember('123', '10', preview('旧.exe'));
  const results = await cache.scan('123', [{ id: '10' }], { force: true });
  assert.equal(results[0].status, 'unavailable'); assert.equal(cache.get('123', '10'), null);
  cache.identify = async () => { const error = new Error('登录过期'); error.code = 'AUTH_EXPIRED'; throw error; };
  const seen = [];
  await assert.rejects(() => cache.scan('123', [{ id: '10' }, { id: '11' }], { onResult: result => seen.push(result) }), { code: 'AUTH_EXPIRED' });
  assert.equal(seen.length, 0);
});

test('damaged cache and invalid entries do not block browsing; cache stays bounded', async t => {
  const cache = await fixture(t);
  await writeFile(cache.file, '{broken'); await cache.init(); assert.equal(cache.entries.size, 0);
  cache.remember('123', '10', { ...preview('bad'), originalSize: -1 });
  cache.remember('../', '10', preview('bad')); cache.remember('123', '10', { status: 'unavailable' });
  assert.equal(cache.entries.size, 0);
  for (let id = 1; id <= 1005; id++) cache.remember('123', String(id), { status: 'ordinary' });
  assert.equal(cache.entries.size, 1000); assert.equal(cache.get('123', '1'), null);
  await Promise.all([cache.save(), cache.save()]);
  assert.equal(JSON.parse(await readFile(cache.file, 'utf8')).entries.length, 1000);
});
