import { roundedBytes, duration } from './transfer-format.js';
import { setText } from './dom.js';

export const syncActive = rule => ['scanning', 'uploading', 'cleaning'].includes(rule.state);
export function syncProgress(rule) {
  const p = rule.progress || {}, known = Boolean(p.totalKnown), finished = rule.state === 'idle' && p.finished;
  return { known, ratio: p.ratio || 0, percent: known ? `${Math.floor((p.ratio || 0) * 100)}%` : rule.state === 'scanning' ? '扫描中' : '—',
    bytes: known ? `${roundedBytes(p.processedBytes)} / ${roundedBytes(p.totalBytes)}` : `已扫描 ${p.scannedFiles || 0} 个 · ${roundedBytes(p.scannedBytes)}`,
    detail: !known ? '正在扫描并比对，完成后显示总大小' : `已处理 ${p.processedFiles || 0}/${p.totalFiles || 0} 个 · 并行 ${p.activeFiles || 0} 个 · 上限 ${p.concurrency || 1} 路`,
    speed: roundedBytes(p.speedBytesPerSecond, true), elapsed: duration((p.elapsedMs || 0) / 1000), remaining: finished ? '00:00:00' : duration(p.remainingSeconds),
    message: rule.error || (finished ? '本轮同步完成' : rule.state === 'cleaning' ? '正在检查删除并清理旧版' : rule.state === 'queued' ? '等待传输队列空闲' : rule.currentFile || '等待下次同步') };
}

