const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  listLocal: (dshHome) => ipcRenderer.invoke('local:list', dshHome),
  listRemote: (cfg) => ipcRenderer.invoke('remote:list', cfg),
  doctor: (cfg) => ipcRenderer.invoke('doctor', cfg),
  backup: (cfg) => ipcRenderer.invoke('backup', cfg),
  restore: (cfg, cwd) => ipcRenderer.invoke('restore', cfg, cwd),
  appInfo: () => ipcRenderer.invoke('app:info'),
  listTrash: (dshHome) => ipcRenderer.invoke('trash:list', dshHome),
  onEvent: (fn) => {
    const h = (_e, evt) => fn(evt);
    ipcRenderer.on('sync:event', h);
    return () => ipcRenderer.removeListener('sync:event', h);
  },
});
