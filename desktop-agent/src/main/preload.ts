import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('spkAgent', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (cfg: Record<string, unknown>) => ipcRenderer.invoke('set-config', cfg),
  getEarnings: () => ipcRenderer.invoke('get-earnings'),
});
