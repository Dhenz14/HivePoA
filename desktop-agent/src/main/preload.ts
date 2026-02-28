import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('spkAgent', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (cfg: Record<string, unknown>) => ipcRenderer.invoke('set-config', cfg),
  getEarnings: () => ipcRenderer.invoke('get-earnings'),
  // P2P
  getPeers: () => ipcRenderer.invoke('get-peers'),
  getValidationStats: () => ipcRenderer.invoke('get-validation-stats'),
  hasPostingKey: () => ipcRenderer.invoke('has-posting-key'),
  setPostingKey: (key: string) => ipcRenderer.invoke('set-posting-key', key),
  clearPostingKey: () => ipcRenderer.invoke('clear-posting-key'),
  // Keychain auth
  openKeychainAuth: () => ipcRenderer.invoke('open-keychain-auth'),
});
