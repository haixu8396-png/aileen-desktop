// Elysia — 预加载脚本（contextBridge 暴露安全 API）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  listModels: () => ipcRenderer.invoke('models:list'),
  addModelFolder: () => ipcRenderer.invoke('models:addFolder'),
  addModelUrl: (payload) => ipcRenderer.invoke('models:addUrl', payload),
  removeModelUrl: (url) => ipcRenderer.invoke('models:removeUrl', url),
  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  listCharacters: () => ipcRenderer.invoke('characters:list'),
  writeCharacter: (file, data, mode) => ipcRenderer.invoke('characters:write', { file, data, mode }),
  deleteCharacter: (file) => ipcRenderer.invoke('characters:delete', file),
  chooseAvatar: () => ipcRenderer.invoke('characters:chooseAvatar'),
  exportCharacter: (data) => ipcRenderer.invoke('characters:export', data),
  importCharacter: () => ipcRenderer.invoke('characters:import'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  readChat: (file) => ipcRenderer.invoke('chat:read', file),
  saveChat: (file, messages) => ipcRenderer.invoke('chat:write', { file, messages }),
  clearChat: (file) => ipcRenderer.invoke('chat:clear', file),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
});
