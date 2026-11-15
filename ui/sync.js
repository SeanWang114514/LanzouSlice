export function createSyncUI({ api, run, notice, make, getState }) {
  const $ = id => document.getElementById(id);
  let editing = null, target = { id: '-1', name: '根目录' }, lastKey = '', lastOwner;
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
  function render(state) {
    const owner = state.account?.uid;
    if (lastOwner !== owner) { lastOwner = owner; reset(); $('sync-target-dialog').close(); $('sync-confirm-dialog').close('cancel'); targetRequest++; }
    controls(); $('sync-warning').textContent = state.sync?.warning || ''; $('sync-warning').hidden = !state.sync?.warning;
    const rules = state.sync?.rules || [], key = JSON.stringify(rules); if (key === lastKey) return; lastKey = key;
    $('sync-count').textContent = `${rules.length} 条`; $('sync-rules').replaceChildren();
    if (!rules.length) $('sync-rules').append(make('p', 'empty-state', owner ? '还没有规则，选择路径并保存后开始' : '登录后创建第一条同步规则'));
    for (const rule of rules) {
      const card = make('article', 'sync-rule'); card.dataset.syncId = rule.id;
      const heading = make('div', 'sync-rule-heading'), title = make('h3', '', rule.name), status = make('span', 'sync-badge', !rule.enabled && !['scanning', 'uploading', 'cleaning'].includes(rule.state) ? '已停用' : states[rule.state] || rule.state); heading.append(title, status);
      const source = make('p', 'sync-rule-path', rule.sourcePath); source.title = rule.sourcePath;
      const schedule = rule.schedule.kind === 'daily' ? `每天 ${rule.schedule.times.join('、')}` : `每 ${rule.schedule.minutes} 分钟`;
      const details = make('p', 'muted small', `${schedule} · 已管理 ${rule.managedFiles} 个文件 · ${rule.deleteRemoved ? '同步删除已开启' : '保留本地已删除的云端文件'}`);
      const next = make('p', 'muted small', `上次执行：${date(rule.lastRun)}　下次：${rule.enabled ? date(rule.nextRun) : '已停用'}`);
      const progress = make('p', 'small', rule.currentFile ? `${states[rule.state]}：${rule.currentFile}` : rule.error || (rule.lastSuccess ? `最近成功：${date(rule.lastSuccess)}` : '首次按计划同步，或点击立即同步'));
      progress.classList.toggle('sync-error', Boolean(rule.error));
      const stats = rule.stats, result = make('p', 'sync-result small', stats ? `新增 ${stats.added} · 更新 ${stats.updated} · 跳过 ${stats.skipped} · 删除 ${stats.deleted} · 失败 ${stats.failed}${rule.cleanupCount ? ` · 待清理旧版 ${rule.cleanupCount}` : ''}` : '等待首次比对');
      const buttons = make('div', 'sync-rule-actions'), active = ['scanning', 'uploading', 'cleaning'].includes(rule.state);
      const add = (label, action, disabled = false) => { const button = make('button', 'secondary compact', label); button.disabled = disabled; button.onclick = () => run(button, action); buttons.append(button); };
      add(rule.state === 'queued' ? '等待空闲…' : '立即同步', () => api.call('runSync', { id: rule.id }), active || rule.state === 'queued');
      add(active || rule.enabled ? '暂停规则' : '启用规则', () => api.call('toggleSync', { id: rule.id, enabled: !active && !rule.enabled }));
      add('编辑', () => edit(rule), active);
      add('移除', async () => { if (await confirm('移除同步规则？', `移除“${rule.name}”并停止后续同步，已上传的云端内容保留。`)) { await api.call('removeSync', { id: rule.id }); if (editing === rule.id) reset(); } }, active);
      card.append(heading, source, details, next, progress, result, buttons); $('sync-rules').append(card);
    }
  }
  scheduleFields(); return { render };
}
