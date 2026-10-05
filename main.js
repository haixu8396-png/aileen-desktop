// ============================================================
// AILEEN — Electron 主进程
// 职责: 窗口管理 / 本地静态文件服务(模型与头像) / 角色卡与设置持久化
// ============================================================
const { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer, screen, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { sanitizeFileName, deepMerge, isInsidePath, normalizeSettings } = require('./shared/util.cjs');
const { makeSenderGuard } = require('./shared/ipc-guard.cjs');
const { streamChatCore, trimBase } = require('./shared/llm.cjs');
const { registerAiIpc } = require('./shared/ai-ipc.cjs');
const { registerAgentIpc } = require('./shared/agent-ipc.cjs');
const { xiaomiAsrLang } = require('./shared/ai-langs.cjs');
const mcBot = require('./mc-bot.cjs');
const { menuText } = require('./shared/menu-i18n.cjs');
// 自检逻辑单独一份（src/main/self-test.cjs）—— 生产代码里不留断言
const { attachSelfTest } = require('./src/main/self-test.cjs');
const { startStaticServer } = require('./src/main/server/static-server.cjs');
const { createSettingsStore } = require('./src/main/storage/settings-store.cjs');
const { registerEmbeddingIpc } = require('./shared/embedding-ipc.cjs');
const { registerStoreIpc } = require('./shared/store-ipc.cjs');

const APP_ROOT = __dirname;
const DIST_INDEX = path.join(APP_ROOT, 'dist', 'index.html');

// 用户数据目录：使用 Electron userData，应用升级/重装/移动都不会丢失设置、角色卡、模型
app.setName('AILEEN');
const DEFAULT_USER_DATA = app.getPath('userData');

// 数据目录优先级：环境变量 AILEEN_DATA_DIR（旧名 ELYSIA_DATA_DIR 兼容）> D:/AileenData（仅当 D 盘存在）> 系统默认 userData（%APPDATA%\AILEEN）
function resolveUserDataDir() {
  const envDir = process.env.AILEEN_DATA_DIR || process.env.ELYSIA_DATA_DIR;
  if (typeof envDir === 'string' && envDir.trim()) return envDir.trim();
  try {
    if (fs.existsSync('D:\\')) return 'D:/AileenData';
  } catch { /* 忽略 */ }
  return DEFAULT_USER_DATA;
}
try { app.setPath('userData', resolveUserDataDir()); } catch { /* 忽略 */ }
let USER_DATA_DIR = null;
let MODELS_DIR = path.join(APP_ROOT, 'models');
let CHARACTERS_DIR = path.join(APP_ROOT, 'characters');
let AVATARS_DIR = path.join(CHARACTERS_DIR, 'avatars');
let DATA_DIR = path.join(APP_ROOT, 'data');
let CHATS_DIR = path.join(DATA_DIR, 'chats');
let SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// ------------------------------------------------------------
// 默认设置
// ------------------------------------------------------------
const DEFAULT_SETTINGS = {
  llm: {
    provider: 'deepseek',       // deepseek | openai | moonshot | siliconflow | groq | zhipu | qwen | xiaomi | openrouter | ollama | custom
    baseUrl: 'https://api.deepseek.com',
    customBaseUrl: false,       // true = 用户手动填写接口地址
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.8,
    maxTokens: 1024,
  },
  tts: {
    provider: 'web',            // web | openai | fish | xiaomi
    baseUrl: 'https://api.openai.com/v1',
    customBaseUrl: false,
    apiKey: '',
    model: 'tts-1',
    voice: '',
    language: 'zh',             // zh | en | ja | es
    rate: 1.0,
    autoPlay: true,
  },
  stt: {
    provider: 'openai',         // openai | xiaomi | web
    baseUrl: 'https://api.openai.com/v1',
    customBaseUrl: false,
    apiKey: '',
    model: 'whisper-1',
    language: 'zh',             // auto | zh | en | ja | es
  },
  behavior: {
    greetingOnLoad: true,
    autoScroll: true,
    narration: 'natural',   // off | rare | natural | rich —— 括号里的动作/心理活动
    pacing: 'natural',      // off | rare | natural —— 回复是否可以带停顿拆成多条
  },
  extraModels: [],   // [{ name, url }] 通过 URL 添加的 Live2D 模型
  theme: {           // 外观调色
    primary: '#ff7eb3',
    secondary: '#38b0de',
  },
  overlay: {         // 无边框 Live2D 悬浮展台
    visible: false,
    x: null,         // null = 自动放到右下角
    y: null,
    width: 380,
    height: 640,
    scale: 0.45,
    opacity: 1,
    interactive: false,  // true = 角色本体也可点击（默认整窗鼠标穿透）
  },
  mc: {              // Minecraft AI 伙伴
    host: '127.0.0.1',
    port: 25565,
    username: 'AILEEN',
    autoReply: false,
  },
  language: 'en',    // 界面语言：en（默认）/ ja / zh
  stage: {           // Live2D 舞台视图偏好
    scale: 0.3,
  },
  chess: {           // 国际象棋
    level: 3,
    playerColor: 'white',
    banter: false,
    fenStack: [],
  },
  // 长期记忆与知识库的语义检索（与对话用的 LLM 分开配置）
  embedding: {
    enabled: true,                                  // 关掉退化关键词检索
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    customBaseUrl: false,
    apiKey: '',
    model: 'text-embedding-3-small',
    batchSize: 16,
  },
  memoryCfg: {         // 长期记忆（关于用户与 AI 的关系）
    enabled: true,
    maxContextTokens: 800,
    minImportance: 0.45,
    perCharacter: true,                             // 每个角色一份记忆
  },
  knowledgeCfg: {      // 知识库（外部资料 / 文档）
    enabled: true,
    maxContextTokens: 1200,
    topK: 5,
    chunkTokens: 500,
    chunkOverlapTokens: 80,
  },
  agent: {           // Coding Agent（第一版：单 Agent + Tool Calling）
    workspace: '',           // 空 = 用默认工作区（见 registerAgentIpc）
    requireMedium: true,     // 写文件/打补丁/git commit 是否要确认
    computerUse: false,      // 电脑控制总开关：开 = 对话走 Agent（Chat 作入口）
  },
};

function ensureDirs() {
  for (const d of [MODELS_DIR, CHARACTERS_DIR, AVATARS_DIR, DATA_DIR, CHATS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// ------------------------------------------------------------
// 设置与 API Key 存储 —— 实现在 src/main/storage/settings-store.cjs
//
// 这里只负责「把依赖接上」：数据目录、默认设置、safeStorage、脱敏规则。
// 密钥相关的三条边界（明文兼容/加密落盘/渲染层永远拿脱敏副本）都在那个文件里。
// ------------------------------------------------------------
const { SECRET_PATHS, SECRET_PREFIX, SECRET_CLEAR, redactSecrets, resolveSecretPatch } = require('./shared/secrets.cjs');

const settingsStore = createSettingsStore({
  settingsFile: SETTINGS_FILE,
  dataDir: DATA_DIR,
  modelsDir: MODELS_DIR,
  charactersDir: CHARACTERS_DIR,
  appRoot: APP_ROOT,
  defaultSettings: DEFAULT_SETTINGS,
  ensureDirs,
  safeStorage,
  secrets: { SECRET_PATHS, SECRET_PREFIX, redactSecrets },
  log: (msg) => console.log('[settings] ' + msg),
});

const {
  encryptionAvailable,
  settingsForRenderer,
  migrateSecretsToEncrypted,
  readSettings,
  writeSettings,
  migrateLegacyData,
} = settingsStore;

// ------------------------------------------------------------
// 本地静态文件服务（Live2D 模型 / 头像）—— 实现在 src/main/server/static-server.cjs
// ------------------------------------------------------------
let modelServer = null;
let modelBaseUrl = 'http://127.0.0.1:0';

async function startModelServer() {
  const srv = await startStaticServer({
    modelsDir: MODELS_DIR,
    avatarsDir: AVATARS_DIR,
    log: (msg) => console.log('[server] ' + msg),
  });
  modelServer = srv.server;
  modelBaseUrl = srv.baseUrl;
}

// ------------------------------------------------------------
// 模型扫描：递归查找 *.model3.json / *.model.json
// ------------------------------------------------------------
function scanModels(dir, prefix) {
  const results = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanModels(full, prefix ? prefix + '/' + entry.name : entry.name));
      // 注意：入口文件本身就叫 model.json / model3.json 的模型（Cubism 2 常见命名）也要能扫到，
      // 原来的正则要求「model」前面必须有一个字符，会把这类模型整个漏掉。
    } else if (entry.isFile() && /^(?:model3?\.json|.+\.model3?\.json)$/i.test(entry.name)) {
      const rel = (prefix ? prefix + '/' : '') + entry.name;
      results.push({
        name: prefix || entry.name.replace(/\.?model3?\.json$/i, '') || entry.name,
        file: rel.replace(/\\/g, '/'),
        url: modelBaseUrl + '/models/' + rel.replace(/\\/g, '/'),
      });
    }
  }
  return results;
}

// ------------------------------------------------------------
// 角色卡读写（characters/*.json）
// ------------------------------------------------------------
function listCharacters() {
  ensureDirs();
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CHARACTERS_DIR, entry.name), 'utf8'));
      out.push({ file: entry.name, data });
    } catch (e) {
      console.warn('[characters] skip broken card:', entry.name, e.message);
    }
  }
  return out;
}

