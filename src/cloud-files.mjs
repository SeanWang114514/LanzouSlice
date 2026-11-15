import { LanzouError } from './lanzou.mjs';

export class CloudFiles {
  constructor({ client, engine, recognition, version = () => client.uid, cancelReads = () => {} }) {
    this.client = client; this.engine = engine; this.recognition = recognition;
    this.version = version; this.cancelReads = cancelReads; this.busy = false;
  }
  account() {
    if (!this.client.loggedIn) throw new LanzouError('请先登录蓝奏云', 'AUTH_EXPIRED');
    return this.version();
  }
  check(version) {
    if (version !== this.version() || !this.client.loggedIn) throw new Error('账号已变化，请重新读取目录');
  }
  async entry({ parentId, id, isFolder }) {
    const version = this.account();
    if (!/^(?:-1|\d+)$/.test(String(parentId)) || !/^\d+$/.test(String(id)) || typeof isFolder !== 'boolean') throw new Error('文件参数无效');
    const files = await this.client.list(String(parentId)); this.check(version);
    const entry = files.find(file => file.id === String(id) && file.isFolder === isFolder);
    if (!entry) throw new Error('文件已被移动或删除，请刷新目录后重试');
    return entry;
  }
  async downloadSelection(items) {
    const version = this.account();
    if (!Array.isArray(items) || !items.length || items.length > 200) throw new Error('每批请选择 1–200 个文件');
    const keys = new Set(), parents = new Map();
    for (const item of items) {
      if (!item || !/^(?:-1|\d+)$/.test(String(item.parentId)) || !/^\d+$/.test(String(item.id)) || typeof item.isFolder !== 'boolean') throw new Error('所选文件参数无效');
      const key = `${item.parentId}:${item.isFolder}:${item.id}`;
      if (keys.has(key)) throw new Error('所选文件重复，请重新选择');
      keys.add(key); parents.set(String(item.parentId), null);
    }
    for (const parent of parents.keys()) { parents.set(parent, await this.client.list(parent)); this.check(version); }
    return items.map(item => {
      const entry = parents.get(String(item.parentId)).find(file => file.id === String(item.id) && file.isFolder === item.isFolder);
      if (!entry) throw new Error('所选文件已被移动或删除，请刷新目录后重试');
      return { ...entry, parentId: String(item.parentId), ...(entry.isFolder ? { slice: this.recognition.get(this.client.uid, entry.id, entry.name) } : {}) };
    });
  }
  async change(action, payload) {
    if (this.engine.syncOwner) throw new Error('自动同步正在运行，请先暂停规则再管理云端文件');
    const version = this.account(), ownerUid = this.client.uid;
    if (!['create', 'rename', 'delete'].includes(action)) throw new Error('未知文件管理操作');
    if (this.busy) throw new Error('正在处理网盘操作，请稍候');
    this.busy = true;
    try {
      if (!/^(?:-1|\d+)$/.test(String(payload.parentId))) throw new Error('上级目录无效');
      const entry = action === 'create' ? null : await this.entry(payload);
      this.check(version);
      if (entry && [...this.engine.active.keys()].some(id => {
        const task = this.engine.tasks.get(id);
        return task?.ownerUid === ownerUid && (entry.isFolder || task.folderId === entry.parentId || task.source?.folderId === entry.parentId || task.source?.file?.id === entry.id);
      })) throw new Error('此操作可能影响当前传输，请先暂停任务后再管理云端文件');
      const name = String(payload.name ?? '').trim();
      if (action !== 'delete' && (!name || name.length > 255 || /[\x00-\x1f/\\]/.test(name) || ['.', '..'].includes(name))) throw new Error('名称不能为空、超过 255 个字符或包含路径分隔符');
      this.cancelReads();
      let id = entry?.id;
      if (action === 'create') id = await this.client.createFolder(name, undefined, String(payload.parentId));
      else if (action === 'rename') await this.client.renameEntry(entry.id, entry.isFolder, name);
      else await this.client.deleteEntry(entry.id, entry.isFolder);
      this.check(version);
      this.recognition.forget(ownerUid, String(payload.parentId));
      if (entry?.isFolder) this.recognition.forget(ownerUid, entry.id);
      await this.recognition.save().catch(() => {});
      return { id, name: action === 'delete' ? entry.name : name };
    } finally { this.busy = false; }
  }
}
