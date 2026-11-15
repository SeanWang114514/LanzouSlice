import { roundedBytes, duration } from './transfer-format.js';
import { icon } from './icons.js';
for (const node of document.querySelectorAll('[data-icon]')) node.replaceChildren(icon(node.dataset.icon));
const $ = id => document.getElementById(id);
const api = window.lanzou;
let state = { account: null, tasks: [] }, source = null, bundle = null, outputDir = '', noticeTimer;
let history = [{ id: '-1', name: '根目录' }];
let directoryFiles = [], directoryPage = 0, directoryHasMore = false, directoryBusy = false, directoryRequest = 0, bundleRequest = 0, selectingSource = false;
let cloudDirty = false, cloudRevision = 0;
let recognitionRequest = 0, currentSlice = null, selectingBundle = false;
let recognitionToken = null;
const directorySnapshots = new Map();
const taskRows = new Map();
let floatingId = null, floatingDismissed = null, floatingMinimized = false;
let managementTarget = null, managementBusy = false;
const selectedDownloads = new Set();
let selectionAnchor = null;
let batchSubmitting = false;
const statusText = task => ({ queued: '排队中', running: '进行中', paused: '已暂停', failed: '失败', completed: '已完成' }[task.state] || task.state);
const smartView = () => (state.settings?.browserView || 'smart') === 'smart';
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
  const logged = Boolean(state.account); const running = state.tasks.some(t => t.state === 'running');
  $('start-upload').disabled = !logged || !source || running || managementBusy || batchSubmitting || state.tasks.some(task => task.state === 'queued');
  $('start-download').disabled = !bundle || !outputDir || running || managementBusy;
  $('upload-hint').textContent = running ? '当前有任务运行，可在右下角或“上传下载”页暂停。' : !logged ? '请先登录蓝奏云。' : !source ? '请选择需要上传的原始文件。' : '准备就绪，将自动创建云端文件夹。';
  $('inspect-folder').disabled = !logged || history.at(-1).id === '-1';
  $('inspect-folder').disabled ||= directoryBusy || managementBusy;
  $('refresh-folders').disabled = !logged || directoryBusy || managementBusy;
  $('new-folder').disabled = !logged || directoryBusy || managementBusy;
  $('folder-up').disabled = history.length <= 1 || directoryBusy || managementBusy;
  $('load-more').disabled = directoryBusy || managementBusy || !logged;
  $('load-more').hidden = !directoryHasMore;
  $('start-upload').disabled ||= selectingSource;
  for (const button of $('folder-list').querySelectorAll('[data-download-slice],[data-download-file]')) button.disabled = directoryBusy || managementBusy || selectingBundle || running || !outputDir;
  const managementDisabled = directoryBusy || managementBusy || selectingBundle || batchSubmitting || !logged;
  for (const button of $('folder-list').querySelectorAll('[data-cloud-manage]')) button.disabled = managementDisabled;
  if (managementDisabled) closeFileMenu();
  for (const id of ['clear-history', 'clear-history-settings']) $(id).disabled = !state.tasks.some(task => task.state === 'completed');
  for (const id of ['clear-all-history', 'clear-all-history-settings']) $(id).disabled = !state.tasks.some(task => ['completed', 'failed'].includes(task.state));
  $('pause-all').disabled = !running && !state.tasks.some(task => task.state === 'queued');
  $('show-floating').disabled = !state.tasks.length;
  updateSelectionControls();
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
function createTaskRow(task) {
  const root = make('article', 'task'); root.dataset.taskId = task.id;
  const top = make('div', 'task-top'), title = make('div', 'task-name'), status = make('span', 'task-status');
  title.append(icon(task.type, 'ui-icon task-direction'), make('span', 'task-name-text', `${task.type === 'upload' ? '上传' : '下载'} · ${task.originalName || '文件任务'}`)); title.title = task.originalName || '文件任务'; top.append(title, status);
  const progressRow = make('div', 'transfer-progress'), progress = make('progress'), percent = make('span', 'task-percent'); progress.max = 1; progress.setAttribute('aria-label', `${task.originalName}进度`); progressRow.append(progress, percent);
  const detail = make('p', 'task-detail');
  const metrics = make('div', 'transfer-metrics');
  const values = ['速度', '已用时间', '预计剩余'].map(text => { const cell = make('div'), value = make('strong'); cell.append(make('small', '', text), value); metrics.append(cell); return value; });
  const bottom = make('div', 'task-bottom'), info = make('small'), buttons = make('div', 'task-buttons'); bottom.append(info, buttons);
  const more = make('details', 'task-more'), metadata = make('div'); more.append(make('summary', '', '位置、分享与任务详情'), metadata);
  root.append(top, progressRow, detail, metrics, bottom, more);
  return { root, status, progress, percent, detail, values, info, buttons, metadata, actionState: null, metadataKey: null };
}
function renderTasks() {
  const tasks = [...state.tasks].reverse(), ids = new Set(tasks.map(task => task.id));
  for (const [id, row] of taskRows) if (!ids.has(id)) { row.root.remove(); taskRows.delete(id); }
  $('tasks').querySelector('.empty-state')?.remove();
  const counts = type => state.tasks.filter(task => task.state === type).length;
  $('task-count').textContent = String(tasks.length);
  $('transfer-summary').textContent = `排队 ${counts('queued')} · 进行中 ${counts('running')} · 暂停 ${counts('paused')} · 失败 ${counts('failed')} · 已完成 ${counts('completed')}`;
  let visible = 0;
  for (const [index, task] of tasks.entries()) {
    let row = taskRows.get(task.id); if (!row) { row = createTaskRow(task); taskRows.set(task.id, row); }
    if ($('tasks').children[index] !== row.root) $('tasks').insertBefore(row.root, $('tasks').children[index] || null);
    row.root.hidden = !(['all', task.type].includes($('transfer-type').value) && ['all', task.state].includes($('transfer-state').value));
    if (!row.root.hidden) visible++;
    row.root.className = `task ${task.state}`;
    row.status.className = `task-status ${task.state}`; row.status.textContent = statusText(task);
    row.progress.value = Math.max(0, Math.min(1, task.progress || 0)); row.percent.textContent = `${Math.round(row.progress.value * 100)}%`;
    row.detail.textContent = task.message || task.error || '准备中'; row.detail.title = row.detail.textContent;
    taskMetrics(task).forEach((text, i) => { row.values[i].textContent = text; row.values[i].title = text; });
    const total = task.totalBytes || task.originalSize || 0;
    row.info.textContent = `${roundedBytes(task.bytes || 0)} / ${task.downloadKind === 'file' && !task.totalKnown && task.state !== 'completed' ? '未知' : roundedBytes(total)} · ${task.downloadKind === 'file' ? '普通文件 · 单连接' : `${task.totalParts || 0} 片 · ${task.concurrency || 1} 路`}`;
    if (row.actionState !== task.state) {
      row.actionState = task.state; row.buttons.replaceChildren();
      const add = (text, action) => { const b = make('button', 'text-button', text); b.addEventListener('click', () => run(b, action)); row.buttons.append(b); };
      if (['running', 'queued'].includes(task.state)) add('暂停', () => updateTaskAction(task));
      if (['paused', 'failed'].includes(task.state)) add('继续', () => updateTaskAction(task));
      add('打开所在文件夹', () => api.call('showResult', { id: task.id }));
      if (task.state === 'completed' && task.downloadKind !== 'file') add('导出清单', () => api.call('exportManifest', { id: task.id }));
      if (['completed', 'failed'].includes(task.state)) add('移除记录', () => clearHistory('all', task.id));
    }
    const lines = [task.naming && `云端兼容目录：${task.naming.cloudFolderName}；原名保存在清单，下载时恢复。`, task.nameRestoration && !task.nameRestoration.exact && `实际保存名：${task.savedName}；完整原名保留在清单。`, task.outputDir && `下载目录：${task.outputDir}`, task.cachePath && `缓存目录：${task.cachePath}`, task.share?.url && `文件夹分享：${task.share.url}${task.share.password ? ` 提取码：${task.share.password}` : ''}`, task.shareWarning, task.indexWarning].filter(Boolean);
    const key = lines.join('\n'); if (row.metadataKey !== key) { row.metadataKey = key; row.metadata.replaceChildren(...lines.map(text => make('p', 'task-detail', text))); }
  }
  if (!visible) $('tasks').append(make('div', 'empty-state', tasks.length ? '没有符合筛选条件的任务' : '暂无传输任务'));
  renderFloating();
}
function renderFloating() {
  const task = state.tasks.find(task => task.state === 'running') || state.tasks.find(task => task.id === floatingId) || state.tasks.at(-1);
  if (!task) { floatingId = null; $('floating-transfer').hidden = true; return; }
  if (floatingId !== task.id) { floatingId = task.id; floatingDismissed = null; }
  const panel = $('floating-transfer'); panel.hidden = floatingDismissed === task.id; panel.classList.toggle('minimized', floatingMinimized);
  $('floating-toggle').textContent = floatingMinimized ? '展开' : '收起'; $('floating-toggle').setAttribute('aria-expanded', String(!floatingMinimized)); $('floating-toggle').setAttribute('aria-label', floatingMinimized ? '展开传输浮窗' : '收起传输浮窗');
  $('floating-state').textContent = `${task.type === 'upload' ? '上传' : '下载'} · ${statusText(task)}`; $('floating-state').className = `task-status ${task.state}`;
  $('floating-name').textContent = task.originalName || '文件任务'; $('floating-name').title = `${task.originalName || '文件任务'} — 点击打开所在文件夹`;
  $('floating-progress').value = Math.max(0, Math.min(1, task.progress || 0)); $('floating-percent').textContent = `${Math.round($('floating-progress').value * 100)}%`;
  $('floating-message').textContent = task.message || '准备中'; $('floating-message').title = task.message || '';
  const values = taskMetrics(task); ['speed', 'elapsed', 'remaining'].forEach((key, i) => { $('floating-' + key).textContent = values[i]; $('floating-' + key).title = values[i]; });
  $('floating-bytes').textContent = `${roundedBytes(task.bytes || 0)} / ${task.downloadKind === 'file' && !task.totalKnown && task.state !== 'completed' ? '未知' : roundedBytes(task.totalBytes || task.originalSize || 0)}`;
  $('floating-action').textContent = ['running', 'queued'].includes(task.state) ? '暂停' : ['paused', 'failed'].includes(task.state) ? '继续' : '查看任务';
}
function render(next) {
  const changedView = (state.settings?.browserView || 'smart') !== (next.settings?.browserView || 'smart');
  const changedAccount = (state.account?.uid || state.account?.label) !== (next.account?.uid || next.account?.label);
  if (next.tasks.some(task => task.type === 'upload' && task.state === 'completed' && !state.tasks.some(previous => previous.id === task.id && previous.state === 'completed'))) { cloudDirty = true; cloudRevision++; }
  state = next;
  if (state.settings) {
    outputDir = state.settings.downloadDir;
    $('output-directory').textContent = outputDir; $('output-directory').title = outputDir;
    $('setting-download-dir').textContent = outputDir;
    $('setting-cache-dir').textContent = state.settings.cacheDir;
    $('auto-clean-cache').checked = state.settings.autoCleanCache;
    $('upload-concurrency').value = String(state.settings.uploadConcurrency);
    $('download-concurrency').value = $('concurrency').value = String(state.settings.downloadConcurrency);
    $('upload-concurrency-label').textContent = `上传并发 ${state.settings.uploadConcurrency} 路`;
    $('settings-warning').textContent = state.settingsWarning || ''; $('settings-warning').hidden = !state.settingsWarning;
  }
  for (const mode of ['raw', 'smart']) { $('view-' + mode).classList.toggle('selected', smartView() === (mode === 'smart')); $('view-' + mode).setAttribute('aria-pressed', String(smartView() === (mode === 'smart'))); }
  if (changedAccount) {
    resetDownloadSelection();
    if ($('cloud-dialog').open) { managementTarget = null; $('cloud-dialog').close(); }
    closeFileMenu();
    directorySnapshots.clear(); recognitionToken = null;
    recognitionRequest++; currentSlice = null;
    directoryRequest++; directoryBusy = false; directoryFiles = []; directoryPage = 0; directoryHasMore = false;
    history = [{ id: '-1', name: '根目录' }]; clearBundle();
    $('folder-path').textContent = '根目录'; $('folder-path').title = '根目录'; $('directory-status').textContent = '';
    $('recognition-status').textContent = '';
    $('folder-list').replaceChildren(make('p', 'muted', state.account ? '点击“刷新目录”读取文件。' : '登录后点击“刷新目录”。'));
    $('folder-list').setAttribute('aria-busy', 'false');
  }
  $('app-version').textContent = `v${state.version}`;
  if (changedAccount) $('account-options').open = !state.account;
  $('account-status').textContent = state.account ? `已登录 · ${state.account.label}` : '未登录';
  $('account-status').classList.toggle('connected', Boolean(state.account));
  $('remember').disabled = !state.encryptionAvailable;
  if (!state.encryptionAvailable) $('remember').checked = false;
  $('login-form').hidden = Boolean(state.account); $('logout').hidden = !state.account;
  renderTasks();
  if (changedView && !changedAccount) {
    resetDownloadSelection();
    recognitionRequest++; clearBundle();
    if (directoryPage) renderDirectory(true);
    if (smartView() && !directoryBusy && directoryPage) void identifyFolders(directoryRequest);
  }
  updateControls();
  refreshUploadedFiles();
}
function refreshUploadedFiles() {
  if (cloudDirty && state.account && !$('download-panel').hidden && !$('account-browser').hidden && history.at(-1).id === '-1' && !directoryBusy && !bundle) void run(null, () => refreshFolders());
}
function switchTab(name) {
  closeFileMenu();
  for (const item of ['upload','download','transfers','settings']) {
    $(`${item}-panel`).hidden = item !== name;
    $(`tab-${item}`).classList.toggle('active', item === name);
    $(`tab-${item}`).setAttribute('aria-selected', String(item === name));
  }
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
function downloadable(file) { return !file.isFolder || Boolean(smartView() && file.slice); }
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
  closeFileMenu();
  if (directoryPage === 1 && state.account) {
    directorySnapshots.set(history.at(-1).id, { entries: directoryFiles.map(file => ({ ...file })), hasMore: directoryHasMore, time: Date.now() });
    while (directorySnapshots.size > 32) directorySnapshots.delete(directorySnapshots.keys().next().value);
  }
  const scrollTop = append ? $('folder-list').scrollTop : 0;
  const table = make('table', 'file-table'); table.setAttribute('aria-label', '云端文件');
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
  const body = table.createTBody();
  const entries = browserEntries(), eligibleKeys = new Set(entries.map(selectionKey));
  for (const key of selectedDownloads) if (!eligibleKeys.has(key)) selectedDownloads.delete(key);
  if (!eligibleKeys.has(selectionAnchor)) selectionAnchor = null;
  for (const file of entries) {
    const row = make('tr', 'folder-row');
    row.dataset.entryId = file.id; row.dataset.entryKind = file.isFolder ? 'folder' : 'file';
    const name = make('td', 'file-name'), label = make('div', 'file-label');
    const slice = smartView() ? file.slice : null;
    const kind = slice ? 'slice' : file.isFolder ? 'folder' : file.name === 'manifest.lanzou.txt' ? 'manifest' : /\.(zip|rar|7z)$/i.test(file.name) ? 'archive' : 'file';
    const displayName = slice?.originalName || file.name;
    const text = make(slice ? 'button' : 'span', `file-name-text${slice ? ' slice-name' : ''}`, displayName); text.title = slice ? `${displayName}\n云端目录：${file.name}\n${slice.totalParts} 个切片；点击查看详情` : file.name;
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
    if (slice) {
      const preview = slice.status === 'preview';
      label.append(make('span', 'slice-badge', preview ? '快速预览' : '切片文件'));
      const caption = make('small', 'slice-caption', `${slice.cached ? (slice.stale ? '缓存预览，后台更新 · ' : '缓存预览 · ') : ''}${preview ? '下载前校验 · ' : ''}${slice.totalParts} 片 · 云端目录：${file.name}`); caption.title = caption.textContent; name.append(caption); row.classList.add('slice-folder');
    } else if (smartView() && file.isFolder && file.identification === 'unavailable') {
      const note = make('small', 'slice-caption recognition-error', `识别失败：${file.identificationMessage || '请重试'}`); note.title = note.textContent; name.append(note);
    } else if (smartView() && file.isFolder && file.identification === 'ordinary') name.append(make('small', 'slice-caption', '普通文件夹'));
    const size = make('td', 'file-size', slice ? sizes(slice.originalSize) : file.isFolder ? '—' : sizes(file.size));
    const time = make('td', 'file-time', file.modifiedTime || '—'); time.title = file.modifiedTime || '';
    const actions = make('td', 'file-actions'); row.append(name, size, time, actions);
    if (file.isFolder) {
      const button = make('button', 'text-button', slice ? '查看切片' : '进入');
      button.setAttribute('aria-label', `进入 ${displayName}`);
      button.addEventListener('click', () => run(button, async () => {
        if (slice) await setBrowserView('raw');
        if (!file.isCurrentSlice) await refreshFolders([...history, { id: file.id, name: displayName, cloudName: file.name }]);
      })); button.disabled = directoryBusy; actions.append(button);
      if (slice) {
        const select = make('button', 'text-button select-download', '下载并合并'); select.dataset.downloadSlice = 'true';
        select.setAttribute('aria-label', `下载并合并 ${displayName}`);
        select.addEventListener('click', () => run(select, () => selectSlice(file, true))); actions.append(select);
      } else if (smartView() && file.identification === 'unavailable') {
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
    body.append(row);
  }
  $('folder-list').replaceChildren(entries.length ? table : make('p', 'muted', '此目录为空。'));
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
  try { await api.call('downloadFile', { id: file.id, parentId: history.at(-1).id }); notice('普通文件下载已开始，可在右下角或“上传下载”页管理'); }
  finally { selectingBundle = false; updateControls(); }
}
async function selectSlice(file, download = false) {
  if (selectingBundle) return;
  selectingBundle = true; clearBundle(); const request = bundleRequest, directory = directoryRequest;
  try {
    const value = await api.call('inspectFolder', { folderId: file.id });
    if (request !== bundleRequest || directory !== directoryRequest) return;
    showBundle(value);
    if (download) { await api.call('download', { key: value.key, outputDir, concurrency: Number($('concurrency').value) }); notice('下载已开始，完成后自动校验并合并为原文件'); }
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
    if (smartView()) void identifyFolders(request, force);
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
  const ordinary = directoryFiles.filter(file => file.isFolder && file.identification === 'ordinary').length;
  const failed = directoryFiles.filter(file => file.identification === 'unavailable').length;
  $('recognition-status').textContent = `切片 ${recognized} · 文件夹 ${ordinary}${pending ? ` · 待识别 ${pending}` : ''}${failed ? ` · 失败 ${failed}` : ''}`;
  $('recognition-status').title = '已知原名从本机账号缓存即时显示；首次遇到的目录在后台逐项识别。普通文件夹正常进入。刷新目录可强制重新识别；下载前始终重新校验完整清单。';
}
function applyRecognition(result) {
  const file = directoryFiles.find(file => file.isFolder && String(file.id) === result.id);
  if (!file) return;
  file.identification = result.status; file.identificationMessage = result.message; file.recognitionStale = Boolean(result.stale);
  if (['ready', 'preview'].includes(result.status)) file.slice = result;
  else delete file.slice;
}
api.onRecognition(({ token, ownerUid, result }) => {
  if (!recognitionToken || token !== recognitionToken.token || String(ownerUid) !== String(state.account?.uid) || recognitionToken.request !== directoryRequest || recognitionToken.recognition !== recognitionRequest || !smartView()) return;
  applyRecognition(result); recognitionToken.pending.delete(result.id);
  renderDirectory(true); recognitionSummary(recognitionToken.pending.size);
});
async function identifyFolders(request, force = false) {
  if (!smartView() || request !== directoryRequest) return;
  const recognition = ++recognitionRequest;
  const valid = () => smartView() && request === directoryRequest && recognition === recognitionRequest;
  const folders = directoryFiles.filter(file => file.isFolder && (!file.identification || file.recognitionStale));
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
      const results = await api.call('identifyFolders', { folderIds: batch.map(file => file.id), folderNames: Object.fromEntries(batch.map(file => [file.id, file.name])), token, force });
      if (!valid()) return;
      for (const result of results) {
        applyRecognition(result); recognitionToken.pending.delete(result.id);
      }
      renderDirectory(true);
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
  source = selected; $('source-name').textContent = selected.name; $('source-path').textContent = selected.path;
  $('choose-source').classList.add('has-file'); $('source-name').title = selected.name; $('source-path').title = selected.path;
  $('source-size').textContent = sizes(selected.size); $('source-size').hidden = false; updateControls();
}
async function startUpload() {
  await api.call('upload', { path: source.path }); notice('上传任务已开始');
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
for (const id of ['transfer-type', 'transfer-state']) $(id).addEventListener('change', renderTasks);
$('pause-all').addEventListener('click', () => run($('pause-all'), () => api.call('pauseAll')));
$('download-selected').addEventListener('click', () => run($('download-selected'), downloadSelected));
$('clear-selection').addEventListener('click', () => { resetDownloadSelection(); updateSelectionControls(); });
$('floating-open').addEventListener('click', () => switchTab('transfers'));
for (const id of ['floating-name', 'floating-folder']) $(id).addEventListener('click', () => run($(id), () => api.call('showResult', { id: floatingId })));
$('show-floating').addEventListener('click', () => { floatingDismissed = null; floatingMinimized = false; renderFloating(); });
$('floating-toggle').addEventListener('click', () => { floatingMinimized = !floatingMinimized; renderFloating(); });
$('floating-close').addEventListener('click', () => { floatingDismissed = floatingId; renderFloating(); });
$('floating-action').addEventListener('click', () => run($('floating-action'), () => { const task = state.tasks.find(task => task.id === floatingId); if (task) return updateTaskAction(task); }));
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
$('refresh-cache').addEventListener('click', () => run($('refresh-cache'), refreshCache));
$('clean-cache').addEventListener('click', () => run($('clean-cache'), async () => {
  const result = await api.call('cleanCache'); await refreshCache(); notice(`已清理 ${result.files} 个缓存文件，释放 ${sizes(result.bytes)}；未完成任务的恢复数据保留`);
}));
for (const id of ['clear-history', 'clear-history-settings']) $(id).addEventListener('click', () => run($(id), () => clearHistory()));
for (const id of ['clear-all-history', 'clear-all-history-settings']) $(id).addEventListener('click', () => run($(id), () => clearHistory('all')));
$('choose-source').addEventListener('click', () => run($('choose-source'), async () => {
  const selected = await api.call('chooseSource'); if (!selected) return;
  setSource(selected);
}));
$('start-upload').addEventListener('click', () => run($('start-upload'), startUpload));
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
});
$('share-form').addEventListener('submit', event => { event.preventDefault(); void run($('share-form').querySelector('button'), async () => { clearBundle(); const request = bundleRequest; const value = await api.call('inspectShare', { url: $('share-url').value, password: $('share-password').value }); if (request === bundleRequest) showBundle(value); }); });
$('choose-directory').addEventListener('click', () => run($('choose-directory'), async () => { const selected = await api.call('chooseDirectory'); if (selected) { outputDir = selected; $('output-directory').textContent = selected; $('output-directory').title = selected; } }));
$('start-download').addEventListener('click', () => run($('start-download'), async () => { await api.call('download', { key: bundle.key, outputDir, concurrency: Number($('concurrency').value) }); notice('下载任务已开始，全部校验后将自动合并'); }));
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
    if (selectingSource) return;
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length !== 1) throw new Error('每次请拖入一个文件，暂不支持批量拖拽');
    const filePath = api.filePath(files[0]);
    if (!filePath) throw new Error('请拖入本机的实际文件，不支持网页链接或虚拟文件');
    selectingSource = true; updateControls();
    try {
      setSource(await api.call('selectSource', { path: filePath }));
      if (state.account && !state.tasks.some(task => task.state === 'running')) await startUpload();
      else notice(state.account ? '文件已选中，当前任务完成或暂停后点击上传' : '文件已选中，登录后点击上传');
    } finally { selectingSource = false; updateControls(); }
  });
});
api.onState(render);
void api.call('state').then(render).catch(error => notice(error.message, true));
