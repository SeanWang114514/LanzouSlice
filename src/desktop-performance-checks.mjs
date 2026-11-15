// Synthetic progress only; isolated profile, no credentials or remote transfers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

export async function checkPerformance(window, { app, engine, sync, outputDir, setAccount }) {
  const web = window.webContents, evaluate = code => web.executeJavaScript(code);
  let messages = 0, bytes = 0;
  const send = web.send.bind(web);
  web.send = (channel, ...args) => {
    if (channel === 'app:state') { messages++; bytes += Buffer.byteLength(JSON.stringify(args[0])); }
    return send(channel, ...args);
  };
  for (let i = 0; i < 300; i++) {
    const id = randomUUID();
    engine.tasks.set(id, { id, type: 'upload', state: 'completed', phase: 'done', originalName: `性能检查-${i}.bin`, originalSize: 1048576,
      bytes: 1048576, totalBytes: 1048576, progress: 1, totalParts: 8, concurrency: 2, createdAt: new Date(1730000000000 + i).toISOString(),
      receipts: Object.fromEntries(Array.from({ length: 8 }, (_, n) => [n, { index: n, name: `part-${n}.zip`, remoteId: `${i * 8 + n}`, sha256: 'a'.repeat(64), payloadSize: 131072, uploadSize: 131200 }])),
      sourcePath: 'C:\\performance-fixture.bin', cachePath: path.join(outputDir, id), message: '性能检查任务' });
  }
  const task = [...engine.tasks.values()].at(-1); task.state = 'running'; task.phase = 'uploading'; task.progress = 0;
  engine.notify(true);
  await evaluate(`window.__perf={mutations:0,taskMutations:0};window.__perfObserver=new MutationObserver(records=>{window.__perf.mutations+=records.length;window.__perf.taskMutations+=records.filter(r=>r.target.closest?.('#tasks')).length});window.__perfObserver.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true})`);
  const usage = () => {
    const metrics = app.getAppMetrics();
    return { cpuSeconds: metrics.reduce((sum, p) => sum + p.cpu.cumulativeCPUUsage, 0), workingSetKiB: metrics.reduce((sum, p) => sum + p.memory.workingSetSize, 0), processes: metrics.length };
  };
  const scenarios = [];
  const pulse = setInterval(() => {
    task.bytes = (task.bytes + 32768) % task.originalSize; task.progress = task.bytes / task.originalSize;
    engine.notify();
  }, 40);
  async function measure(name, tab, minimized = false) {
    if (window.isMinimized()) window.restore();
    await evaluate(`document.querySelector('#tab-${tab}').click()`); await delay(700);
    if (minimized) { window.minimize(); await delay(300); }
    await evaluate(`window.__perf.mutations=0;window.__perf.taskMutations=0`);
    const start = usage(), startMessages = messages, startBytes = bytes, started = performance.now();
    await delay(3500);
    const end = usage(), elapsed = performance.now() - started;
    const renderer = await evaluate(`({...window.__perf,nodes:document.querySelectorAll('*').length,taskRows:document.querySelectorAll('#tasks .task').length,heapBytes:performance.memory?.usedJSHeapSize||0})`);
    scenarios.push({ name, elapsedMs: Math.round(elapsed), messages: messages - startMessages, messageBytes: bytes - startBytes,
      cpuCorePercent: Math.max(0, (end.cpuSeconds - start.cpuSeconds) * 100000 / elapsed), workingSetMiB: end.workingSetKiB / 1024, processes: end.processes, ...renderer });
  }
  try {
    await measure('hidden-transfer-page', 'upload');
    await measure('visible-transfer-page', 'transfers');
    await measure('minimized', 'transfers', true);
    await measure('restored', 'transfers');
    task.state = 'completed'; task.phase = 'done'; task.progress = 1; task.message = '性能检查已完成'; engine.notify(true);
    await delay(300);
    const restored = await evaluate(`({completed:document.querySelector('[data-task-id="${task.id}"] .task-status')?.textContent==='已完成',rows:document.querySelectorAll('#tasks .task').length})`);
    assert.ok(restored.completed, '恢复显示后应更新任务状态');
    const lightweight = await evaluate(`Boolean(document.querySelector('#task-pagination'))`);
    const paginationLayouts = [];
    if (lightweight) {
      assert.equal(scenarios[0].taskRows, 0, '从未打开的传输页不应创建卡片');
      assert.ok(scenarios[1].taskRows <= 50, '历史列表节点应限制为一页');
      assert.equal(scenarios[2].messages, 0, '最小化期间应停止界面进度推送');
      await evaluate(`document.querySelector('#task-next').click()`);
      assert.equal(await evaluate(`Boolean(document.querySelector('[data-task-id="${task.id}"]'))`), false);
      await evaluate(`document.querySelector('#task-previous').click()`);
      assert.equal(await evaluate(`Boolean(document.querySelector('[data-task-id="${task.id}"]'))`), true);
      for (const [width, height] of [[940, 700], [1260, 900], [1920, 1080]]) {
        window.setContentSize(width, height);
        await evaluate(`document.querySelector('#task-pagination').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        await delay(150);
        const fit = await evaluate(`(()=>{const node=document.querySelector('#task-pagination'),rect=node.getBoundingClientRect(),button=document.querySelector('#task-next').getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,right:rect.right,overflow:node.scrollWidth>node.clientWidth,nextClickable:!!document.elementFromPoint(button.x+button.width/2,button.y+button.height/2)?.closest('#task-next')}})()`);
        assert.ok(fit.width === width && fit.scrollWidth <= width && fit.right <= width && !fit.overflow && fit.nextClickable, `分页布局或按钮命中异常：${JSON.stringify(fit)}`);
        paginationLayouts.push(fit);
        await writeFile(path.join(outputDir, `pagination-${width}x${height}.png`), (await web.capturePage()).toPNG());
      }
      window.setContentSize(1260, 900); await evaluate('window.scrollTo(0,0)');
    }
    engine.client.uid = 'performance'; engine.client.vei = 'offline-fixture';
    setAccount({ uid: 'performance', label: '离线性能检查' });
    engine.client.listPage = async () => ({ page: 1, hasMore: false, entries: Array.from({ length: 60 }, (_, i) => ({ id: String(1000 + i), parentId: '-1', isFolder: i < 30, name: i < 30 ? `识别目录-${i}` : `普通文件-${i}.txt`, size: 16 })) });
    engine.identifyFolder = async () => { await delay(120); return { ordinary: true }; };
    const rule = { id: randomUUID(), ownerUid: 'performance', name: '性能规则', sourcePath: 'C:\\performance-fixture', parentId: '-1', enabled: false,
      schedule: { kind: 'interval', minutes: 30 }, entries: {}, pending: [], garbage: [], state: 'uploading',
      stats: { added: 0, updated: 0, skipped: 0, deleted: 0, failed: 0 }, progress: { totalKnown: true, ratio: 0.1, totalFiles: 300, totalBytes: 1048576, processedFiles: 0, processedBytes: 0, activeFiles: 1, concurrency: 2 } };
    sync.rules.push(rule); engine.notify(true);
    const updates = setInterval(() => { rule.stats.skipped++; rule.progress.processedFiles++; rule.currentFile = `file-${rule.stats.skipped}`; sync.changed(false); }, 80);
    let syncCardReused, directoryRowReused, selectionPreserved;
    try {
      await evaluate(`document.querySelector('#tab-sync').click()`); await delay(250);
      await evaluate(`window.__syncReference=document.querySelector('.sync-rule')`);
      await measure('visible-sync-page', 'sync');
      syncCardReused = await evaluate(`window.__syncReference===document.querySelector('.sync-rule')`);
      await evaluate(`document.querySelector('#tab-download').click()`); await delay(100);
      await evaluate(`window.__rowReference=document.querySelector('.folder-row[data-entry-kind="file"]');window.__rowReference.querySelector('input').click()`);
      await measure('directory-recognition', 'download');
      directoryRowReused = await evaluate(`window.__rowReference===document.querySelector('.folder-row[data-entry-kind="file"]')`);
      selectionPreserved = await evaluate(`document.querySelector('.folder-row[data-entry-kind="file"] input').checked`);
      assert.ok(selectionPreserved, '目录识别不能丢失选择');
      if (lightweight) { assert.ok(syncCardReused, '统计变化不能重建规则卡片'); assert.ok(directoryRowReused, '识别其他目录不能重建普通文件行'); }
    } finally { clearInterval(updates); }
    const result = { fixture: '300 tasks, eight receipts each, synthetic 25Hz progress; no real network transfer', scenarios, restored,
      syncCardReused, directoryRowReused, selectionPreserved, paginationLayouts, idleSyncTimer: Boolean(sync.timer), timestamp: new Date().toISOString() };
    await writeFile(path.join(outputDir, 'performance.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(outputDir, 'performance.png'), (await web.capturePage()).toPNG());
    console.log('PERFORMANCE_RESULT', JSON.stringify(result));
    return result;
  } finally { clearInterval(pulse); web.send = send; }
}
