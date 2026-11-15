// Native Windows login-item regression. Uses unique temporary entries and always removes them.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'win32') throw new Error('此检查需要 Windows，不会用模拟 API 代替');
if (!process.versions.electron) {
  const { default: executable } = await import('electron');
  const child = spawn(executable, [path.resolve('scripts/windows-startup.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, 'Windows 启动项原生检查失败');
} else {
  const { app } = await import('electron');
  const target = path.resolve(process.argv[2] || process.execPath), output = path.resolve(process.argv[3] || '.tmp/windows-startup');
  const modulePath = process.argv[2] ? path.join(path.dirname(target), 'resources/app.asar/src/desktop-lifecycle.mjs') : path.resolve('src/desktop-lifecycle.mjs');
  const { DesktopLifecycle } = await import(pathToFileURL(modulePath).href);
  const profile = path.join(output, `profile-${randomUUID()}`);
  mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
  app.whenReady().then(async () => {
  const name = `LanzouSlice-StartupCheck-${randomUUID()}`, otherName = `${name}-other`;
  const options = { name, path: target, args: ['--autostart'] }, features = {}, observations = [];
  let failure;
  try {
    assert.ok((await stat(target)).isFile()); await mkdir(output, { recursive: true });
    const storage = { settings: { openAtLogin: false, startHidden: false, closeToTray: false }, async configure(patch) { Object.assign(this.settings, patch); } };
    const loginItems = {
      getLoginItemSettings(options) { const value = app.getLoginItemSettings(options); observations.push({ operation: 'get', value }); return value; },
      setLoginItemSettings(options) { app.setLoginItemSettings(options); observations.push({ operation: 'set', options }); }
    };
    const desktop = new DesktopLifecycle({ app, window: new EventEmitter(), storage, loginItems, isQuitting: () => false, startupSupported: true });
    desktop.loginOptions = options;
    assert.equal(app.getLoginItemSettings(options).launchItems.some(item => item.name === name), false);
    app.setLoginItemSettings({ ...options, name: otherName, args: ['--other'], openAtLogin: true, enabled: true });
    await desktop.configure({ openAtLogin: true });
    const enabled = app.getLoginItemSettings(options), own = enabled.launchItems.find(item => item.name === name && item.scope === 'user');
    assert.equal(enabled.openAtLogin, false); assert.equal(own.enabled, true);
    assert.equal(path.normalize(own.path).toLowerCase(), target.toLowerCase()); assert.deepEqual(own.args, []);
    const command = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', name], { windowsHide: true });
    assert.ok(command.includes(Buffer.from('--autostart')));
    assert.equal(storage.settings.openAtLogin, true); features.customNameRegisteredDespiteDefaultFlagFalse = true;
    desktop.initialize(); assert.equal(desktop.warning, ''); features.initializationRecognizesRegistration = true;
    app.setLoginItemSettings({ ...options, openAtLogin: true, enabled: false });
    assert.equal(app.getLoginItemSettings(options).executableWillLaunchAtLogin, true);
    assert.deepEqual(desktop.getLoginItemSettings(), { openAtLogin: true, executableWillLaunchAtLogin: false });
    desktop.initialize(); assert.match(desktop.warning, /Windows/); features.disabledItemNotMaskedByAnotherEntry = true;
    const save = storage.configure;
    storage.configure = async () => { throw new Error('startup check disk failure'); };
    await assert.rejects(() => desktop.configure({ openAtLogin: true }), /startup check disk failure/);
    assert.deepEqual(desktop.getLoginItemSettings(), { openAtLogin: true, executableWillLaunchAtLogin: false }); features.diskFailureRestoresDisabledRegistration = true;
    storage.configure = save;
    await desktop.configure({ openAtLogin: true }); assert.equal(desktop.warning, '');
    assert.equal(desktop.getLoginItemSettings().executableWillLaunchAtLogin, true); features.reenableWorks = true;
    await desktop.configure({ openAtLogin: false });
    assert.deepEqual(desktop.getLoginItemSettings(), { openAtLogin: false, executableWillLaunchAtLogin: false });
    assert.equal(storage.settings.openAtLogin, false); features.disableRemovesOwnEntry = true;
    assert.equal(app.getLoginItemSettings(options).launchItems.find(item => item.name === otherName)?.enabled, true); features.otherEntryPreserved = true;
  } catch (error) { failure = error; }
  finally {
    for (const entry of [name, otherName]) app.setLoginItemSettings({ ...options, name: entry, openAtLogin: false });
    const remaining = app.getLoginItemSettings(options).launchItems.filter(item => [name, otherName].includes(item.name));
    assert.deepEqual(remaining, []); features.temporaryEntriesRemoved = true;
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'windows-startup.json'), JSON.stringify({ target, modulePath, electron: process.versions.electron, features, observations, temporaryNames: [name, otherName], systemRebootTested: false, error: failure?.stack || null }, null, 2));
    if (failure) console.error(failure);
    console.log('WINDOWS_STARTUP_CHECK', JSON.stringify(features)); app.exit(failure ? 1 : 0);
  }
  }).catch(error => { console.error(error); app.exit(1); });
}
