// AILEEN — 预加载脚本（contextBridge 暴露安全 API）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  listModels: () => ipcRenderer.invoke('models:list'),
  addModelFolder: () => ipcRenderer.invoke('models:addFolder'),
  addModelUrl: (payload) => ipcRenderer.invoke('models:addUrl', payload),
  removeModelUrl: (url) => ipcRenderer.invoke('models:removeUrl', url),
  deleteModel: (target) => ipcRenderer.invoke('models:delete', target),
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
  // 清除密钥的哨兵值：表单留空 = 保持原样，要清除必须显式送这个
  SECRET_CLEAR: '__AILEEN_CLEAR_SECRET__',

  // ---- AI 网络请求（都由主进程发出，API Key 不经过渲染层）----
  llmStream: (payload) => ipcRenderer.invoke('llm:stream', payload),
  llmAbort: (requestId) => ipcRenderer.invoke('llm:abort', requestId),
  llmListModels: (payload) => ipcRenderer.invoke('llm:listModels', payload),
  llmTest: (payload) => ipcRenderer.invoke('llm:test', payload),
  ttsFetchAudio: (payload) => ipcRenderer.invoke('tts:fetchAudio', payload),
  ttsListVoices: (payload) => ipcRenderer.invoke('tts:listVoices', payload),
  sttTranscribe: (payload) => ipcRenderer.invoke('stt:transcribe', payload),
  sttListModels: (payload) => ipcRenderer.invoke('stt:listModels', payload),

  // ---- 嵌入模型（长期记忆 / 知识库的语义检索，与对话用的 Key 分开）----
  embeddingListModels: (payload) => ipcRenderer.invoke('embedding:listModels', payload),
  embeddingTest: (payload) => ipcRenderer.invoke('embedding:test', payload),
  // 渲染层只送文本、拿回向量 —— 嵌入模型的 Key 不出主进程
  embeddingEmbed: (payload) => ipcRenderer.invoke('embedding:embed', payload),

  // ---- 记忆库 / 知识库的存储通道（主进程只放行 memory/ 与 knowledge/ 两个目录）----
  storeRoots: () => ipcRenderer.invoke('store:roots'),
  storeFs: (payload) => ipcRenderer.invoke('store:fs', payload),
  onLlmChunk: (cb) => {
    const fn = (_e, msg) => cb(msg);
    ipcRenderer.on('llm:chunk', fn);
    return () => ipcRenderer.removeListener('llm:chunk', fn);
  },

  // ---- Agent（Coding Agent）----
  // 工具能力全部在主进程执行，渲染层只说「要做什么」；
  // 目录项以 { name, isDirectory } 返回（Dirent 的方法跨 IPC 会丢）。
  agentWorkspace: () => ipcRenderer.invoke('agent:workspace'),
  agentCursor: () => ipcRenderer.invoke('agent:cursor'),
  agentWindow: (payload) => ipcRenderer.invoke('agent:window', payload),
  agentOpen: (payload) => ipcRenderer.invoke('agent:open', payload),
  agentInput: (payload) => ipcRenderer.invoke('agent:input', payload),
  agentFs: (payload) => ipcRenderer.invoke('agent:fs', payload),
  agentExec: (payload) => ipcRenderer.invoke('agent:exec', payload),
  agentGit: (payload) => ipcRenderer.invoke('agent:git', payload),
  agentScreenshot: (payload) => ipcRenderer.invoke('agent:screenshot', payload),

  // ---- 无边框悬浮展台 ----
  overlayStatus: () => ipcRenderer.invoke('overlay:status'),
  overlayToggle: () => ipcRenderer.invoke('overlay:toggle'),
  overlayHide: () => ipcRenderer.invoke('overlay:hide'),
  overlaySetModel: (model) => ipcRenderer.invoke('overlay:setModel', model),
  overlaySetHitArea: (rect) => ipcRenderer.invoke('overlay:hitArea', rect),
  overlaySetIgnore: (ignore) => ipcRenderer.invoke('overlay:setIgnore', ignore),
  overlaySetInteractive: (on) => ipcRenderer.invoke('overlay:interactive', on),
  overlayResize: (payload) => ipcRenderer.invoke('overlay:resize', payload),
  overlayGetState: () => ipcRenderer.invoke('overlay:getState'),
  overlayDragStart: () => ipcRenderer.invoke('overlay:dragStart'),
  overlayDragMove: () => ipcRenderer.invoke('overlay:dragMove'),
  overlayDragEnd: () => ipcRenderer.invoke('overlay:dragEnd'),
  overlayReset: () => ipcRenderer.invoke('overlay:reset'),
  onMenuAction: (cb) => ipcRenderer.on('menu:action', (_e, action) => cb(action)),
  // ---- Minecraft 伙伴 ----
  mcConnect: (opts) => ipcRenderer.invoke('mc:connect', opts),
  mcDisconnect: () => ipcRenderer.invoke('mc:disconnect'),
  mcStatus: () => ipcRenderer.invoke('mc:status'),
  mcSay: (text) => ipcRenderer.invoke('mc:say', text),
  mcFollow: (name) => ipcRenderer.invoke('mc:follow', name),
  mcStopFollow: () => ipcRenderer.invoke('mc:stopFollow'),
  mcStep: (payload) => ipcRenderer.invoke('mc:step', payload),
  mcJump: () => ipcRenderer.invoke('mc:jump'),
  onMcEvent: (cb) => ipcRenderer.on('mc:event', (_e, ev) => cb(ev)),

  onOverlayState: (cb) => ipcRenderer.on('overlay:state', (_e, st) => cb(st)),
  onOverlayModel: (cb) => ipcRenderer.on('overlay:model', (_e, m) => cb(m)),
});
