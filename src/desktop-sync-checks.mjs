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
      const value = await evaluate(`(()=>{const panel=document.querySelector('#sync-panel').getBoundingClientRect(),save=document.querySelector('#sync-save').getBoundingClientRect(),tabs=document.querySelector('.tabs').getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,panelRight:panel.right,saveRight:save.right,tabsRight:tabs.right,controls:[...document.querySelectorAll('#sync-panel input:not([type=checkbox]),#sync-panel select')].filter(n=>!n.disabled&&!n.closest('[hidden]')).map(n=>({id:n.id,width:n.getBoundingClientRect().width}))}})()`);
      assert.ok(value.scrollWidth <= width, `同步页不能横向滚动：${JSON.stringify(value)}`); assert.ok(value.panelRight <= width); assert.ok(value.tabsRight <= width); assert.ok(value.saveRight <= width); assert.ok(value.controls.every(control => control.width >= 120), JSON.stringify(value));
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
    await ruleButton(0, '立即同步'); await until(`document.querySelector('#sync-rules').textContent.includes('新增 2')&&!document.querySelector('#sync-rules').textContent.includes('同步上传')`);
    await ruleButton(0, '立即同步'); await until(`document.querySelector('#sync-rules').textContent.includes('跳过 2')`);
    await writeFile(path.join(sourceDir, '文档.txt'), 'changed from desktop fixture'); await ruleButton(0, '立即同步'); await until(`document.querySelector('#sync-rules').textContent.includes('更新 1')&&document.querySelector('#sync-rules').textContent.includes('跳过 1')`);
    await evaluate(`window.lanzou.call('clearHistory',{scope:'all'})`); await ruleButton(0, '立即同步'); await until(`document.querySelector('#sync-rules').textContent.includes('跳过 2')`);
    await ruleButton(0, '暂停规则'); await until(`document.querySelector('#sync-rules').textContent.includes('已停用')`);
    await ruleButton(0, '编辑'); assert.equal(await evaluate(`document.querySelector('#sync-path').disabled`), true);
    await fill({ 'sync-delete': true, 'sync-enabled': false, 'sync-schedule': 'interval', 'sync-minutes': '15' }); await click('sync-save'); await until(`document.querySelector('#sync-confirm-dialog').open`); await click('sync-confirm-cancel');
    assert.equal((await current()).sync.rules[0].deleteRemoved, false);
    await until(`!document.querySelector('#sync-save').disabled`); await click('sync-save'); await until(`document.querySelector('#sync-confirm-dialog').open`); await click('sync-confirm-ok'); await until(`document.querySelector('#sync-rules').textContent.includes('同步删除已开启')`);
    state = await current(); assert.equal(state.sync.rules[0].schedule.minutes, 15); assert.equal(state.sync.rules[0].enabled, false); const preservedRoot = state.sync.rules[0].rootId;
    await layout('sync-rules');
    // Removing a rule requires confirmation, and never removes its cloud content.
    await ruleButton(0, '移除'); await until(`document.querySelector('#sync-confirm-dialog').open`); await click('sync-confirm-ok'); await until(`document.querySelectorAll('#sync-rules .sync-rule').length===0`);
    const preserved = await evaluate(`window.lanzou.call('list',{folderId:'888'})`); assert.ok(preserved.some(entry => entry.id === preservedRoot), '移除规则必须保留云端目录');
    await evaluate(`document.querySelector('#sync-editor').open=true`); await click('sync-pick-file'); await until(`document.querySelector('#sync-path').value.endsWith('文档.txt')`);
    await fill({ 'sync-path': '' }); await fill({ 'sync-path': path.join(sourceDir, '文档.txt'), 'sync-name': '单文件', 'sync-enabled': false }); await click('sync-save'); await until(`document.querySelectorAll('#sync-rules .sync-rule').length===1`); assert.equal((await current()).sync.rules[0].sourceKind, 'file');
    await ruleButton(0, '编辑'); await fill({ 'sync-name': '直接填写路径' }); await click('sync-save'); await until(`document.querySelector('#sync-rules').textContent.includes('直接填写路径')`);
    assert.deepEqual(choices, ['openDirectory', 'openFile']);
    await writeFile(path.join(outputDir, 'sync-layouts.json'), JSON.stringify(layouts, null, 2));
    return { automaticSyncTab: true, syncLoggedOutGuard: true, syncFilePicker: true, syncFolderPicker: true, syncTypedPath: true, syncCloudTarget: true, syncDailyMultipleTimes: true, syncInterval: true, syncNoRepeatUpload: true, syncOnlyChangedFile: true, syncHistoryIndependent: true, syncDeleteConfirmation: true, syncEdit: true, syncPause: true, syncRemoveKeepsCloud: true, syncResponsive: true };
  } finally { dialog.showOpenDialog = originalPicker; }
}