// ------------------------------------------------------------
// 窗口
// ------------------------------------------------------------
// ------------------------------------------------------------
// 无边框 Live2D 悬浮展台（额外开一个窗口，角色浮在桌面上）
// 设计要点：
//   1) 透明 + 无边框 + 置顶 + 不抢焦点（focusable:false / showInactive）
//   2) 默认整窗「鼠标穿透」：只有光标进入渲染层上报的交互热区（右下角手柄/工具栏）
//      时才接收鼠标事件 —— 所以角色不会挡住底下的任何操作
//   3) 主进程每 250ms 读一次真实光标位置做兜底判定，避免卡在「可接收」状态
//   4) 拖拽走 IPC + screen.getCursorScreenPoint()，跨 DPI 稳定，且拖拽期间强制接收事件
//   5) 位置 / 尺寸 / 透明度 / 可点击开关全部持久化到 settings.overlay
// ------------------------------------------------------------
let overlayWin = null;
let overlayIgnoring = false;
let overlayHit = null;        // 渲染层上报的交互热区（窗口内 CSS 像素）
let overlayDrag = null;       // { dx, dy }
let overlayWatch = null;
let overlayInteractive = false;
let overlayModel = null;      // 当前同步给悬浮窗的模型 { url, name }
let overlayPersistTimer = null;
let overlayIgnoreRequests = [];
let overlayExpectedSize = null;   // 程序化设定的尺寸（唯一合法尺寸）
let overlayProgrammaticUntil = 0; // 这段时间内的 resize 事件视为程序化行为

function overlaySettings() {
  const s = readSettings();
  return (s && s.overlay) || {};
}

