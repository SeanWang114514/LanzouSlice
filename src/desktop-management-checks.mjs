// Invoked only by the isolated loopback desktop fixture.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkFileManagement(window, { evaluate, until, capture, fixtureOrigin, firstFile, checkFolderClick, outputDir }) {
  const layouts = [], size = window.getContentSize();
  const row = id => `document.querySelector('.folder-row[data-entry-id="${id}"]')`;
  const selected = () => evaluate(`[...document.querySelectorAll('[data-download-select]:checked')].map(box=>box.dataset.downloadSelect).sort()`);
  const context = async (id, expected = true) => {
    if (expected) await until(`!document.querySelector('#refresh-folders').disabled&&!/待识别|正在识别/.test(document.querySelector('#recognition-status').textContent)`);
    await evaluate(`${row(id)}.querySelector('.file-name').scrollIntoView({block:'nearest'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const point = await evaluate(`(()=>{const n=${row(id)}.querySelector('.file-name'),r=n.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);if(!n.contains(document.elementFromPoint(x,y)))throw new Error('Context click is obscured');return {x,y}})()`);
    window.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...point, button: 'right', clickCount: 1 });
    await evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`);
    assert.equal(await evaluate(`document.querySelector('#file-menu').matches(':popover-open')`), expected, `native right click for ${id}`);
    return point;
  };
  const menu = async (id, action) => {
    await context(id);
    await until(`document.querySelector('#file-menu').matches(':popover-open')`);
    await evaluate(`document.querySelector('#file-menu [data-cloud-action="${action}"]').click()`);
    await until(`document.querySelector('#cloud-dialog').open`);
  };
  const submit = async name => evaluate(`${name === undefined ? '' : `document.querySelector('#cloud-name').value=${JSON.stringify(name)};`}document.querySelector('#cloud-form').requestSubmit(document.querySelector('#cloud-confirm'))`);
  const done = async () => {
    try { await until(`!document.querySelector('#cloud-dialog').open&&!document.querySelector('#refresh-folders').disabled`); }
    catch (error) {
      const detail = await evaluate(`({title:document.querySelector('#cloud-dialog-title').textContent,error:document.querySelector('#cloud-dialog-error').textContent,errorHidden:document.querySelector('#cloud-dialog-error').hidden,confirmDisabled:document.querySelector('#cloud-confirm').disabled})`);
      await capture('file-management-error.png'); throw new Error(error.message+' '+JSON.stringify(detail));
    }
  };
  const enter = async id => {
    await evaluate(`${row(id)}.querySelector('.file-actions button').click()`);
    await until(`!document.querySelector('#refresh-folders').disabled`);
  };
  const stats = async () => (await (await fetch(`${fixtureOrigin}/fixture/stats`)).json()).requests;
  try {
    await evaluate(`document.querySelector('#tab-download').click()`);
    while (!await evaluate(`document.querySelector('#folder-up').disabled`)) {
      await evaluate(`document.querySelector('#folder-up').click()`); await until(`!document.querySelector('#refresh-folders').disabled`);
    }
    await until(`${row('888')}!==null&&document.querySelector('.slice-folder')!==null&&!document.querySelector('#refresh-folders').disabled`);
    await evaluate(`document.querySelector('#clear-selection').click();${row('9981')}.querySelector('input').click();${row('9982')}.querySelector('input').click()`);
    const pointer = await context('9982');
    const position = await evaluate(`(()=>{const r=document.querySelector('#file-menu').getBoundingClientRect();return {left:r.left,top:r.top}})()`);
    assert.ok(Math.abs(position.left-pointer.x)<=1&&Math.abs(position.top-pointer.y)<=1);
    assert.deepEqual(await selected(), ['file:9981','file:9982']);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#file-menu [data-cloud-action]')].map(button=>button.dataset.cloudAction)`),['delete']);
    await capture('context-menu-file.png');
    await context('9981');
    await evaluate(`document.querySelector('#file-menu [data-cloud-action="delete"]').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('#cloud-delete-list li').length`),2);
    await evaluate(`document.querySelector('#cloud-cancel').click();document.querySelector('#clear-selection').click()`);
    await context('9982');
    await evaluate(`document.querySelector('#file-menu [data-cloud-action="rename"]').click()`);
    assert.equal(await evaluate(`document.querySelector('#cloud-name').value`),'批量文档二.txt');
    await evaluate(`document.querySelector('#cloud-cancel').click()`);
    await context('9100'); assert.deepEqual(await selected(), ['file:9100']);
    for (const type of ['keyDown','keyUp']) window.webContents.sendInputEvent({type,keyCode:'Escape'});
    await until(`!document.querySelector('#file-menu').matches(':popover-open')`);
    await menu('888','delete');
    assert.equal(await evaluate(`document.querySelector('#cloud-dialog-title').textContent`),'删除云端文件夹');
    assert.ok((await evaluate(`document.querySelector('#cloud-dialog-description').textContent`)).includes('可进入目录'));
    assert.deepEqual(await selected(), ['folder:888']);
    await evaluate(`document.querySelector('#cloud-cancel').click();document.querySelector('#view-raw').click()`);
    await until(`document.querySelector('#view-raw').getAttribute('aria-pressed')==='true'`);
    await menu('9982','rename');
    assert.equal(await evaluate(`document.querySelector('#cloud-name').value`),'批量文档二.txt');
    await evaluate(`document.querySelector('#cloud-cancel').click();document.querySelector('#view-smart').click()`);
    await until(`document.querySelector('.slice-folder')!==null`);
    await context('9982');
    await evaluate(`document.querySelector('#folder-list').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:8,clientY:8}))`);
    assert.equal(await evaluate(`document.querySelector('#file-menu').matches(':popover-open')`),false);
    await context('9982');
    await evaluate(`document.querySelector('#folder-list').scrollTop+=80`);
    await until(`!document.querySelector('#file-menu').matches(':popover-open')`);
    await context('9982');
    await evaluate(`document.querySelector('#tab-settings').click()`);
    assert.equal(await evaluate(`document.querySelector('#file-menu').matches(':popover-open')`),false);
    await evaluate(`document.querySelector('#tab-download').click()`);
    await context('9982');
    assert.ok((await fetch(`${fixtureOrigin}/fixture/control?rootDelay=800`)).ok);
    await evaluate(`document.querySelector('#refresh-folders').click()`);
    await context('9982', false);
    await until(`!document.querySelector('#refresh-folders').disabled`);
    assert.ok((await fetch(`${fixtureOrigin}/fixture/control?rootDelay=0`)).ok);
    await enter('888'); await until(`${row('9876')}!==null`);
    assert.equal(await evaluate(`${row('9876')}.querySelector('[data-download-file]').textContent`),'下载');
    await evaluate(`${row('9876')}.querySelector('[data-download-file]').click()`);
    await until(`window.lanzou.call('state').then(s=>s.tasks.some(t=>t.downloadKind==='file'&&t.state==='completed'))`);
    const state = await evaluate(`window.lanzou.call('state')`), task = state.tasks.find(task=>task.downloadKind==='file');
    assert.deepEqual(await readFile(task.resultPath),Buffer.alloc(16,78));
    await evaluate(`document.querySelector('#tab-transfers').click()`);
    assert.equal(await evaluate(`document.querySelector('#tasks .task').textContent.includes('普通文件 · 单连接')&&!document.querySelector('#tasks .task').textContent.includes('导出清单')`),true);
    await checkFolderClick(`document.querySelector('#floating-folder')`, ['reveal', task.resultPath]);
    await checkFolderClick(`[...document.querySelectorAll('#tasks .task button')].find(button=>button.textContent==='打开所在文件夹')`, ['reveal', task.resultPath]);
    await evaluate(`document.querySelector('#floating-close').click();document.querySelector('#tab-download').click()`);

    await menu('9876','delete');
    const before = (await stats()).filter(request=>request.task==='6').length;
    assert.equal(await evaluate(`document.activeElement.id`),'cloud-cancel');
    await evaluate(`document.querySelector('#cloud-cancel').click()`);
    assert.equal((await stats()).filter(request=>request.task==='6').length,before);
    assert.equal(await evaluate(`${row('9876')}!==null`),true);
    await menu('9876','rename'); await submit('改名后的资料 &+.txt'); await done();
    assert.equal(await evaluate(`${row('9876')}.querySelector('.file-name-text').textContent`),'改名后的资料 &+.txt');

    for (const [width,height] of [[940,700],[1260,900],[1920,1080]]) {
      window.setContentSize(width,height);
      await evaluate(`document.querySelector('#notice').hidden=true;document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(resolve)))`);
      await evaluate(`${row('9876')}.querySelector('[data-cloud-manage]').click()`);
      const visible = await evaluate(`(()=>{const list=document.querySelector('#folder-list').getBoundingClientRect(),menu=document.querySelector('#file-menu').getBoundingClientRect();return {viewportWidth:innerWidth,viewportHeight:innerHeight,menu:{left:menu.left,right:menu.right,top:menu.top,bottom:menu.bottom},listWidth:list.width,actionsFit:[...document.querySelectorAll('.file-actions')].every(cell=>{const r=cell.getBoundingClientRect();return [...cell.querySelectorAll('button')].every(button=>{const b=button.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom})})}})()`);
      assert.ok(visible.actionsFit && visible.listWidth>=width*.65);
      assert.ok(visible.menu.left>=0&&visible.menu.top>=0&&visible.menu.right<=visible.viewportWidth&&visible.menu.bottom<=visible.viewportHeight);
      layouts.push({name:`file-management-${width}x${height}`,...visible}); await capture(`file-management-${width}x${height}.png`);
      await evaluate(`document.querySelector('#file-menu [data-cloud-action="delete"]').click()`);
      const dialog = await evaluate(`(()=>{const r=document.querySelector('#cloud-dialog').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,confirmVisible:document.querySelector('#cloud-confirm').getBoundingClientRect().bottom<=r.bottom}})()`);
      assert.ok(dialog.left>=0&&dialog.top>=0&&dialog.right<=visible.viewportWidth&&dialog.bottom<=visible.viewportHeight&&dialog.confirmVisible);
      layouts.push({name:`cloud-delete-dialog-${width}x${height}`,...dialog}); await capture(`cloud-delete-dialog-${width}x${height}.png`);
      await evaluate(`document.querySelector('#cloud-cancel').click()`);
      await evaluate(`${row('9876')}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-1,clientY:innerHeight-1}))`);
      const edge = await evaluate(`(()=>{const r=document.querySelector('#file-menu').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`);
      assert.ok(edge.left>=8&&edge.top>=8&&edge.right<=edge.width-8&&edge.bottom<=edge.height-8,JSON.stringify(edge));
      layouts.push({name:`context-menu-edge-${width}x${height}`,...edge}); await capture(`context-menu-edge-${width}x${height}.png`);
      await evaluate(`document.querySelector('#file-menu').hidePopover()`);
    }

    await evaluate(`document.querySelector('#new-folder').click()`); await submit('bad/name');
    await until(`!document.querySelector('#cloud-dialog-error').hidden`);
    assert.equal(await evaluate(`document.querySelector('#cloud-dialog').open`),true);
    await submit('ManagementTest'); await done();
    const folderId = await evaluate(`[...document.querySelectorAll('.folder-row')].find(node=>node.querySelector('.file-name-text').textContent==='ManagementTest').dataset.entryId`);
    await enter(folderId);
    await evaluate(`document.querySelector('#new-folder').click()`); await submit('Child'); await done();
    assert.equal(await evaluate(`document.querySelector('#folder-list').textContent.includes('Child')`),true);
    await evaluate(`document.querySelector('#folder-up').click()`); await until(`${row(folderId)}!==null&&!document.querySelector('#refresh-folders').disabled`);
    await menu(folderId,'rename'); await submit('ManagedFolder'); await done();
    assert.equal(await evaluate(`${row(folderId)}.textContent.includes('ManagedFolder')`),true);
    await menu(folderId,'delete');
    assert.equal(await evaluate(`document.querySelector('#cloud-dialog-description').textContent.includes('所有内容')`),true);
    await submit(); await done(); assert.equal(await evaluate(`${row(folderId)}===null`),true);
    await menu('9876','delete'); await submit(); await done();
    assert.equal(await evaluate(`${row('9876')}===null`),true);
    assert.equal((await stats()).filter(request=>request.task==='6').length,before+1);
    assert.deepEqual(await readFile(task.resultPath),Buffer.alloc(16,78));

    assert.ok((await fetch(`${fixtureOrigin}/fixture/control?batchDelete=1&failDelete=1`)).ok);
    await evaluate(`document.querySelector('#refresh-folders').click()`); await until(`${row('8802')}!==null&&!document.querySelector('#refresh-folders').disabled`);
    await evaluate(`${row('881')}.querySelector('input').click()`);
    assert.deepEqual(await selected(),['folder:881']);
    assert.equal(await evaluate(`document.querySelector('#download-selected').disabled`),true);
    await evaluate(`${row('8801')}.querySelector('input').click();${row('8802')}.querySelector('input').click()`);
    const attemptsBefore = (await (await fetch(`${fixtureOrigin}/fixture/stats`)).json()).deleteAttempts.length;
    await menu('881','delete');
    assert.equal(await evaluate(`document.querySelectorAll('#cloud-delete-list li').length`),3);
    assert.ok((await evaluate(`document.querySelector('#cloud-delete-list').textContent`)).includes('选中文件一 &+.txt'));
    assert.equal(await evaluate(`document.activeElement.id`),'cloud-cancel');
    await evaluate(`document.querySelector('#cloud-cancel').click()`);
    assert.equal((await (await fetch(`${fixtureOrigin}/fixture/stats`)).json()).deleteAttempts.length,attemptsBefore);
    await menu('8801','delete');
    for (const [width,height] of [[940,700],[1260,900],[1920,1080]]) {
      window.setContentSize(width,height);
      await evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`);
      const dialog = await evaluate(`(()=>{const r=document.querySelector('#cloud-dialog').getBoundingClientRect(),list=document.querySelector('#cloud-delete-list').getBoundingClientRect(),button=document.querySelector('#cloud-confirm').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,items:document.querySelectorAll('#cloud-delete-list li').length,contentsFit:list.top>=r.top&&list.bottom<=button.top&&button.bottom<=r.bottom}})()`);
      assert.ok(dialog.left>=0&&dialog.top>=0&&dialog.right<=dialog.width&&dialog.bottom<=dialog.height&&dialog.items===3&&dialog.contentsFit);
      layouts.push({name:`batch-delete-dialog-${width}x${height}`,...dialog}); await capture(`batch-delete-dialog-${width}x${height}.png`);
    }
    await submit();
    await until(`!document.querySelector('#cloud-confirm').disabled&&!document.querySelector('#cloud-dialog-error').hidden`);
    assert.equal(await evaluate(`document.querySelector('#cloud-dialog').open`),true);
    assert.deepEqual(await selected(),['file:8802']);
    assert.equal(await evaluate(`${row('881')}===null&&${row('8801')}===null&&${row('8803')}!==null`),true);
    assert.equal(await evaluate(`document.querySelectorAll('#cloud-delete-list li').length`),1);
    assert.equal((await (await fetch(`${fixtureOrigin}/fixture/stats`)).json()).batchFolderChildExists,false);
    assert.ok((await fetch(`${fixtureOrigin}/fixture/control?failDelete=0`)).ok);
    await submit(); await done();
    assert.deepEqual(await selected(),[]);
    assert.equal(await evaluate(`${row('8802')}===null&&${row('8803')}!==null`),true);
    const attempts = (await (await fetch(`${fixtureOrigin}/fixture/stats`)).json()).deleteAttempts.slice(attemptsBefore);
    assert.deepEqual(attempts,[{task:'3',id:'881'},{task:'6',id:'8801'},{task:'6',id:'8802'},{task:'6',id:'8802'}]);
    const batchDeleteFeatures = {ordinaryFolderSelection:true,folderModifierSelection:true,batchContextDeleteOnly:true,batchDeleteConfirmation:true,batchDeleteMixedTargets:true,batchDeleteCancel:true,batchDeletePartialRetry:true,batchDeletePreservesUnselected:true,batchDeleteAncestorOnce:true};

    await evaluate(`document.querySelector('#folder-up').click()`); await until(`document.querySelector('#folder-up').disabled&&!document.querySelector('#refresh-folders').disabled`);
    await until(`document.querySelector('.slice-folder')!==null`);
    const sliceId = await evaluate(`document.querySelector('.slice-folder').dataset.entryId`);
    await menu(sliceId,'rename');
    assert.equal(await evaluate(`document.querySelector('#cloud-dialog-description').textContent.includes('原文件名保持不变')`),true);
    await submit('RenamedSliceFolder'); await done(); await until(`${row(sliceId)}.querySelector('.slice-name')!==null`);
    assert.equal(await evaluate(`${row(sliceId)}.querySelector('.slice-name').textContent`),path.basename(firstFile));
    await menu(sliceId,'delete');
    assert.equal(await evaluate(`document.querySelector('#cloud-dialog-description').textContent.includes(${JSON.stringify(path.basename(firstFile))})&&document.querySelector('#cloud-dialog-description').textContent.includes('整个云端目录')`),true);
    await evaluate(`document.querySelector('#cloud-cancel').click()`);
    assert.ok((await fetch(`${fixtureOrigin}/fixture/control?sliceChild=${sliceId}`)).ok);
    await evaluate(`${row(sliceId)}.querySelector('.file-actions button').click()`);
    await until(`${row('883')}!==null&&!document.querySelector('#folder-up').disabled&&!document.querySelector('#refresh-folders').disabled`);
    await evaluate(`document.querySelector('#view-smart').click()`);
    await until(`!!${row(sliceId)}?.querySelector('.slice-name')&&${row('883')}!==null&&!document.querySelector('#refresh-folders').disabled`);
    await evaluate(`${row(sliceId)}.querySelector('input').click();${row('883')}.querySelector('input').click()`);
    assert.deepEqual(await selected(),['folder:883','folder:'+sliceId].sort());
    const parentBefore = (await (await fetch(`${fixtureOrigin}/fixture/stats`)).json()).deleteAttempts.length;
    await menu(sliceId,'delete');
    assert.equal(await evaluate(`document.querySelectorAll('#cloud-delete-list li').length`),2);
    await submit(); await done();
    const parentStats = await (await fetch(`${fixtureOrigin}/fixture/stats`)).json();
    assert.deepEqual(parentStats.deleteAttempts.slice(parentBefore),[{task:'3',id:sliceId}]);
    assert.equal(parentStats.currentSliceChildExists,false);
    assert.equal(await evaluate(`document.querySelector('#folder-up').disabled`),true);
    await writeFile(path.join(outputDir,'batch-delete-checks.json'),JSON.stringify({features:batchDeleteFeatures,deleteAttempts:attempts,remainingSelection:[],unselectedPreserved:true,recursiveFolderDeletion:true,ancestorDeletion:{selected:2,requests:1,returnedToParent:true},layouts:layouts.filter(item=>item.name.startsWith('batch-delete-dialog-'))},null,2));
    assert.equal(await evaluate(`${row(sliceId)}===null`),true);
    await evaluate(`document.querySelector('#refresh-folders').click()`); await until(`!document.querySelector('#refresh-folders').disabled`);
    assert.equal(await evaluate(`${row(sliceId)}===null`),true);
    await evaluate(`document.querySelector('#tab-transfers').click();document.querySelector('#clear-all-history').click()`);
    await until(`document.querySelector('#task-count').textContent==='0'`);
    assert.deepEqual(await readFile(task.resultPath),Buffer.alloc(16,78));
    const contextFeatures = {nativeContextMenu:true,contextMenuRetainsSelection:true,contextMenuSelectsTarget:true,contextMenuSingleItemActions:true,contextMenuFolderActions:true,contextMenuSliceActions:true,contextMenuViewportClamp:true,contextMenuBusyGuard:true,contextMenuDismissal:true};
    await writeFile(path.join(outputDir,'context-menu-checks.json'), JSON.stringify({features:contextFeatures,input:'native Chromium right mouse events; synthetic extreme coordinates for viewport bounds',layouts:layouts.filter(item=>item.name.startsWith('context-menu-edge-'))},null,2));
    return { layouts, features:{...batchDeleteFeatures,...contextFeatures,ordinaryFileDownload:true,ordinaryTaskManagement:true,cloudDeleteConfirmation:true,cloudFileDelete:true,cloudFolderRenameAndDelete:true,nestedFolderCreation:true,managementErrorRecovery:true,sliceDirectoryManagement:true,managementCacheInvalidation:true,localResultsSurviveCloudDelete:true} };
  } catch (error) {
    await capture('context-menu-error.png');
    throw new Error(`File management checks: ${error.stack}`);
  } finally { window.setContentSize(...size); }
}
