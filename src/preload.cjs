const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('lanzou', {
  filePath(file) {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  async call(action, payload = {}) {
    const result = await ipcRenderer.invoke('app:command', { action, payload });
    if (!result.ok) { const error = new Error(result.error); error.code = result.code; throw error; }
    return result.value;
  },
  onState(callback) {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('app:state', handler);
    return () => ipcRenderer.removeListener('app:state', handler);
  },
  onRecognition(callback) {
    const handler = (_event, result) => callback(result);
    ipcRenderer.on('app:recognition', handler);
    return () => ipcRenderer.removeListener('app:recognition', handler);
  }
});