function overlayBounds() {
  const o = overlaySettings();
  const area = screen.getPrimaryDisplay().workArea;
  // 尺寸/坐标都要钳制：历史版本被拖大过，或换了更小的显示器，都不能让窗口跑到屏幕外或撑爆
  const width = Math.min(Math.max(Math.round(o.width || 380), 220), Math.min(1400, area.width));
  const height = Math.min(Math.max(Math.round(o.height || 640), 260), Math.min(1600, area.height));
  const defX = area.x + area.width - width - 28;
  const defY = area.y + area.height - height - 28;
  const rawX = typeof o.x === 'number' ? o.x : defX;
  const rawY = typeof o.y === 'number' ? o.y : defY;
  return {
    x: Math.round(Math.min(Math.max(rawX, area.x - width + 80), area.x + area.width - 80)),
    y: Math.round(Math.min(Math.max(rawY, area.y), area.y + area.height - 60)),
    width,
    height,
  };
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** 唯一合法的改尺寸入口：登记期望尺寸 → 临时解禁 → setBounds → 立刻锁回 */
async function applyOverlayBounds(next) {
  if (!overlayWin || overlayWin.isDestroyed()) return null;
  overlayExpectedSize = { width: next.width, height: next.height };
  overlayProgrammaticUntil = Date.now() + 900;
  const locked = !overlayWin.isResizable();
  if (locked) { overlayWin.setResizable(true); await sleepMs(50); }
  overlayWin.setBounds(next);
  await sleepMs(50);
  if (locked) { overlayWin.setResizable(false); }
  reassertOverlayIgnore();
  return overlayWin.getBounds();
}

/** 工具条 −/＋ 的入口：以右下角为锚点缩放 */
async function resizeOverlayBy(dw, dh) {
  if (!overlayWin || overlayWin.isDestroyed()) return null;
  const b = overlayWin.getBounds();
  const width = Math.min(1400, Math.max(220, b.width + dw));
  const height = Math.min(1600, Math.max(260, b.height + dh));
  const r = await applyOverlayBounds({
    x: b.x + (b.width - width),
    y: b.y + (b.height - height),
    width,
    height,
  });
  persistOverlayBounds();
  return r;
}

function persistOverlayBounds() {
  if (overlayPersistTimer) clearTimeout(overlayPersistTimer);
  overlayPersistTimer = setTimeout(() => {
    overlayPersistTimer = null;
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const b = overlayWin.getBounds();
    // 尺寸要存「程序化设定的值」，不能存 Windows 回读的实际值：
    // 无边框窗口带隐形边框，回读值比请求值大 1~6px；
    // 存回读值的话，下次启动拿这个更大的值再请求，又再大几像素 ——
    // 每轮增长一点，表现出来就是「窗口自己越变越大」。
    const size = overlayExpectedSize || { width: b.width, height: b.height };
    try { writeSettings({ overlay: { x: b.x, y: b.y, width: size.width, height: size.height } }); }
    catch (err) { console.error('[overlay] persist failed:', err); }
  }, 400);
}

function broadcastOverlayState() {
  const visible = !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible());
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('overlay:state', { visible, interactive: overlayInteractive });
  }
}

/**
 * 强制重申一遍穿透状态。
 * setResizable() 在 Windows 上会重建窗口样式，穿透状态可能被一并重置，
 * 所以每次程序化改完尺寸都要重申一次，不能依赖缓存。
 */
function reassertOverlayIgnore() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayIgnoring = null; // 让 setOverlayIgnore 一定真的调用一次
  setOverlayIgnore(!overlayShouldCapture());
}

// 拖拽超时兜底：正常情况下 pointermove 会不停刷新它。
// 万一 pointerup 丢了（窗口中途改尺寸、指针捕获失效…），overlayDrag 会一直是 set 状态，
// overlayShouldCapture() 就永远返回 true —— 展台会永久吃掉鼠标，底下全点不动。
let overlayDragTimer = null;
function armDragTimeout() {
  if (overlayDragTimer) clearTimeout(overlayDragTimer);
  overlayDragTimer = setTimeout(() => {
    overlayDragTimer = null;
    if (overlayDrag) {
      overlayDrag = null;
      persistOverlayBounds();
      reassertOverlayIgnore();
    }
  }, 4000);
}

function setOverlayIgnore(ignore) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayIgnoring === ignore) return;
  if (overlayIgnoring === null) overlayIgnoring = !ignore; // 走完下面这次调用
  overlayIgnoring = ignore;
  overlayWin.setIgnoreMouseEvents(ignore, { forward: true });
}

/** 光标是否落在渲染层上报的交互热区内（该热区在窗口内坐标下恒定，与鼠标当前位置无关） */
function overlayCursorInHit() {
  if (!overlayWin || overlayWin.isDestroyed()) return false;
  if (!overlayHit || overlayHit.w <= 0 || overlayHit.h <= 0) return false;
  const pt = screen.getCursorScreenPoint();
  const b = overlayWin.getBounds();
  const x = pt.x - b.x;
  const y = pt.y - b.y;
  return x >= overlayHit.x && x <= overlayHit.x + overlayHit.w &&
         y >= overlayHit.y && y <= overlayHit.y + overlayHit.h;
}

/** 当前是否应该接收鼠标：拖拽中 / 主动开启可点击 / 光标落在交互热区内 */
function overlayShouldCapture() {
  if (!overlayWin || overlayWin.isDestroyed()) return false;
  if (overlayDrag) return true;
  if (overlayInteractive) return true;
  return overlayCursorInHit();
}

function startOverlayWatch() {
  if (overlayWatch) return;
  overlayWatch = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed()) { stopOverlayWatch(); return; }
    setOverlayIgnore(!overlayShouldCapture());
  }, 250);
}

function stopOverlayWatch() {
  if (overlayWatch) { clearInterval(overlayWatch); overlayWatch = null; }
}

function destroyOverlayWindow() {
  stopOverlayWatch();
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  overlayWin = null;
  overlayIgnoring = false;
  overlayHit = null;
  overlayDrag = null;
  writeSettings({ overlay: { visible: false } });
  broadcastOverlayState();
}

function createOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  // 刻意不恢复上次的「角色可点击」：那是使用时临时开的开关。
  // 如果持久化，上次误开一次，之后每次启动展台都会吃掉桌面点击 —— 表现就是「点都点不了」。
  overlayInteractive = false;
  const overlayPath = path.join(APP_ROOT, 'dist', 'overlay.html');
  if (!process.env.AILEEN_DEV_URL && !fs.existsSync(overlayPath)) {
    console.error('[overlay] 缺少构建产物 dist/overlay.html，请先 npm run build');
    return null;
  }
  overlayWin = new BrowserWindow(Object.assign({}, overlayBounds(), {
    title: 'AILEEN Stage',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // 尺寸只允许用工具条的 −/＋ 改，用户不能自己拖边/拖角/贴边缩放。
    // resizable:false 会让 Windows 忽略 setBounds 的尺寸变化，所以程序化改尺寸时
    // 走「临时解禁 → setBounds → 立刻锁回」的流程（见 resizeOverlayBy）。
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  }));
  try {
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (err) { /* 某些平台不支持，忽略 */ }
  overlayExpectedSize = { width: overlayWin.getBounds().width, height: overlayWin.getBounds().height };
  overlayIgnoring = false;
  setOverlayIgnore(true);
  startOverlayWatch();
  if (process.env.AILEEN_DEV_URL) {
    overlayWin.loadURL(process.env.AILEEN_DEV_URL.replace(/\/+$/, '') + '/overlay.html');
  } else {
    overlayWin.loadFile(overlayPath);
  }
  overlayWin.once('ready-to-show', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    overlayWin.showInactive();
    startOverlayWatch();
    if (overlayModel) overlayWin.webContents.send('overlay:model', overlayModel);
    broadcastOverlayState();
  });
  // 兜底：即使用户缩放被系统绕过了，也不允许尺寸变成非程序化的值（直接弹回）
  overlayWin.on('will-resize', (e) => { e.preventDefault(); });
  overlayWin.on('maximize', () => { try { overlayWin.unmaximize(); } catch (err) { /* ignore */ } });
  overlayWin.on('resize', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (Date.now() < overlayProgrammaticUntil) return;
    const b = overlayWin.getBounds();
    const exp = overlayExpectedSize;
    if (exp && (Math.abs(b.width - exp.width) > 4 || Math.abs(b.height - exp.height) > 4)) {
      overlayProgrammaticUntil = Date.now() + 400;
      overlayWin.setBounds({ x: b.x, y: b.y, width: exp.width, height: exp.height });
      reassertOverlayIgnore();
    }
  });
  overlayWin.on('moved', persistOverlayBounds);
  overlayWin.on('resized', persistOverlayBounds);
  overlayWin.on('closed', () => { overlayWin = null; stopOverlayWatch(); });
  return overlayWin;
}

function toggleOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) { destroyOverlayWindow(); return false; }
  const w = createOverlayWindow();
  if (!w) return false;
  writeSettings({ overlay: { visible: true } });
  return true;
}

function registerOverlayIpc() {
  handle('overlay:status', () => ({
    visible: !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()),
    interactive: overlayInteractive,
  }));
  handle('overlay:toggle', () => toggleOverlayWindow());
  handle('overlay:hide', () => { destroyOverlayWindow(); return false; });
  handle('overlay:hitArea', (_e, rect) => {
    if (!rect || typeof rect !== 'object') { overlayHit = null; return null; }
    overlayHit = {
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      w: Math.max(0, Number(rect.w) || 0),
      h: Math.max(0, Number(rect.h) || 0),
    };
    return overlayHit;
  });
  handle('overlay:setIgnore', (_e, ignore) => {
    overlayIgnoreRequests.push({ at: Date.now(), ignore: !!ignore, inHit: overlayCursorInHit() });
    if (overlayIgnoreRequests.length > 40) overlayIgnoreRequests.shift();
    // 渲染层要求「接收鼠标」时，主进程用真实光标位置复核一遍：
    // 渲染层刚加载完时 #ov-tools 可能还没排版（getBoundingClientRect 全 0），
    // 那会被误判成「光标在把手上」，导致整窗突然不穿透、挡住桌面操作。
    if (ignore === false && !overlayInteractive && !overlayDrag && !overlayCursorInHit()) {
      return overlayIgnoring;
    }
    setOverlayIgnore(!!ignore);
    return overlayIgnoring;
  });
  handle('overlay:interactive', (_e, on) => {
    overlayInteractive = !!on;
    // 只影响本次运行，不写进设置（见上面的理由）
    setOverlayIgnore(!overlayShouldCapture());
    broadcastOverlayState();
    return overlayInteractive;
  });
  handle('overlay:setModel', (_e, model) => {
    overlayModel = model && model.url ? { url: String(model.url), name: String(model.name || '') } : null;
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:model', overlayModel);
    return true;
  });
  handle('overlay:getState', () => ({
    model: overlayModel,
    overlay: overlaySettings(),
    theme: readSettings().theme || {},
    language: readSettings().language || 'en',
  }));
  handle('overlay:resize', async (_e, payload) => {
    const dw = Math.round((payload && payload.dw) || 0);
    const dh = Math.round((payload && payload.dh) || 0);
    return resizeOverlayBy(dw, dh);
  });
  handle('overlay:reset', async () => {
    if (!overlayWin || overlayWin.isDestroyed()) return null;
    const width = 380;
    const height = 640;
    const area = screen.getPrimaryDisplay().workArea;
    const x = area.x + area.width - width - 28;
    const y = area.y + area.height - height - 28;
    writeSettings({ overlay: { x: null, y: null, width, height } });
    return await applyOverlayBounds({ x, y, width, height });
  });
  handle('overlay:dragStart', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return false;
    const pt = screen.getCursorScreenPoint();
    const b = overlayWin.getBounds();
    overlayDrag = { dx: pt.x - b.x, dy: pt.y - b.y };
    armDragTimeout();
    setOverlayIgnore(false);
    return true;
  });
  handle('overlay:dragMove', () => {
    if (!overlayDrag || !overlayWin || overlayWin.isDestroyed()) return false;
    const pt = screen.getCursorScreenPoint();
    overlayWin.setPosition(Math.round(pt.x - overlayDrag.dx), Math.round(pt.y - overlayDrag.dy));
    armDragTimeout();
    return true;
  });
  handle('overlay:dragEnd', () => {
    if (overlayDragTimer) { clearTimeout(overlayDragTimer); overlayDragTimer = null; }
    overlayDrag = null;
    persistOverlayBounds();
    setOverlayIgnore(!overlayShouldCapture());
    return true;
  });
}

let mainWin = null;
let appMenuLang = '';

/** 给主窗口发菜单动作（渲染层执行） */
function sendMenuAction(action) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('menu:action', action);
}

