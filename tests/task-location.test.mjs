import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openTaskFolder } from '../src/task-location.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lanzou-location-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, '测试 [安装包] &+💾.zip');
  await writeFile(file, 'result');
  const calls = [], shell = { showItemInFolder: value => calls.push(['reveal', value]), openPath: async value => { calls.push(['open', value]); return ''; } };
  return { directory, file, calls, shell };
}

test('completed sliced and ordinary downloads reveal their exact saved result', async t => {
  const { directory, file, calls, shell } = await fixture(t);
  for (const downloadKind of [undefined, 'file']) await openTaskFolder({ type: 'download', downloadKind, state: 'completed', outputDir: directory, resultPath: file }, shell);
  assert.deepEqual(calls, [['reveal', file], ['reveal', file]]);
});

test('running, paused and failed downloads can open the download directory before merging', async t => {
  const { directory, calls, shell } = await fixture(t);
  for (const state of ['running', 'paused', 'failed']) await openTaskFolder({ type: 'download', state, outputDir: directory }, shell);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ['open', directory]));
});

test('uploads reveal the original source file without exposing source paths to the renderer', async t => {
  const { file, calls, shell } = await fixture(t);
  for (const state of ['running', 'completed']) await openTaskFolder({ type: 'upload', state, sourcePath: file }, shell);
  assert.deepEqual(calls, [['reveal', file], ['reveal', file]]);
});

test('moved results and sources fall back to their existing parent directory', async t => {
  const { directory, calls, shell } = await fixture(t);
  const missing = path.join(directory, 'moved.zip');
  await openTaskFolder({ type: 'download', outputDir: directory, resultPath: missing }, shell);
  await openTaskFolder({ type: 'upload', sourcePath: missing }, shell);
  assert.deepEqual(calls, [['open', directory], ['open', directory]]);
});

test('invalid tasks, relative paths, absent folders and non-directory targets never reach the shell', async t => {
  const { directory, file, calls, shell } = await fixture(t);
  for (const task of [undefined, { type: 'other' }, { type: 'upload' }, { type: 'download', outputDir: 'relative' }, { type: 'download', outputDir: directory, resultPath: 'relative.zip' }, { type: 'download', outputDir: path.join(directory, 'missing') }, { type: 'download', outputDir: file }]) await assert.rejects(openTaskFolder(task, shell));
  assert.deepEqual(calls, []);
});

test('Explorer launch failures are returned as user-visible errors', async t => {
  const { directory, shell } = await fixture(t);
  shell.openPath = async () => 'test launch error';
  await assert.rejects(openTaskFolder({ type: 'download', outputDir: directory }, shell), /无法打开所在文件夹.*test launch error/);
});
