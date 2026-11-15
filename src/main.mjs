import { app, BrowserWindow, ipcMain, dialog, shell, session, safeStorage } from 'electron';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CookieJar } from 'tough-cookie';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { LanzouClient, ACCOUNT_ORIGIN, PC_ORIGIN, WEB_UA } from './lanzou.mjs';
import { TransferEngine, localFileName } from './transfer.mjs';
import { FolderRecognition } from './folder-recognition.mjs';
import { CloudFiles } from './cloud-files.mjs';
import { openTaskFolder } from './task-location.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeTest = process.argv.includes('--smoke-test');
const smokeOutputArg = process.argv.find(arg => arg.startsWith('--smoke-output='));
const smokeOutput = path.resolve(smokeOutputArg ? smokeOutputArg.slice('--smoke-output='.length) : '.tmp');
if (smokeTest) mkdirSync(smokeOutput, { recursive: true });
const trace = stage => { if (smokeTest) appendFileSync(path.join(smokeOutput, 'smoke-trace.log'), `${new Date().toISOString()} ${stage}\n`); };
trace('main module loaded');
if (smokeTest) app.disableHardwareAcceleration();
const testDataArg = process.argv.find(arg => arg.startsWith('--test-data='));
if (testDataArg) app.setPath('userData', path.resolve(testDataArg.slice('--test-data='.length)));
const smokeApiArg = smokeTest && process.argv.find(arg => arg.startsWith('--smoke-api='));
const smokeApi = smokeApiArg ? new URL(smokeApiArg.slice('--smoke-api='.length)) : null;
if (smokeApi && (!testDataArg || smokeApi.protocol !== 'http:' || smokeApi.hostname !== '127.0.0.1')) throw new Error('离线界面测试仅允许独立数据目录和本机回环服务');
if (!app.requestSingleInstanceLock()) app.exit(0);
const appURL = pathToFileURL(path.join(root, 'ui/index.html')).href;
let window, loginWindow, engine, client, quitting = false, account = null, encryptionAvailable = false, authVersion = 0;
const bundles = new Map();
const dataDir = app.getPath('userData');
const credentialPath = path.join(dataDir, 'session.bin');
let identifyController, recognition, cloudFiles;
const seededUploads = new Set();
function seedUploads(initial = false) {
  let changed = false;
  for (const task of engine.tasks.values()) {
    if (task.type !== 'upload' || task.state !== 'completed' || !task.ownerUid || !task.manifestId || seededUploads.has(task.id)) continue;
    seededUploads.add(task.id);
    if (recognition.get(task.ownerUid, task.folderId, task.folderName)) continue;
    recognition.remember(task.ownerUid, task.folderId, { status: 'preview', originalName: task.manifest?.originalName || task.originalName, originalSize: task.manifest?.originalSize ?? task.originalSize, totalParts: task.manifest?.parts.length || task.totalParts }, task.folderName, Date.now() - (initial ? 300_000 : 0));
    changed = true;
  }
  if (changed) void recognition.save().catch(() => {});
}
function resetReads() { identifyController?.abort(); bundles.clear(); }
function manifestInfo(bundle) { return { originalName: bundle.manifest.originalName, originalSize: bundle.manifest.originalSize, totalParts: bundle.manifest.parts.length, sha256: bundle.manifest.sha256, partNames: bundle.manifest.parts.map(part => part.name), indexNames: bundle.indexNames || [], folderId: bundle.source.folderId }; }
function bundleInfo(bundle, version) {
  if (version !== authVersion) throw new Error('账号已变化，请重新读取目录');
  const key = randomUUID();
  if (bundles.size >= 200) bundles.delete(bundles.keys().next().value);
  bundles.set(key, { bundle, version });
  return { key, ...manifestInfo(bundle) };
}

