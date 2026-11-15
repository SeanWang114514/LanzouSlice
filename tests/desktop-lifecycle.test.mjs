import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStorage } from '../src/storage.mjs';
import { DesktopLifecycle } from '../src/desktop-lifecycle.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'slice-tray-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new LocalStorage(dir); await storage.init();
  const window = new EventEmitter(), app = { quits: 0, quit() { this.quits++; } }, requests = [];
  let visible = true, minimized = false, quitting = false, item = { openAtLogin: false, executableWillLaunchAtLogin: false };
  Object.assign(window, { isDestroyed: () => false, isVisible: () => visible, isMinimized: () => minimized, restore: () => { minimized = false; }, show: () => { visible = true; }, hide: () => { visible = false; }, focus() {}, webContents: { send: channel => requests.push(channel) } });
  class Tray extends EventEmitter { isDestroyed() { return Boolean(this.dead); } destroy() { this.dead = true; } setToolTip() {} setContextMenu(menu) { this.menu = menu; } }
  const Menu = { buildFromTemplate: items => ({ getMenuItemById: id => items.find(item => item.id === id) }) };
  const calls = [], loginItems = {
    // A custom registry name does not change Electron's default AppUserModelID lookup.
    getLoginItemSettings: () => ({ openAtLogin: false, executableWillLaunchAtLogin: item.executableWillLaunchAtLogin, launchItems: item.openAtLogin ? [{ name: 'LanzouSlice', path: process.execPath, args: [], scope: 'user', enabled: item.executableWillLaunchAtLogin }] : [] }),
    setLoginItemSettings: value => { calls.push(value); item = { openAtLogin: value.openAtLogin, executableWillLaunchAtLogin: value.openAtLogin && value.enabled }; }
  };
  const desktop = new DesktopLifecycle({ app, window, Tray, Menu, storage, icon: '', isQuitting: () => quitting, loginItems, startupSupported: true, ...options });
  t.after(() => desktop.destroy());
  return { dir, storage, desktop, window, app, calls, requests, loginItems, setQuitting: value => { quitting = value; }, minimize: () => { minimized = true; }, get item() { return item; } };
}

test('desktop switches default off, persist independently and reject invalid saved values', async t => {
  const { storage, dir } = await fixture(t);
  for (const key of ['openAtLogin', 'startHidden', 'closeToTray']) {
    assert.equal(storage.settings[key], false);
    await assert.rejects(() => storage.configure({ [key]: 'true' }), /无效/);
  }
  await storage.configure({ startHidden: true, closeToTray: true });
  const restored = new LocalStorage(dir); await restored.init();
  assert.equal(restored.settings.startHidden, true); assert.equal(restored.settings.closeToTray, true); assert.equal(restored.settings.openAtLogin, false);
  await writeFile(storage.file, JSON.stringify({ startHidden: 1, openAtLogin: 'yes', closeToTray: null, uploadConcurrency: 3 }));
  const legacy = new LocalStorage(dir); await legacy.init();
  assert.equal(legacy.settings.uploadConcurrency, 3);
  for (const key of ['openAtLogin', 'startHidden', 'closeToTray']) assert.equal(legacy.settings[key], false);
});

test('login item registration targets this executable and changes only on explicit settings', async t => {
  const { desktop, calls, storage } = await fixture(t); desktop.initialize(); assert.equal(calls.length, 0);
  await desktop.configure({ openAtLogin: true });
  assert.equal(calls[0].path, process.execPath); assert.deepEqual(calls[0].args, ['--autostart']); assert.equal(calls[0].name, 'LanzouSlice'); assert.equal(calls[0].enabled, true);
  assert.equal(storage.settings.openAtLogin, true);
  desktop.initialize(); assert.equal(desktop.warning, '');
  await desktop.configure({ openAtLogin: false }); assert.equal(calls.at(-1).openAtLogin, false); assert.equal(storage.settings.openAtLogin, false);
  await storage.configure({ openAtLogin: true }); desktop.initialize(); assert.match(desktop.warning, /Windows/);
  await desktop.configure({ autoCleanCache: false }); assert.match(desktop.warning, /Windows/);
  const unsupported = await fixture(t, { startupSupported: false });
  await assert.rejects(() => unsupported.desktop.configure({ openAtLogin: true }), /成品版/); assert.equal(unsupported.calls.length, 0);
});

test('custom startup entry is checked by user scope, not default or executable-wide flags', async t => {
  const f = await fixture(t);
  const own = { name: 'LanzouSlice', path: process.execPath, args: [], scope: 'user', enabled: true };
  let entries = [own];
  f.loginItems.getLoginItemSettings = () => ({ openAtLogin: false, executableWillLaunchAtLogin: true, launchItems: entries });
  assert.deepEqual(f.desktop.getLoginItemSettings(), { openAtLogin: true, executableWillLaunchAtLogin: true });
  await f.storage.configure({ openAtLogin: true }); f.desktop.initialize(); assert.equal(f.desktop.warning, '');
  for (const patch of [{ name: 'OtherApp' }, { scope: 'machine' }]) {
    entries = [{ ...own, ...patch }];
    assert.deepEqual(f.desktop.getLoginItemSettings(), { openAtLogin: false, executableWillLaunchAtLogin: false });
  }
  entries = [{ ...own, enabled: false }, { ...own, name: 'OtherApp' }];
  assert.deepEqual(f.desktop.getLoginItemSettings(), { openAtLogin: true, executableWillLaunchAtLogin: false });
  f.desktop.initialize(); assert.match(f.desktop.warning, /Windows/);
});

