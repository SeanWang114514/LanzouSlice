import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const output = path.resolve(process.argv[3] || '.tmp/transfer-smoke'); await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.resolve('.tmp/transfer-profile-'));
const packaged = process.argv[2], executable = path.resolve(packaged || 'node_modules/electron/dist/electron.exe');
const child = spawn(executable, [...(packaged ? [] : ['.']), '--smoke-test', '--smoke-transfers', `--test-data=${profile}`, `--smoke-output=${output}`], { stdio: 'inherit' });
const timer = setTimeout(() => child.kill(), 60000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
assert.equal(code, 0, 'Transfer UI checks failed');
