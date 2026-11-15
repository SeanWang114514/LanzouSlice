import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startMockLanzou } from '../tests/mock-lanzou.mjs';

await mkdir('.tmp', { recursive: true });
const profile = await mkdtemp(path.resolve('.tmp/sync-profile-')), source = await mkdtemp(path.resolve('.tmp/sync-source-'));
const output = path.resolve('.tmp/sync-smoke'); await mkdir(output, { recursive: true });
await mkdir(path.join(source, '子目录')); await writeFile(path.join(source, '文档.txt'), Buffer.alloc(512000, 5)); await writeFile(path.join(source, '子目录', '文档.txt'), Buffer.alloc(512000, 6));
const mock = await startMockLanzou({ rejectSpecialFolderNames: true, uploadDelay: 120 });
mock.folders.set('888', '同步目标');
try {
  const packaged = process.argv[2], executable = path.resolve(packaged || 'node_modules/electron/dist/electron.exe');
  const child = spawn(executable, [...(packaged ? [] : ['.']), '--smoke-test', '--smoke-sync', `--test-data=${profile}`, `--smoke-output=${output}`, `--smoke-api=${mock.origin}`, `--smoke-sync-source=${source}`], { stdio: 'pipe', windowsHide: true });
  child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.on('data', chunk => process.stderr.write(chunk));
  const timer = setTimeout(() => child.kill(), 90000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, 'Electron sync checks failed');
  const state = JSON.parse(await readFile(path.join(profile, 'sync-rules.json'), 'utf8'));
  assert.equal(state.rules.length, 1); assert.equal(state.rules[0].sourceKind, 'file');
  assert.equal(mock.folders.has('888'), true, 'removing rules must preserve parent folders');
  assert.equal(mock.maxUploads, 3, '同步的多个文件和切片必须共享三路并发预算');
  console.log('SYNC_DESKTOP_OK', JSON.stringify({ profile, output, uploads: mock.uploadOrder.length, maxConcurrentUploads: mock.maxUploads, network: 'loopback fixture only' }));
} finally { await mock.close(); }
