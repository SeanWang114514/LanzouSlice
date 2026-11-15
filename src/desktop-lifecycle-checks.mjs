// Isolated native-window checks; Windows login-item writes use the smoke adapter.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

export async function checkLifecycle(window, { app, desktop, engine, sync, outputDir, phase }) {
  const web = window.webContents, evaluate = code => web.executeJavaScript(code);
  const call = (action, payload = {}) => evaluate(`window.lanzou.call(${JSON.stringify(action)},${JSON.stringify(payload)})`);
  const features = {}, layouts = [];
  async function until(check, label) {
    const deadline = Date.now() + 25000;
    while (!await check()) { if (Date.now() > deadline) throw new Error(`启动与托盘检查超时：${label}`); await delay(30); }
  }
  async function toggle(id, key, value) {
    await evaluate(`document.querySelector('#${id}').click()`);
    await until(() => engine.storage.settings[key] === value, key);
    await until(() => evaluate(`!document.querySelector('#${id}').disabled&&document.querySelector('#${id}').checked===${value}`), `${key} UI`);
  }
  if (phase === 'setup') {
    await until(() => window.isVisible(), 'normal startup visible'); assert.equal(desktop.tray, undefined);
    for (const key of ['openAtLogin', 'startHidden', 'closeToTray']) assert.equal(engine.storage.settings[key], false);
    features.defaultsOff = true;
    await evaluate(`document.querySelector('#tab-settings').click()`);
    await until(() => evaluate(`!document.querySelector('#open-at-login').disabled`), 'settings ready');
    await toggle('open-at-login', 'openAtLogin', true);
    assert.equal(desktop.loginItems.getLoginItemSettings().openAtLogin, false);
    assert.equal(desktop.getLoginItemSettings().openAtLogin, true);
    await toggle('open-at-login', 'openAtLogin', false);
    assert.equal(desktop.getLoginItemSettings().openAtLogin, false);
    features.startupAdapter = true;
    await toggle('start-hidden', 'startHidden', true);
    await toggle('close-to-tray', 'closeToTray', true);
    assert.equal(window.isVisible(), true); assert.ok(desktop.tray && !desktop.tray.isDestroyed());
    features.liveSettingsAndTray = true;
    for (const [width, height] of [[940, 700], [1260, 900], [1920, 1080]]) {
      window.setContentSize(width, height); await delay(200);
      for (const id of ['open-at-login', 'start-hidden', 'close-to-tray']) {
        // Native occlusion can pause animation frames; the hit check below forces layout.
        await evaluate(`document.querySelector('#${id}').scrollIntoView({block:'center'})`); await delay(100);
        const fit = await evaluate(`(()=>{const n=document.querySelector('#${id}'),r=n.getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,id:n.id,clickable:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n}})()`);
        assert.equal(fit.width, width); assert.ok(fit.scrollWidth <= width && fit.clickable, JSON.stringify(fit)); layouts.push(fit);
      }
      await evaluate(`window.scrollTo(0,0);document.querySelector('#notice').hidden=true`); await delay(200);
      await writeFile(path.join(outputDir, `settings-${width}x${height}.png`), (await web.capturePage()).toPNG());
    }
    window.setContentSize(1260, 900);
    await call('login', { account: 'test', password: 'only-for-fixture', remember: false });
    const source = path.join(outputDir, '托盘后台传输.bin'); await writeFile(source, Buffer.alloc(32768, 53));
    const ruleId = await call('saveSync', { sourcePath: source, name: '托盘后台同步', schedule: { kind: 'interval', minutes: 30 }, enabled: false });
    const taskId = await call('upload', { path: source });
    await until(() => engine.tasks.get(taskId)?.state === 'running', 'upload running');
    await call('runSync', { id: ruleId });
    await evaluate(`document.querySelector('#window-close').click()`);
    await until(() => !window.isVisible(), 'close hides'); assert.equal(window.isDestroyed(), false);
    let messages = 0; const send = web.send.bind(web);
    web.send = (channel, ...args) => { if (channel === 'app:state') messages++; return send(channel, ...args); };
    try {
      await until(() => engine.tasks.get(taskId)?.state === 'completed' && Object.keys(sync.own(ruleId).entries).length === 1 && !sync.active, 'hidden upload and sync complete');
      assert.equal(messages, 0); features.hiddenHasZeroStatePush = true;
    } finally { web.send = send; }
    features.closeKeepsTransfersAndSync = true;
    desktop.tray.emit('click'); await until(() => window.isVisible(), 'tray click restores');
    window.minimize(); await until(() => window.isMinimized(), 'minimized');
    desktop.tray.emit('double-click'); await until(() => window.isVisible() && !window.isMinimized(), 'tray restores minimized');
    features.trayRestoresWindow = true;
    await evaluate(`document.querySelector('#tab-upload').click()`);
    desktop.menu.getMenuItemById('open-settings').click();
    await until(() => evaluate(`!document.querySelector('#settings-panel').hidden`), 'tray settings'); features.trayOpensSettings = true;
    window.hide(); app.emit('second-instance', {}, ['app', '--autostart']); assert.equal(window.isVisible(), false);
    app.emit('second-instance', {}, ['app']); await until(() => window.isVisible(), 'second instance restores'); features.secondInstancePolicy = true;
  } else if (phase === 'restart') {
    assert.equal(window.isVisible(), false); assert.ok(desktop.tray && !desktop.tray.isDestroyed());
    assert.equal(engine.storage.settings.startHidden, true); assert.equal(engine.storage.settings.closeToTray, true);
    features.persistedSilentStartup = true;
    desktop.menu.getMenuItemById('open-settings').click();
    await until(() => window.isVisible(), 'silent startup restore');
    await until(() => evaluate(`!document.querySelector('#settings-panel').hidden`), 'restored settings');
    await toggle('start-hidden', 'startHidden', false); assert.ok(desktop.tray);
    window.close(); assert.equal(window.isVisible(), false); features.independentCloseSetting = true;
    await call('saveSettings', { closeToTray: false }); await until(() => window.isVisible(), 'last tray setting restores'); assert.equal(desktop.tray, null);
    features.lastTraySettingRestoresWindow = true;
    await call('saveSettings', { closeToTray: true });
    await call('login', { account: 'test', password: 'only-for-fixture', remember: false });
    const source = path.join(outputDir, '退出保存传输.bin'); await writeFile(source, Buffer.alloc(65536, 73));
    const taskId = await call('upload', { path: source });
    await until(() => engine.tasks.get(taskId)?.state === 'running', 'shutdown transfer running');
    features.quitWhileTransferRunning = true;
    await writeFile(path.join(outputDir, 'shutdown-task.json'), JSON.stringify({ taskId }));
    // A delayed disk write proves repeated Quit waits for the already accepted setting.
    const configure = engine.storage.configure.bind(engine.storage);
    engine.storage.configure = async patch => { await delay(250); return configure(patch); };
    void desktop.configure({ browserView: 'raw' }).catch(() => {});
  } else throw new Error('未知托盘验收阶段');
  await writeFile(path.join(outputDir, `${phase}.json`), JSON.stringify({ phase, version: app.getVersion(), features, layouts }, null, 2));
  console.log('LIFECYCLE_PHASE_OK', phase, JSON.stringify(features));
  const quit = desktop.menu.getMenuItemById('quit-app'); quit.click(); quit.click();
}
