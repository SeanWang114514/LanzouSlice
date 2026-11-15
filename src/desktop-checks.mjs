// Invoked only by --smoke-test against the launcher's loopback protocol fixture.
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { checkFileManagement } from './desktop-management-checks.mjs';
import { checkBatchDownloads } from './desktop-batch-checks.mjs';
import { shell } from 'electron';

export async function checkReadAndDrop(window, { firstFile, secondFile, outputDir, fixtureOrigin }) {
  const web = window.webContents;
  const evaluate = code => web.executeJavaScript(code);
  async function until(expression, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (!await evaluate(expression)) {
      if (Date.now() > deadline) {
        const detail = await evaluate(`({notice:document.querySelector('#notice').textContent,directory:document.querySelector('#directory-status').textContent,rows:document.querySelectorAll('.folder-row').length})`);
        throw new Error(`界面检查超时：${expression} ${JSON.stringify(detail)}`);
      }
      await delay(25);
    }
  }
  async function capture(name) {
    for (let attempt = 0; attempt < 3; attempt++) {
      // The offscreen compositor may still be replacing its surface after a resize.
      await delay(120);
      try {
        await writeFile(path.join(outputDir,name),(await web.capturePage()).toPNG());
        return;
      } catch (error) {
        if (error.message !== 'UnknownVizError' || attempt === 2) throw new Error(`桌面截图 ${name} 失败：${error.message}`);
      }
    }
  }
  const layoutChecks = [];
  async function checkLayout(withSummary = false, prefix = withSummary ? 'download-ready' : 'directory') {
    const originalSize = window.getContentSize();
    try {
      for (const [width, height] of [[940,700],[1260,900],[1920,1080]]) {
        window.setContentSize(width, height);
        await evaluate(`document.querySelector('#notice').hidden=true;window.scrollTo(0,0);document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
        const metrics = await evaluate(`(()=>{
          const rect=id=>{const r=document.querySelector(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,width:r.width}};
          const list=document.querySelector('#folder-list');
          return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,panel:rect('#download-panel'),list:rect('#folder-list'),toolbar:rect('.browser-toolbar'),settings:rect('.download-settings'),download:rect('#start-download'),listScrolls:list.scrollHeight>list.clientHeight,titleSize:parseFloat(getComputedStyle(document.querySelector('.download-heading h2')).fontSize)};
        })()`);
        assert.ok(metrics.scrollWidth <= metrics.width, '文件浏览器不能出现横向页面滚动');
        assert.ok(metrics.list.width >= metrics.width * .65, '文件列表应使用窗口主要宽度');
        assert.ok(metrics.list.height >= (withSummary ? 250 : 320), `${prefix} ${width}×${height} 文件列表必须保持主要工作区高度：${JSON.stringify(metrics)}`);
        assert.ok(metrics.list.height >= metrics.panel.height * (withSummary ? .48 : .58), '文件列表必须占据下载面板主要空间');
        assert.ok(metrics.download.bottom <= metrics.height && metrics.download.right <= metrics.width, '下载操作必须留在当前窗口内');
        assert.ok(metrics.settings.top >= metrics.list.bottom && metrics.toolbar.bottom <= metrics.list.top, '工具栏、列表和下载设置不能相互遮挡');
        assert.ok(metrics.titleSize <= 18, '下载标题应使用紧凑字号');
        if (!withSummary) assert.ok(metrics.listScrolls, '多页文件应在列表内部滚动');
        const name = `${prefix}-${width}x${height}`;
        layoutChecks.push({name,...metrics});
        await capture(`${name}.png`);
      }
    } finally { window.setContentSize(...originalSize); }
  }
  async function checkOtherView(name, actionSelector) {
    const originalSize = window.getContentSize();
    try {
      for (const [width,height] of [[940,700],[1260,900],[1920,1080]]) {
        window.setContentSize(width,height);
        await evaluate(`document.querySelector('#notice').hidden=true;window.scrollTo(0,0);document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
        const metrics = await evaluate(`(()=>{const action=document.querySelector(${JSON.stringify(actionSelector)}).getBoundingClientRect(),side=document.querySelector('.account-panel').getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,actionBottom:action.bottom,actionRight:action.right,sideBottom:side.bottom}})()`);
        assert.ok(metrics.scrollWidth <= metrics.width, `${name} 页面不能横向溢出`);
        assert.ok(metrics.actionBottom <= metrics.height && metrics.actionRight <= metrics.width, `${name} 操作必须在窗口内`);
        assert.ok(metrics.sideBottom <= metrics.height, '账号栏应在窗口内独立滚动');
        layoutChecks.push({name:`${name}-${width}x${height}`,...metrics});
        await capture(`${name}-${width}x${height}.png`);
      }
    } finally { window.setContentSize(...originalSize); }
  }
  await until(`document.querySelector('#app-version').textContent.startsWith('v')`);
  await checkOtherView('login','#start-upload');
  await evaluate(`document.querySelector('#tab-settings').click();{const input=document.querySelector('#upload-concurrency');input.value='3';input.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await until(`window.lanzou.call('state').then(state=>state.settings.uploadConcurrency===3&&document.querySelector('#upload-concurrency-label').textContent.includes('3'))`);
  await evaluate(`{const input=document.querySelector('#download-concurrency');input.value='2';input.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await until(`document.querySelector('#concurrency').value==='2'`);
  await evaluate(`document.querySelector('#tab-download').click();{const input=document.querySelector('#concurrency');input.value='5';input.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await until(`document.querySelector('#download-concurrency').value==='5'`);
  await evaluate(`{const input=document.querySelector('#concurrency');input.value='2';input.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await until(`document.querySelector('#download-concurrency').value==='2'`);
  const concurrencySettings = await evaluate(`window.lanzou.call('state').then(state=>state.settings)`);
  assert.equal(concurrencySettings.uploadConcurrency, 3); assert.equal(concurrencySettings.downloadConcurrency, 2); assert.equal(concurrencySettings.autoCleanCache, true);
  await evaluate(`document.querySelector('#tab-upload').click()`);
  await evaluate(`{const input=document.createElement('input');input.id='smoke-files';input.type='file';input.multiple=true;input.hidden=true;document.body.append(input);}`);
  web.debugger.attach('1.3');
  async function checkNeumorphism() {
    const styles = await evaluate(`(()=>{
      const pick=selector=>{const s=getComputedStyle(document.querySelector(selector));return {background:s.backgroundColor,color:s.color,shadow:s.boxShadow,radius:s.borderRadius,transform:s.transform}};
      const root=getComputedStyle(document.documentElement),token=name=>root.getPropertyValue(name).trim();
      return {body:pick('body'),panel:pick('#upload-panel'),button:pick('#official-login'),primary:pick('#login'),input:pick('#account'),tray:pick('#choose-source'),list:pick('#folder-list'),tab:pick('#tab-upload'),menu:pick('#file-menu'),dialog:pick('#cloud-dialog'),floating:pick('#floating-transfer'),tokens:Object.fromEntries(['surface','ink','muted','accent','accent-wash','success','success-wash','danger','danger-wash'].map(name=>[name,token('--'+name)]))};
    })()`);
    assert.equal(styles.body.background, 'rgb(228, 230, 238)');
    for (const item of [styles.panel,styles.button,styles.tab,styles.menu,styles.dialog,styles.floating]) {
      assert.notEqual(item.shadow, 'none'); assert.ok(!item.shadow.includes('inset'), '浮起表面需要外阴影');
    }
    assert.equal(styles.panel.radius, '16px');
    for (const item of [styles.input,styles.tray,styles.list]) assert.ok(item.shadow.includes('inset'), '输入与内容托盘需要内凹层次');
    const rgb=color=>color.startsWith('#')?color.slice(1).match(/../g).map(n=>parseInt(n,16)):color.match(/[\d.]+/g).slice(0,3).map(Number);
    const luminance=color=>rgb(color).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
    const ratio=(a,b)=>{const [light,dark]=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (light+.05)/(dark+.05)};
    const t=styles.tokens;
    const contrast={body:ratio(t.ink,t.surface),muted:ratio(t.muted,t.surface),primary:ratio(styles.primary.color,styles.primary.background),accent:ratio(t.accent,t.surface),selected:ratio(t.ink,t['accent-wash']),success:ratio(t.success,t['success-wash']),danger:ratio(t.danger,t['danger-wash'])};
    contrast.selectedAccent=ratio(t.accent,t['accent-wash']);
    contrast.selectedMuted=ratio(t.muted,t['accent-wash']);
    for(const [name,value] of Object.entries(contrast)) assert.ok(value>=4.5, `${name} 对比度必须至少为 4.5:1，实际 ${value}`);
    await web.debugger.sendCommand('CSS.enable');
    const {root}=await web.debugger.sendCommand('DOM.getDocument');
    const node=await web.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'#official-login'});
    let pressed,focus,reduced,forced;
    try {
      await web.debugger.sendCommand('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:['active']});
      await evaluate(`new Promise(resolve=>setTimeout(resolve,170))`);
      pressed=await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('#official-login'));return {shadow:s.boxShadow,transform:s.transform}})()`);
      assert.ok(pressed.shadow.includes('inset')); assert.equal(pressed.transform,'none');
      await web.debugger.sendCommand('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:['focus-visible']});
      focus=await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('#official-login'));return {style:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor}})()`);
      assert.equal(focus.style,'solid'); assert.ok(parseFloat(focus.width)>=2); assert.equal(focus.color,styles.primary.background);
      await web.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      reduced=await evaluate(`({matches:matchMedia('(prefers-reduced-motion:reduce)').matches,transition:getComputedStyle(document.querySelector('#official-login')).transitionDuration})`);
      assert.ok(reduced.matches); assert.equal(reduced.transition,'0s');
      await web.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
      forced=await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('#upload-panel'));return {matches:matchMedia('(forced-colors:active)').matches,shadow:s.boxShadow,border:s.borderTopStyle,width:s.borderTopWidth}})()`);
      assert.ok(forced.matches); assert.equal(forced.shadow,'none'); assert.equal(forced.border,'solid'); assert.ok(parseFloat(forced.width)>=1);
    } finally {
      await web.debugger.sendCommand('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:[]});
      await web.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
    }
    const features={neumorphicPalette:true,neumorphicRaisedSurfaces:true,neumorphicInsetInputs:true,neumorphicPressedControls:true,readableThemeContrast:true,visibleKeyboardFocus:true,reducedMotionTheme:true,forcedColorsTheme:true};
    await writeFile(path.join(outputDir,'neumorphism-checks.json'),JSON.stringify({features,styles,contrast,pressed,focus,reduced,forced},null,2));
    return features;
  }
  const folderCalls = [], folderClicks = [], nativeReveal = shell.showItemInFolder, nativeOpen = shell.openPath;
  async function checkFolderClick(expression, expected) {
    const before = folderCalls.length;
    await evaluate(`(${expression}).click()`);
    const deadline = Date.now() + 3000;
    while (folderCalls.length === before && Date.now() < deadline) await delay(20);
    assert.equal(folderCalls.length, before + 1, '打开文件夹按钮必须通过 IPC 到达主进程');
    assert.deepEqual(folderCalls.at(-1), expected);
    folderClicks.push({ control: expression, method: expected[0], path: expected[1] });
  }
  try {
    // Record shell calls only inside this isolated desktop test; do not open Explorer windows.
    shell.showItemInFolder = filename => { folderCalls.push(['reveal', filename]); };
    shell.openPath = async directory => { folderCalls.push(['open', directory]); return ''; };
    await web.debugger.sendCommand('DOM.enable');
    const theme = await checkNeumorphism();
    const iconChecks = await evaluate(`(()=>{
      const hosts=[...document.querySelectorAll('[data-icon]')],logo=document.querySelector('.logo');
      const details=hosts.map(host=>{const svg=host.querySelector('svg'),style=svg&&getComputedStyle(svg);return {name:host.dataset.icon,vector:!!svg,hidden:svg?.getAttribute('aria-hidden')==='true',nonFocusable:svg?.getAttribute('focusable')==='false',stroke:style?.stroke,fill:style?.fill,width:style?.width,height:style?.height,label:host.getAttribute('aria-label')}});
      return {static:details,logoLoaded:logo.complete&&logo.naturalWidth>0,quietSurfaces:['.logo','.account-icon','.file-icon'].every(selector=>getComputedStyle(document.querySelector(selector)).boxShadow==='none')};
    })()`);
    assert.equal(iconChecks.static.length,5);
    assert.ok(iconChecks.static.every(item=>item.vector&&item.hidden&&item.nonFocusable&&item.fill==='none'&&item.stroke!=='none'));
    assert.ok(iconChecks.logoLoaded&&iconChecks.quietSurfaces);
    assert.equal(iconChecks.static.find(item=>item.name==='close').label,'隐藏传输浮窗');
    const { root } = await web.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await web.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#smoke-files' });
    async function drop(files) {
      await web.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files });
      await evaluate(`{const data=new DataTransfer();for(const file of document.querySelector('#smoke-files').files)data.items.add(file);const zone=document.querySelector('#choose-source');zone.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:data}));zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));}`);
    }
    await drop([firstFile]);
    await until(`document.querySelector('#source-path').textContent===${JSON.stringify(firstFile)}`);
    await until(`document.querySelector('#notice').textContent.includes('登录后点击上传')`);
    assert.equal(await evaluate(`window.lanzou.call('state').then(state=>state.tasks.length)`), 0);
    assert.equal(await evaluate(`!document.querySelector('#source-size').hidden&&document.querySelector('#source-size').textContent.includes('KiB')&&document.querySelector('#choose-source').classList.contains('has-file')`), true);

    await drop([firstFile, secondFile]);
    await until(`document.querySelector('#notice').textContent.includes('每次请拖入一个文件')`);
    assert.equal(await evaluate(`document.querySelector('#source-path').textContent`), firstFile);
    await evaluate(`{const data=new DataTransfer();data.items.add(new File(['virtual'],'virtual.bin'));document.querySelector('#choose-source').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));}`);
    await until(`document.querySelector('#notice').textContent.includes('实际文件')`);
    assert.equal(await evaluate(`window.lanzou.call('selectSource',{path:${JSON.stringify(path.dirname(firstFile))}}).then(()=>false,error=>error.message.includes('文件夹'))`), true);

    await evaluate(`window.lanzou.call('login',{account:'test',password:'only-for-fixture',remember:false})`);
    await until(`document.querySelector('#account-status').classList.contains('connected')`);
    assert.equal(await evaluate(`document.querySelector('#account-options').open`), false);
    await checkOtherView('upload','#start-upload');
    await evaluate(`document.querySelector('#tab-download').click()`);
    await until(`document.querySelector('#directory-status').textContent.includes('第 1 页')`);
    assert.equal(await evaluate(`document.querySelector('#folder-list').textContent.includes('第一页文件')&&!document.querySelector('#folder-list').textContent.includes('第二页文件')`), true);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.file-table th')].map(node=>node.textContent)`), ['名称','大小','修改时间','操作']);
    assert.equal(await evaluate(`{const name=[...document.querySelectorAll('.file-name-text')].find(node=>node.textContent.includes('长文件名'));name.title===name.textContent&&name.scrollWidth>name.clientWidth}`), true);
    await evaluate(`document.querySelector('#folder-list').scrollTop=180`);
    await evaluate(`document.querySelector('#load-more').click()`);
    await until(`document.querySelector('#directory-status').textContent.includes('第 2 页')`);
    assert.equal(await evaluate(`document.querySelector('#folder-list').scrollTop`), 180);
    assert.equal(await evaluate(`document.querySelector('#folder-list').textContent.includes('第一页文件')&&document.querySelector('#folder-list').textContent.includes('第二页文件')`), true);
    await evaluate(`document.querySelector('#load-more').click()`);
    await until(`document.querySelector('#load-more').hidden`);
    assert.equal(await evaluate(`{const list=document.querySelector('#folder-list'),head=document.querySelector('.file-table th');Math.abs(head.getBoundingClientRect().top-list.getBoundingClientRect().top)<=2}`), true);
    await evaluate(`document.querySelector('#folder-list').scrollTop=0`);
    await checkLayout();
    iconChecks.files=await evaluate(`[...document.querySelectorAll('.entry-icon')].map(svg=>({viewBox:svg.getAttribute('viewBox'),hidden:svg.getAttribute('aria-hidden'),stroke:getComputedStyle(svg).strokeWidth,width:getComputedStyle(svg).width,height:getComputedStyle(svg).height}))`);
    assert.ok(iconChecks.files.length>3&&iconChecks.files.every(item=>item.viewBox==='0 0 24 24'&&item.hidden==='true'&&item.stroke==='1.75px'&&item.width==='20px'&&item.height==='20px'));
    await evaluate(`document.querySelector('#share-source').click()`);
    assert.equal(await evaluate(`document.querySelector('#browser-views').hidden`), true);
    await checkOtherView('share','#start-download');
    await evaluate(`document.querySelector('#account-source').click()`);

    const enter = name => evaluate(`{const row=[...document.querySelectorAll('.folder-row')].find(row=>row.textContent.includes(${JSON.stringify(name)}));if(!row)throw new Error('未找到测试目录');row.querySelector('.file-actions button').click();}`);
    await evaluate(`document.querySelector('#folder-list').scrollTop=140`);
    await enter('读取失败目录');
    await until(`document.querySelector('#directory-status').textContent.includes('读取失败')`);
    assert.equal(await evaluate(`document.querySelector('#notice').getBoundingClientRect().bottom<document.querySelector('.download-settings').getBoundingClientRect().top`), true, '提示消息不能遮挡底部操作');
    assert.equal(await evaluate(`document.querySelector('#folder-path').textContent`), '根目录');
    assert.equal(await evaluate(`document.querySelector('#folder-list').scrollTop`), 140);
    assert.equal(await evaluate(`document.querySelector('#folder-list').textContent.includes('第二页文件')`), true);
    await enter('可进入目录');
    await until(`document.querySelector('#folder-path').textContent.includes('可进入目录')`);
    await until(`document.querySelector('#folder-list').textContent.includes('普通文件夹')`);
    assert.equal(await evaluate(`document.querySelector('#folder-list').textContent.includes('普通文档.txt')&&document.querySelectorAll('.slice-folder').length===0&&document.querySelectorAll('[data-download-slice]').length===0`), true);
    await enter('普通子目录');
    await until(`document.querySelector('#folder-path').textContent.includes('普通子目录')&&document.querySelector('#folder-list').textContent.includes('此目录为空')`);
    await evaluate(`document.querySelector('#folder-up').click()`);
    await until(`document.querySelector('#folder-path').textContent.endsWith('可进入目录')&&!document.querySelector('#refresh-folders').disabled`);
    await fetch(`${fixtureOrigin}/fixture/control?rootDelay=350`);
    const instantNavigation = await evaluate(`(()=>{const started=performance.now();document.querySelector('#folder-up').click();return {root:document.querySelector('#folder-path').textContent==='根目录',rows:document.querySelectorAll('.folder-row').length,time:performance.now()-started,updating:document.querySelector('#directory-status').textContent.includes('正在更新')}})()`);
    assert.equal(instantNavigation.root, true); assert.equal(instantNavigation.updating, true); assert.ok(instantNavigation.rows > 0);
    await until(`!document.querySelector('#refresh-folders').disabled`);
    await fetch(`${fixtureOrigin}/fixture/control?rootDelay=0`);
    await until(`document.querySelector('#folder-path').textContent==='根目录'&&document.querySelector('#folder-up').disabled`);
    await until(`document.querySelector('#directory-status').textContent.includes('第 1 页')`);
    assert.equal(await evaluate(`document.querySelector('#folder-list').scrollTop`), 0);

    await evaluate(`document.querySelector('#tab-upload').click()`);
    await drop([firstFile]);
    await until(`(async()=>{const s=await window.lanzou.call('state');return s.tasks.some(task=>task.type==='upload'&&task.state==='running')})()`);
    await drop([secondFile]);
    await until(`document.querySelector('#source-path').textContent===${JSON.stringify(secondFile)}`);
    await until(`document.querySelector('#notice').textContent.includes('当前任务')`);
    await until(`!document.querySelector('#floating-transfer').hidden`);
    assert.match(await evaluate(`document.querySelector('#floating-speed').textContent`), /^\d+\.\d{2} (?:B|KiB|MiB|GiB|TiB)\/s$/);
    await checkFolderClick(`document.querySelector('#floating-folder')`, ['reveal', firstFile]);
    await checkFolderClick(`document.querySelector('#floating-name')`, ['reveal', firstFile]);
    assert.match(await evaluate(`document.querySelector('#floating-elapsed').textContent`), /^\d{2}:\d{2}:\d{2}$/);
    assert.equal(await evaluate(`document.querySelector('.tasks-panel')===null`), true);
    await evaluate(`document.querySelector('#floating-toggle').click()`);
    assert.equal(await evaluate(`document.querySelector('#floating-transfer').getBoundingClientRect().height`), 48);
    await evaluate(`document.querySelector('#floating-toggle').click();document.querySelector('#floating-open').click()`);
    await until(`!document.querySelector('#transfers-panel').hidden`);
    await checkFolderClick(`[...document.querySelectorAll('#tasks .task-buttons button')].find(button=>button.textContent==='打开所在文件夹')`, ['reveal', firstFile]);
    await evaluate(`document.querySelector('#pause-all').click()`);
    await until(`window.lanzou.call('state').then(state=>state.tasks[0].state==='paused')`);
    await until(`document.querySelector('#floating-action').textContent==='继续'`);
    assert.equal(await evaluate(`document.querySelector('#floating-speed').textContent`), '0.00 B/s');
    await checkOtherView('transfer-manager-paused', '#pause-all');
    await evaluate(`document.querySelector('#floating-action').click()`);
    // Keep the already-loaded browser open during completion: a late state event must refresh it.
    await evaluate(`document.querySelector('#tab-download').click()`);
    await until(`(async()=>{const s=await window.lanzou.call('state');return s.tasks.some(task=>task.type==='upload'&&task.state==='completed')})()`);
    const state = await evaluate(`window.lanzou.call('state')`);
    assert.equal(state.tasks.length, 1); assert.equal(state.tasks[0].originalName, path.basename(firstFile));
    assert.equal(state.tasks[0].concurrency, 3); assert.equal(state.tasks[0].totalParts, 5);
    assert.equal(await evaluate(`document.querySelector('#choose-source').classList.contains('dragging')`), false);
    await evaluate(`document.querySelector('#tab-transfers').click()`);
    assert.equal(await evaluate(`!document.querySelector('#transfers-panel').hidden&&document.querySelectorAll('#tasks .task').length===1`), true);
    await evaluate(`document.querySelector('.task-more').open=true`);
    assert.equal(await evaluate(`document.querySelector('.task-more').open`), true);

    await evaluate(`document.querySelector('#tab-download').click()`);
    await until(`document.querySelector('#folder-list').textContent.includes(${JSON.stringify(state.tasks[0].folderName)})`);
    await until(`document.querySelector('.slice-folder .select-download')!==null`);
    assert.equal(await evaluate(`document.querySelector('.slice-folder .file-name-text').textContent`), path.basename(firstFile));
    assert.equal(await evaluate(`document.querySelector('.file-table tbody tr').classList.contains('slice-folder')`), true);
    assert.equal(await evaluate(`document.querySelector('.slice-badge').textContent`), '快速预览');
    assert.equal(await evaluate(`document.querySelector('.slice-caption').textContent.includes('下载前校验')`), true);
    assert.equal(await evaluate(`document.querySelector('#bundle-summary').hidden`), true);
    assert.equal(await evaluate(`document.querySelector('#view-smart').getAttribute('aria-pressed')`), 'true');
    await until(`document.querySelector('.recognition-error')!==null`);
    assert.equal(await evaluate(`document.querySelector('.recognition-error').textContent.includes('离线目录读取失败')`), true);
    const folderId = state.tasks[0].folderId;
    const countReads = stats => stats.requests.filter(request => request.folderId === folderId && ['47','5'].includes(request.task)).length;
    const beforeCache = countReads(await (await fetch(`${fixtureOrigin}/fixture/stats`)).json());
    const instantPage = await evaluate(`window.lanzou.call('listPage',{folderId:'-1'}).then(page=>page.entries.find(file=>file.id===${JSON.stringify(folderId)}))`);
    assert.equal(instantPage.slice.originalName, path.basename(firstFile)); assert.equal(instantPage.slice.cached, true);
    const warm = await evaluate(`window.lanzou.call('identifyFolders',{folderIds:[${JSON.stringify(folderId)}]})`);
    assert.equal(warm[0].cached, true); assert.equal(countReads(await (await fetch(`${fixtureOrigin}/fixture/stats`)).json()), beforeCache);
    await evaluate(`window.__recognitionResults=[];window.__recognitionPending=true;window.__recognitionOff=window.lanzou.onRecognition(event=>{if(event.token==='desktop-stream')window.__recognitionResults.push(event.result)});window.__recognitionScan=window.lanzou.call('identifyFolders',{folderIds:['999','888'],force:true,token:'desktop-stream'}).then(results=>{window.__recognitionPending=false;return results});undefined`);
    await until(`window.__recognitionResults.some(result=>result.id==='888')`);
    assert.equal(await evaluate(`window.__recognitionPending`), true, '快目录应先于慢目录整批结束显示');
    await evaluate(`window.__recognitionScan.then(()=>{window.__recognitionOff();})`);
    await evaluate(`document.querySelector('#refresh-folders').click()`);
    await until(`document.querySelector('.slice-folder .slice-name')!==null&&!document.querySelector('.slice-folder .slice-caption').textContent.includes('缓存预览')`);
    await until(`!document.querySelector('#recognition-status').textContent.includes('待识别')`);
    assert.ok(countReads(await (await fetch(`${fixtureOrigin}/fixture/stats`)).json()) > beforeCache, '刷新目录必须绕过旧识别缓存');
    const normal = await evaluate(`(()=>{const row=[...document.querySelectorAll('.folder-row')].find(row=>row.querySelector('.file-name-text').textContent==='可进入目录');return {folder:!!row.querySelector('.entry-icon.folder'),enter:row.querySelector('button').textContent,downloads:row.querySelectorAll('[data-download-slice]').length,caption:row.querySelector('.slice-caption')?.textContent}})()`);
    assert.deepEqual(normal, {folder:true,enter:'进入',downloads:0,caption:'普通文件夹'});
    await writeFile(path.join(outputDir,'recognition-checks.json'),JSON.stringify({instantNavigation,warmChildRequests:0,uploadedPreviewSeeded:true,streamedBeforeSlowFolder:true,forceRefresh:true,ordinaryFolder:normal},null,2));
    await evaluate(`document.querySelector('#notice').hidden=true`);
    await capture('recognized-original-name.png');
    await checkLayout(false, 'smart-directory');
    await evaluate(`document.querySelector('#view-raw').click()`);
    await until(`window.lanzou.call('state').then(state=>state.settings.browserView==='raw'&&document.querySelector('#view-raw').getAttribute('aria-pressed')==='true')`);
    assert.equal(await evaluate(`document.querySelectorAll('.slice-folder').length`), 0);
    assert.equal(await evaluate(`[...document.querySelectorAll('.file-name-text')].some(node=>node.textContent===${JSON.stringify(state.tasks[0].folderName)})`), true);
    await capture('raw-cloud.png');
    await checkLayout(false, 'raw-directory');
    await evaluate(`document.querySelector('#view-smart').click()`);
    await until(`document.querySelector('.slice-folder .slice-name')!==null`);
    await evaluate(`document.querySelector('.slice-name').click()`);
    await until(`!document.querySelector('#bundle-summary').hidden&&!document.querySelector('#start-download').disabled`);
    assert.equal(await evaluate(`document.querySelector('#bundle-summary strong').textContent`), path.basename(firstFile));
    assert.equal(await evaluate(`document.querySelector('.bundle-integrity code').textContent`), state.tasks[0].sourceSha256);
    const initialSettings = await evaluate(`window.lanzou.call('state').then(state=>state.settings)`);
    assert.ok(path.isAbsolute(initialSettings.downloadDir) && path.isAbsolute(initialSettings.cacheDir));
    await evaluate(`window.lanzou.call('saveSettings',{autoCleanCache:false})`);
    await until(`!document.querySelector('#auto-clean-cache').checked`);
    await evaluate(`document.querySelector('.select-download').click()`);
    await until(`window.lanzou.call('state').then(state=>state.tasks.some(task=>task.type==='download'&&task.state==='completed'))`);
    const downloaded = await evaluate(`window.lanzou.call('state').then(state=>state.tasks.find(task=>task.type==='download'))`);
    assert.equal(downloaded.concurrency, 2);
    assert.deepEqual(await readFile(downloaded.resultPath), await readFile(firstFile));
    assert.equal(path.dirname(downloaded.resultPath), initialSettings.downloadDir);
    assert.equal(path.dirname(downloaded.cachePath), initialSettings.cacheDir);
    await until(`document.querySelector('#floating-state').textContent==='下载 · 已完成'`);
    await checkFolderClick(`document.querySelector('#floating-folder')`, ['reveal', downloaded.resultPath]);
    await checkFolderClick(`document.querySelector('#floating-name')`, ['reveal', downloaded.resultPath]);
    await evaluate(`document.querySelector('#tab-transfers').click()`);
    await checkFolderClick(`[...document.querySelectorAll('#tasks .task[data-task-id="${downloaded.id}"] button')].find(button=>button.textContent==='打开所在文件夹')`, ['reveal', downloaded.resultPath]);
    assert.equal(Object.hasOwn(state.tasks[0], 'sourcePath'), false);
    await evaluate(`document.querySelector('#tab-settings').click()`);
    await until(`document.querySelector('#cache-status').textContent.includes('可清理')`);
    assert.ok((await evaluate(`window.lanzou.call('cacheInfo')`)).cleanableBytes > 0);
    await checkOtherView('settings','#set-download-dir');
    await evaluate(`document.querySelector('#clean-cache').click()`);
    await until(`document.querySelector('#notice').textContent.includes('已清理')`);
    assert.equal((await evaluate(`window.lanzou.call('cacheInfo')`)).cleanableBytes, 0);
    assert.deepEqual(await readFile(downloaded.resultPath), await readFile(firstFile));
    await evaluate(`document.querySelector('#auto-clean-cache').click()`);
    await until(`window.lanzou.call('state').then(state=>state.settings.autoCleanCache)`);
    await evaluate(`document.querySelector('#tab-download').click()`);
    await enter(state.tasks[0].folderName);
    await until(`document.querySelector('#folder-list').textContent.includes('manifest.lanzou.txt')`);
    await evaluate(`[...document.querySelectorAll('.folder-row button')].find(button=>button.textContent==='读取清单').click()`);
    await until(`!document.querySelector('#bundle-summary').hidden`);
    assert.equal(await evaluate(`document.querySelector('#bundle-summary strong').textContent`), path.basename(firstFile));
    await checkLayout(true);
    await evaluate(`document.querySelector('#view-smart').click()`);
    await until(`document.querySelector('.slice-folder .slice-name')!==null`);
    assert.equal(await evaluate(`document.querySelectorAll('.folder-row').length`), 1);
    assert.equal(await evaluate(`document.querySelector('#folder-list').textContent.includes('part-000001.zip')`), false);
    assert.equal(await evaluate(`document.querySelector('.slice-name').textContent`), path.basename(firstFile));
    await evaluate(`document.querySelector('.slice-name').click()`);
    await until(`!document.querySelector('#bundle-summary').hidden`);
    await checkLayout(true, 'smart-current');
    await writeFile(path.join(outputDir,'layout-checks.json'),JSON.stringify(layoutChecks,null,2));
    await evaluate(`document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
    await capture('read-and-drop.png');
    await evaluate(`document.querySelector('#tab-transfers').click();document.querySelector('#floating-close').click()`);
    await checkOtherView('transfer-manager-completed', '#clear-all-history');
    iconChecks.transfers=await evaluate(`[...document.querySelectorAll('#tasks .task-name')].map(title=>({text:title.textContent,vector:!!title.querySelector('svg.task-direction'),truncates:getComputedStyle(title.querySelector('.task-name-text')).textOverflow}))`);
    assert.equal(iconChecks.transfers.length,2);
    assert.ok(iconChecks.transfers.every(item=>item.vector&&item.truncates==='ellipsis'));
    assert.ok(iconChecks.transfers.some(item=>item.text.startsWith('上传 ·'))&&iconChecks.transfers.some(item=>item.text.startsWith('下载 ·')));
    iconChecks.features={staticSvgIcons:true,unifiedFileIcons:true,quietIconSurfaces:true,transferDirectionIcons:true};
    await writeFile(path.join(outputDir,'icon-checks.json'),JSON.stringify(iconChecks,null,2));
    Object.assign(theme,iconChecks.features);
    await evaluate(`{const select=document.querySelector('#transfer-type');select.value='download';select.dispatchEvent(new Event('change',{bubbles:true}));}`);
    assert.equal(await evaluate(`document.querySelectorAll('#tasks .task:not([hidden])').length`), 1);
    assert.equal(await evaluate(`document.querySelector('#tasks .task:not([hidden]) .task-name').textContent.startsWith('下载 ·')`), true);
    await evaluate(`{const select=document.querySelector('#transfer-state');select.value='failed';select.dispatchEvent(new Event('change',{bubbles:true}));}`);
    assert.equal(await evaluate(`document.querySelectorAll('#tasks .task:not([hidden])').length`), 0);
    await evaluate(`for(const id of ['transfer-type','transfer-state']){const select=document.getElementById(id);select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}));}`);
    await evaluate(`{const row=[...document.querySelectorAll('#tasks .task')].find(node=>node.querySelector('.task-name').textContent.startsWith('上传 ·'));[...row.querySelectorAll('button')].find(button=>button.textContent==='移除记录').click();}`);
    await until(`document.querySelector('#task-count').textContent==='1'`);
    assert.equal(await evaluate(`window.lanzou.call('state').then(state=>state.tasks.length===1&&state.tasks[0].type==='download')`), true);
    await evaluate(`document.querySelector('#show-floating').click()`);
    const actual = await evaluate(`window.lanzou.call('state')`), beforeSize = window.getContentSize();
    try {
      for (const [width,height] of [[940,700],[1260,900],[1920,1080]]) {
        window.setContentSize(width,height);
        const sample = { ...actual, tasks: [{ ...actual.tasks[0], state:'running', phase:'downloading', message:'正在下载切片（界面数值演示）', speedBytesPerSecond:1536, elapsedMs:59500, remainingSeconds:3599.5, progress:.125 }] };
        web.send('app:state',sample);
        await until(`!document.querySelector('#floating-transfer').hidden&&document.querySelector('#floating-speed').textContent==='1.50 KiB/s'`);
        assert.equal(await evaluate(`document.querySelector('#tasks .transfer-metrics strong').textContent`), '1.50 KiB/s');
        assert.equal(await evaluate(`document.querySelector('#floating-elapsed').textContent`),'00:01:00');
        assert.equal(await evaluate(`document.querySelector('#floating-remaining').textContent`),'01:00:00');
        const measure = `(()=>{
          const panel=document.querySelector('#floating-transfer'),r=panel.getBoundingClientRect();
          const rows=[panel.querySelector('.floating-heading'),panel.querySelector('.floating-name'),panel.querySelector('.transfer-progress'),panel.querySelector('.transfer-metrics'),panel.querySelector('.floating-actions')].map(node=>node.getBoundingClientRect());
          return {width:r.width,height:r.height,right:r.right,bottom:r.bottom,
            contentFits:[...panel.querySelectorAll('button,small,strong,.floating-name,.floating-message,progress,#floating-percent')].every(node=>{const b=node.getBoundingClientRect();return b.width>0&&b.height>0&&b.top>=r.top+1&&b.bottom<=r.bottom-1&&b.left>=r.left+1&&b.right<=r.right-1}),
            rowsDoNotOverlap:rows.every((row,i)=>!i||row.top>=rows[i-1].bottom),
            buttonsReachable:[...panel.querySelectorAll('button')].every(node=>{const b=node.getBoundingClientRect();return node.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))}),
            bytesFit:panel.querySelector('#floating-bytes').scrollWidth<=panel.querySelector('#floating-bytes').clientWidth,
            fields:[...panel.querySelectorAll('.transfer-metrics strong')].map(node=>({width:node.clientWidth,height:node.clientHeight,overflow:node.scrollWidth>node.clientWidth}))};
        })()`;
        const first = await evaluate(measure);
        assert.equal(first.width,344); assert.equal(first.height,128); assert.ok(first.right<=width && first.bottom<=height+4);
        assert.ok(first.contentFits && first.rowsDoNotOverlap && first.buttonsReachable && first.bytesFit,'紧凑浮窗内容不能裁切、重叠或遮挡操作');
        assert.ok(first.fields.every(field=>!field.overflow));
        await capture(`transfer-floating-${width}x${height}.png`);
        web.send('app:state',{...sample,tasks:[{...sample.tasks[0],speedBytesPerSecond:1024**3*999,elapsedMs:864000000,remainingSeconds:8639999,originalName:'超长文件名 [安装包] &+💾'.repeat(40)+'.exe'}]});
        await until(`document.querySelector('#floating-speed').textContent==='999.00 GiB/s'`);
        const second = await evaluate(measure);
        assert.deepEqual(second,first,'浮窗和数字区域不应因数值长度变化而改变尺寸或溢出');
        layoutChecks.push({name:`transfer-floating-${width}x${height}`,...second});
      }
    } finally { web.send('app:state',actual); window.setContentSize(...beforeSize); }
    await until(`!document.querySelector('#clear-all-history').disabled`);
    await writeFile(path.join(outputDir,'layout-checks.json'),JSON.stringify(layoutChecks,null,2));
    await evaluate(`document.querySelector('#clear-all-history').click()`);
    await until(`document.querySelector('#task-count').textContent==='0'&&document.querySelectorAll('#tasks .task').length===0`);
    assert.equal((await evaluate(`window.lanzou.call('state')`)).tasks.length, 0);
    assert.deepEqual(await readFile(downloaded.resultPath), await readFile(firstFile));
    assert.equal(await evaluate(`document.querySelector('#transfers-panel').hidden`), false, '清空历史后应保留管理页');
    assert.equal(await evaluate(`document.querySelector('#floating-transfer').hidden`), true);
    const batch = await checkBatchDownloads(window, { evaluate, until, capture, firstFile, outputDir, fixtureOrigin });
    layoutChecks.push(...batch.layouts);
    const management = await checkFileManagement(window, { evaluate, until, capture, fixtureOrigin, firstFile, checkFolderClick, outputDir });
    Object.assign(management.features, theme);
    assert.equal(folderClicks.length, 8);
    await writeFile(path.join(outputDir,'folder-opening-checks.json'), JSON.stringify({ shellCallsIntercepted: true, realExplorerWindowsOpened: false, clicks: folderClicks }, null, 2));
    layoutChecks.push(...management.layouts);
    await writeFile(path.join(outputDir,'layout-checks.json'),JSON.stringify(layoutChecks,null,2));
    return { ...batch.features, ...management.features, twoDecimalTransferSpeed:true, floatingFolderButton:true, clickableFloatingName:true, uploadSourceLocation:true, slicedDownloadLocation:true, ordinaryDownloadLocation:true, transferManagerFolderButtons:true, nativeFilePath:true, unloggedDropSelectsOnly:true, multipleFilesRejected:true, virtualFileRejected:true, directoryRejected:true, firstPage:true, loadMore:true, endOfList:true, navigationRollback:true, nestedNavigation:true, automaticDropUpload:true, busyDropSelectsOnly:true, manifestRead:true, responsiveFileBrowser:true, alignedFileColumns:true, longNameOverflow:true, paginationKeepsScroll:true, stickyTableHeader:true, compactAccount:true, uploadMetadata:true, expandableTaskDetails:true, responsiveLoginUploadShare:true, automaticOriginalName:true, accountDownloadWithoutShareCode:true, downloadSelection:true, defaultDownloadDirectory:true, dedicatedCacheDirectory:true, cacheCleanup:true, autoCleanToggle:true, clearHistory:true, mergedResultPreserved:true, responsiveSettings:true, uploadConcurrencySetting:true, downloadConcurrencySetting:true, downloadConcurrencyShortcut:true, smartDisplayMode:true, rawDisplayMode:true, displayModeSaved:true, sliceBadgeAndPriority:true, recognitionErrorVisible:true, oneClickDownloadMerge:true, currentSliceCollapsed:true, hashDetailsVisible:true, iframeAliasedSignature:true, fastIndexPreview:true, previewRequiresManifestSelection:true, transferManager:true, typeAndStatusFilters:true, pauseAllAndResumePopup:true, floatingTransferProgress:true, roundedSpeedAndTime:true, fixedFloatingDimensions:true, fixedMetricDimensions:true, allHistoryCleanup:true, singleHistoryRemoval:true, instantDirectoryPreview:true, warmRecognitionZeroReads:true, uploadPreviewPreheated:true, streamedRecognition:true, ordinaryFolderDisplay:true, nestedOrdinaryFolders:true, forceRecognitionRefresh:true };
  } finally { shell.showItemInFolder = nativeReveal; shell.openPath = nativeOpen; web.debugger.detach(); await evaluate(`document.querySelector('#smoke-files')?.remove()`); }
}
