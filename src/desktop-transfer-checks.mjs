// Isolated synthetic task list; pointer events exercise the actual renderer selection handlers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

export async function checkTransfers(window, { app, engine, outputDir }) {
  const web = window.webContents, evaluate = code => web.executeJavaScript(code), features = {}, layouts = [];
  const until = async expression => { const end = Date.now() + 10000; while (!await evaluate(expression)) { if (Date.now() > end) throw new Error(`Transfer UI timeout: ${expression}`); await delay(25); } };
  const sourcePath = path.join(outputDir, 'protected-original.bin'); await writeFile(sourcePath, 'preserve original');
  const tasks = Array.from({ length: 207 }, (_, index) => {
    const id = randomUUID(); return { id, type: index % 2 ? 'upload' : 'download', state: 'paused', ownerUid: '123', sourcePath,
      originalName: index === 206 ? '批量选择-长文件名'.repeat(30) + '.bin' : `选择检查-${index}.bin`, originalSize: 32000,
      cachePath: path.join(outputDir, 'missing-cache', id), message: '等待手动继续', createdAt: new Date().toISOString() };
  });
  const syncId = randomUUID(); engine.tasks.set(syncId, { ...tasks[0], id: syncId, syncRuleId: randomUUID() });
  for (const task of tasks) engine.tasks.set(task.id, task);
  const order = tasks.map(task => task.id).reverse(), selector = id => `[data-task-id="${id}"]`;
  engine.notify(true);
  await evaluate(`document.querySelector('#tab-transfers').click();window.confirm=()=>true;true`);
  await until(`document.querySelectorAll('#tasks .task').length===50`);
  const selected = () => evaluate(`[...document.querySelectorAll('[data-task-select]:checked')].map(n=>n.dataset.taskSelect)`);
  const expect = async ids => assert.deepEqual((await selected()).sort(), [...ids].sort());
  async function click(id, modifiers = [], part = '.task-name-text') {
    const query = `${selector(id)} ${part}`;
    await evaluate(`document.querySelector(${JSON.stringify(query)}).scrollIntoView({block:'center'})`);
    const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(query)}),r=n.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);if(!n.contains(document.elementFromPoint(x,y)))throw new Error('Task click obscured');return {x,y}})()`);
    window.focus(); for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) web.sendInputEvent({ type, ...point, button: 'left', clickCount: 1, modifiers });
    await delay(35);
  }
  await click(order[0]); await expect([order[0]]);
  await click(order[2], ['control']); await expect([order[0], order[2]]);
  await click(order[0], ['control']); await expect([order[2]]);
  await click(order[0], ['control'], 'input'); await expect([order[0], order[2]]); features.ctrlToggleAndCheckbox = true;
  await click(order[3], ['shift']); await expect(order.slice(0, 4));
  await click(order[1], ['shift']); await expect(order.slice(0, 2));
  await click(order[4]); await click(order[1], ['shift']); await expect(order.slice(1, 5)); features.shiftRangeAndAnchor = true;
  await click(order[8], ['control']); await click(order[6], ['control', 'shift']); await expect([...order.slice(1, 5), ...order.slice(6, 9)]); features.ctrlShiftAppends = true;
  await click(order[4], ['shift'], 'input'); await expect(order.slice(4, 9)); features.shiftCheckboxMatchesHighlight = true;
  const firstNode = await evaluate(`window.__selectedTaskNode=document.querySelector(${JSON.stringify(selector(order[4]))});true`);
  assert.equal(firstNode, true); engine.notify(true); await delay(180);
  await expect(order.slice(4, 9)); assert.equal(await evaluate(`window.__selectedTaskNode===document.querySelector(${JSON.stringify(selector(order[4]))})`), true); features.refreshReusesRowsAndSelection = true;
  await click(order[4], [], 'summary'); await expect(order.slice(4, 9)); features.detailsDoNotSelect = true;
  await evaluate(`document.querySelector('#task-next').click()`); await click(order[51], ['shift']);
  assert.match(await evaluate(`document.querySelector('#task-selection-count').textContent`), /^已选 44 项/); features.shiftAcrossPages = true;
  await evaluate(`document.querySelector('#task-previous').click()`); await expect(order.slice(8, 50)); features.paginationPreservesSelection = true;
  await evaluate(`document.querySelector('#clear-task-selection').click();document.querySelector('#select-all-tasks').click()`); await expect(order.slice(0, 50));
  await evaluate(`document.querySelector('#task-next').click();document.querySelector('#select-all-tasks').click()`);
  assert.match(await evaluate(`document.querySelector('#task-selection-count').textContent`), /^已选 100 项/);
  for (let i = 0; i < 3; i++) await evaluate(`document.querySelector('#task-next').click();document.querySelector('#select-all-tasks').click()`);
  assert.match(await evaluate(`document.querySelector('#task-selection-count').textContent`), /^已选 200 项/); features.selectionLimit200 = true;
  assert.equal(await evaluate(`document.querySelector('[data-task-select="${syncId}"]').disabled`), true); features.syncManagedSeparately = true;
  await evaluate(`document.querySelector('#transfer-type').value='upload';document.querySelector('#transfer-type').dispatchEvent(new Event('change'))`);
  assert.match(await evaluate(`document.querySelector('#task-selection-count').textContent`), /^已选 0 项/); features.filterResetsSelection = true;
  await evaluate(`document.querySelector('#transfer-type').value='all';document.querySelector('#transfer-type').dispatchEvent(new Event('change'))`);
  // Cancel two paused/queued tasks through the batch button; cancel a controlled active worker separately.
  const queued = engine.tasks.get(order[1]); queued.state = 'queued'; engine.syncOwner = 'fixture-hold'; engine.notify(true); await delay(180);
  await click(order[0]); await click(order[1], ['control']);
  await evaluate(`window.confirm=()=>false;document.querySelector('#cancel-selected-tasks').click()`); await delay(100);
  assert.equal(engine.tasks.get(order[0]).state, 'paused'); await expect(order.slice(0, 2)); features.dismissCancelPreservesTasks = true;
  await evaluate(`window.confirm=()=>true;document.querySelector('#cancel-selected-tasks').click()`);
  await until(`document.querySelectorAll('#tasks .task.canceled').length===2`);
  for (const id of order.slice(0, 2)) { assert.equal(engine.tasks.get(id).state, 'canceled'); assert.equal(JSON.parse(await readFile(path.join(engine.taskDir(id), 'task.json'), 'utf8')).state, 'canceled'); }
  assert.equal(engine.tasks.get(order[2]).state, 'paused'); await expect([]); features.batchCancelOnlySelected = true;
  engine.syncOwner = null; const active = engine.tasks.get(order[2]);
  engine.start(active, signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  await until(`document.querySelector(${JSON.stringify(selector(active.id) + ' [data-cancel-task]')})!==null`);
  await click(active.id, [], '[data-cancel-task]'); await until(`document.querySelector(${JSON.stringify(selector(active.id))}).classList.contains('canceled')`);
  assert.equal(engine.active.size, 0); await expect([]); features.singleCancelStopsActiveWithoutSelecting = true;
  assert.equal(await readFile(sourcePath, 'utf8'), 'preserve original'); features.originalPreserved = true;
  assert.equal(await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector(active.id))});return [...r.querySelectorAll('button')].some(b=>b.textContent==='继续')})()`), false); features.canceledHasNoResume = true;
  for (const [width, height] of [[940, 700], [1260, 900], [1920, 1080]]) {
    window.setContentSize(width, height); await delay(120);
    await evaluate(`document.querySelector('#tasks').scrollTop=0`);
    const layout = await evaluate(`(()=>{const ids=['#select-all-tasks','#clear-task-selection','#cancel-selected-tasks','#task-next'],nodes=ids.map(id=>{const n=document.querySelector(id),r=n.getBoundingClientRect();return {id,inside:r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth,hit:n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}});return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,nodes,rows:document.querySelectorAll('#tasks .task').length}})()`);
    assert.equal(layout.overflow, false); assert.ok(layout.nodes.every(node => node.inside && node.hit)); assert.equal(layout.rows, 50); layouts.push(layout);
    await web.capturePage().then(image => writeFile(path.join(outputDir, `transfer-${width}.png`), image.toPNG()));
  }
  features.responsiveControlsAndPageLimit = true;
  await evaluate(`document.querySelector('#transfer-state').value='canceled';document.querySelector('#transfer-state').dispatchEvent(new Event('change'))`);
  await until(`document.querySelectorAll('#tasks .task').length===3`); features.canceledFilter = true;
  await evaluate(`(()=>{const row=document.querySelector('#tasks .task');[...row.querySelectorAll('button')].find(b=>b.textContent==='移除记录').click()})()`);
  await until(`document.querySelectorAll('#tasks .task').length===2`); features.canceledHistoryRemoval = true;
  await engine.pauseAll();
  const report = { version: app.getVersion(), features, layouts, sourcePreserved: true, network: 'synthetic tasks; existing transfer cancellation is separately exercised over loopback HTTP' };
  await writeFile(path.join(outputDir, 'transfer-checks.json'), JSON.stringify(report, null, 2));
  console.log('TRANSFER_DESKTOP_OK', JSON.stringify(report));
}
