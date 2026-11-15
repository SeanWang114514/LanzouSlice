// Runs only with --smoke-test --smoke-sync, an independent profile and a loopback fixture.
import assert from 'node:assert/strict';
import { dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function checkSync(window, { sourceDir, outputDir }) {
  const evaluate = code => window.webContents.executeJavaScript(code), originalPicker = dialog.showOpenDialog;
  const layouts = [], choices = [];
  async function until(expression) {
    const deadline = Date.now() + 15000;
    while (!await evaluate(expression)) { if (Date.now() > deadline) throw new Error(`同步界面等待超时：${expression}；${await evaluate(`document.querySelector('#notice').textContent`)}`); await delay(25); }
  }
  const click = id => evaluate(`document.querySelector('#${id}').click()`);
  const fill = values => evaluate(`for(const [id,value] of Object.entries(${JSON.stringify(values)})){const node=document.getElementById(id);if(typeof value==='boolean')node.checked=value;else node.value=value;node.dispatchEvent(new Event('change',{bubbles:true}));}`);
  const current = () => evaluate(`window.lanzou.call('state')`);
  const ruleButton = (index, label) => evaluate(`[...document.querySelectorAll('#sync-rules .sync-rule')][${index}]&&[...[...document.querySelectorAll('#sync-rules .sync-rule')][${index}].querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)})?.click()`);
  async function layout(name) {
    for (const [width, height] of [[940, 700], [1260, 900], [1920, 1080]]) {
      window.setContentSize(width, height); await evaluate(`document.querySelector('#notice').hidden=true;document.querySelector('#floating-transfer').hidden=true;window.scrollTo(0,0);document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
      const value = await evaluate(`(()=>{const panel=document.querySelector('#sync-panel').getBoundingClientRect(),save=document.querySelector('#sync-save').getBoundingClientRect(),tabs=document.querySelector('.tabs').getBoundingClientRect(),float=document.querySelector('#floating-sync'),rect=float.getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,panelRight:panel.right,saveRight:save.right,tabsRight:tabs.right,floating:float.hidden?null:{width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom,overflow:float.scrollWidth>float.clientWidth},controls:[...document.querySelectorAll('#sync-panel input:not([type=checkbox]),#sync-panel select')].filter(n=>!n.disabled&&!n.closest('[hidden]')).map(n=>({id:n.id,width:n.getBoundingClientRect().width}))}})()`);
      assert.ok(value.scrollWidth <= width, `同步页不能横向滚动：${JSON.stringify(value)}`); assert.ok(value.panelRight <= width); assert.ok(value.tabsRight <= width); assert.ok(value.saveRight <= width); assert.ok(value.controls.every(control => control.width >= 120), JSON.stringify(value));
      if (value.floating) { assert.equal(value.floating.width, 344); assert.equal(value.floating.height, 128); assert.ok(value.floating.right <= width && value.floating.bottom <= height); assert.equal(value.floating.overflow, false); }
      layouts.push({ name: `${name}-${width}x${height}`, ...value }); await delay(150); await writeFile(path.join(outputDir, `${name}-${width}x${height}.png`), (await window.webContents.capturePage()).toPNG());
    }
    window.setContentSize(1260, 900);
  }
  try {
    await click('tab-sync'); assert.equal(await evaluate(`document.querySelector('#sync-panel').hidden`), false); assert.equal(await evaluate(`document.querySelector('#sync-save').disabled`), true);
    await evaluate(`window.lanzou.call('login',{account:'test',password:'only-for-fixture',remember:false})`); await until(`!document.querySelector('#sync-save').disabled`);
    dialog.showOpenDialog = async (_window, options) => { choices.push(options.properties[0]); return { canceled: false, filePaths: [options.properties[0] === 'openDirectory' ? sourceDir : path.join(sourceDir, '文档.txt')] }; };
    await click('sync-pick-folder'); await until(`document.querySelector('#sync-path').value===${JSON.stringify(sourceDir)}`);
    await click('sync-pick-target'); await until(`document.querySelector('#sync-target-dialog').open&&document.querySelector('#sync-target-folders button')`);
    await evaluate(`[...document.querySelectorAll('#sync-target-folders button')].find(button=>button.textContent==='同步目标').click()`); await until(`document.querySelector('#sync-target-path').textContent.includes('同步目标')&&!document.querySelector('#sync-target-use').disabled`); await click('sync-target-use');
    await fill({ 'sync-name': '工作文件 · 自动同步', 'sync-schedule': 'daily', 'sync-times': '09:00, 14:00, 20:30' }); await layout('sync-editor'); await click('sync-save');
    await until(`document.querySelectorAll('#sync-rules .sync-rule').length===1`); let state = await current(), rule = state.sync.rules[0];
    assert.equal(rule.parentId, '888'); assert.equal(rule.deleteRemoved, false); assert.deepEqual(rule.schedule.times, ['09:00', '14:00', '20:30']); assert.equal(await evaluate(`document.querySelector('#sync-editor').open`), false);
    await evaluate(`window.lanzou.call('saveSettings',{uploadConcurrency:3})`);
    await ruleButton(0, '立即同步');
    await until(`window.lanzou.call('state').then(s=>s.sync.rules[0].progress?.speedBytesPerSecond>0&&s.sync.rules[0].progress?.remainingSeconds>0)`);
    state = await current(); const live = state.sync.rules[0].progress;
    assert.equal(live.totalBytes, 1024000); assert.equal(live.totalFiles, 2); assert.equal(live.concurrency, 3); assert.ok(live.ratio > 0 && live.ratio < 1);
    assert.equal(await evaluate(`document.querySelector('#floating-transfer').hidden&&!document.querySelector('#floating-sync').hidden&&document.querySelectorAll('.sync-progress progress').length===1`), true);
    await until(`document.querySelector('#sync-floating-remaining').textContent!=='—'`);
    assert.match(await evaluate(`document.querySelector('#sync-floating-speed').textContent`), /\d+\.\d{2} .+\/s/);
    assert.match(await evaluate(`document.querySelector('#sync-floating-remaining').textContent`), /\d{2}:\d{2}:\d{2}/);
    await layout('sync-progress');
    await click('sync-floating-toggle'); assert.equal(await evaluate(`document.querySelector('#floating-sync').getBoundingClientRect().height`), 48);
    await click('sync-floating-toggle'); await click('sync-floating-close'); assert.equal(await evaluate(`document.querySelector('#floating-sync').hidden`), true);
    await click('show-sync-floating'); assert.equal(await evaluate(`document.querySelector('#floating-sync').hidden`), false);
    await click('sync-floating-action'); await until(`window.lanzou.call('state').then(s=>s.sync.rules[0].state==='paused')`);
    await until(`document.querySelector('#sync-floating-action').textContent==='继续同步'&&!document.querySelector('#sync-floating-action').disabled`);
    assert.equal((await current()).sync.rules[0].progress.speedBytesPerSecond, 0); assert.equal(await evaluate(`document.querySelector('#sync-floating-action').textContent`), '继续同步');
    await click('sync-floating-action'); await until(`window.lanzou.call('state').then(s=>s.sync.rules[0].state==='uploading')`);
    const manualPath = path.join(outputDir, 'queued-manual.txt'); await writeFile(manualPath, Buffer.alloc(30000, 9));
    const manualId = await evaluate(`window.lanzou.call('upload',{path:${JSON.stringify(manualPath)}})`);
    assert.equal((await current()).tasks.find(task => task.id === manualId).state, 'queued');
    await until(`window.lanzou.call('state').then(s=>s.sync.rules[0].state==='idle'&&s.tasks.find(t=>t.id===${JSON.stringify(manualId)})?.state==='running')`);
    await until(`document.querySelector('#floating-sync').hidden&&!document.querySelector('#floating-transfer').hidden&&document.querySelector('#floating-name').textContent==='queued-manual.txt'`);
    assert.equal((await current()).sync.rules[0].progress.ratio, 1);
    await until(`window.lanzou.call('state').then(s=>s.tasks.find(t=>t.id===${JSON.stringify(manualId)})?.state==='completed')`);
    await ruleButton(0, '立即同步'); await until(`window.lanzou.call('state').then(s=>s.sync.rules[0].state==='idle'&&s.sync.rules[0].stats.skipped===2)`);
    assert.equal((await current()).sync.rules[0].progress.transferredBytes, 0); assert.equal(await evaluate(`document.querySelector('#sync-floating-percent').textContent`), '100%');
    await writeFile(path.join(sourceDir, '文档.txt'), 'changed from desktop fixture'); await ruleButton(0, '立即同步'); await until(`window.lanzou.call('state').then(s=>s.sync.rules[0].state==='idle'&&s.sync.rules[0].stats.updated===1&&s.sync.rules[0].stats.skipped===1)`);
    await evaluate(`window.lanzou.call('clearHistory',{scope:'all'})`); await ruleButton(0, '立即同步'); await until(`window.lanzou.call('state').then(s=>s.sync.rules[0].state==='idle'&&s.sync.rules[0].stats.skipped===2)`);
    await ruleButton(0, '暂停规则'); await until(`document.querySelector('#sync-rules').textContent.includes('已停用')`);
    await ruleButton(0, '编辑'); assert.equal(await evaluate(`document.querySelector('#sync-path').disabled`), true);
    await fill({ 'sync-delete': true, 'sync-enabled': false, 'sync-schedule': 'interval', 'sync-minutes': '15' }); await click('sync-save'); await until(`document.querySelector('#sync-confirm-dialog').open`); await click('sync-confirm-cancel');
    assert.equal((await current()).sync.rules[0].deleteRemoved, false);
    await until(`!document.querySelector('#sync-save').disabled`); await click('sync-save'); await until(`document.querySelector('#sync-confirm-dialog').open`); await click('sync-confirm-ok'); await until(`document.querySelector('#sync-rules').textContent.includes('同步删除已开启')`);
    state = await current(); assert.equal(state.sync.rules[0].schedule.minutes, 15); assert.equal(state.sync.rules[0].enabled, false); const preservedRoot = state.sync.rules[0].rootId;
    await layout('sync-rules');
    await click('tab-download'); await until(`document.querySelector('#folder-list').textContent.includes('同步目标')&&!document.querySelector('#refresh-folders').disabled`);
    await evaluate(`[...document.querySelectorAll('.folder-row')].find(row=>row.textContent.includes('同步目标')).querySelector('.file-name-text').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await until(`document.querySelector('.sync-folder')&&!document.querySelector('#refresh-folders').disabled`);
    assert.equal(await evaluate(`document.querySelector('.sync-folder .file-name-text').textContent`), '工作文件 · 自动同步');
    assert.equal(await evaluate(`document.querySelector('.sync-folder [data-download-slice]')===null`), true, '同步根目录不能当作单个切片下载');
    await evaluate(`document.querySelector('.sync-folder input').click()`); assert.equal(await evaluate(`document.querySelector('#download-selected').disabled`), true);
    await click('refresh-folders'); await until(`document.querySelector('.sync-folder')&&!document.querySelector('#refresh-folders').disabled`);
    assert.equal(await evaluate(`document.querySelector('.sync-folder').textContent.includes('普通文件夹')`), false);
    await writeFile(path.join(outputDir, 'sync-browser.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector('.sync-folder .file-name-text').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await until(`document.querySelector('#folder-path').textContent.includes('工作文件 · 自动同步')&&document.querySelectorAll('.slice-folder').length===2&&!document.querySelector('#refresh-folders').disabled`);
    assert.equal(await evaluate(`[...document.querySelectorAll('.slice-folder .file-name-text')].every(node=>node.textContent==='文档.txt')`), true);
    await click('folder-up'); await until(`document.querySelector('.sync-folder')&&!document.querySelector('#refresh-folders').disabled`);
    await click('view-raw'); await until(`document.querySelector('#view-raw').getAttribute('aria-pressed')==='true'&&document.querySelector('.sync-folder')===null`);
    assert.match(await evaluate(`document.querySelector('.folder-row .file-name-text').textContent`), /^sync[a-f\d]{32}$/);
    await click('view-smart'); await until(`document.querySelector('.sync-folder')`); await click('tab-sync');
    // Removing a rule requires confirmation, and never removes its cloud content.
    await ruleButton(0, '移除'); await until(`document.querySelector('#sync-confirm-dialog').open`); await click('sync-confirm-ok'); await until(`document.querySelectorAll('#sync-rules .sync-rule').length===0`);
    const preserved = await evaluate(`window.lanzou.call('list',{folderId:'888'})`); assert.ok(preserved.some(entry => entry.id === preservedRoot), '移除规则必须保留云端目录');
    await click('tab-download');
    assert.equal(await evaluate(`document.querySelector('.sync-folder')===null`), true, '移除规则应立即撤销目录别名');
    await click('tab-sync');
    await evaluate(`document.querySelector('#sync-editor').open=true`); await click('sync-pick-file'); await until(`document.querySelector('#sync-path').value.endsWith('文档.txt')`);
    await fill({ 'sync-path': '' }); await fill({ 'sync-path': path.join(sourceDir, '文档.txt'), 'sync-name': '单文件', 'sync-enabled': false }); await click('sync-save'); await until(`document.querySelectorAll('#sync-rules .sync-rule').length===1`); assert.equal((await current()).sync.rules[0].sourceKind, 'file');
    await ruleButton(0, '编辑'); await fill({ 'sync-name': '直接填写路径' }); await click('sync-save'); await until(`document.querySelector('#sync-rules').textContent.includes('直接填写路径')`);
    assert.deepEqual(choices, ['openDirectory', 'openFile']);
    await writeFile(path.join(outputDir, 'sync-layouts.json'), JSON.stringify(layouts, null, 2));
    return { automaticSyncTab: true, syncLoggedOutGuard: true, syncFilePicker: true, syncFolderPicker: true, syncTypedPath: true, syncCloudTarget: true, syncDailyMultipleTimes: true, syncInterval: true, syncNoRepeatUpload: true, syncOnlyChangedFile: true, syncHistoryIndependent: true, syncDeleteConfirmation: true, syncEdit: true, syncPause: true, syncRemoveKeepsCloud: true, syncResponsive: true, syncSmartFolderName: true, syncFolderDoubleClick: true, syncChildrenRecognized: true, syncRootNotSliceDownload: true, syncAliasSurvivesRefresh: true, syncRawCloudName: true, syncAliasRemovedWithRule: true, syncSharedConcurrency: true, syncWholeRoundProgress: true, syncDedicatedFloating: true, syncSpeedAndETA: true, syncFloatingDimensions: true, syncFloatingControls: true, syncFloatingPauseResume: true, syncManualFloatingHandoff: true };
  } finally { dialog.showOpenDialog = originalPicker; }
}
