import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(process.argv[2] || '.');
const output = path.resolve(process.argv[3] || '.tmp/performance-after');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), [root, '--smoke-test', '--smoke-performance', `--test-data=${profile}`, `--smoke-output=${output}`], { stdio: 'inherit', windowsHide: true });
const timer = setTimeout(() => child.kill(), 60000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
assert.equal(code, 0, '性能场景检查失败');