function snapshot() { return { account, tasks: engine.publicTasks(), dataDir, settings: engine.storage.settings, settingsWarning: engine.storage.warning, version: app.getVersion(), encryptionAvailable }; }
function emitState() {
  seedUploads();
  if (account && !client.loggedIn) account = null;
  if (window && !window.isDestroyed()) window.webContents.send('app:state', snapshot());
}
async function saveSession(remember, label) {
  account = { label: label || `蓝奏云 ${client.uid}`, uid: client.uid, remembered: Boolean(remember) };
  if (remember) {
    if (!encryptionAvailable) throw new Error('系统凭证加密不可用，本次登录可用，但无法记住登录');
    await mkdir(dataDir, { recursive: true });
    await writeFile(credentialPath, await safeStorage.encryptStringAsync(JSON.stringify({ jar: await client.jar.serialize(), label: account.label })), { mode: 0o600 });
  } else await rm(credentialPath, { force: true });
  emitState();
}
async function restoreSession() {
  const version = authVersion;
  try {
    if (!encryptionAvailable) return;
    const value = JSON.parse((await safeStorage.decryptStringAsync(await readFile(credentialPath))).result);
    const restored = new LanzouClient({ jar: await CookieJar.deserialize(value.jar) });
    await restored.refresh();
    if (version !== authVersion) return;
    client.jar = restored.jar; client.uid = restored.uid; client.vei = restored.vei;
    account = { label: value.label, uid: client.uid, remembered: true };
  } catch { if (version === authVersion) account = null; }
}
function authSession() { return session.fromPartition('lanzou-auth'); }
async function importOfficialSession(remember) {
  authVersion++;
  resetReads();
  await engine.pauseAll();
  const cookies = await authSession().cookies.get({});
  if (!cookies.some(c => c.name === 'ylogin' || c.name === 'phpdisk_info')) throw new Error('尚未检测到登录，请先在官网登录窗口完成登录');
  const jar = new CookieJar();
  for (const c of cookies) {
    if (!(c.domain === 'woozooo.com' || c.domain?.endsWith('.woozooo.com'))) continue;
    const url = `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
    const value = `${c.name}=${c.value}; Path=${c.path || '/'}${c.hostOnly ? '' : `; Domain=${c.domain}`}${c.secure ? '; Secure' : ''}${c.httpOnly ? '; HttpOnly' : ''}${c.expirationDate ? `; Expires=${new Date(c.expirationDate * 1000).toUTCString()}` : ''}`;
    await jar.setCookie(value, url).catch(() => {});
  }
  client.jar = jar;
  await client.refresh(); await saveSession(remember); return { loggedIn: true };
}
async function openLogin(remember) {
  if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.show(); loginWindow.focus(); return; }
  const ses = authSession(); ses.setUserAgent(WEB_UA);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  loginWindow = new BrowserWindow({ width: 1040, height: 780, title: '蓝奏云官网登录', parent: window, autoHideMenuBar: true, webPreferences: { partition: 'lanzou-auth', nodeIntegration: false, contextIsolation: true, sandbox: true } });
  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).hostname.endsWith('.woozooo.com')) void loginWindow.loadURL(url); } catch {}
    return { action: 'deny' };
  });
  loginWindow.webContents.on('will-navigate', (event, url) => {
    try { const u = new URL(url); if (u.protocol !== 'https:' || !(u.hostname === 'woozooo.com' || u.hostname.endsWith('.woozooo.com'))) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  let checking = false;
  loginWindow.webContents.on('did-finish-load', async () => {
    if (checking || !loginWindow || !loginWindow.webContents.getURL().startsWith(PC_ORIGIN)) return;
    checking = true;
    try { await importOfficialSession(remember); loginWindow?.close(); } catch {}
    finally { checking = false; }
  });
  loginWindow.on('closed', () => { loginWindow = null; });
  await loginWindow.loadURL(`${ACCOUNT_ORIGIN}/accounts.php?action=login&ref=pc.woozooo.com`);
}

async function sourceInfo(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error('请拖入本机的实际文件');
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('请选择或拖入一个文件，暂不支持上传文件夹');
  return { path: filePath, name: path.basename(filePath), size: info.size };
}
async function command(action, payload = {}) {
  switch (action) {
    case 'state': return snapshot();
    case 'login': {
      authVersion++;
      resetReads();
      await engine.pauseAll();
      account = null; emitState();
      await client.login(String(payload.account || ''), String(payload.password || ''));
      await saveSession(Boolean(payload.remember), String(payload.account || '').trim());
      return snapshot();
    }
    case 'officialLogin': await openLogin(Boolean(payload.remember)); return null;
    case 'confirmLogin': await importOfficialSession(Boolean(payload.remember)); loginWindow?.close(); return snapshot();
    case 'logout':
      authVersion++;
      resetReads();
      await engine.pauseAll(); client.jar = new CookieJar(); client.uid = client.vei = null; account = null;
      bundles.clear();
      await rm(credentialPath, { force: true });
      await authSession().clearStorageData(); emitState(); return snapshot();
    case 'chooseSource': {
      const result = await dialog.showOpenDialog(window, { title: '选择需要切片上传的文件', properties: ['openFile'] });
      return result.canceled ? null : sourceInfo(result.filePaths[0]);
    }
    case 'selectSource': return sourceInfo(String(payload.path || ''));
    case 'chooseDirectory': {
      const result = await dialog.showOpenDialog(window, { title: '选择下载和合并保存目录', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled) return null;
      await engine.storage.configure({ downloadDir: result.filePaths[0] }); emitState(); return result.filePaths[0];
    }
    case 'chooseSettingDirectory': {
      if (!['downloadDir', 'cacheDir'].includes(payload.key)) throw new Error('未知目录设置');
      const result = await dialog.showOpenDialog(window, { title: payload.key === 'cacheDir' ? '选择缓存位置（将建立 LanzouSliceCache 专用子目录）' : '选择默认下载目录', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled) return null;
      await engine.storage.configure({ [payload.key]: payload.key === 'cacheDir' ? path.join(result.filePaths[0], 'LanzouSliceCache') : result.filePaths[0] });
      emitState(); return snapshot();
    }
    case 'saveSettings': {
      const patch = Object.fromEntries(['autoCleanCache', 'uploadConcurrency', 'downloadConcurrency', 'browserView'].filter(key => Object.hasOwn(payload, key)).map(key => [key, payload[key]]));
      if (!Object.keys(patch).length) throw new Error('没有可保存的设置');
      await engine.storage.configure(patch);
      if (patch.autoCleanCache === true) await engine.cleanCache().catch(error => { engine.storage.warning = `自动清理已开启，部分缓存暂未清理：${error.message}`; });
      emitState(); return snapshot();
    }
    case 'cacheInfo': return engine.cacheInfo();
    case 'cleanCache': return engine.cleanCache();
    case 'clearHistory': return engine.clearHistory({ scope: payload.scope ?? 'completed', id: payload.id });
    case 'upload': return engine.createUpload(String(payload.path || ''));
    case 'manageCloud': return cloudFiles.change(payload.action, payload);
    case 'downloadFile': {
      const version = authVersion;
      const file = await cloudFiles.entry({ ...payload, isFolder: false });
      if (version !== authVersion) throw new Error('账号已变化，请重新读取目录');
      return engine.createFileDownload(file);
    }
    case 'downloadBatch': {
      const version = authVersion;
      const files = await cloudFiles.downloadSelection(payload.items);
      if (version !== authVersion) throw new Error('账号已变化，请重新读取目录');
      return engine.createDownloadBatch(files, engine.storage.settings.downloadDir, engine.storage.settings.downloadConcurrency);
    }
    case 'list': return client.list(String(payload.folderId || '-1'));
    case 'listPage': {
      if (!account || !client.loggedIn) throw new Error('请先登录蓝奏云');
      identifyController?.abort();
      const version = authVersion, ownerUid = account.uid;
      const result = await client.listPage(String(payload.folderId || '-1'), Number(payload.page || 1));
      if (version !== authVersion) throw new Error('账号已变化，请重新读取目录');
      for (const entry of result.entries) {
        if (!entry.isFolder) continue;
        if (payload.force) recognition.forget(ownerUid, entry.id);
        const cached = recognition.get(ownerUid, entry.id, entry.name);
        if (cached) {
          entry.identification = cached.status; entry.recognitionStale = cached.stale;
          if (cached.status !== 'ordinary') entry.slice = cached;
        }
      }
      if (payload.force) void recognition.save().catch(() => {});
      return result;
    }
    case 'identifyFolders': {
      if (!account || !client.loggedIn) throw new Error('请先登录蓝奏云');
      const ids = payload.folderIds;
      if (!Array.isArray(ids) || ids.length > 256 || ids.some(id => !/^\d+$/.test(String(id)))) throw new Error('文件夹识别参数无效');
      identifyController?.abort(); const controller = new AbortController(); identifyController = controller;
      const version = authVersion, ownerUid = account.uid;
      const folders = ids.map(id => ({ id: String(id), name: typeof payload.folderNames?.[id] === 'string' ? payload.folderNames[id].slice(0, 4096) : undefined }));
      const results = await recognition.scan(ownerUid, folders, { signal: controller.signal, force: Boolean(payload.force), onResult(result) {
        if (version !== authVersion || controller.signal.aborted) return;
        if (window && !window.isDestroyed()) window.webContents.send('app:recognition', { token: payload.token, ownerUid, result });
      } });
      if (version !== authVersion) throw new Error('账号已变化，请重新读取目录');
      return results;
    }
    case 'inspectFolder':
    case 'inspectShare': {
      const version = authVersion;
      const ownerUid = account?.uid;
      let bundle;
      try { bundle = action === 'inspectFolder' ? await engine.inspectFolder(String(payload.folderId)) : await engine.inspectShare(String(payload.url || '').trim(), String(payload.password || '')); }
      catch (error) { if (action === 'inspectFolder') { recognition.forget(ownerUid, String(payload.folderId)); void recognition.save().catch(() => {}); } throw error; }
      if (action === 'inspectFolder' && version === authVersion) { recognition.remember(ownerUid, String(payload.folderId), { status: 'ready', ...manifestInfo(bundle) }); void recognition.save().catch(() => {}); }
      return bundleInfo(bundle, version);
    }
    case 'download': {
      const entry = bundles.get(payload.key); if (!entry || entry.version !== authVersion) throw new Error('请重新选择远程文件任务');
      return engine.createDownload(entry.bundle, payload.outputDir ? String(payload.outputDir) : engine.storage.settings.downloadDir, payload.concurrency);
    }
    case 'pause': await engine.pause(String(payload.id)); return null;
    case 'pauseAll': await engine.pauseAll(); return null;
    case 'resume': return engine.resume(String(payload.id), String(payload.password || ''));
    case 'showResult': return openTaskFolder(engine.tasks.get(String(payload.id)), shell);
    case 'exportManifest': {
      const task = engine.tasks.get(payload.id);
      const name = localFileName(task?.manifest?.originalName || task?.originalName || 'file');
      const result = await dialog.showSaveDialog(window, { title: '导出文件清单', defaultPath: localFileName(`${name}.lanzou.txt`), filters: [{ name: '切片清单', extensions: ['txt'] }] });
      if (!result.canceled) await engine.exportManifest(String(payload.id), result.filePath);
      return null;
    }
    case 'openData': return shell.openPath(dataDir);
    default: throw new Error('未知操作');
  }
}

trace('waiting for app ready');
app.whenReady().then(async () => {
trace('app ready');
encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable();
client = new LanzouClient(smokeApi ? { pcOrigin: smokeApi.origin, accountOrigin: smokeApi.origin } : {}); engine = new TransferEngine({ client, dataDir, ...(smokeApi ? { maxPartBytes: 8192 } : {}), defaultDownloadDir: smokeTest ? path.join(dataDir, 'downloads') : path.join(app.getPath('downloads'), '蓝奏切片') });
await engine.init();
recognition = new FolderRecognition({ dataDir, identify: async (id, signal) => {
  const { index, bundle, ordinary } = await engine.identifyFolder(id, signal);
  return ordinary ? { status: 'ordinary' } : index ? { status: 'preview', ...index } : { status: 'ready', ...manifestInfo(bundle) };
} });
await recognition.init(); seedUploads(true); engine.on('change', emitState);
cloudFiles = new CloudFiles({ client, engine, recognition, version: () => authVersion, cancelReads: resetReads });
trace('engine initialized');
ipcMain.handle('app:command', async (event, { action, payload }) => {
  if (event.senderFrame?.url !== appURL) throw new Error('不允许此页面访问本地功能');
  try { return { ok: true, value: await command(action, payload) }; }
  catch (error) {
    if (error.code === 'AUTH_EXPIRED') { account = null; emitState(); }
    return { ok: false, error: error.message || '操作失败', code: error.code };
  }
});
window = new BrowserWindow({ width: 1260, height: 900, minWidth: 940, minHeight: 700, show: !smokeTest, title: '蓝奏切片', backgroundColor: '#e4e6ee', icon: path.join(root, 'ui/assets/app-icon.png'), autoHideMenuBar: true, webPreferences: { preload: path.join(root, 'src/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: smokeTest } });
trace('window created');
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', (event, url) => { if (url !== appURL) event.preventDefault(); });
app.on('second-instance', () => { if (window.isMinimized()) window.restore(); window.show(); window.focus(); });
await window.loadURL(appURL);
trace('window loaded');
if (smokeTest) {
  try {
    const features = smokeApi ? await (await import('./desktop-checks.mjs')).checkReadAndDrop(window, {
      firstFile: process.argv.find(arg => arg.startsWith('--smoke-drop-file='))?.slice('--smoke-drop-file='.length),
      secondFile: process.argv.find(arg => arg.startsWith('--smoke-second-file='))?.slice('--smoke-second-file='.length),
      fixtureOrigin: smokeApi.origin,
      outputDir: smokeOutput
    }) : undefined;
    const result = await window.webContents.executeJavaScript(`(async()=>{
      const state=await window.lanzou.call('state');
      const until=Date.now()+5000;
      while(document.querySelectorAll('#tasks .task').length!==state.tasks.length) {
        if(Date.now()>until) throw new Error('任务列表未完成渲染：'+document.querySelector('#notice').textContent);
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      document.querySelector('#tab-download').click();
      const downloadTabWorks=!document.querySelector('#download-panel').hidden;
      document.querySelector('#share-source').click();
      const shareTabWorks=!document.querySelector('#share-form').hidden;
      document.querySelector('#tab-upload').click();
      const namingVisible=state.tasks.every(task=>!task.naming||[...document.querySelectorAll('#tasks .task-detail')].some(node=>node.textContent.includes(task.naming.cloudFolderName)));
      if(state.tasks.length) { document.querySelector('#tab-transfers').click(); document.querySelector('#tasks').scrollIntoView({block:'end'}); }
      return {title:document.title,version:state.version,hasBridge:!!window.lanzou,taskCount:state.tasks.length,renderedTaskCount:document.querySelectorAll('#tasks .task').length,namingVisible,upload:!!document.querySelector('#start-upload'),download:!!document.querySelector('#start-download'),status:document.querySelector('#account-status').textContent,downloadTabWorks,shareTabWorks};
    })()`);
    if (features) result.features = features;
    if (encryptionAvailable) {
      const dummy = 'lanzou-slice-smoke-test-not-a-credential';
      result.encryptionRoundtrip = (await safeStorage.decryptStringAsync(await safeStorage.encryptStringAsync(dummy))).result === dummy;
      if (!result.encryptionRoundtrip) throw new Error('系统会话加密检查失败');
    }
    await writeFile(path.join(smokeOutput, 'desktop-smoke.json'), JSON.stringify(result, null, 2));
    await window.webContents.executeJavaScript(`document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const screenshot = await window.webContents.capturePage();
    await writeFile(path.join(smokeOutput, 'desktop-smoke.png'), screenshot.toPNG());
    console.log('DESKTOP_SMOKE', JSON.stringify(result));
    if (!result.hasBridge || !result.upload || !result.download || !result.downloadTabWorks || !result.shareTabWorks || !result.namingVisible || result.renderedTaskCount !== result.taskCount) throw new Error('桌面组件未完整加载');
    quitting = true; app.exit(0);
  } catch (error) { console.error(error.message); quitting = true; app.exit(1); }
} else void restoreSession().then(emitState);
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  resetReads();
  void engine.pauseAll().then(() => recognition.save()).catch(() => {}).finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
}).catch(error => {
  trace(`startup error: ${error.message}`);
  console.error('启动失败：', error);
  app.exit(1);
});
