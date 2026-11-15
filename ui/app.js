import { roundedBytes, duration } from './transfer-format.js';
import { icon } from './icons.js';
import { createSyncUI, syncActive, syncProgress } from './sync.js';
import { setText } from './dom.js';
for (const node of document.querySelectorAll('[data-icon]')) node.replaceChildren(icon(node.dataset.icon));
const $ = id => document.getElementById(id);
const api = window.lanzou;
let state = { account: null, tasks: [] }, sources = [], bundle = null, outputDir = '', noticeTimer;
const sourceRemovals = new Set();
let history = [{ id: '-1', name: '根目录' }];
let directoryFiles = [], directoryPage = 0, directoryHasMore = false, directoryBusy = false, directoryRequest = 0, bundleRequest = 0, selectingSource = false;
let cloudDirty = false, cloudRevision = 0;
let recognitionRequest = 0, currentSlice = null, selectingBundle = false;
let recognitionToken = null;
const directorySnapshots = new Map();
const taskRows = new Map();
const TASK_PAGE_SIZE = 50;
const selectedTasks = new Set();
let taskSelectionAnchor = null, taskSelectionOrder = [], cancelSubmitting = false;
let taskPage = 0, tasksDirty = true, directoryDirty = false, recognitionTimer = null;
const directoryRows = new Map();
let floatingId = null, floatingDismissed = null, floatingMinimized = false;
let floatingSyncId = null, floatingSyncKey = null, floatingSyncDismissed = null;
let managementTarget = null, managementBusy = false;
const selectedDownloads = new Set();
let selectionAnchor = null;
let batchSubmitting = false;
let uploadSubmitting = false, downloadSubmitting = false;
const statusText = task => ({ queued: '排队中', running: '进行中', paused: '已暂停', failed: '失败', completed: '已完成', canceled: '已取消' }[task.state] || task.state);
const canCancelTask = task => task && !task.syncRuleId && ['queued', 'running', 'paused', 'failed'].includes(task.state);
const syncUI = createSyncUI({ api, run, notice, make, getState: () => state });
const smartView = () => (state.settings?.browserView || 'smart') === 'smart';
const syncFolder = file => file.isFolder ? state.sync?.rules.find(rule => String(rule.rootId) === String(file.id)) : null;
const sizes = value => {
  if (!value) return '0 B';
  const i = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** i).toFixed(i ? 2 : 0)} ${['B','KiB','MiB','GiB','TiB'][i]}`;
};
function notice(message, error = false) {
  clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = false;
  $('notice').setAttribute('role', error ? 'alert' : 'status');
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 14000 : 5000);
}
async function run(button, action) {
  const wasDisabled = button?.disabled; if (button) button.disabled = true;
  try { return await action(); }
  catch (error) { notice(error.message || '操作失败', true); }
  finally { if (button) button.disabled = wasDisabled; updateControls(); }
}
function updateControls() {
  const logged = Boolean(state.account); const running = state.sync?.busy || state.tasks.some(t => t.state === 'running');
  $('start-upload').disabled = !logged || !sources.length || uploadSubmitting || managementBusy || batchSubmitting;
  $('choose-source').disabled = selectingSource || uploadSubmitting;
  if ($('source-selection').disabled !== (selectingSource || uploadSubmitting)) $('source-selection').disabled = selectingSource || uploadSubmitting;
  $('start-download').disabled = !bundle || !outputDir || downloadSubmitting || managementBusy;
  $('upload-hint').textContent = !logged ? '请先登录蓝奏云；已选文件会保留。' : !sources.length ? '可多选或拖入文件，每次最多 200 个。' : running ? '可继续添加上传，任务将排队执行；可在“上传下载”页管理。' : `已选 ${sources.length} 个文件，将按顺序上传，每个文件单独建立云端目录。`;
  $('inspect-folder').disabled = !logged || history.at(-1).id === '-1';
  $('inspect-folder').disabled ||= directoryBusy || managementBusy;
  $('refresh-folders').disabled = !logged || directoryBusy || managementBusy;
  $('new-folder').disabled = !logged || directoryBusy || managementBusy;
  $('folder-up').disabled = history.length <= 1 || directoryBusy || managementBusy;
  $('load-more').disabled = directoryBusy || managementBusy || !logged;
  $('load-more').hidden = !directoryHasMore;
  $('start-upload').disabled ||= selectingSource;
  for (const button of $('folder-list').querySelectorAll('[data-download-slice],[data-download-file]')) button.disabled = directoryBusy || managementBusy || selectingBundle || batchSubmitting || !outputDir;
  const managementDisabled = directoryBusy || managementBusy || selectingBundle || batchSubmitting || !logged || state.sync?.busy;
  for (const button of $('folder-list').querySelectorAll('[data-cloud-manage]')) button.disabled = managementDisabled;
  if (managementDisabled) closeFileMenu();
  for (const id of ['clear-history', 'clear-history-settings']) $(id).disabled = !state.tasks.some(task => task.state === 'completed');
  for (const id of ['clear-all-history', 'clear-all-history-settings']) $(id).disabled = cancelSubmitting || !state.tasks.some(task => ['completed', 'failed', 'canceled'].includes(task.state));
  $('pause-all').disabled = !running && !state.tasks.some(task => task.state === 'queued');
  $('show-floating').disabled = !state.tasks.length;
  $('show-sync-floating').disabled = !state.sync?.rules.some(rule => rule.progress);
  updateSelectionControls();
  updateTaskSelectionControls();
}
function make(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function taskMetrics(task) {
  return [roundedBytes(task.speedBytesPerSecond, true), duration((task.elapsedMs || 0) / 1000), task.state === 'completed' ? '00:00:00' : duration(task.remainingSeconds)];
}
function updateTaskAction(task) {
  if (['running', 'queued'].includes(task.state)) return api.call('pause', { id: task.id });
  if (['paused', 'failed'].includes(task.state)) return api.call('resume', { id: task.id, password: $('share-password').value });
  return switchTab('transfers');
}
function resetTaskSelection() { selectedTasks.clear(); taskSelectionAnchor = null; }
function selectTask(id, event = {}, checkbox = false) {
  if (cancelSubmitting) return;
  const additive = event.ctrlKey || event.metaKey, preserve = additive || checkbox && !event.shiftKey;
  const next = new Set(preserve ? selectedTasks : []);
  let ids = [id];
  if (event.shiftKey) {
    const from = taskSelectionOrder.indexOf(taskSelectionAnchor), to = taskSelectionOrder.indexOf(id);
    if (from >= 0 && to >= 0) ids = taskSelectionOrder.slice(Math.min(from, to), Math.max(from, to) + 1);
    else taskSelectionAnchor = id;
  } else {
    taskSelectionAnchor = id;
    if ((checkbox || additive) && next.has(id)) { next.delete(id); ids = []; }
  }
  let limited = false;
  for (const key of ids) {
    if (next.size >= 200 && !next.has(key)) { limited = true; break; }
    next.add(key);
  }
  selectedTasks.clear(); for (const key of next) selectedTasks.add(key);
  if (limited) notice('每次最多选择 200 个任务，请分批操作');
  updateTaskSelectionControls();
}
function updateTaskSelectionControls() {
  for (const [id, row] of taskRows) {
    row.checkbox.checked = selectedTasks.has(id); row.checkbox.disabled = cancelSubmitting || Boolean(row.task.syncRuleId);
    row.root.classList.toggle('is-selected', row.checkbox.checked);
    for (const button of row.buttons.querySelectorAll('[data-cancel-task]')) button.disabled = cancelSubmitting;
  }
  const rows = [...taskRows.values()].filter(row => !row.task.syncRuleId), checked = rows.filter(row => row.checkbox.checked).length;
  const all = $('select-all-tasks'); all.checked = rows.length > 0 && checked === rows.length; all.indeterminate = checked > 0 && checked < rows.length; all.disabled = cancelSubmitting || !rows.length;
  const cancellable = state.tasks.filter(task => selectedTasks.has(task.id) && canCancelTask(task)).length;
  setText($('task-selection-count'), `已选 ${selectedTasks.size} 项 · 可取消 ${cancellable} 项`);
  $('clear-task-selection').disabled = cancelSubmitting || !selectedTasks.size;
  $('cancel-selected-tasks').disabled = cancelSubmitting || !cancellable;
  setText($('cancel-selected-tasks'), cancelSubmitting ? '正在取消…' : `取消所选（${cancellable}）`);
}
async function cancelTasks(ids) {
  if (cancelSubmitting) return;
  const selected = new Set(ids), eligible = state.tasks.filter(task => selected.has(task.id) && canCancelTask(task)).map(task => task.id);
  if (!eligible.length || !confirm(`取消 ${eligible.length} 个传输任务？\n停止后无法继续，任务临时缓存将清理。本地原文件、已完成下载和云端已上传内容保留。`)) return;
  cancelSubmitting = true; updateTaskSelectionControls();
  try {
    const result = await api.call('cancel', { ids: eligible });
    const failed = new Set(result.failures.map(item => item.id));
    for (const id of eligible) if (!failed.has(id)) selectedTasks.delete(id);
    render(await api.call('state'));
    notice(`已取消 ${result.canceled} 项${result.skipped ? `，${result.skipped} 项已结束或不存在` : ''}${result.failures.length ? `；${result.failures.length} 项保存或缓存清理未完成：${result.failures[0].error}` : ''}`, Boolean(result.failures.length));
  } finally { cancelSubmitting = false; updateTaskSelectionControls(); }
}
function createTaskRow(task) {
  const root = make('article', 'task'); root.dataset.taskId = task.id;
  const top = make('div', 'task-top'), title = make('div', 'task-name'), status = make('span', 'task-status');
  const checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.dataset.taskSelect = task.id; checkbox.setAttribute('aria-label', `选择任务 ${task.originalName || '文件任务'}`);
  checkbox.title = task.syncRuleId ? '自动同步任务请到自动同步页面管理规则' : 'Ctrl 点击增减选择；Shift 连选；Ctrl+Shift 追加范围'; title.append(checkbox);
  checkbox.addEventListener('change', () => selectTask(task.id, {}, true));
  const selectionTarget = event => !task.syncRuleId && (!event.target.closest('button,input,a,select,textarea,details,[contenteditable="true"]') || event.target === checkbox);
  root.addEventListener('mousedown', event => { if (event.button === 0 && event.shiftKey && selectionTarget(event)) event.preventDefault(); });
  root.addEventListener('click', event => {
    if (event.button !== 0 || !selectionTarget(event) || event.target === checkbox && !event.shiftKey) return;
    event.preventDefault(); selectTask(task.id, event);
    if (event.target === checkbox) requestAnimationFrame(updateTaskSelectionControls);
  }, true);
  title.append(icon(task.type, 'ui-icon task-direction'), make('span', 'task-name-text', `${task.type === 'upload' ? '上传' : '下载'} · ${task.originalName || '文件任务'}`)); title.title = task.originalName || '文件任务'; top.append(title, status);
  const progressRow = make('div', 'transfer-progress'), progress = make('progress'), percent = make('span', 'task-percent'); progress.max = 1; progress.setAttribute('aria-label', `${task.originalName}进度`); progressRow.append(progress, percent);
  const detail = make('p', 'task-detail');
  const metrics = make('div', 'transfer-metrics');
  const values = ['速度', '已用时间', '预计剩余'].map(text => { const cell = make('div'), value = make('strong'); cell.append(make('small', '', text), value); metrics.append(cell); return value; });
  const bottom = make('div', 'task-bottom'), info = make('small'), buttons = make('div', 'task-buttons'); bottom.append(info, buttons);
  const more = make('details', 'task-more'), metadata = make('div'); more.append(make('summary', '', '位置、分享与任务详情'), metadata);
  root.append(top, progressRow, detail, metrics, bottom, more);
  return { root, checkbox, status, progress, percent, detail, values, info, buttons, metadata, actionState: null, metadataKey: null, task };
}
function renderTasks() {
  tasksDirty = false;
  const tasks = [...state.tasks].reverse();
  const filtered = tasks.filter(task => ['all', task.type].includes($('transfer-type').value) && ['all', task.state].includes($('transfer-state').value));
  taskSelectionOrder = filtered.filter(task => !task.syncRuleId).map(task => task.id);
  const existing = new Set(tasks.map(task => task.id)); for (const id of selectedTasks) if (!existing.has(id)) selectedTasks.delete(id);
  if (!existing.has(taskSelectionAnchor)) taskSelectionAnchor = null;
  const pages = Math.max(1, Math.ceil(filtered.length / TASK_PAGE_SIZE)); taskPage = Math.min(taskPage, pages - 1);
  const page = filtered.slice(taskPage * TASK_PAGE_SIZE, (taskPage + 1) * TASK_PAGE_SIZE), ids = new Set(page.map(task => task.id));
  for (const [id, row] of taskRows) if (!ids.has(id)) { row.root.remove(); taskRows.delete(id); }
  $('tasks').querySelector('.empty-state')?.remove();
  const counts = {}; for (const task of tasks) counts[task.state] = (counts[task.state] || 0) + 1;
  setText($('task-count'), tasks.length);
  setText($('transfer-summary'), `排队 ${counts.queued || 0} · 进行中 ${counts.running || 0} · 暂停 ${counts.paused || 0} · 失败 ${counts.failed || 0} · 已完成 ${counts.completed || 0} · 已取消 ${counts.canceled || 0}`);
  setText($('task-page-status'), `第 ${taskPage + 1} / ${pages} 页 · 筛选结果 ${filtered.length} 项 · 每页 ${TASK_PAGE_SIZE} 项`);
  $('task-previous').disabled = taskPage === 0; $('task-next').disabled = taskPage >= pages - 1;
  $('task-pagination').hidden = filtered.length <= TASK_PAGE_SIZE;
  for (const [index, task] of page.entries()) {
    let row = taskRows.get(task.id); if (!row) { row = createTaskRow(task); taskRows.set(task.id, row); }
    row.task = task;
    if ($('tasks').children[index] !== row.root) $('tasks').insertBefore(row.root, $('tasks').children[index] || null);
    const className = `task ${task.state}${selectedTasks.has(task.id) ? ' is-selected' : ''}`; if (row.root.className !== className) row.root.className = className;
    const statusClass = `task-status ${task.state}`; if (row.status.className !== statusClass) row.status.className = statusClass;
    setText(row.status, statusText(task));
    const ratio = Math.max(0, Math.min(1, task.progress || 0)); if (row.progress.value !== ratio) row.progress.value = ratio;
    setText(row.percent, `${Math.round(ratio * 100)}%`);
    setText(row.detail, task.message || task.error || '准备中'); if (row.detail.title !== row.detail.textContent) row.detail.title = row.detail.textContent;
    taskMetrics(task).forEach((text, i) => { setText(row.values[i], text); if (row.values[i].title !== text) row.values[i].title = text; });
    const total = task.totalBytes || task.originalSize || 0;
    setText(row.info, `${roundedBytes(task.bytes || 0)} / ${task.downloadKind === 'file' && !task.totalKnown && task.state !== 'completed' ? '未知' : roundedBytes(total)} · ${task.downloadKind === 'file' ? '普通文件 · 单连接' : `${task.totalParts || 0} 片 · ${task.concurrency || 1} 路`}`);
    if (row.actionState !== task.state) {
      row.actionState = task.state; row.buttons.replaceChildren();
      const add = (text, action) => { const b = make('button', 'text-button', text); b.addEventListener('click', () => run(b, action)); row.buttons.append(b); return b; };
      if (['running', 'queued'].includes(task.state)) add('暂停', () => updateTaskAction(row.task));
      if (['paused', 'failed'].includes(task.state)) add('继续', () => updateTaskAction(row.task));
      if (canCancelTask(task)) add('取消', () => cancelTasks([task.id])).dataset.cancelTask = task.id;
      add('打开所在文件夹', () => api.call('showResult', { id: task.id }));
      if (task.state === 'completed' && task.downloadKind !== 'file') add('导出清单', () => api.call('exportManifest', { id: task.id }));
      if (['completed', 'failed', 'canceled'].includes(task.state)) add('移除记录', () => clearHistory('all', task.id));
    }
    const lines = [task.naming && `云端兼容目录：${task.naming.cloudFolderName}；原名保存在清单，下载时恢复。`, task.nameRestoration && !task.nameRestoration.exact && `实际保存名：${task.savedName}；完整原名保留在清单。`, task.outputDir && `下载目录：${task.outputDir}`, task.cachePath && `缓存目录：${task.cachePath}`, task.share?.url && `文件夹分享：${task.share.url}${task.share.password ? ` 提取码：${task.share.password}` : ''}`, task.shareWarning, task.indexWarning].filter(Boolean);
    const key = lines.join('\n'); if (row.metadataKey !== key) { row.metadataKey = key; row.metadata.replaceChildren(...lines.map(text => make('p', 'task-detail', text))); }
  }
  if (!page.length) $('tasks').append(make('div', 'empty-state', tasks.length ? '没有符合筛选条件的任务' : '暂无传输任务'));
  updateTaskSelectionControls();
}
function renderFloating() {
  if (document.hidden) return;
  const manual = state.tasks.filter(task => !task.syncRuleId), running = manual.find(task => task.state === 'running');
  const latestManual = Math.max(0, ...manual.map(task => Date.parse(task.lastStoppedAt || task.createdAt) || 0));
  const rules = state.sync?.rules || [], rule = rules.find(syncActive) || (!running && rules.filter(rule => rule.progress && (rule.lastFinished || 0) >= latestManual).sort((a, b) => (b.lastRun || 0) - (a.lastRun || 0))[0]);
  $('floating-sync').hidden = true;
  if (rule) { $('floating-transfer').hidden = true; renderSyncFloating(rule); return; }
  floatingSyncId = null;
  const task = running || manual.find(task => task.id === floatingId) || manual.at(-1);
  if (!task) { floatingId = null; $('floating-transfer').hidden = true; return; }
  if (floatingId !== task.id) { floatingId = task.id; floatingDismissed = null; }
  const panel = $('floating-transfer'); panel.hidden = floatingDismissed === task.id; panel.classList.toggle('minimized', floatingMinimized);
  if (panel.hidden) return;
  setText($('floating-toggle'), floatingMinimized ? '展开' : '收起');
  if ($('floating-toggle').getAttribute('aria-expanded') !== String(!floatingMinimized)) { $('floating-toggle').setAttribute('aria-expanded', String(!floatingMinimized)); $('floating-toggle').setAttribute('aria-label', floatingMinimized ? '展开传输浮窗' : '收起传输浮窗'); }
  setText($('floating-state'), `${task.type === 'upload' ? '上传' : '下载'} · ${statusText(task)}`);
  const statusClass = `task-status ${task.state}`; if ($('floating-state').className !== statusClass) $('floating-state').className = statusClass;
  setText($('floating-name'), task.originalName || '文件任务');
  const title = `${task.originalName || '文件任务'} — 点击打开所在文件夹`; if ($('floating-name').title !== title) $('floating-name').title = title;
  if (floatingMinimized) return;
  const ratio = Math.max(0, Math.min(1, task.progress || 0)); if ($('floating-progress').value !== ratio) $('floating-progress').value = ratio;
  setText($('floating-percent'), `${Math.round(ratio * 100)}%`);
  setText($('floating-message'), task.message || '准备中'); if ($('floating-message').title !== (task.message || '')) $('floating-message').title = task.message || '';
  const values = taskMetrics(task); ['speed', 'elapsed', 'remaining'].forEach((key, i) => { setText($('floating-' + key), values[i]); if ($('floating-' + key).title !== values[i]) $('floating-' + key).title = values[i]; });
  setText($('floating-bytes'), `${roundedBytes(task.bytes || 0)} / ${task.downloadKind === 'file' && !task.totalKnown && task.state !== 'completed' ? '未知' : roundedBytes(task.totalBytes || task.originalSize || 0)}`);
  setText($('floating-action'), ['running', 'queued'].includes(task.state) ? '暂停' : ['paused', 'failed'].includes(task.state) ? '继续' : '查看任务');
}
function renderSyncFloating(rule) {
  floatingSyncId = rule.id;
  const key = `${rule.id}:${rule.lastRun}`;
  if (key !== floatingSyncKey) { floatingSyncKey = key; floatingSyncDismissed = null; }
  const panel = $('floating-sync'), values = syncProgress(rule); panel.hidden = floatingSyncDismissed === key; panel.classList.toggle('minimized', floatingMinimized);
  if (panel.hidden || document.hidden) return;
  setText($('sync-floating-toggle'), floatingMinimized ? '展开' : '收起');
  if ($('sync-floating-toggle').getAttribute('aria-expanded') !== String(!floatingMinimized)) $('sync-floating-toggle').setAttribute('aria-expanded', String(!floatingMinimized));
  setText($('sync-floating-state'), ({ scanning: '扫描比对', uploading: '同步上传', cleaning: '清理旧版', paused: '已暂停', error: '同步失败', queued: '等待空闲' }[rule.state] || (rule.progress?.finished ? '本轮完成' : '等待计划')));
  const statusClass = `task-status ${rule.state === 'error' ? 'failed' : syncActive(rule) ? 'running' : rule.progress?.finished ? 'completed' : 'paused'}`;
  if ($('sync-floating-state').className !== statusClass) $('sync-floating-state').className = statusClass;
  setText($('sync-floating-name'), rule.name); if ($('sync-floating-name').title !== rule.sourcePath) $('sync-floating-name').title = rule.sourcePath;
  if (floatingMinimized) return;
  if (values.known) { if ($('sync-floating-progress').value !== values.ratio) $('sync-floating-progress').value = values.ratio; } else if ($('sync-floating-progress').hasAttribute('value')) $('sync-floating-progress').removeAttribute('value');
  for (const key of ['percent', 'bytes', 'speed', 'elapsed', 'remaining']) setText($('sync-floating-' + key), values[key]);
  setText($('sync-floating-message'), `${values.detail} · ${values.message}`); if ($('sync-floating-message').title !== $('sync-floating-message').textContent) $('sync-floating-message').title = $('sync-floating-message').textContent;
  setText($('sync-floating-action'), syncActive(rule) || rule.state === 'queued' ? '暂停规则' : ['paused', 'error'].includes(rule.state) ? '继续同步' : '查看规则');
}
function render(next) {
  const syncFolders = value => JSON.stringify(value.sync?.rules.map(rule => [rule.id, rule.rootId, rule.name, rule.managedFiles]));
  const changedSync = syncFolders(state) !== syncFolders(next);
  const changedView = (state.settings?.browserView || 'smart') !== (next.settings?.browserView || 'smart');
  const changedAccount = (state.account?.uid || state.account?.label) !== (next.account?.uid || next.account?.label);
  const changedSettings = JSON.stringify([state.settings, state.settingsWarning, state.startupSupported]) !== JSON.stringify([next.settings, next.settingsWarning, next.startupSupported]);
  const taskStates = value => value.tasks.map(task => `${task.id}:${task.state}`).join('|');
  const changedControls = changedAccount || changedSettings || taskStates(state) !== taskStates(next) || Boolean(state.sync?.busy) !== Boolean(next.sync?.busy);
  const completed = new Set(state.tasks.filter(task => task.state === 'completed').map(task => task.id));
  if (next.tasks.some(task => task.type === 'upload' && task.state === 'completed' && !completed.has(task.id))) { cloudDirty = true; cloudRevision++; }
  state = next;
  syncUI.render(state);
  if (state.settings && changedSettings) {
    outputDir = state.settings.downloadDir;
    $('output-directory').textContent = outputDir; $('output-directory').title = outputDir;
    $('setting-download-dir').textContent = outputDir;
    $('setting-cache-dir').textContent = state.settings.cacheDir;
    $('auto-clean-cache').checked = state.settings.autoCleanCache;
    for (const [id, key] of [['open-at-login', 'openAtLogin'], ['start-hidden', 'startHidden'], ['close-to-tray', 'closeToTray']]) $(id).checked = Boolean(state.settings[key]);
    $('open-at-login').disabled = !state.startupSupported;
    setText($('startup-support-hint'), state.startupSupported ? '便携版移动位置后，请重新开启此项；系统启动应用也需要允许本软件。' : '开机自启仅支持 Windows 便携成品版，开发运行不会注册系统启动项。');
    $('upload-concurrency').value = String(state.settings.uploadConcurrency);
    $('download-concurrency').value = $('concurrency').value = String(state.settings.downloadConcurrency);
    $('upload-concurrency-label').textContent = `上传并发 ${state.settings.uploadConcurrency} 路`;
    $('settings-warning').textContent = state.settingsWarning || ''; $('settings-warning').hidden = !state.settingsWarning;
  }
  if (changedView || changedSettings) for (const mode of ['raw', 'smart']) { $('view-' + mode).classList.toggle('selected', smartView() === (mode === 'smart')); $('view-' + mode).setAttribute('aria-pressed', String(smartView() === (mode === 'smart'))); }
  if (changedAccount) {
    resetTaskSelection();
    resetDownloadSelection();
    if ($('cloud-dialog').open) { managementTarget = null; $('cloud-dialog').close(); }
    closeFileMenu();
    directorySnapshots.clear(); directoryRows.clear(); recognitionToken = null;
    clearTimeout(recognitionTimer); recognitionTimer = null; directoryDirty = false;
    recognitionRequest++; currentSlice = null;
    directoryRequest++; directoryBusy = false; directoryFiles = []; directoryPage = 0; directoryHasMore = false;
    history = [{ id: '-1', name: '根目录' }]; clearBundle();
    $('folder-path').textContent = '根目录'; $('folder-path').title = '根目录'; $('directory-status').textContent = '';
    $('recognition-status').textContent = '';
    $('folder-list').replaceChildren(make('p', 'muted', state.account ? '点击“刷新目录”读取文件。' : '登录后点击“刷新目录”。'));
    $('folder-list').setAttribute('aria-busy', 'false');
  }
  setText($('app-version'), `v${state.version}`);
  const restoreWindow = state.windowState?.maximized || state.windowState?.fullscreen;
  const maximizeButton = $('window-maximize'), windowAction = restoreWindow ? '还原' : '最大化';
  if (maximizeButton.title !== windowAction) { maximizeButton.title = windowAction; maximizeButton.setAttribute('aria-label', windowAction); }
  if (maximizeButton.dataset.icon !== (restoreWindow ? 'restore' : 'maximize')) {
    maximizeButton.dataset.icon = restoreWindow ? 'restore' : 'maximize';
    maximizeButton.replaceChildren(icon(maximizeButton.dataset.icon));
  }
  if (changedAccount) $('account-options').open = !state.account;
  setText($('account-status'), state.account ? `已登录 · ${state.account.label}` : '未登录');
  $('account-status').classList.toggle('connected', Boolean(state.account));
  $('remember').disabled = !state.encryptionAvailable;
  if (!state.encryptionAvailable) $('remember').checked = false;
  $('login-form').hidden = Boolean(state.account); $('logout').hidden = !state.account;
  tasksDirty = true;
  if (!$('transfers-panel').hidden && !document.hidden) renderTasks();
  renderFloating();
  if (changedView && !changedAccount) {
    resetDownloadSelection();
    recognitionRequest++; clearBundle();
    if (directoryPage) renderDirectory(true);
    if (smartView() && !directoryBusy && directoryPage) void identifyFolders(directoryRequest);
  }
  if (changedSync && !changedAccount && !changedView && directoryPage) renderDirectory(true);
  if (changedControls) updateControls();
  refreshUploadedFiles();
}
function refreshUploadedFiles() {
  if (cloudDirty && state.account && !$('download-panel').hidden && !$('account-browser').hidden && history.at(-1).id === '-1' && !directoryBusy && !bundle) void run(null, () => refreshFolders());
}
function switchTab(name) {
  closeFileMenu();
  for (const item of ['upload','download','sync','transfers','settings']) {
    $(`${item}-panel`).hidden = item !== name;
    $(`tab-${item}`).classList.toggle('active', item === name);
    $(`tab-${item}`).setAttribute('aria-selected', String(item === name));
  }
  if (name === 'transfers' && tasksDirty) renderTasks();
  if (name === 'sync') syncUI.render(state);
  if (name === 'download' && directoryDirty) renderDirectory(true);
  if (name === 'download' && state.account && (!directoryPage || cloudDirty) && !directoryBusy) void run(null, () => refreshFolders(cloudDirty ? [{ id: '-1', name: '根目录' }] : history));
  if (name === 'settings') void run(null, refreshCache);
}
function showBundle(value) {
  bundle = value; const panel = $('bundle-summary'); panel.hidden = false;
  panel.title = `SHA-256：${value.sha256}`;
  panel.replaceChildren(make('strong', '', value.originalName), make('p', '', `${sizes(value.originalSize)} · ${value.totalParts} 个切片 · 下载后自动校验并合并`));
  const integrity = make('details', 'bundle-integrity'); integrity.append(make('summary', '', 'SHA-256 校验信息'), make('code', '', value.sha256)); panel.append(integrity); updateControls();
}
function clearBundle() { bundleRequest++; bundle = null; $('bundle-summary').hidden = true; updateControls(); }
function fileIcon(kind) { return icon(kind, `entry-icon ${kind}`); }
function selectionKey(file) { return `${file.isFolder ? 'folder' : 'file'}:${file.id}`; }
function downloadable(file) { return !file.isFolder || Boolean(smartView() && file.slice && !syncFolder(file)); }
function resetDownloadSelection() { selectedDownloads.clear(); selectionAnchor = null; }
function browserEntries() {
  let entries = directoryFiles;
  if (smartView() && currentSlice) {
    const technical = new Set(['manifest.lanzou.txt', ...currentSlice.partNames, ...(currentSlice.indexNames || [])]);
    entries = [{ id: history.at(-1).id, name: history.at(-1).cloudName || history.at(-1).name, isFolder: true, isCurrentSlice: true, slice: currentSlice }, ...directoryFiles.filter(file => file.isFolder || !technical.has(file.name))];
  }
  return smartView() ? [...entries].sort((a, b) => Number(Boolean(b.slice)) - Number(Boolean(a.slice))) : entries;
}
function selectDownload(file, event = {}, checkbox = false) {
  if (batchSubmitting || directoryBusy || managementBusy || selectingBundle) return;
  const key = selectionKey(file), additive = event.ctrlKey || event.metaKey;
  const preserve = additive || (checkbox && !event.shiftKey);
  const next = new Set(preserve ? selectedDownloads : []);
  let keys = [key];
  if (event.shiftKey) {
    const ordered = browserEntries().map(selectionKey);
    const from = ordered.indexOf(selectionAnchor), to = ordered.indexOf(key);
    if (from >= 0 && to >= 0) keys = ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
    else selectionAnchor = key;
  } else {
    selectionAnchor = key;
    if ((checkbox || additive) && next.has(key)) { next.delete(key); keys = []; }
  }
  let limited = false;
  for (const value of keys) {
    if (next.size >= 200 && !next.has(value)) { limited = true; break; }
    next.add(value);
  }
  selectedDownloads.clear(); for (const value of next) selectedDownloads.add(value);
  if (limited) notice('每批最多选择 200 项，请分批操作');
  if (selectedDownloads.size) clearBundle();
  updateSelectionControls();
}
function updateSelectionControls() {
  const busy = batchSubmitting || directoryBusy || managementBusy || selectingBundle;
  const boxes = [...$('folder-list').querySelectorAll('[data-download-select]')];
  for (const box of boxes) {
    box.checked = selectedDownloads.has(box.dataset.downloadSelect); box.disabled = busy;
    box.closest('tr').classList.toggle('is-selected', box.checked);
  }
  const all = $('select-all-downloads'), count = boxes.filter(box => box.checked).length;
  if (all) { all.checked = boxes.length > 0 && count === boxes.length; all.indeterminate = count > 0 && count < boxes.length; all.disabled = busy || !boxes.length; }
  $('selection-count').textContent = `已选 ${selectedDownloads.size} 项`;
  $('clear-selection').disabled = !selectedDownloads.size || batchSubmitting;
  const downloads = browserEntries().filter(file => downloadable(file) && selectedDownloads.has(selectionKey(file))).length;
  $('download-selected').textContent = batchSubmitting ? '正在加入…' : `下载所选（${downloads}）`;
  $('download-selected').disabled = !downloads || busy || !state.account || !outputDir;
}
async function downloadSelected() {
  if (batchSubmitting) return;
  const items = browserEntries().filter(file => downloadable(file) && selectedDownloads.has(selectionKey(file))).map(file => ({ id: file.id, isFolder: file.isFolder, parentId: file.isCurrentSlice ? history.at(-2)?.id || '-1' : history.at(-1).id }));
  if (!items.length) return;
  const ownerUid = state.account?.uid, directory = directoryRequest;
  batchSubmitting = true; updateControls();
  try {
    const result = await api.call('downloadBatch', { items });
    if (ownerUid !== state.account?.uid) return;
    if (directory === directoryRequest) resetDownloadSelection();
    notice(`已加入 ${result.ids.length} 个下载任务，将依次下载，切片自动校验合并；可在“上传下载”页管理`);
  } finally { batchSubmitting = false; updateControls(); }
}
function renderDirectory(append = false) {
  if ($('download-panel').hidden || $('account-browser').hidden || document.hidden) { directoryDirty = true; return; }
  directoryDirty = false; clearTimeout(recognitionTimer); recognitionTimer = null;
  closeFileMenu();
  if (directoryPage === 1 && state.account) {
    directorySnapshots.set(history.at(-1).id, { entries: directoryFiles.map(file => ({ ...file })), hasMore: directoryHasMore, time: Date.now() });
    while (directorySnapshots.size > 32) directorySnapshots.delete(directorySnapshots.keys().next().value);
  }
  const scrollTop = append ? $('folder-list').scrollTop : 0;
  let table = $('folder-list').querySelector('.file-table');
  const existingTable = Boolean(table);
  if (!table) { table = make('table', 'file-table'); table.setAttribute('aria-label', '云端文件'); }
  if (!existingTable) {
  const head = table.createTHead().insertRow();
  for (const text of ['名称','大小','修改时间','操作']) { const cell = make('th', '', text); cell.scope = 'col'; head.append(cell); }
  const all = make('input'); all.type = 'checkbox'; all.id = 'select-all-downloads'; all.setAttribute('aria-label', '全选已加载的文件和文件夹'); all.title = '全选已加载的项目，每批最多 200 项；普通文件夹可选择管理，不递归下载';
  const heading = make('span', 'file-label'); heading.append(all, make('span', '', '名称')); head.cells[0].replaceChildren(heading);
  all.addEventListener('change', () => {
    const eligible = browserEntries();
    resetDownloadSelection();
    if (all.checked) { for (const file of eligible.slice(0, 200)) selectedDownloads.add(selectionKey(file)); if (eligible.length > 200) notice('每批最多 200 项，已选择前 200 项，其余请分批操作'); clearBundle(); }
    updateSelectionControls();
  });
  }
  const body = table.tBodies[0] || table.createTBody();
  const entries = browserEntries(), eligibleKeys = new Set(entries.map(selectionKey));
  for (const [key, cached] of directoryRows) if (!eligibleKeys.has(key)) { cached.row.remove(); directoryRows.delete(key); }
  for (const key of selectedDownloads) if (!eligibleKeys.has(key)) selectedDownloads.delete(key);
  if (!eligibleKeys.has(selectionAnchor)) selectionAnchor = null;
  for (const [index, file] of entries.entries()) {
    const key = selectionKey(file), syncRule = smartView() ? syncFolder(file) : null;
    const signature = JSON.stringify([file, smartView(), syncRule && [syncRule.name, syncRule.managedFiles]]);
    const cached = directoryRows.get(key);
    if (cached?.file === file && cached.signature === signature) {
      if (body.children[index] !== cached.row) body.insertBefore(cached.row, body.children[index] || null);
      continue;
    }
    cached?.row.remove();
    const row = make('tr', 'folder-row');
    row.dataset.entryId = file.id; row.dataset.entryKind = file.isFolder ? 'folder' : 'file';
    const name = make('td', 'file-name'), label = make('div', 'file-label');
    const sync = smartView() ? syncFolder(file) : null;
    const slice = smartView() && !sync ? file.slice : null;
    const kind = slice ? 'slice' : file.isFolder ? 'folder' : file.name === 'manifest.lanzou.txt' ? 'manifest' : /\.(zip|rar|7z)$/i.test(file.name) ? 'archive' : 'file';
    const displayName = sync?.name || slice?.originalName || file.name;
    const text = make(slice ? 'button' : 'span', `file-name-text${slice ? ' slice-name' : ''}`, displayName); text.title = sync ? `${displayName}\n自动同步目录：${file.name}\n双击进入` : slice ? `${displayName}\n云端目录：${file.name}\n${slice.totalParts} 个切片；点击查看详情` : file.name;
    if (slice) text.addEventListener('click', () => run(text, () => selectSlice(file)));
    const checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', `选择 ${displayName}`);
    {
      checkbox.dataset.downloadSelect = selectionKey(file);
      checkbox.title = 'Ctrl+点击切换选择；Shift+点击连续选择；Ctrl+Shift+点击追加范围';
      checkbox.addEventListener('change', () => selectDownload(file, {}, true));
      const selectionTarget = event => {
        const control = event.target.closest('button,input,a,select,textarea,summary,[contenteditable="true"]');
        return !control || control === checkbox || control === text;
      };
      row.addEventListener('mousedown', event => {
        if (event.button === 0 && event.shiftKey && selectionTarget(event)) event.preventDefault();
      });
      row.addEventListener('click', event => {
        if (event.button !== 0 || !selectionTarget(event)) return;
        if (event.target === checkbox && !event.shiftKey) return;
        if (event.target === text && slice && !event.ctrlKey && !event.metaKey && !event.shiftKey) return;
        event.preventDefault(); event.stopPropagation();
        selectDownload(file, event);
        // Chromium rolls back a cancelled checkbox click after the microtask checkpoint.
        if (event.target === checkbox) requestAnimationFrame(updateSelectionControls);
      }, true);
    }
    label.append(checkbox, fileIcon(kind), text); name.append(label);
    if (sync) {
      label.append(make('span', 'slice-badge', '自动同步'));
      name.append(make('small', 'slice-caption', `${sync.managedFiles} 个同步文件 · 云端目录：${file.name}`)); row.classList.add('sync-folder');
    } else if (slice) {
      const preview = slice.status === 'preview';
      label.append(make('span', 'slice-badge', preview ? '快速预览' : '切片文件'));
      const caption = make('small', 'slice-caption', `${slice.cached ? (slice.stale ? '缓存预览，待复核 · ' : '缓存预览 · ') : ''}${slice.message ? `更新未完成：${slice.message} · ` : ''}${preview ? '下载前校验 · ' : ''}${slice.totalParts} 片 · 云端目录：${file.name}`); caption.title = caption.textContent; name.append(caption); row.classList.add('slice-folder');
    } else if (smartView() && file.isFolder && file.identification === 'unavailable') {
      const note = make('small', 'slice-caption recognition-error', `识别失败：${file.identificationMessage || '请重试'}`); note.title = note.textContent; name.append(note);
    } else if (smartView() && file.isFolder && file.identification === 'ordinary') name.append(make('small', 'slice-caption', '普通文件夹'));
    const size = make('td', 'file-size', slice ? sizes(slice.originalSize) : file.isFolder ? '—' : sizes(file.size));
    const time = make('td', 'file-time', file.modifiedTime || '—'); time.title = file.modifiedTime || '';
    const actions = make('td', 'file-actions'); row.append(name, size, time, actions);
    if (file.isFolder) {
      const button = make('button', 'text-button', slice ? '查看切片' : '进入');
      button.setAttribute('aria-label', `进入 ${displayName}`);
      const enterFolder = async () => {
        if (directoryBusy || managementBusy || batchSubmitting) return;
        if (slice) await setBrowserView('raw');
        if (!file.isCurrentSlice) await refreshFolders([...history, { id: file.id, name: displayName, cloudName: file.name }]);
      };
      button.addEventListener('click', () => run(button, enterFolder));
      row.addEventListener('dblclick', event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const control = event.target.closest('button,input,a,select,textarea,summary,[contenteditable="true"]');
        if (control && control !== text) return;
        event.preventDefault(); void run(null, enterFolder);
      });
      button.disabled = directoryBusy; actions.append(button);
      if (slice) {
        const select = make('button', 'text-button select-download', '下载并合并'); select.dataset.downloadSlice = 'true';
        select.setAttribute('aria-label', `下载并合并 ${displayName}`);
        select.addEventListener('click', () => run(select, () => selectSlice(file, true))); actions.append(select);
      } else if (!sync && smartView() && file.identification === 'unavailable') {
        const retry = make('button', 'text-button', '重试识别'); retry.disabled = directoryBusy;
        retry.addEventListener('click', () => run(retry, async () => { delete file.identification; await identifyFolders(directoryRequest, true); })); actions.append(retry);
      }
    } else {
      if (file.name === 'manifest.lanzou.txt') {
        const inspect = make('button', 'text-button', '读取清单'); inspect.disabled = directoryBusy;
        inspect.addEventListener('click', () => run(inspect, inspectCurrentFolder)); actions.append(inspect);
      }
      const download = make('button', 'text-button', '下载'); download.dataset.downloadFile = 'true';
      download.setAttribute('aria-label', `下载 ${displayName}`);
      download.title = '直接下载网盘文件；切片请在智能识别中选择“下载并合并”';
      download.addEventListener('click', () => run(download, () => downloadRegular(file))); actions.append(download);
    }
    const more = make('button', 'text-button', '更多'); more.dataset.cloudManage = 'true';
    more.setAttribute('aria-label', `管理 ${displayName}`); more.setAttribute('aria-haspopup', 'menu');
    more.addEventListener('click', () => openFileMenu(more, file)); actions.append(more);
    row.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (more.disabled) return;
      if (!selectedDownloads.has(selectionKey(file))) selectDownload(file);
      openFileMenu(more, file, event);
    });
    body.insertBefore(row, body.children[index] || null);
    directoryRows.set(key, { row, file, signature });
  }
  if (!entries.length) { $('folder-list').replaceChildren(make('p', 'muted', '此目录为空。')); directoryRows.clear(); }
  else if (!existingTable) $('folder-list').replaceChildren(table);
  $('folder-list').scrollTop = scrollTop;
  $('folder-path').textContent = history.map(h => smartView() ? h.name : h.cloudName || h.name).join(' / '); $('folder-path').title = $('folder-path').textContent; updateControls();
  const folders = entries.filter(file => file.isFolder && !(smartView() && file.slice)).length;
  const counts = smartView() ? `${entries.filter(file => file.slice).length} 个切片文件 · ${folders} 个文件夹 · ${entries.filter(file => !file.isFolder).length} 个普通文件` : `${folders} 个文件夹 · ${entries.length - folders} 个文件`;
  $('directory-status').textContent = `${counts} · 第 ${directoryPage} 页${directoryHasMore ? '' : ' · 已全部加载'}`;
  if (!smartView()) $('recognition-status').textContent = '原始网盘 · 显示实际目录、切片和清单';
}
async function setBrowserView(mode) {
  render(await api.call('saveSettings', { browserView: mode }));
}
function closeFileMenu() {
  if ($('file-menu').matches(':popover-open')) $('file-menu').hidePopover();
}
function openFileMenu(button, file, pointer = null) {
  if (directoryBusy || managementBusy || selectingBundle || batchSubmitting || !state.account) return;
  const menu = $('file-menu');
  closeFileMenu();
  menu.replaceChildren();
  const selected = browserEntries().filter(entry => selectedDownloads.has(selectionKey(entry)));
  const multiple = selected.length > 1 && selectedDownloads.has(selectionKey(file));
  menu.setAttribute('aria-label', multiple ? `管理选中的 ${selected.length} 项` : `管理 ${file.slice?.originalName || file.name}`);
  const actions = multiple ? [['delete', '删除']] : [['rename', file.slice ? '重命名云端目录' : '重命名'], ['delete', file.slice ? '删除切片文件' : '删除']];
  for (const [action, label] of actions) {
    const item = make('button', `text-button${action === 'delete' ? ' danger-text' : ''}`, label);
    item.setAttribute('role', 'menuitem'); item.dataset.cloudAction = action;
    item.addEventListener('click', () => { menu.hidePopover(); openCloudDialog(action, file, multiple ? selected : null); }); menu.append(item);
  }
  menu.showPopover();
  const rect = button.getBoundingClientRect(), { width, height } = menu.getBoundingClientRect();
  const left = pointer ? pointer.clientX : rect.right - width;
  const top = pointer ? pointer.clientY : rect.bottom + height + 8 <= innerHeight ? rect.bottom + 4 : rect.top - height - 4;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, left))}px`;
  menu.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, top))}px`;
  menu.querySelector('button').focus();
}
function openCloudDialog(action, file = null, files = null) {
  if (managementBusy || directoryBusy || !state.account) return;
  const slice = file?.slice, deleting = action === 'delete';
  managementTarget = { action, file, parentId: file?.isCurrentSlice ? history.at(-2)?.id || '-1' : history.at(-1).id, ownerUid: state.account.uid };
  if (files) managementTarget.files = files.map(entry => ({ ...entry, parentId: entry.isCurrentSlice ? history.at(-2)?.id || '-1' : history.at(-1).id }));
  $('cloud-dialog-title').textContent = action === 'create' ? '新建文件夹' : deleting ? (slice ? '删除云端切片文件' : file.isFolder ? '删除云端文件夹' : '删除云端文件') : slice ? '重命名云端目录' : '重命名';
  $('cloud-dialog-description').textContent = deleting
    ? `确认删除“${slice?.originalName || file.name}”？${file.isFolder ? '将删除整个云端目录及其所有内容。' : ''}${slice ? `实际目录：${file.name}。删除后无法再下载或合并此文件。` : ''}本地已下载文件与历史记录保留。`
    : slice ? '这里只修改网盘目录名称，清单中保存的原文件名保持不变。' : action === 'create' ? '在当前网盘目录中创建文件夹。' : '修改网盘中的实际名称。';
  $('cloud-delete-list').hidden = !files;
  if (files) { $('cloud-dialog-title').textContent = '删除选中的云端项目'; renderDeleteSelection(managementTarget); }
  $('cloud-name-field').hidden = deleting; $('cloud-name').required = !deleting;
  $('cloud-name').value = action === 'rename' ? file.name : '';
  $('cloud-dialog-error').hidden = true;
  $('cloud-confirm').textContent = deleting ? '确认删除' : '保存'; $('cloud-confirm').classList.toggle('danger-button', deleting);
  $('cloud-dialog').showModal();
  if (deleting) $('cloud-cancel').focus(); else { $('cloud-name').focus(); $('cloud-name').select(); }
}
function renderDeleteSelection(target) {
  const folders = target.files.filter(file => file.isFolder).length;
  $('cloud-dialog-description').textContent = `${target.deletedCount ? `已删除 ${target.deletedCount} 项，仍有 ${target.files.length} 项未删除。` : `确认删除选中的 ${target.files.length} 项？`}${folders ? `包含 ${folders} 个文件夹，将删除整个目录及其所有内容。` : ''}本地已下载文件与历史记录保留。`;
  $('cloud-delete-list').replaceChildren(...target.files.map(file => make('li', '', `${file.slice?.originalName || file.name}${file.slice ? `（云端目录：${file.name}）` : file.isFolder ? '（文件夹）' : ''}`)));
}
async function deleteCloudSelection(target) {
  const active = () => managementTarget === target && target.ownerUid === state.account?.uid;
  const removed = [], failures = [];
  // The collapsed current slice represents the ancestor of all other visible entries.
  const entries = target.files.some(file => file.isCurrentSlice) ? target.files.filter(file => file.isCurrentSlice) : target.files;
  for (const [index, file] of entries.entries()) {
    if (!active()) return;
    $('cloud-confirm').textContent = `正在删除（${index + 1} / ${entries.length}）…`;
    try {
      await api.call('manageCloud', { action: 'delete', parentId: file.parentId, id: file.id, isFolder: file.isFolder });
      removed.push(file);
    } catch (error) { failures.push(`${file.slice?.originalName || file.name}：${error.message}`); }
  }
  if (!active()) return;
  const deletedCurrent = removed.some(file => file.isCurrentSlice);
  const removedKeys = new Set((deletedCurrent ? target.files : removed).map(selectionKey));
  target.deletedCount = (target.deletedCount || 0) + removedKeys.size;
  target.files = target.files.filter(file => !removedKeys.has(selectionKey(file)));
  for (const key of removedKeys) selectedDownloads.delete(key);
  if (removed.length) {
    directorySnapshots.clear(); recognitionRequest++; recognitionToken = null; currentSlice = null;
    if (deletedCurrent) { history = history.slice(0, -1); directoryFiles = []; directoryPage = 0; }
    else directoryFiles = directoryFiles.filter(file => !removedKeys.has(selectionKey(file)));
    renderDirectory(true);
  }
  let refreshError = '';
  try { await refreshFolders(history); } catch (error) { refreshError = `目录刷新失败：${error.message}，请手动刷新。`; }
  if (!active()) return;
  if (target.files.length) {
    renderDeleteSelection(target);
    $('cloud-dialog-error').textContent = `剩余 ${target.files.length} 项未删除，可重试。${failures.slice(0, 3).join('；')}${refreshError}`;
    $('cloud-dialog-error').hidden = false;
  } else {
    managementTarget = null; $('cloud-dialog').close();
    notice(`已删除 ${target.deletedCount} 个云端项目，本地文件保留。${refreshError}`, Boolean(refreshError));
  }
}
async function submitCloudChange(event) {
  event.preventDefault(); if (!managementTarget || managementBusy) return;
  const target = managementTarget; managementBusy = true;
  $('cloud-confirm').disabled = $('cloud-cancel').disabled = true; $('cloud-name').disabled = true;
  $('cloud-confirm').textContent = '处理中…'; $('cloud-dialog-error').hidden = true;
  clearBundle(); updateControls();
  try {
    if (target.files) { await deleteCloudSelection(target); return; }
    const result = await api.call('manageCloud', { action: target.action, parentId: target.parentId, id: target.file?.id, isFolder: target.file?.isFolder, name: $('cloud-name').value });
    if (target.ownerUid !== state.account?.uid) return;
    managementTarget = null; $('cloud-dialog').close(); directorySnapshots.clear(); recognitionRequest++; recognitionToken = null; currentSlice = null;
    if (target.file?.isCurrentSlice && target.action === 'delete') { history = history.slice(0, -1); directoryFiles = []; directoryPage = 0; }
    else if (target.action === 'delete') directoryFiles = directoryFiles.filter(file => file.id !== target.file.id || file.isFolder !== target.file.isFolder);
    else if (target.action === 'rename') {
      const file = directoryFiles.find(file => file.id === target.file.id && file.isFolder === target.file.isFolder);
      if (file) file.name = result.name;
      if (target.file.isCurrentSlice) history.at(-1).cloudName = result.name;
    }
    renderDirectory(true);
    const done = target.action === 'delete' ? '云端内容已删除，本地文件保留' : target.action === 'create' ? '文件夹已创建' : '已重命名';
    try { await refreshFolders(history); notice(done); }
    catch (error) { notice(`${done}；目录刷新失败：${error.message}，请手动刷新`, true); }
  } catch (error) {
    if (target.ownerUid === state.account?.uid && $('cloud-dialog').open) { $('cloud-dialog-error').textContent = error.message; $('cloud-dialog-error').hidden = false; }
  } finally {
    managementBusy = false; $('cloud-confirm').disabled = $('cloud-cancel').disabled = $('cloud-name').disabled = false;
    $('cloud-confirm').textContent = target.action === 'delete' ? '确认删除' : '保存'; updateControls();
  }
}
async function downloadRegular(file) {
  if (selectingBundle) return;
  selectingBundle = true; clearBundle(); updateControls();
  try { await api.call('downloadFile', { id: file.id, parentId: history.at(-1).id }); notice('普通文件下载已加入传输队列，可在“上传下载”页管理'); }
  finally { selectingBundle = false; updateControls(); }
}
async function selectSlice(file, download = false) {
  if (selectingBundle) return;
  selectingBundle = true; clearBundle(); const request = bundleRequest, directory = directoryRequest;
  try {
    const value = await api.call('inspectFolder', { folderId: file.id });
    if (request !== bundleRequest || directory !== directoryRequest) return;
    showBundle(value);
    if (download) { await api.call('download', { key: value.key, outputDir, concurrency: Number($('concurrency').value) }); notice('下载已加入传输队列，完成后自动校验并合并为原文件'); }
  } catch (error) {
    if (request === bundleRequest && directory === directoryRequest) { delete file.slice; file.identification = 'unavailable'; file.identificationMessage = error.message; renderDirectory(true); }
    throw error;
  } finally { selectingBundle = false; updateControls(); }
}
async function refreshFolders(nextHistory = history, append = false, force = false) {
  closeFileMenu();
  if (!append && (force || nextHistory.at(-1).id !== history.at(-1).id)) resetDownloadSelection();
  clearBundle(); recognitionRequest++; const request = ++directoryRequest; const target = [...nextHistory];
  recognitionToken = null;
  const previous = { history, files: directoryFiles, page: directoryPage, hasMore: directoryHasMore, slice: currentSlice, scrollTop: $('folder-list').scrollTop };
  const cached = !append && !force && directorySnapshots.get(target.at(-1).id);
  let showedSnapshot = false;
  const revision = cloudRevision; let succeeded = false;
  $('recognition-status').textContent = '';
  directoryBusy = true; updateControls(); $('directory-status').textContent = append ? '正在加载下一页…' : '正在读取目录…';
  if (cached && Date.now() - cached.time < 300_000) {
    history = target; directoryFiles = cached.entries.map(file => ({ ...file })); directoryPage = 1; directoryHasMore = cached.hasMore; currentSlice = null;
    renderDirectory(); $('directory-status').textContent += ' · 正在更新'; showedSnapshot = true;
  }
  $('folder-list').setAttribute('aria-busy', 'true');
  for (const button of $('folder-list').querySelectorAll('button')) button.disabled = true;
  try {
    const result = await api.call('listPage', { folderId: target.at(-1).id, page: append ? directoryPage + 1 : 1, force });
    if (request !== directoryRequest) return;
    const nextFiles = append ? [...directoryFiles] : []; const seen = new Set(nextFiles.map(file => `${file.isFolder}:${file.id}`)); let added = 0;
    for (const file of result.entries) {
      const key = `${file.isFolder}:${file.id}`;
      if (!seen.has(key)) { seen.add(key); nextFiles.push(file); added++; }
    }
    if (append && result.entries.length && !added) throw new Error('文件列表重复返回，已停止翻页，请刷新目录后重试');
    if (!append) currentSlice = null;
    history = target; directoryFiles = nextFiles; directoryPage = result.page; directoryHasMore = result.hasMore;
    if (target.at(-1).id === '-1' && revision === cloudRevision) cloudDirty = false;
    succeeded = true;
    renderDirectory(append);
    if (smartView()) void identifyFolders(request);
  } catch (error) {
    if (request !== directoryRequest) return;
    if (showedSnapshot) {
      history = previous.history; directoryFiles = previous.files; directoryPage = previous.page; directoryHasMore = previous.hasMore; currentSlice = previous.slice;
      renderDirectory(true); $('folder-list').scrollTop = previous.scrollTop;
    }
    $('directory-status').textContent = '读取失败，已保留原目录，可重试。'; throw error;
  } finally {
    if (request === directoryRequest) {
      directoryBusy = false; $('folder-list').setAttribute('aria-busy', 'false');
      for (const button of $('folder-list').querySelectorAll('button')) button.disabled = false;
      updateControls();
      if (succeeded) refreshUploadedFiles();
    }
  }
}
function recognitionSummary(pending = 0) {
  const recognized = directoryFiles.filter(file => file.slice).length + Number(Boolean(currentSlice));
  const synced = directoryFiles.filter(syncFolder).length;
  const ordinary = directoryFiles.filter(file => file.isFolder && !syncFolder(file) && file.identification === 'ordinary').length;
  const failed = directoryFiles.filter(file => !syncFolder(file) && file.identification === 'unavailable').length;
  $('recognition-status').textContent = `切片 ${recognized} · 文件夹 ${ordinary}${synced ? ` · 同步目录 ${synced}` : ''}${pending ? ` · 待识别 ${pending}` : ''}${failed ? ` · 失败 ${failed}` : ''}`;
  $('recognition-status').title = '刷新目录保留已知原名；切片预览 5 分钟、普通目录 1 分钟内复用，过期后后台复核。单个目录识别最多等待 12 秒，临时网络失败保留预览；下载前始终重新校验完整清单。';
}
function applyRecognition(result) {
  const file = directoryFiles.find(file => file.isFolder && String(file.id) === result.id);
  if (!file || syncFolder(file)) return;
  file.identification = result.status; file.identificationMessage = result.message; file.recognitionStale = Boolean(result.stale);
  if (['ready', 'preview'].includes(result.status)) file.slice = result;
  else delete file.slice;
}
api.onRecognition(({ token, ownerUid, result }) => {
  if (!recognitionToken || token !== recognitionToken.token || String(ownerUid) !== String(state.account?.uid) || recognitionToken.request !== directoryRequest || recognitionToken.recognition !== recognitionRequest || !smartView()) return;
  applyRecognition(result); recognitionToken.pending.delete(result.id);
  scheduleRecognitionRender();
});
function scheduleRecognitionRender() {
  directoryDirty = true;
  if (recognitionTimer || $('download-panel').hidden || $('account-browser').hidden || document.hidden) return;
  recognitionTimer = setTimeout(() => { recognitionTimer = null; renderDirectory(true); recognitionSummary(recognitionToken?.pending.size || 0); }, 100);
}
async function identifyFolders(request) {
  if (!smartView() || request !== directoryRequest) return;
  const recognition = ++recognitionRequest;
  const valid = () => smartView() && request === directoryRequest && recognition === recognitionRequest;
  const folders = directoryFiles.filter(file => file.isFolder && !syncFolder(file) && (!file.identification || file.recognitionStale));
  recognitionToken = { token: `${request}:${recognition}`, request, recognition, pending: new Set(folders.map(file => String(file.id))) };
  const token = recognitionToken.token;
  recognitionSummary(folders.length);
  try {
    if (!currentSlice && history.at(-1).id !== '-1' && directoryFiles.some(file => !file.isFolder && file.name === 'manifest.lanzou.txt')) {
      $('recognition-status').textContent = '正在识别当前切片目录…';
      const value = await api.call('inspectFolder', { folderId: history.at(-1).id });
      if (!valid()) return;
      currentSlice = value; renderDirectory(true);
    }
    for (let offset = 0; offset < folders.length; offset += 256) {
      if (!valid()) return;
      const batch = folders.slice(offset, offset + 256);
      const results = await api.call('identifyFolders', { folderIds: batch.map(file => file.id), folderNames: Object.fromEntries(batch.map(file => [file.id, file.name])), token });
      if (!valid()) return;
      for (const result of results) {
        applyRecognition(result); recognitionToken.pending.delete(result.id);
      }
      scheduleRecognitionRender();
    }
    if (valid()) {
      recognitionSummary();
    }
  } catch (error) { if (valid()) $('recognition-status').textContent = `原名识别未完成，可刷新重试：${error.message}`; }
}
async function refreshCache() {
  const info = await api.call('cacheInfo');
  $('cache-status').textContent = `可清理 ${sizes(info.cleanableBytes)} · 恢复数据 ${sizes(info.protectedBytes)}（保留）`;
}
async function clearHistory(scope = 'completed', id) {
  const result = await api.call('clearHistory', { scope, ...(id ? { id } : {}) });
  render(await api.call('state'));
  await refreshCache(); notice(`已清理 ${result.removed} 条${scope === 'all' ? '已结束' : '已完成'}记录，保留 ${result.retained} 条任务；原文件与下载结果保留`);
}
async function inspectCurrentFolder() {
  clearBundle(); const request = bundleRequest;
  const value = await api.call('inspectFolder', { folderId: history.at(-1).id });
  if (request === bundleRequest) showBundle(value);
}
function setSource(selected) {
  sources = Array.isArray(selected) ? selected : [selected];
  sourceRemovals.clear();
  const name = !sources.length ? '多选文件，或批量拖到这里' : sources.length === 1 ? sources[0].name : `已选择 ${sources.length} 个文件`;
  const paths = sources.map(file => file.path).join('；');
  $('source-name').textContent = name; $('source-name').title = sources.map(file => file.name).join('；');
  $('source-path').textContent = paths || '每次最多 200 个；登录后拖入即排队上传'; $('source-path').title = paths;
  $('choose-source').classList.toggle('has-file', Boolean(sources.length));
  $('source-size').textContent = `${sources.length > 1 ? '合计 ' : ''}${sizes(sources.reduce((sum, file) => sum + file.size, 0))}`; $('source-size').hidden = !sources.length;
  const rows = document.createDocumentFragment();
  for (const file of sources) {
    const row = make('li', 'source-item'), label = make('label'), checkbox = make('input');
    checkbox.type = 'checkbox'; checkbox.dataset.sourcePath = file.path; checkbox.setAttribute('aria-label', `选择移除 ${file.name}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) sourceRemovals.add(file.path); else sourceRemovals.delete(file.path);
      updateSourceSelection();
    });
    const name = make('span', 'source-item-name', file.name); name.title = file.path;
    label.append(checkbox, name, make('small', 'source-item-size', sizes(file.size))); row.append(label); rows.append(row);
  }
  $('source-list').replaceChildren(rows); $('source-selection').hidden = !sources.length;
  updateSourceSelection(); updateControls();
}
function updateSourceSelection() {
  const count = sourceRemovals.size, all = $('source-select-all');
  all.checked = sources.length > 0 && count === sources.length; all.indeterminate = count > 0 && count < sources.length;
  $('remove-sources').disabled = !count;
  setText($('remove-sources'), `移除所选（${count}）`);
  setText($('source-selection-count'), `待移除 ${count} / ${sources.length} 项`);
}
async function startUpload() {
  if (uploadSubmitting || !sources.length) return;
  uploadSubmitting = true; updateControls();
  try {
    const result = await api.call('uploadBatch', { paths: sources.map(file => file.path) });
    const issue = result.stopped || result.failures.slice(0, 3).map(file => `${file.path}：${file.error}`).join('；');
    if (issue) setSource(sources.filter(file => result.pendingPaths.includes(file.path)));
    notice(`${result.ids.length} 个上传任务已加入任务列表${result.paused ? `，其中 ${result.paused} 个已暂停，请到“上传下载”页继续` : '，在传输队列中按顺序开始'}${issue ? `；${issue}。未建立任务的文件保留，可检查后重试` : ''}`, Boolean(issue));
  }
  finally { uploadSubmitting = false; updateControls(); }
}
$('login-form').addEventListener('submit', event => {
  event.preventDefault(); void run($('login'), async () => {
    const password = $('password').value; $('password').value = '';
    render(await api.call('login', { account: $('account').value, password, remember: $('remember').checked })); notice('已登录蓝奏云');
  });
});
$('official-login').addEventListener('click', () => run($('official-login'), () => api.call('officialLogin', { remember: $('remember').checked })));
$('confirm-login').addEventListener('click', () => run($('confirm-login'), async () => { render(await api.call('confirmLogin', { remember: $('remember').checked })); notice('已确认官网登录'); }));
$('logout').addEventListener('click', () => run($('logout'), async () => { render(await api.call('logout')); clearBundle(); history = [{ id: '-1', name: '根目录' }]; $('folder-list').replaceChildren(make('p', 'muted', '登录后点击“刷新目录”。')); }));
$('open-data').addEventListener('click', () => run($('open-data'), () => api.call('openData')));
$('tab-upload').addEventListener('click', () => switchTab('upload'));
$('tab-sync').addEventListener('click', () => switchTab('sync'));
$('tab-download').addEventListener('click', () => switchTab('download'));
$('new-folder').addEventListener('click', () => openCloudDialog('create'));
$('cloud-form').addEventListener('submit', submitCloudChange);
$('cloud-cancel').addEventListener('click', () => { managementTarget = null; $('cloud-dialog').close(); });
$('cloud-dialog').addEventListener('cancel', event => { if (managementBusy) event.preventDefault(); else managementTarget = null; });
$('file-menu').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault(); const buttons = [...$('file-menu').querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
  buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
});
$('folder-list').addEventListener('scroll', closeFileMenu, { passive: true });
$('folder-list').addEventListener('contextmenu', event => { if (!event.target.closest('.folder-row')) closeFileMenu(); });
window.addEventListener('resize', closeFileMenu);
$('tab-settings').addEventListener('click', () => switchTab('settings'));
$('tab-transfers').addEventListener('click', () => switchTab('transfers'));
for (const id of ['transfer-type', 'transfer-state']) $(id).addEventListener('change', () => { taskPage = 0; resetTaskSelection(); renderTasks(); });
$('select-all-tasks').addEventListener('change', event => {
  const ids = [...taskRows].filter(([, row]) => !row.task.syncRuleId).map(([id]) => id);
  let limited = false;
  for (const id of ids) {
    if (!event.target.checked) selectedTasks.delete(id);
    else if (selectedTasks.size < 200 || selectedTasks.has(id)) selectedTasks.add(id);
    else limited = true;
  }
  if (limited) notice('每次最多选择 200 个任务，请分批操作');
  taskSelectionAnchor = null; updateTaskSelectionControls();
});
$('clear-task-selection').addEventListener('click', () => { resetTaskSelection(); updateTaskSelectionControls(); });
$('cancel-selected-tasks').addEventListener('click', () => run($('cancel-selected-tasks'), () => cancelTasks([...selectedTasks])));
$('task-previous').addEventListener('click', () => { taskPage = Math.max(0, taskPage - 1); renderTasks(); });
$('task-next').addEventListener('click', () => { taskPage++; renderTasks(); });
$('pause-all').addEventListener('click', () => run($('pause-all'), () => api.call('pauseAll')));
$('download-selected').addEventListener('click', () => run($('download-selected'), downloadSelected));
$('clear-selection').addEventListener('click', () => { resetDownloadSelection(); updateSelectionControls(); });
$('floating-open').addEventListener('click', () => switchTab('transfers'));
for (const id of ['floating-name', 'floating-folder']) $(id).addEventListener('click', () => run($(id), () => api.call('showResult', { id: floatingId })));
$('show-floating').addEventListener('click', () => { floatingDismissed = null; floatingMinimized = false; renderFloating(); });
$('floating-toggle').addEventListener('click', () => { floatingMinimized = !floatingMinimized; renderFloating(); });
$('floating-close').addEventListener('click', () => { floatingDismissed = floatingId; renderFloating(); });
$('floating-action').addEventListener('click', () => run($('floating-action'), () => { const task = state.tasks.find(task => task.id === floatingId); if (task) return updateTaskAction(task); }));
for (const id of ['sync-floating-open', 'sync-floating-name']) $(id).addEventListener('click', () => switchTab('sync'));
$('show-sync-floating').addEventListener('click', () => { floatingSyncDismissed = null; floatingMinimized = false; const rule = state.sync?.rules.find(syncActive) || [...(state.sync?.rules || [])].filter(rule => rule.progress).sort((a, b) => (b.lastRun || 0) - (a.lastRun || 0))[0]; if (rule) { $('floating-transfer').hidden = true; renderSyncFloating(rule); } });
$('sync-floating-toggle').addEventListener('click', () => { floatingMinimized = !floatingMinimized; const rule = state.sync?.rules.find(rule => rule.id === floatingSyncId); if (rule) renderSyncFloating(rule); });
$('sync-floating-close').addEventListener('click', () => { floatingSyncDismissed = floatingSyncKey; $('floating-sync').hidden = true; });
$('sync-floating-action').addEventListener('click', () => run($('sync-floating-action'), () => { const rule = state.sync?.rules.find(rule => rule.id === floatingSyncId); if (rule) return syncActive(rule) || rule.state === 'queued' ? api.call('toggleSync', { id: rule.id, enabled: false }) : ['paused', 'error'].includes(rule.state) ? api.call('runSync', { id: rule.id }) : switchTab('sync'); }));
for (const [id, key] of [['upload-concurrency', 'uploadConcurrency'], ['download-concurrency', 'downloadConcurrency'], ['concurrency', 'downloadConcurrency']]) $(id).addEventListener('change', () => run($(id), async () => {
  try { render(await api.call('saveSettings', { [key]: Number($(id).value) })); notice('并发设置已保存，新任务或暂停后继续时生效'); }
  finally { $(id).value = String(state.settings[key]); }
}));
for (const [id, key] of [['set-download-dir', 'downloadDir'], ['set-cache-dir', 'cacheDir']]) $(id).addEventListener('click', () => run($(id), async () => {
  const next = await api.call('chooseSettingDirectory', { key }); if (next) { render(next); await refreshCache(); notice('目录设置已保存，新任务将使用新位置'); }
}));
$('auto-clean-cache').addEventListener('change', () => run($('auto-clean-cache'), async () => {
  try { render(await api.call('saveSettings', { autoCleanCache: $('auto-clean-cache').checked })); await refreshCache(); notice('自动清理设置已保存'); }
  finally { $('auto-clean-cache').checked = state.settings.autoCleanCache; }
}));
for (const [id, key] of [['open-at-login', 'openAtLogin'], ['start-hidden', 'startHidden'], ['close-to-tray', 'closeToTray']]) $(id).addEventListener('change', () => run($(id), async () => {
  try { render(await api.call('saveSettings', { [key]: $(id).checked })); notice(key === 'startHidden' ? '静默启动设置已保存，下次启动生效' : '启动与托盘设置已保存'); }
  finally { $(id).checked = Boolean(state.settings[key]); }
}));
$('refresh-cache').addEventListener('click', () => run($('refresh-cache'), refreshCache));
$('clean-cache').addEventListener('click', () => run($('clean-cache'), async () => {
  const result = await api.call('cleanCache'); await refreshCache(); notice(`已清理 ${result.files} 个缓存文件，释放 ${sizes(result.bytes)}；未完成任务的恢复数据保留`);
}));
for (const id of ['clear-history', 'clear-history-settings']) $(id).addEventListener('click', () => run($(id), () => clearHistory()));
for (const id of ['clear-all-history', 'clear-all-history-settings']) $(id).addEventListener('click', () => run($(id), () => clearHistory('all')));
$('choose-source').addEventListener('click', () => run($('choose-source'), async () => {
  if (selectingSource || uploadSubmitting) return;
  selectingSource = true; updateControls();
  try { const selected = await api.call('chooseSource'); if (selected) setSource(selected); }
  finally { selectingSource = false; updateControls(); }
}));
$('start-upload').addEventListener('click', () => run($('start-upload'), startUpload));
$('source-select-all').addEventListener('change', () => {
  sourceRemovals.clear();
  for (const checkbox of $('source-list').querySelectorAll('input')) {
    checkbox.checked = $('source-select-all').checked;
    if (checkbox.checked) sourceRemovals.add(checkbox.dataset.sourcePath);
  }
  updateSourceSelection();
});
$('remove-sources').addEventListener('click', () => {
  if (selectingSource || uploadSubmitting || !sourceRemovals.size) return;
  const count = sourceRemovals.size;
  setSource(sources.filter(file => !sourceRemovals.has(file.path)));
  notice(`已从上传选择中移除 ${count} 个文件，本地原文件保留`);
});
$('refresh-folders').addEventListener('click', () => run($('refresh-folders'), () => refreshFolders(history, false, true)));
$('load-more').addEventListener('click', () => run($('load-more'), () => refreshFolders(history, true)));
$('folder-up').addEventListener('click', () => run($('folder-up'), () => refreshFolders(history.length > 1 ? history.slice(0, -1) : history)));
$('inspect-folder').addEventListener('click', () => run($('inspect-folder'), inspectCurrentFolder));
for (const mode of ['raw', 'smart']) $('view-' + mode).addEventListener('click', () => run($('view-' + mode), () => setBrowserView(mode)));
for (const source of ['account','share']) $(source + '-source').addEventListener('click', () => {
  closeFileMenu();
  $('account-browser').hidden = source !== 'account'; $('share-form').hidden = source !== 'share';
  $('browser-views').hidden = source !== 'account';
  $('account-source').classList.toggle('selected', source === 'account'); $('share-source').classList.toggle('selected', source === 'share'); clearBundle();
  if (source === 'account' && directoryDirty) renderDirectory(true);
});
$('share-form').addEventListener('submit', event => { event.preventDefault(); void run($('share-form').querySelector('button'), async () => { clearBundle(); const request = bundleRequest; const value = await api.call('inspectShare', { url: $('share-url').value, password: $('share-password').value }); if (request === bundleRequest) showBundle(value); }); });
$('choose-directory').addEventListener('click', () => run($('choose-directory'), async () => { const selected = await api.call('chooseDirectory'); if (selected) { outputDir = selected; $('output-directory').textContent = selected; $('output-directory').title = selected; } }));
$('start-download').addEventListener('click', () => run($('start-download'), async () => {
  if (downloadSubmitting) return;
  downloadSubmitting = true; updateControls();
  try { await api.call('download', { key: bundle.key, outputDir, concurrency: Number($('concurrency').value) }); notice('下载已加入传输队列，全部校验后将自动合并'); }
  finally { downloadSubmitting = false; updateControls(); }
}));
let dragDepth = 0;
const dropZone = $('choose-source');
const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
for (const name of ['dragover', 'drop']) document.addEventListener(name, event => { if (hasFiles(event)) event.preventDefault(); });
document.addEventListener('dragend', () => { dragDepth = 0; dropZone.classList.remove('dragging'); });
dropZone.addEventListener('dragenter', event => { if (hasFiles(event)) { event.preventDefault(); dragDepth++; dropZone.classList.add('dragging'); } });
dropZone.addEventListener('dragover', event => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
dropZone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove('dragging'); } });
dropZone.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; dropZone.classList.remove('dragging');
  void run(null, async () => {
    if (selectingSource || uploadSubmitting) throw new Error('正在加入文件，请稍候再拖入');
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length || files.length > 200) throw new Error('每次请拖入 1–200 个文件');
    const paths = files.map(file => api.filePath(file));
    if (paths.some(file => !file)) throw new Error('请拖入本机的实际文件，不支持网页链接或虚拟文件；本批未加入队列');
    selectingSource = true; updateControls();
    try {
      setSource(await api.call('selectSources', { paths }));
      if (state.account) await startUpload();
      else notice(`已选中 ${sources.length} 个文件，登录后点击上传`);
    } finally { selectingSource = false; updateControls(); }
  });
});
for (const [id, action] of [['window-minimize', 'windowMinimize'], ['window-maximize', 'windowToggleMaximize'], ['window-close', 'windowClose']]) $(id).addEventListener('click', () => run($(id), () => api.call(action)));
api.onState(render);
api.onOpenSettings(() => switchTab('settings'));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (!$('transfers-panel').hidden && tasksDirty) renderTasks();
    if (!$('sync-panel').hidden) syncUI.render(state);
    if (!$('download-panel').hidden && directoryDirty) renderDirectory(true);
    renderFloating();
  }
});
void api.call('state').then(render).catch(error => notice(error.message, true));
