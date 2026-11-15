// Only used with the isolated loopback desktop fixture.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export async function checkBatchDownloads(window, { evaluate, until, capture, firstFile, outputDir, fixtureOrigin }) {
  const layouts = [], size = window.getContentSize();
  const box = key => `document.querySelector('[data-download-select="${key}"]')`;
  const count = text => `document.querySelector('#selection-count').textContent===${JSON.stringify(text)}`;
  const selected = () => evaluate(`[...document.querySelectorAll('[data-download-select]:checked')].map(box=>box.dataset.downloadSelect).sort()`);
  const expectSelected = async (keys, message) => assert.deepEqual(await selected(), [...keys].sort(), message);
  async function clickRow(key, modifiers = [], part = '.file-name') {
    const [kind, id] = key.split(':');
    const selector = `.folder-row[data-entry-kind="${kind}"][data-entry-id="${id}"] ${part}`;
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
    const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);if(!n.contains(document.elementFromPoint(x,y)))throw new Error('Selection click is obscured');return {x,y}})()`);
    window.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1, modifiers });
    await evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`);
  }
  try {
    await evaluate(`document.querySelector('#tab-download').click()`);
    while (!await evaluate(`document.querySelector('#folder-up').disabled`)) {
      await evaluate(`document.querySelector('#folder-up').click()`); await until(`!document.querySelector('#refresh-folders').disabled`);
    }
    await until(`document.querySelector('.slice-folder [data-download-select]')!==null&&!document.querySelector('#refresh-folders').disabled`);
    const sliceId = await evaluate(`document.querySelector('.slice-folder').dataset.entryId`);
    await clickRow('file:9981'); await expectSelected(['file:9981'], 'plain row click selects one file');
    await clickRow('file:9982', ['control'], '.file-name-text'); await expectSelected(['file:9981', 'file:9982'], 'Ctrl adds a nonadjacent file');
    await clickRow('file:9981', ['control']); await expectSelected(['file:9982'], 'Ctrl toggles an existing selection off');
    await clickRow('file:9981', ['control'], 'input'); await expectSelected(['file:9981', 'file:9982'], 'Ctrl checkbox toggles exactly once');
    await clickRow('file:9100'); await expectSelected(['file:9100'], 'plain row click replaces a previous multiselection');
    await clickRow('file:9103', ['shift']); await expectSelected(['file:9100', 'file:9101', 'file:9102', 'file:9103'], 'Shift selects a forward range');
    await clickRow('file:9101', ['shift']); await expectSelected(['file:9100', 'file:9101'], 'repeated Shift preserves the original anchor and shrinks the range');
    await clickRow('file:9104'); await clickRow('file:9981', ['control']); await clickRow('file:9101', ['control', 'shift']);
    await expectSelected(['file:9981', 'file:9982', 'file:9100', 'file:9101', 'file:9104'], 'Ctrl+Shift appends a range and preserves unrelated selections');
    await clickRow('file:9104'); await clickRow('file:9101', ['shift'], 'input');
    await expectSelected(['file:9101', 'file:9102', 'file:9103', 'file:9104'], 'Shift checkbox selects backwards and retains native checked state');
    await clickRow('file:9102', ['shift'], 'input'); await expectSelected(['file:9102', 'file:9103', 'file:9104'], 'repeated Shift checkbox retains its anchor');
    await clickRow('folder:' + sliceId, ['control'], '.file-name-text');
    await expectSelected(['file:9102', 'file:9103', 'file:9104', 'folder:' + sliceId], 'Ctrl slice name selects without opening details');
    assert.equal(await evaluate(`document.querySelector('#bundle-summary').hidden`), true);
    await clickRow('file:9982', ['shift'], '.file-name-text');
    await expectSelected(['folder:' + sliceId, 'folder:999', 'folder:888', 'file:9981', 'file:9982'], 'range includes slices, ordinary folders and files');
    await clickRow('folder:888', ['control']); await expectSelected(['folder:' + sliceId, 'folder:999', 'file:9981', 'file:9982'], 'Ctrl toggles an ordinary folder');
    await clickRow('file:9981', ['control'], '[data-cloud-manage]');
    assert.equal(await evaluate(`document.querySelector('#file-menu').matches(':popover-open')`), true);
    await expectSelected(['folder:' + sliceId, 'folder:999', 'file:9981', 'file:9982'], 'modified action button still opens its menu without selecting');
    await evaluate(`document.querySelector('#file-menu').hidePopover()`);
    await clickRow('file:9981');
    await evaluate(`document.querySelector('#load-more').click()`); await until(`document.querySelector('#directory-status').textContent.includes('第 2 页')&&!document.querySelector('#refresh-folders').disabled`);
    await clickRow('file:9201', ['shift']);
    await expectSelected(['file:9981', 'file:9982', ...Array.from({length:18},(_,i)=>'file:'+(9100+i)), 'file:9200', 'file:9201'], 'anchor survives pagination and DOM replacement');
    await evaluate(`document.querySelector('#refresh-folders').click()`); await until(`document.querySelector('.slice-folder [data-download-select]')!==null&&!document.querySelector('#refresh-folders').disabled`);
    await clickRow('file:9103', ['shift']); await expectSelected(['file:9103'], 'manual refresh clears the range anchor');
    await evaluate(`document.querySelector('#clear-selection').click()`); await clickRow('file:9102', ['shift']);
    await expectSelected(['file:9102'], 'clear-selection clears the range anchor');
    assert.ok((await fetch(new URL('/fixture/control?bulkRows=220', fixtureOrigin))).ok);
    await evaluate(`document.querySelector('#refresh-folders').click()`); await until(`${box('file:50219')}!==null&&!document.querySelector('#refresh-folders').disabled`);
    await clickRow('file:50000'); await clickRow('file:50219', ['shift']); assert.equal((await selected()).length, 200);
    assert.equal(await evaluate(count('已选 200 项')), true);
    await clickRow('file:50219', ['control']); assert.equal((await selected()).length, 200);
    assert.equal(await evaluate(`${box('file:50219')}.checked`), false);
    assert.ok((await fetch(new URL('/fixture/control?bulkRows=0', fixtureOrigin))).ok);
    await evaluate(`document.querySelector('#refresh-folders').click()`); await until(`document.querySelector('.slice-folder [data-download-select]')!==null&&${box('file:9981')}!==null&&!document.querySelector('#refresh-folders').disabled`);
    await expectSelected([], 'restored directory starts with an empty selection');
    await evaluate(`${box('file:9981')}.click()`); assert.equal(await evaluate(count('已选 1 项')), true);
    assert.equal(await evaluate(`document.querySelector('#select-all-downloads').indeterminate`), true);
    await evaluate(`document.querySelector('#load-more').click()`); await until(`document.querySelector('#directory-status').textContent.includes('第 2 页')&&!document.querySelector('#refresh-folders').disabled`);
    assert.equal(await evaluate(`${box('file:9981')}.checked&&${count('已选 1 项')}`), true);
    await evaluate(`document.querySelector('#select-all-downloads').click()`);
    assert.equal(await evaluate(`document.querySelector('#select-all-downloads').checked&&[...document.querySelectorAll('[data-download-select]')].every(box=>box.checked)`), true);
    assert.equal(await evaluate(`document.querySelector('.folder-row[data-entry-id="888"] input').disabled`), false);
    await evaluate(`${box('file:9981')}.click()`); assert.equal(await evaluate(`document.querySelector('#select-all-downloads').indeterminate`), true);
    await evaluate(`document.querySelector('#clear-selection').click()`); assert.equal(await evaluate(`${count('已选 0 项')}&&document.querySelector('#download-selected').disabled`), true);
    await evaluate(`${box('file:9981')}.click();document.querySelector('.folder-row[data-entry-id="888"] .file-actions button').click()`);
    await until(`document.querySelector('#folder-path').textContent.includes('可进入目录')&&!document.querySelector('#refresh-folders').disabled`);
    assert.equal(await evaluate(count('已选 0 项')), true);
    await evaluate(`document.querySelector('#folder-up').click()`); await until(`${box('file:9981')}!==null&&!document.querySelector('#refresh-folders').disabled`);
    await clickRow('file:9100', ['shift']); await expectSelected(['file:9100'], 'navigation clears range anchors');
    await evaluate(`document.querySelector('#clear-selection').click()`);
    await evaluate(`${box('file:9981')}.click();document.querySelector('#view-raw').click()`);
    await until(`document.querySelector('#view-raw').getAttribute('aria-pressed')==='true'`); assert.equal(await evaluate(count('已选 0 项')), true);
    await evaluate(`${box('file:9981')}.click();document.querySelector('#view-smart').click()`);
    await until(`document.querySelector('.slice-folder [data-download-select]')!==null`); assert.equal(await evaluate(count('已选 0 项')), true);
    await clickRow('file:9103', ['shift']); await expectSelected(['file:9103'], 'mode changes clear range anchors');
    await evaluate(`document.querySelector('#clear-selection').click();document.querySelector('#folder-list').scrollTop=0;window.scrollTo(0,0)`);
    await evaluate(`${box('file:9981')}.click();${box('file:9982')}.click();${box('folder:' + sliceId)}.click();${box('folder:888')}.click()`);
    assert.equal(await evaluate(count('已选 4 项')), true);
    assert.equal(await evaluate(`document.querySelector('#download-selected').textContent`),'下载所选（3）');
    for (const [width, height] of [[940,700],[1260,900],[1920,1080]]) {
      window.setContentSize(width, height);
      await evaluate(`document.querySelector('#notice').hidden=true;document.querySelector('#folder-list').scrollTop=0;document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(resolve)))`);
      const metrics = await evaluate(`(()=>{const panel=document.querySelector('#download-panel').getBoundingClientRect(),list=document.querySelector('#folder-list').getBoundingClientRect(),actions=document.querySelector('.selection-actions').getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,listHeight:list.height,panelHeight:panel.height,selected:document.querySelectorAll('[data-download-select]:checked').length,actions:{left:actions.left,right:actions.right,top:actions.top,bottom:actions.bottom},buttonsReachable:['clear-selection','download-selected'].every(id=>{const n=document.getElementById(id),r=n.getBoundingClientRect();return r.left>=actions.left&&r.right<=actions.right&&r.bottom<=innerHeight&&n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})}})()`);
      assert.equal(metrics.selected, 4); assert.ok(metrics.scrollWidth <= width && metrics.actions.right <= width && metrics.buttonsReachable);
      assert.ok(metrics.listHeight >= metrics.panelHeight * .55);
      layouts.push({ name: `multi-select-${width}x${height}`, ...metrics }); await capture(`multi-select-${width}x${height}.png`);
    }
    const state = await evaluate(`window.lanzou.call('state')`), destination = path.join(state.settings.downloadDir, path.basename(firstFile));
    await rename(destination, path.join(state.settings.downloadDir, 'earlier-fixture-result.exe'));
    await evaluate(`window.__batchEvents=[];window.__batchOff=window.lanzou.onState(s=>window.__batchEvents.push(s.tasks.map(t=>({id:t.id,state:t.state}))));document.querySelector('#download-selected').click()`);
    await until(`window.lanzou.call('state').then(s=>s.tasks.length===3&&s.tasks.every(t=>t.state==='completed'))`, 18000);
    await until(count('已选 0 项'));
    const completed = await evaluate(`window.lanzou.call('state').then(s=>s.tasks)`), events = await evaluate(`window.__batchOff();window.__batchEvents`);
    assert.ok(events.some(tasks => tasks.some(task => task.state === 'queued')));
    assert.ok(events.every(tasks => tasks.filter(task => task.state === 'running').length <= 1));
    assert.deepEqual(await readFile(destination), await readFile(firstFile));
    for (const [name, value] of [['批量文档一.txt', 43], ['批量文档二.txt', 44]]) assert.deepEqual(await readFile(path.join(state.settings.downloadDir, name)), Buffer.alloc(128 * 1024, value));
    await evaluate(`document.querySelector('#tab-transfers').click()`); assert.equal(await evaluate(`document.querySelectorAll('#tasks .task').length`), 3);
    await evaluate(`{const input=document.querySelector('#transfer-state');input.value='queued';input.dispatchEvent(new Event('change',{bubbles:true}));}`);
    assert.equal(await evaluate(`document.querySelectorAll('#tasks .task:not([hidden])').length`), 0);
    await evaluate(`{const input=document.querySelector('#transfer-state');input.value='all';input.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelector('#clear-all-history').click()`);
    await until(`document.querySelector('#task-count').textContent==='0'`);
    const features = { ctrlClickSelection: true, shiftRangeSelection: true, ctrlShiftRangeSelection: true, modifierCheckboxSelection: true, modifierPaginationAnchor: true, modifierAnchorReset: true, modifierActionIsolation: true, rangeSelectionLimit: true, multiSelectCheckboxes: true, selectAllLoadedDownloads: true, selectionAcrossPagination: true, selectionClearedOnNavigation: true, selectionClearedOnModeSwitch: true, ordinaryFoldersNotBatchDownloaded: true, mixedBatchDownloads: true, backgroundDownloadQueue: true, responsiveMultiSelect: true };
    await writeFile(path.join(outputDir, 'batch-download-checks.json'), JSON.stringify({ features, modifierInput: 'native Chromium mouseDown/up via Electron sendInputEvent with control/shift modifiers', rangeLimitFixture: { availableFiles: 220, maximumSelected: 200 }, completed: completed.map(task => ({ name: task.originalName, state: task.state, concurrency: task.concurrency, downloadKind: task.downloadKind || 'slice' })), queuedObserved: true, singleRunningTransfer: true, resultBytesMatch: true, layouts }, null, 2));
    return { features, layouts };
  } finally { window.setContentSize(...size); }
}
