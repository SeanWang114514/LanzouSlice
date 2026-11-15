import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startMockLanzou } from '../tests/mock-lanzou.mjs';

const output = path.resolve(process.argv[3] || '.tmp/lifecycle-smoke'); await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.resolve('.tmp/lifecycle-profile-'));
const packaged = process.argv[2], executable = path.resolve(packaged || 'node_modules/electron/dist/electron.exe');
const mock = await startMockLanzou({ rejectSpecialFolderNames: true, uploadDelay: 450 });
try {
  for (const phase of ['setup', 'restart']) {
    const child = spawn(executable, [...(packaged ? [] : ['.']), '--smoke-test', '--smoke-lifecycle', `--lifecycle-phase=${phase}`, `--test-data=${profile}`, `--smoke-output=${output}`, `--smoke-api=${mock.origin}`], { stdio: 'pipe' });
    child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.on('data', chunk => process.stderr.write(chunk));
    const timer = setTimeout(() => child.kill(), 70000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, `${phase} lifecycle checks failed`);
  }
  const settings = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'));
  assert.equal(settings.startHidden, false); assert.equal(settings.closeToTray, true); assert.equal(settings.openAtLogin, false); assert.equal(settings.browserView, 'raw');
  const { taskId } = JSON.parse(await readFile(path.join(output, 'shutdown-task.json'), 'utf8'));
  const task = JSON.parse(await readFile(path.join(profile, 'tasks', taskId, 'task.json'), 'utf8')); assert.equal(task.state, 'paused');
  const report = { profile, output, startup: 'mocked login-item API; no registry changes or reboot', network: 'loopback only', savedOnQuit: true, repeatedQuitWaits: true, pausedOnQuit: task.state, uploads: mock.uploadOrder.length };
  await writeFile(path.join(output, 'lifecycle-summary.json'), JSON.stringify(report, null, 2));
  console.log('LIFECYCLE_DESKTOP_OK', JSON.stringify(report));
} finally { await mock.close(); }