export function createSyncUI({ api, run, notice, make, getState }) {
  const $ = id => document.getElementById(id);
  let editing = null, target = { id: '-1', name: '根目录' }, lastOwner;
  const cards = new Map();
  let targetHistory = [], targetPage = 0, targetBusy = false, targetRequest = 0, resolveConfirm;
  const date = time => time ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '尚未执行';
  const states = { idle: '等待计划', queued: '等待空闲', scanning: '扫描比对', uploading: '同步上传', cleaning: '清理旧版', error: '需要重试', paused: '已暂停' };
  function scheduleFields() {
    const daily = $('sync-schedule').value === 'daily';
    $('sync-interval-field').hidden = daily; $('sync-minutes').disabled = daily; $('sync-minutes').required = !daily;
    $('sync-daily-field').hidden = !daily; $('sync-times').required = daily;
  }
  function confirm(title, message) {
    $('sync-confirm-title').textContent = title; $('sync-confirm-text').textContent = message; $('sync-confirm-dialog').showModal();
    return new Promise(resolve => { resolveConfirm = resolve; });
  }
  $('sync-confirm-cancel').onclick = () => $('sync-confirm-dialog').close('cancel');
  $('sync-confirm-ok').onclick = () => $('sync-confirm-dialog').close('ok');
  $('sync-confirm-dialog').addEventListener('close', () => { resolveConfirm?.($('sync-confirm-dialog').returnValue === 'ok'); resolveConfirm = null; });
  function reset() {
    editing = null; target = { id: '-1', name: '根目录' }; $('sync-form').reset();
    $('sync-path').disabled = false; $('sync-target').textContent = '根目录 / 本规则专用目录';
    $('sync-editor-title').textContent = '新建同步规则'; $('sync-save').textContent = '保存规则'; $('sync-cancel').hidden = true;
    scheduleFields(); controls();
  }
  function controls() {
    const logged = Boolean(getState().account), warning = getState().sync?.warning;
    for (const id of ['sync-save', 'sync-pick-file', 'sync-pick-folder', 'sync-pick-target']) $(id).disabled = !logged || Boolean(warning) || Boolean(editing && id !== 'sync-save');
  }
  function edit(rule) {
    editing = rule.id; target = { id: rule.parentId, name: rule.parentId === '-1' ? '根目录' : `云端目录 ${rule.parentId}` };
    $('sync-name').value = rule.name; $('sync-path').value = rule.sourcePath; $('sync-path').disabled = true;
    $('sync-target').textContent = `${target.name} / 本规则专用目录`;
    $('sync-schedule').value = rule.schedule.kind; $('sync-minutes').value = rule.schedule.minutes || 30; $('sync-times').value = (rule.schedule.times || []).join(', ');
    $('sync-enabled').checked = rule.enabled; $('sync-delete').checked = rule.deleteRemoved;
    $('sync-editor-title').textContent = '编辑同步规则'; $('sync-save').textContent = '保存修改'; $('sync-cancel').hidden = false; $('sync-editor').open = true;
    scheduleFields(); controls(); $('sync-editor').scrollIntoView({ block: 'start' }); $('sync-name').focus();
  }
  $('sync-cancel').onclick = reset; $('sync-schedule').onchange = scheduleFields;
  for (const [id, kind] of [['sync-pick-file', 'file'], ['sync-pick-folder', 'directory']]) $(id).onclick = () => run($(id), async () => {
    const source = await api.call('chooseSyncSource', { kind }); if (source) $('sync-path').value = source;
  });
  $('sync-form').addEventListener('submit', event => {
    event.preventDefault(); void run($('sync-save'), async () => {
      const old = getState().sync?.rules.find(rule => rule.id === editing);
      if ($('sync-delete').checked && !old?.deleteRemoved && !await confirm('启用同步删除？', '此后本地移除文件时，将删除这条规则管理的对应云端版本。其他规则和手动上传内容不受影响。')) return;
      const schedule = $('sync-schedule').value === 'daily' ? { kind: 'daily', times: $('sync-times').value.split(/[,，\s]+/).filter(Boolean) } : { kind: 'interval', minutes: Number($('sync-minutes').value) };
      await api.call('saveSync', { ...(editing ? { id: editing } : {}), name: $('sync-name').value, sourcePath: $('sync-path').value, parentId: target.id, schedule, enabled: $('sync-enabled').checked, deleteRemoved: $('sync-delete').checked });
      reset(); $('sync-editor').open = false; notice('规则已保存，将按设定时间执行；也可点击“立即同步”。');
    });
  });
  async function loadTarget(next, append = false) {
    const request = ++targetRequest; targetBusy = true; $('sync-target-use').disabled = true; $('sync-target-up').disabled = true; $('sync-target-more').disabled = true;
    try {
      const page = await api.call('listPage', { folderId: next.at(-1).id, page: append ? targetPage + 1 : 1 });
      if (request !== targetRequest) return;
      targetHistory = next; targetPage = page.page; $('sync-target-path').textContent = next.map(entry => entry.name).join(' / ');
      if (!append) $('sync-target-folders').replaceChildren();
      for (const entry of page.entries.filter(entry => entry.isFolder)) {
        const button = make('button', 'secondary sync-folder-choice', entry.name); button.type = 'button'; button.title = entry.name;
        button.onclick = () => { if (!targetBusy) void run(button, () => loadTarget([...targetHistory, entry])); }; $('sync-target-folders').append(button);
      }
      if (!$('sync-target-folders').children.length) $('sync-target-folders').append(make('p', 'muted small', '此目录暂无子文件夹'));
      $('sync-target-more').hidden = !page.hasMore;
    } finally {
      if (request === targetRequest) { targetBusy = false; $('sync-target-use').disabled = false; $('sync-target-up').disabled = targetHistory.length <= 1; $('sync-target-more').disabled = false; }
    }
  }
  $('sync-pick-target').onclick = () => run($('sync-pick-target'), async () => { $('sync-target-dialog').showModal(); targetHistory = []; await loadTarget([{ id: '-1', name: '根目录' }]); });
  $('sync-target-up').onclick = () => run($('sync-target-up'), () => loadTarget(targetHistory.slice(0, -1)));
  $('sync-target-more').onclick = () => run($('sync-target-more'), () => loadTarget(targetHistory, true));
  $('sync-target-close').onclick = () => $('sync-target-dialog').close();
  $('sync-target-use').onclick = () => { if (!targetHistory.length || targetBusy) return; target = targetHistory.at(-1); $('sync-target').textContent = targetHistory.map(entry => entry.name).join(' / ') + ' / 本规则专用目录'; $('sync-target-dialog').close(); };
  function refreshProgress(rules) {
    const byId = new Map(rules.map(rule => [rule.id, rule]));
    for (const card of $('sync-rules').children) {
      const rule = byId.get(card.dataset.syncId); if (!rule) continue;
      const schedule = rule.schedule.kind === 'daily' ? `每天 ${rule.schedule.times.join('、')}` : `每 ${rule.schedule.minutes} 分钟`;
      setText(card.querySelector('.sync-rule-details'), `${schedule} · 已管理 ${rule.managedFiles} 个文件 · ${rule.deleteRemoved ? '同步删除已开启' : '保留本地已删除的云端文件'}`);
      setText(card.querySelector('.sync-rule-next'), `上次执行：${date(rule.lastRun)}　下次：${rule.enabled ? date(rule.nextRun) : '已停用'}`);
      const stats = rule.stats;
      setText(card.querySelector('.sync-result'), stats ? `新增 ${stats.added} · 更新 ${stats.updated} · 跳过 ${stats.skipped} · 删除 ${stats.deleted} · 失败 ${stats.failed}${rule.cleanupCount ? ` · 待清理旧版 ${rule.cleanupCount}` : ''}` : '等待首次比对');
      const current = card.querySelector('.sync-current-file');
      setText(current, rule.currentFile ? `${states[rule.state]}：${rule.currentFile}` : rule.error || (rule.lastSuccess ? `最近成功：${date(rule.lastSuccess)}` : '首次按计划同步，或点击立即同步'));
      current.classList.toggle('sync-error', Boolean(rule.error));
      if (!rule.progress) continue;
      const values = syncProgress(rule), bar = card.querySelector('progress');
      if (values.known) { if (bar.value !== values.ratio) bar.value = values.ratio; } else if (bar.hasAttribute('value')) bar.removeAttribute('value');
      setText(card.querySelector('.transfer-progress>span'), values.percent);
      const size = card.querySelector('.sync-progress-size');
      setText(size, `已处理 / 总大小：${values.bytes}`);
      const title = `整轮源文件大小，包含跳过的不变文件；本轮需上传 ${roundedBytes(rule.progress.uploadBytes)}，跳过 ${roundedBytes(rule.progress.skippedBytes)}`;
      if (size.title !== title) size.title = title;
      setText(card.querySelector('.sync-progress-detail'), values.detail);
      card.querySelectorAll('.transfer-metrics strong').forEach((node, i) => setText(node, [values.speed, values.elapsed, values.remaining][i]));
    }
  }
  function render(state) {
    const owner = state.account?.uid;
    if (lastOwner !== owner) { lastOwner = owner; reset(); $('sync-target-dialog').close(); $('sync-confirm-dialog').close('cancel'); targetRequest++; cards.clear(); $('sync-rules').replaceChildren(); }
    controls(); setText($('sync-warning'), state.sync?.warning || ''); $('sync-warning').hidden = !state.sync?.warning;
    if ($('sync-panel').hidden || document.hidden) return;
    const rules = state.sync?.rules || [], ids = new Set(rules.map(rule => rule.id));
    for (const [id, item] of cards) if (!ids.has(id)) { item.root.remove(); cards.delete(id); }
    setText($('sync-count'), `${rules.length} 条`);
    if (rules.length) $('sync-rules').querySelector('.empty-state')?.remove();
    else if (!$('sync-rules').querySelector('.empty-state')) $('sync-rules').append(make('p', 'empty-state', owner ? '还没有规则，选择路径并保存后开始' : '登录后创建第一条同步规则'));
    for (const [index, rule] of rules.entries()) {
      const key = JSON.stringify([rule.name, rule.sourcePath, rule.parentId, rule.schedule, rule.enabled, rule.deleteRemoved, rule.state, Boolean(rule.progress)]);
      const old = cards.get(rule.id);
      if (old?.key === key) { if ($('sync-rules').children[index] !== old.root) $('sync-rules').insertBefore(old.root, $('sync-rules').children[index] || null); continue; }
      old?.root.remove();
      const currentRule = () => getState().sync?.rules.find(item => item.id === rule.id);
      const card = make('article', 'sync-rule'); card.dataset.syncId = rule.id;
      const heading = make('div', 'sync-rule-heading'), title = make('h3', '', rule.name), status = make('span', 'sync-badge', !rule.enabled && !['scanning', 'uploading', 'cleaning'].includes(rule.state) ? '已停用' : states[rule.state] || rule.state); heading.append(title, status);
      const source = make('p', 'sync-rule-path', rule.sourcePath); source.title = rule.sourcePath;
      const schedule = rule.schedule.kind === 'daily' ? `每天 ${rule.schedule.times.join('、')}` : `每 ${rule.schedule.minutes} 分钟`;
      const details = make('p', 'muted small sync-rule-details', `${schedule} · 已管理 ${rule.managedFiles} 个文件 · ${rule.deleteRemoved ? '同步删除已开启' : '保留本地已删除的云端文件'}`);
      const next = make('p', 'muted small sync-rule-next', `上次执行：${date(rule.lastRun)}　下次：${rule.enabled ? date(rule.nextRun) : '已停用'}`);
      const progress = make('p', 'small sync-current-file', rule.currentFile ? `${states[rule.state]}：${rule.currentFile}` : rule.error || (rule.lastSuccess ? `最近成功：${date(rule.lastSuccess)}` : '首次按计划同步，或点击立即同步'));
      progress.classList.toggle('sync-error', Boolean(rule.error));
      const stats = rule.stats, result = make('p', 'sync-result small', stats ? `新增 ${stats.added} · 更新 ${stats.updated} · 跳过 ${stats.skipped} · 删除 ${stats.deleted} · 失败 ${stats.failed}${rule.cleanupCount ? ` · 待清理旧版 ${rule.cleanupCount}` : ''}` : '等待首次比对');
      const buttons = make('div', 'sync-rule-actions'), active = syncActive(rule);
      const add = (label, action, disabled = false) => { const button = make('button', 'secondary compact', label); button.disabled = disabled; button.onclick = () => run(button, action); buttons.append(button); };
      add(rule.state === 'queued' ? '等待空闲…' : '立即同步', () => api.call('runSync', { id: rule.id }), active || rule.state === 'queued');
      add(active || rule.enabled ? '暂停规则' : '启用规则', () => api.call('toggleSync', { id: rule.id, enabled: !active && !rule.enabled }));
      add('编辑', () => { const latest = currentRule(); if (latest) edit(latest); }, active);
      add('移除', async () => { if (await confirm('移除同步规则？', `移除“${rule.name}”并停止后续同步，已上传的云端内容保留。`)) { await api.call('removeSync', { id: rule.id }); if (editing === rule.id) reset(); } }, active);
      card.append(heading, source, details, next, progress);
      if (rule.progress) {
        const values = syncProgress(rule), group = make('div', 'sync-progress'), row = make('div', 'transfer-progress'), bar = make('progress'), percent = make('span', '', values.percent);
        bar.max = 1; if (values.known) bar.value = values.ratio; bar.setAttribute('aria-label', `${rule.name}整轮同步进度`); row.append(bar, percent);
        const size = make('p', 'sync-progress-size small', `已处理 / 总大小：${values.bytes}`); size.title = `整轮源文件大小，包含跳过的不变文件；本轮需上传 ${roundedBytes(rule.progress.uploadBytes)}，跳过 ${roundedBytes(rule.progress.skippedBytes)}`;
        const metrics = make('div', 'transfer-metrics');
        for (const [label, value] of [['上传速度', values.speed], ['已用时间', values.elapsed], ['预计剩余', values.remaining]]) { const cell = make('div'); cell.append(make('small', '', label), make('strong', '', value)); metrics.append(cell); }
        group.append(row, size, make('p', 'small muted sync-progress-detail', values.detail), metrics); card.append(group);
      }
      card.append(result, buttons); $('sync-rules').insertBefore(card, $('sync-rules').children[index] || null); cards.set(rule.id, { key, root: card });
    }
    refreshProgress(rules);
  }
  scheduleFields(); return { render };
}