// ------------------------------------------------------------
// 原生应用菜单（中文）：默认 autoHideMenuBar 隐藏，按 Alt 才出现。
// 旧版这里露出的是 Electron 默认英文菜单，属于明显的「菜单问题」。
// ------------------------------------------------------------
/** 原生菜单随界面语言重建；lang 省略时读设置 */
function buildAppMenu(lang) {
  const M = menuText(lang || readSettings().language || 'en');
  const template = [
    {
      label: M.app,
      submenu: [
        { label: M.about, click: () => sendMenuAction('about') },
        { label: M.datadir, click: () => sendMenuAction('datadir') },
        { type: 'separator' },
        { role: 'quit', label: M.quit },
      ],
    },
    {
      label: M.edit,
      submenu: [
        { role: 'undo', label: M.undo },
        { role: 'redo', label: M.redo },
        { type: 'separator' },
        { role: 'cut', label: M.cut },
        { role: 'copy', label: M.copy },
        { role: 'paste', label: M.paste },
        { role: 'selectAll', label: M.selectAll },
      ],
    },
    {
      label: M.character,
      submenu: [
        { label: M.newCard, accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-card') },
        { label: M.importCard, accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('import-card') },
        { type: 'separator' },
        { label: M.clearChat, click: () => sendMenuAction('clear-chat') },
      ],
    },
    {
      label: M.settingsGroup,
      submenu: [
        { label: M.settings, accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('settings') },
        { label: M.llm, click: () => sendMenuAction('llm') },
        { label: M.tts, click: () => sendMenuAction('tts') },
        { label: M.stt, click: () => sendMenuAction('stt') },
        { label: M.perform, click: () => sendMenuAction('perform') },
        { label: M.personaStudio, click: () => sendMenuAction('persona') },
        { label: M.model, click: () => sendMenuAction('model') },
        { label: M.theme, click: () => sendMenuAction('theme') },
      ],
    },
    {
      label: M.stageGroup,
      submenu: [
        { label: M.toggleStage, accelerator: 'CmdOrCtrl+Shift+S', click: () => toggleOverlayWindow() },
        { label: M.fixClickThrough, click: () => {
          // 逃生阀：万一展台卡在「接收鼠标」状态把桌面点击全吃了，这里一键恢复穿透
          overlayInteractive = false;
          overlayDrag = null;
          if (overlayDragTimer) { clearTimeout(overlayDragTimer); overlayDragTimer = null; }
          reassertOverlayIgnore();
        } },
        { label: M.resetStage, click: () => {
          if (!overlayWin || overlayWin.isDestroyed()) { createOverlayWindow(); }
          setTimeout(() => {
            if (!overlayWin || overlayWin.isDestroyed()) return;
            const width = 380, height = 640;
            const area = screen.getPrimaryDisplay().workArea;
            overlayWin.setBounds({ x: area.x + area.width - width - 28, y: area.y + area.height - height - 28, width, height });
            writeSettings({ overlay: { x: null, y: null, width, height } });
          }, 600);
        } },
      ],
    },
    {
      label: M.funGroup,
      submenu: [
        { label: M.mc, click: () => sendMenuAction('mc') },
        { label: M.chess, click: () => sendMenuAction('chess') },
      ],
    },
    {
      label: M.view,
      submenu: [
        { role: 'reload', label: M.reload },
        { role: 'forceReload', label: M.forceReload },
        { role: 'toggleDevTools', label: M.devtools },
        { type: 'separator' },
        { role: 'resetZoom', label: M.resetZoom },
        { role: 'zoomIn', label: M.zoomIn },
        { role: 'zoomOut', label: M.zoomOut },
        { type: 'separator' },
        // Electron 的 togglefullscreen 角色默认没绑快捷键，F11 要自己给
        { role: 'togglefullscreen', label: M.fullscreen, accelerator: 'F11' },
      ],
    },
    {
      label: M.help,
      submenu: [
        { label: M.homepage, click: () => shell.openExternal('https://github.com/haixu8396-png/aileen-desktop') },
        { label: M.shortcuts, click: () => sendMenuAction('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------
// Minecraft AI 伙伴（mineflayer, MIT）IPC
// ------------------------------------------------------------
function registerMcIpc() {
  handle('mc:connect', (_e, opts) => mcBot.connect(opts));
  handle('mc:disconnect', () => mcBot.disconnect());
  handle('mc:status', () => mcBot.status());
  handle('mc:say', (_e, text) => mcBot.say(text));
  handle('mc:follow', (_e, name) => mcBot.follow(name));
  handle('mc:stopFollow', () => mcBot.stopFollow());
  handle('mc:step', (_e, payload) => mcBot.step(payload && payload.dir, payload && payload.ms));
  handle('mc:jump', () => mcBot.jump());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    title: 'AILEEN',
    backgroundColor: '#14151a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWin = win;
  mcBot.init((channel, payload) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload); });

  if (process.env.AILEEN_DEV_URL) {
    win.loadURL(process.env.AILEEN_DEV_URL);
  } else if (fs.existsSync(DIST_INDEX)) {
    win.loadFile(DIST_INDEX);
  } else {
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<h3 style="font-family:sans-serif">未找到构建产物，请先运行 <code>npm run build</code></h3>'
    ));
  }

  // 自检（诊断 / self-test）全部搬到了 src/main/self-test.cjs ——
  // 生产代码里不留断言逻辑，依赖在这里注入。
  if (process.env.AILEEN_SELFTEST) attachSelfTest(win, selfTestDeps());

  return win;
}

/**
 * 自检要用到的内部依赖，集中在这里注入给 src/main/self-test.cjs。
 *
 * 为什么用取值函数（而不是直接给值）：overlay 的状态与模型列表都是**会变的**，
 * 传值会在自检跑起来之前就被快照住，断言就会看到过期数据。
 */
function selfTestDeps() {
  return {
    opts: { userDataDir: USER_DATA_DIR, appRoot: APP_ROOT, distIndex: DIST_INDEX },
    settings: {
      readSettings,
      writeSettings,
      settingsForRenderer,
      settingsFile: SETTINGS_FILE,
      encryptionAvailable,
      secretPrefix: SECRET_PREFIX,
      secretClear: SECRET_CLEAR,
      resolveSecretPatch,
    },
    models: { modelsDir: MODELS_DIR, charactersDir: CHARACTERS_DIR, scanModels },
    overlay: {
      getHit: () => overlayHit,
      getIgnoring: () => overlayIgnoring,
      getInteractive: () => overlayInteractive,
      getModel: () => overlayModel,
      getWatch: () => overlayWatch,
      getDrag: () => overlayDrag,
      getCursorInHit: () => overlayCursorInHit(),
      getShouldCapture: () => overlayShouldCapture(),
      getSettings: () => overlaySettings(),
      getExpectedSize: () => overlayExpectedSize,
      getProgrammaticUntil: () => overlayProgrammaticUntil,
      getIgnoreRequests: () => overlayIgnoreRequests,
      applyBounds: (next) => applyOverlayBounds(next),
      createWindow: () => createOverlayWindow(),
      destroyWindow: () => destroyOverlayWindow(),
    },
    deps: { crypto, fs, path, Menu, app, mainWindow: () => mainWin },
  };
}

// ------------------------------------------------------------
// IPC
// ------------------------------------------------------------
// ------------------------------------------------------------
// IPC 发送方鉴权
//
// 渲染层能调的 IPC 里有不少高权限操作：写/删文件、删模型、截屏、打开路径、
// 改设置、以及代发网络请求（LLM/TTS/STT —— 它们会带着 API Key 出去）。
// 不校验来源的话，任何能在这个进程里执行脚本的东西都能直接调它们。
// 所以统一在 handle() 里过一道：
//   1) 发送方必须是我们的窗口（主窗口或展台窗口）之一；
//   2) 页面 URL 必须是我们自己的页面（打包后的 dist 页面 / 开发服务器）。
// 规则本身是纯函数，放在 shared/ipc-guard.cjs，有单测。
// ------------------------------------------------------------
const assertTrustedSender = makeSenderGuard({
  allowedWebContentsIds: () => [mainWin, overlayWin]
    .filter((w) => w && !w.isDestroyed())
    .map((w) => w.webContents.id),
  allowedUrls: () => {
    const list = [];
    for (const p of [DIST_INDEX, path.join(APP_ROOT, 'dist', 'overlay.html')]) {
      try { if (fs.existsSync(p)) list.push(pathToFileURL(p).toString()); } catch { /* ignore */ }
    }
    return list;
  },
  devUrl: () => process.env.AILEEN_DEV_URL || '',
  onReject: (msg) => console.warn('[ipc] 已拒绝不可信调用：' + msg),
});

/**
 * 所有 ipcMain.handle 都走这个包装：先验发送方，再进业务。
 * 这里刻意用 bind 拿注册函数（而不是直接写 ipcMain.handle 调用），
 * 否则下面把 handler 批量换成 handle() 时会把包装器自己套进去。
 */
const registerIpcHandler = ipcMain.handle.bind(ipcMain);
function handle(channel, fn) {
  registerIpcHandler(channel, (event, ...args) => {
    assertTrustedSender(event);
    return fn(event, ...args);
  });
}

// ------------------------------------------------------------
// 参数校验层（不信任渲染层的输入）
//
// 发送方鉴权解决「是谁在调」，这里解决「调的时候给了什么」。
// 规则集中在 shared/ipc-schemas.cjs：每个通道一行，缺规则会**显式报错**
// —— 「新加了 IPC 忘了写校验」必须当场失败，而不是默认放行。
//
// 渲染层内部调用的通道（overlay / mc / llm / agent）由各自 register* 拿到的是
// validatedHandle，所以那批也在这张表里；表里没有的内部通道才退回 handle。
// ------------------------------------------------------------
const { CHANNELS: IPC_SCHEMAS, makeValidatedHandle } = require('./shared/ipc-schemas.cjs');
const strictHandle = makeValidatedHandle(handle, (err, channel) => {
  console.warn('[ipc] 参数校验失败：' + channel + ' —— ' + ((err && err.message) || err));
});
/** 渲染层能直接调的通道走校验；主进程内部自己注册的通道维持原样 */
function validatedHandle(channel, fn) {
  return IPC_SCHEMAS[channel] ? strictHandle(channel, fn) : handle(channel, fn);
}


function registerIpc() {
  validatedHandle('app:info', () => ({    modelBaseUrl,
    modelsDir: MODELS_DIR,
    charactersDir: CHARACTERS_DIR,
    avatarsDir: AVATARS_DIR,
    dataDir: DATA_DIR,
    userDataDir: USER_DATA_DIR,
    appRoot: APP_ROOT,
    version: app.getVersion(),
  }));

  validatedHandle('models:list', () => {
    const local = scanModels(MODELS_DIR, '');
    const extra = (readSettings().extraModels || []).map((m) => ({
      name: m.name || 'URL 模型',
      file: m.url,
      url: m.url,
      source: 'url',
    }));
    return [...local, ...extra];
  });

  // 从文件夹导入 Live2D 模型（复制到 models/）
  validatedHandle('models:addFolder', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Live2D 模型文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const srcDir = result.filePaths[0];
    const name = path.basename(srcDir).replace(/[^\w\u4e00-\u9fa5-]+/g, '_') || 'model';
    const destDir = path.join(MODELS_DIR, name);
    fs.mkdirSync(destDir, { recursive: true });
    const copyRec = (from, to) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const s = path.join(from, entry.name);
        const d = path.join(to, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          copyRec(s, d);
        } else if (entry.isFile()) {
          fs.copyFileSync(s, d);
        }
      }
    };
    copyRec(srcDir, destDir);
    return scanModels(MODELS_DIR, '');
  });

  // 通过 URL 添加 Live2D 模型
  validatedHandle('models:addUrl', (_e, payload) => {
    const url = String((payload && payload.url) || '').trim();
    const name = String((payload && payload.name) || '').trim() || 'URL 模型';
    if (!/^https?:\/\//i.test(url)) throw new Error('无效的模型 URL');
    const s = readSettings();
    const list = s.extraModels || [];
    if (!list.some((m) => m.url === url)) list.push({ name, url });
    s.extraModels = list;
    writeSettings(s);
    return [...scanModels(MODELS_DIR, ''), ...list.map((m) => ({ name: m.name, file: m.url, url: m.url, source: 'url' }))];
  });

  // 移除 URL 模型
  validatedHandle('models:removeUrl', (_e, url) => {
    const s = readSettings();
    s.extraModels = (s.extraModels || []).filter((m) => m.url !== String(url || ''));
    writeSettings(s);
    return [...scanModels(MODELS_DIR, ''), ...s.extraModels.map((m) => ({ name: m.name, file: m.url, url: m.url, source: 'url' }))];
  });

  // 删除本地模型：连同磁盘上的文件夹一起删。
  // 这是唯一一个会真删用户文件的接口，所以路径校验必须死板：
  // 只接受 models/ 下第一层目录名，绝不允许越出 models 之外。
  validatedHandle('models:delete', async (_e, target) => {
    const raw = String((target && (target.dir || target.file || target.name)) || '').trim();
    if (!raw) throw new Error('无效的模型路径');
    const modelsRoot = path.normalize(MODELS_DIR);
    const first = raw.split(/[\\/]+/).filter(Boolean)[0];
    if (!first || first === '.' || first === '..') throw new Error('无效的模型路径');
    const dir = path.normalize(path.join(MODELS_DIR, first));
    if (dir === modelsRoot || !dir.startsWith(modelsRoot + path.sep)) {
      throw new Error('拒绝操作 models 目录以外的路径');
    }
    // 必须正好是「当前真的扫到的某个模型」的顶层目录 —— 不是「像模型」就行。
    // 这样即便以后参数被拼错，也不可能顺手指向别的东西。
    const known = scanModels(MODELS_DIR, '').some((m) => String(m.file).split('/')[0] === first);
    if (!known) throw new Error('这个目录不在模型列表里，已中止');
    if (!fs.existsSync(dir)) throw new Error('模型文件夹不存在');
    if (scanModels(dir, '').length === 0) throw new Error('这个文件夹里没有 Live2D 模型文件，已中止');
    // 删到回收站，而不是 fs.rmSync 彻底抹掉：这是唯一会动用户文件的接口，
    // 误删要能捞回来。之前用硬删除，用户手一抖模型就真没了。
    await shell.trashItem(dir);
    return scanModels(MODELS_DIR, '');
  });

  // 屏幕捕获（视觉功能）
  validatedHandle('screen:capture', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 1440, height: 900 },
        fetchWindowIcons: false,
      });
      return sources
        .filter((s) => s.thumbnail && !s.thumbnail.isEmpty())
        .map((s) => ({
          id: s.id,
          name: s.name,
          display_id: s.display_id || '',
          thumbnail: s.thumbnail.toDataURL(),
        }));
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  });

  validatedHandle('characters:list', () => listCharacters());

  validatedHandle('characters:write', (_e, payload) => {
    const { file, data, mode } = payload || {};
    const safe = sanitizeFileName(file);
    let target = safe;
    if (mode !== 'update') {
      let i = 1;
      while (fs.existsSync(path.join(CHARACTERS_DIR, target + '.json'))) {
        i += 1;
        target = safe + '-' + i;
        if (i > 999) throw new Error('同名角色卡过多');
      }
    }
    const full = path.join(CHARACTERS_DIR, target + '.json');
    if (!isInsidePath(full, CHARACTERS_DIR)) throw new Error('非法路径');
    fs.writeFileSync(full, JSON.stringify(data, null, 2), 'utf8');
    return { file: target + '.json' };
  });

  validatedHandle('characters:delete', (_e, file) => {
    const safe = path.basename(String(file || ''));
    const full = path.join(CHARACTERS_DIR, safe);
    if (full.startsWith(CHARACTERS_DIR + path.sep) && fs.existsSync(full)) {
      fs.unlinkSync(full);
    }
    return true;
  });

  validatedHandle('characters:chooseAvatar', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: '选择角色头像',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const src = result.filePaths[0];
    const ext = path.extname(src).toLowerCase() || '.png';
    const name = 'avatar-' + crypto.randomBytes(6).toString('hex') + ext;
    const dest = path.join(AVATARS_DIR, name);
    fs.copyFileSync(src, dest);
    return { rel: 'avatars/' + name, url: modelBaseUrl + '/avatars/' + name };
  });

  validatedHandle('characters:export', async (_e, data) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(win, {
      title: '导出角色卡',
      defaultPath: path.join(APP_ROOT, 'characters', (data && data.name ? data.name : 'character') + '.json'),
      filters: [{ name: '角色卡 JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
    return result.filePath;
  });

  validatedHandle('characters:import', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: '导入角色卡',
      filters: [{ name: '角色卡 JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    const baseName = sanitizeFileName(data && data.name ? data.name : path.basename(result.filePaths[0], '.json'));
    let name = baseName;
    let i = 1;
    while (fs.existsSync(path.join(CHARACTERS_DIR, name + '.json'))) {
      i += 1;
      name = baseName + '-' + i;
      if (i > 999) throw new Error('同名角色卡过多');
    }
    const full = path.join(CHARACTERS_DIR, name + '.json');
    if (!isInsidePath(full, CHARACTERS_DIR)) throw new Error('非法路径');
    fs.writeFileSync(full, JSON.stringify(data, null, 2), 'utf8');
    return { file: name + '.json', data };
  });

  // 送给渲染层的设置永远不含明文密钥，只带「配没配」的标记
  validatedHandle('settings:get', () => settingsForRenderer(readSettings()));
  validatedHandle('settings:set', (_e, incoming) => {
    // 渲染层拿不到明文密钥，它送回来的 apiKey 只有三种含义（见 shared/secrets.cjs）：
    //   '' / undefined → 保持原样（表单留空不该把已配好的密钥抹掉）
    //   SECRET_CLEAR   → 明确清除
    //   其它字符串      → 设为新值
    const patch = resolveSecretPatch(
      incoming && typeof incoming === 'object' ? deepMerge({}, incoming) : {},
      readSettings(),
    );
    const next = writeSettings(patch);
    // 语言变了要重建原生菜单
    if (next && next.language !== appMenuLang) { appMenuLang = next.language; buildAppMenu(appMenuLang); }
    return settingsForRenderer(next);
  });

  registerOverlayIpc();
  registerMcIpc();
  // Coding Agent 的工具能力：文件、命令、git、截屏全在主进程执行，
  // 渲染层只送「要做什么」。workspace 边界与敏感路径在这里兜底。
  registerAgentIpc({
    // 这些通道渲染层能直接调，所以走带参数校验的那条 registration
    handle: validatedHandle,
    getSettings: readSettings,
    defaultWorkspace: () => DATA_DIR,
    // 主进程自己要用到的 Electron 能力（打开外链）
    electron: { shell },
    // 鼠标坐标：screen 的坐标是**逻辑像素**，而 SetCursorPos 要物理像素，
    // 所以要乘上缩放因子 —— 不乘的话 125%/150% 缩放屏上会点偏。
    cursorPoint: () => {
      const pt = screen.getCursorScreenPoint();
      const disp = screen.getDisplayNearestPoint(pt);
      const scale = (disp && disp.scaleFactor) || 1;
      return {
        x: Math.round(pt.x * scale),
        y: Math.round(pt.y * scale),
        logicalX: pt.x,
        logicalY: pt.y,
        scale,
        size: disp && disp.size ? { width: Math.round(disp.size.width * scale), height: Math.round(disp.size.height * scale) } : null,
      };
    },
    // 截屏能力：复用 desktopCapturer，给 Agent 一个「看一眼」的手段
    captureScreen: async ({ withData } = {}) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: withData ? 1440 : 480, height: withData ? 900 : 300 },
        fetchWindowIcons: false,
      });
      const list = sources.filter((s) => s.thumbnail && !s.thumbnail.isEmpty());
      if (!list.length) throw new Error('没有截到任何屏幕或窗口');
      const first = list[0];
      const size = first.thumbnail.getSize();
      return {
        count: list.length,
        width: size.width,
        height: size.height,
        names: list.slice(0, 12).map((s) => s.name),
        dataUrl: withData ? first.thumbnail.toDataURL() : '',
      };
    },
    log: (...args) => console.warn('[agent]', ...args),
  });
  // LLM / TTS / STT 的网络请求都在主进程发出：API Key 不出主进程
  registerAiIpc({
    handle,
    getSettings: readSettings,
    trimBase,
    streamChatCore,
    xiaomiAsrLang,
    log: (...args) => console.warn('[ai]', ...args),
  });

  // 嵌入模型：记忆与知识库的语义检索用（与对话用的 Key 分开配置）
  registerEmbeddingIpc({
    handle: validatedHandle,
    getSettings: readSettings,
    log: (...args) => console.log('[embedding]', ...args),
  });

  // 记忆库 / 知识库的存储通道：只允许 <userData>/memory 与 /knowledge 两个根
  registerStoreIpc({
    handle: validatedHandle,
    dataDir: DATA_DIR,
    log: (...args) => console.log('[store]', ...args),
  });

  // 仅允许打开用户数据目录内的路径（防止渲染层被利用打开任意程序/文件）
  handle('shell:openPath', async (_e, p) => {
    if (typeof p !== 'string' || !p) return false;
    const target = path.resolve(p);
    if (!isInsidePath(target, USER_DATA_DIR) && !isInsidePath(target, APP_ROOT)) return false;
    return shell.openPath(target);
  });

  // 聊天记录持久化（按角色存文件，避免 localStorage 容量/清缓存丢失）
  handle('chat:read', (_e, file) => {
    const safe = sanitizeFileName(String(file || '').replace(/\.json$/, ''));
    const full = path.join(CHATS_DIR, safe + '.json');
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  });

  handle('chat:write', (_e, payload) => {
    const { file, messages } = payload || {};
    const safe = sanitizeFileName(String(file || '').replace(/\.json$/, ''));
    const full = path.join(CHATS_DIR, safe + '.json');
    if (!isInsidePath(full, CHATS_DIR)) throw new Error('非法路径');
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    const list = Array.isArray(messages) ? messages.slice(-2000) : [];
    fs.writeFileSync(full, JSON.stringify(list), 'utf8');
    return true;
  });

  handle('chat:clear', (_e, file) => {
    const safe = sanitizeFileName(String(file || '').replace(/\.json$/, ''));
    const full = path.join(CHATS_DIR, safe + '.json');
    if (isInsidePath(full, CHATS_DIR) && fs.existsSync(full)) fs.unlinkSync(full);
    return true;
  });
}

