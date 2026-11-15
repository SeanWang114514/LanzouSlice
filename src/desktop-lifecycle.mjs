export class DesktopLifecycle {
  constructor({ app, window, Tray, Menu, icon, storage, isQuitting, loginItems = app, startupSupported = process.platform === 'win32' && app.isPackaged }) {
    Object.assign(this, { app, window, Tray, Menu, icon, storage, isQuitting, loginItems, startupSupported });
    this.loginOptions = { name: 'LanzouSlice', path: process.execPath, args: ['--autostart'] };
    this.queue = Promise.resolve(); this.warning = ''; this.endingSession = false;
    window.on('close', event => {
      if (!isQuitting() && !this.endingSession && storage.settings.closeToTray) {
        try { this.ensureTray(); event.preventDefault(); window.hide(); }
        catch (error) { this.warning = `无法隐藏到托盘，将正常退出：${error.message}`; }
      }
    });
    window.on('query-session-end', () => { this.endingSession = true; });
  }
  show(settings = false) {
    if (this.window.isDestroyed()) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show(); this.window.focus();
    if (settings) this.window.webContents.send('app:open-settings');
  }
  ensureTray() {
    if (this.tray && !this.tray.isDestroyed()) return;
    const tray = new this.Tray(this.icon);
    try {
      tray.setToolTip('蓝奏切片');
      this.menu = this.Menu.buildFromTemplate([
        { id: 'show-main', label: '显示主窗口', click: () => this.show() },
        { id: 'open-settings', label: '打开设置', click: () => this.show(true) },
        { type: 'separator' },
        { id: 'quit-app', label: '退出软件', click: () => this.app.quit() }
      ]);
      tray.setContextMenu(this.menu);
      tray.on('click', () => this.show()); tray.on('double-click', () => this.show());
      this.tray = tray;
    } catch (error) { tray.destroy(); throw error; }
  }
  apply(settings = this.storage.settings) {
    if (settings.startHidden || settings.closeToTray) this.ensureTray();
    else if (this.tray) {
      if (!this.window.isDestroyed() && !this.window.isVisible()) this.show();
      this.destroy();
    }
  }
  initialize() {
    try { this.apply(); }
    catch (error) { this.warning = `托盘不可用，已显示主窗口：${error.message}`; }
    if (this.startupSupported && this.storage.settings.openAtLogin) {
      try {
        const actual = this.getLoginItemSettings();
        if (!actual.openAtLogin || actual.executableWillLaunchAtLogin === false) this.warning ||= 'Windows 启动项未生效或程序位置已变化，请在设置中重新开启开机自启，并检查系统启动应用。';
      } catch (error) { this.warning ||= `无法读取开机启动项：${error.message}`; }
    }
  }
  getLoginItemSettings() {
    // Electron's top-level openAtLogin checks AppUserModelID, not our custom name.
    // launchItems filters by executable path; its args omits switches such as --autostart.
    const { launchItems } = this.loginItems.getLoginItemSettings(this.loginOptions);
    const item = launchItems.find(item => item.name === this.loginOptions.name && item.scope === 'user');
    return { openAtLogin: Boolean(item), executableWillLaunchAtLogin: Boolean(item?.enabled) };
  }
  setOpenAtLogin(value, enabled = value) {
    this.loginItems.setLoginItemSettings({ ...this.loginOptions, openAtLogin: value, enabled });
    const actual = this.getLoginItemSettings();
    if (actual.openAtLogin !== value || value && enabled && actual.executableWillLaunchAtLogin === false) throw new Error('Windows 未应用开机自启设置，请检查系统启动应用或权限');
  }
  configure(patch) {
    const work = this.queue.catch(() => {}).then(async () => {
      for (const key of ['openAtLogin', 'startHidden', 'closeToTray']) if (Object.hasOwn(patch, key) && typeof patch[key] !== 'boolean') throw new Error('启动与托盘设置必须为开关值');
      const changesLogin = Object.hasOwn(patch, 'openAtLogin');
      if (changesLogin && !this.startupSupported) throw new Error('开机自启仅支持 Windows 便携成品版，请在打包后的程序中设置');
      const previous = { ...this.storage.settings }; let loginChanged = false, previousLogin;
      try {
        if (patch.startHidden || patch.closeToTray) this.ensureTray();
        if (changesLogin) {
          previousLogin = this.getLoginItemSettings();
          loginChanged = true; this.setOpenAtLogin(patch.openAtLogin);
        }
        await this.storage.configure(patch); this.apply(); if (changesLogin) this.warning = '';
      } catch (error) {
        if (loginChanged) {
          try { this.setOpenAtLogin(previousLogin.openAtLogin, previousLogin.executableWillLaunchAtLogin); }
          catch (restoreError) { this.warning = `开机启动项恢复失败，请检查 Windows 启动应用：${restoreError.message}`; }
        }
        this.apply(previous); throw error;
      }
    });
    this.queue = work; return work;
  }
  destroy() { this.tray?.destroy(); this.tray = null; this.menu = null; }
}
