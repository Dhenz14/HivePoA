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
  // Auth
  getAuthToken: () => ipcRenderer.invoke('get-api-auth-token'),
  // Keychain auth
  openKeychainAuth: () => ipcRenderer.invoke('open-keychain-auth'),
  // GPU Contribution
  gpuGetStatus: () => ipcRenderer.invoke('gpu-get-status'),
  gpuStart: () => ipcRenderer.invoke('gpu-start'),
  gpuStop: () => ipcRenderer.invoke('gpu-stop'),
  gpuPause: () => ipcRenderer.invoke('gpu-pause'),
  gpuResume: () => ipcRenderer.invoke('gpu-resume'),
  gpuGamingMode: () => ipcRenderer.invoke('gpu-gaming-mode'),
  gpuUpdateConfig: (updates: Record<string, unknown>) => ipcRenderer.invoke('gpu-update-config', updates),
  // GPU event listeners
  onGpuNotification: (callback: (data: { type: string; message: string }) => void) => {
    ipcRenderer.on('gpu-notification', (_event, data) => callback(data));
  },
  onGpuStateChange: (callback: (data: { from: string; to: string }) => void) => {
    ipcRenderer.on('gpu-state-change', (_event, data) => callback(data));
  },
});