// ------------------------------------------------------------
// 启动
// ------------------------------------------------------------
app.whenReady().then(async () => {
  USER_DATA_DIR = app.getPath('userData');
  MODELS_DIR = path.join(USER_DATA_DIR, 'models');
  CHARACTERS_DIR = path.join(USER_DATA_DIR, 'characters');
  AVATARS_DIR = path.join(CHARACTERS_DIR, 'avatars');
  DATA_DIR = path.join(USER_DATA_DIR, 'data');
  CHATS_DIR = path.join(DATA_DIR, 'chats');
  SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
  try {
    ensureDirs();
  } catch (err) {
    // D 盘不可用时回退到默认用户目录
    console.error('[data] 无法使用 ' + USER_DATA_DIR + '，回退到默认目录：', err);
    app.setPath('userData', DEFAULT_USER_DATA);
    USER_DATA_DIR = app.getPath('userData');
    MODELS_DIR = path.join(USER_DATA_DIR, 'models');
    CHARACTERS_DIR = path.join(USER_DATA_DIR, 'characters');
    AVATARS_DIR = path.join(CHARACTERS_DIR, 'avatars');
    DATA_DIR = path.join(USER_DATA_DIR, 'data');
    CHATS_DIR = path.join(DATA_DIR, 'chats');
    SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
    ensureDirs();
  }
  migrateLegacyData();
  // 历史明文 API Key → safeStorage 密文（幂等，safeStorage 不可用时自动跳过）
  migrateSecretsToEncrypted();
  await startModelServer();
  registerIpc();
  appMenuLang = readSettings().language || 'en';
  buildAppMenu(appMenuLang);

  // 授予麦克风权限
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  createWindow();

  // 上次退出时展台是开着的，就自动恢复（位置/尺寸沿用保存值）
  if (overlaySettings().visible) {
    setTimeout(() => { try { createOverlayWindow(); } catch (err) { console.error('[overlay] 自动恢复失败:', err); } }, 400);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  stopOverlayWatch();
  if (modelServer) modelServer.close();
});