test('unapplied startup writes still fail and do not save or leave a temporary tray', async t => {
  for (const disabled of [false, true]) {
    const f = await fixture(t);
    f.loginItems.setLoginItemSettings = value => {
      f.calls.push(value);
      f.loginItems.getLoginItemSettings = () => ({ openAtLogin: false, executableWillLaunchAtLogin: true, launchItems: disabled && value.openAtLogin ? [{ name: 'LanzouSlice', path: process.execPath, args: ['--autostart'], scope: 'user', enabled: false }] : [] });
    };
    await assert.rejects(() => f.desktop.configure({ openAtLogin: true, startHidden: true }), /Windows 未应用/);
    assert.equal(f.storage.settings.openAtLogin, false); assert.equal(f.storage.settings.startHidden, false); assert.equal(f.desktop.tray, null);
    assert.equal(f.calls.at(-1).openAtLogin, false);
  }
});

test('disk failure preserves a registered but system-disabled custom startup item', async t => {
  const f = await fixture(t);
  f.loginItems.setLoginItemSettings({ ...f.desktop.loginOptions, openAtLogin: true, enabled: false });
  f.storage.configure = async () => { throw new Error('disk full'); };
  await assert.rejects(() => f.desktop.configure({ openAtLogin: true }), /disk full/);
  assert.equal(f.item.openAtLogin, true); assert.equal(f.item.executableWillLaunchAtLogin, false);
  assert.equal(f.calls.at(-1).enabled, false); assert.equal(f.desktop.warning, '');
});

test('failed disk save rolls back login item and temporary tray without enabling a hidden start', async t => {
  const f = await fixture(t); const original = f.storage.configure.bind(f.storage);
  f.storage.configure = async () => { throw new Error('disk full'); };
  await assert.rejects(() => f.desktop.configure({ openAtLogin: true, startHidden: true }), /disk full/);
  assert.equal(f.item.openAtLogin, false); assert.equal(f.storage.settings.startHidden, false); assert.equal(f.desktop.tray, null); assert.equal(f.window.isVisible(), true);
  f.storage.configure = original;
  await Promise.all([f.desktop.configure({ openAtLogin: true }), f.desktop.configure({ openAtLogin: false, closeToTray: true })]);
  assert.equal(f.item.openAtLogin, false); assert.equal(f.storage.settings.closeToTray, true);
  assert.equal(JSON.parse(await readFile(f.storage.file, 'utf8')).openAtLogin, false);
});

test('tray close preserves the window, restores minimized windows and exposes a real exit', async t => {
  const f = await fixture(t); await f.desktop.configure({ closeToTray: true });
  let prevented = false; f.window.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.window.isVisible(), false); assert.equal(f.app.quits, 0);
  f.minimize(); f.desktop.tray.emit('click'); assert.equal(f.window.isVisible(), true); assert.equal(f.window.isMinimized(), false);
  f.desktop.menu.getMenuItemById('open-settings').click(); assert.ok(f.requests.includes('app:open-settings'));
  f.desktop.menu.getMenuItemById('quit-app').click(); assert.equal(f.app.quits, 1);
  f.setQuitting(true); prevented = false; f.window.emit('close', { preventDefault() { prevented = true; } }); assert.equal(prevented, false);
});

test('silent start retains its tray independently; disabling both modes cannot strand a hidden window', async t => {
  const f = await fixture(t); await f.desktop.configure({ startHidden: true });
  f.window.hide(); f.desktop.apply(); assert.ok(f.desktop.tray); assert.equal(f.window.isVisible(), false);
  await f.desktop.configure({ startHidden: false }); assert.equal(f.desktop.tray, null); assert.equal(f.window.isVisible(), true);
  await f.desktop.configure({ closeToTray: true }); f.window.emit('query-session-end');
  let prevented = false; f.window.emit('close', { preventDefault() { prevented = true; } }); assert.equal(prevented, false);
});

test('unavailable tray prevents silent settings from saving and reports startup fallback', async t => {
  const f = await fixture(t, { Tray: class { constructor() { throw new Error('tray unavailable'); } } });
  await assert.rejects(() => f.desktop.configure({ startHidden: true }), /tray unavailable/); assert.equal(f.storage.settings.startHidden, false);
  await f.storage.configure({ startHidden: true }); f.desktop.initialize(); assert.match(f.desktop.warning, /已显示主窗口/); assert.equal(f.desktop.tray, undefined);
});
