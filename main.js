// ============================================================
// AILEEN — Electron 主进程
// 职责: 窗口管理 / 本地静态文件服务(模型与头像) / 角色卡与设置持久化
// ============================================================
const { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const { sanitizeFileName, deepMerge, isInsidePath, normalizeSettings } = require('./shared/util.cjs');
const mcBot = require('./mc-bot.cjs');
const { menuText } = require('./shared/menu-i18n.cjs');

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
};

function ensureDirs() {
  for (const d of [MODELS_DIR, CHARACTERS_DIR, AVATARS_DIR, DATA_DIR, CHATS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readSettings() {
  ensureDirs();
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    raw = {};
  }
  // 白名单 + 类型/范围校验：未知字段丢弃，脏数据不会长期留存
  return normalizeSettings(deepMerge(DEFAULT_SETTINGS, raw), DEFAULT_SETTINGS);
}

function copyDirRec(src, dst) {
  if (!fs.existsSync(src)) return;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyDirRec(s, d);
    } else if (e.isFile() && !fs.existsSync(d)) {
      fs.copyFileSync(s, d);
    }
  }
}

// 首次启动时，把历史版本的数据迁移到当前数据目录，之后以当前目录为准
function migrateLegacyData() {
  try {
    // 历史数据位置：旧版 D 盘目录、旧版 %APPDATA%\Elysia、旧版应用目录
    const legacyRoots = [
      'D:/ElysiaData',
      path.join(process.env.APPDATA || '', 'Elysia'),
      APP_ROOT,
    ].filter((p) => p && p !== USER_DATA_DIR);

    const hasSettings = () => fs.existsSync(SETTINGS_FILE);
    const hasChars = () => fs.existsSync(CHARACTERS_DIR) && fs.readdirSync(CHARACTERS_DIR).some((n) => n.endsWith('.json'));
    // 注意：models/ 里只有 README.txt 时不算「已有模型」，否则会挡住旧版本模型的迁移
    const hasModels = () => fs.existsSync(MODELS_DIR) &&
      fs.readdirSync(MODELS_DIR).some((n) => n !== 'README.txt' && !n.startsWith('.'));

    for (const root of legacyRoots) {
      if (!fs.existsSync(root)) continue;
      const legacySettings = path.join(root, 'data', 'settings.json');
      if (!hasSettings() && fs.existsSync(legacySettings)) {
        fs.copyFileSync(legacySettings, SETTINGS_FILE);
      }
      const legacyChars = path.join(root, 'characters');
      if (!hasChars() && fs.existsSync(legacyChars)) {
        copyDirRec(legacyChars, CHARACTERS_DIR);
      }
      const legacyModels = path.join(root, 'models');
      if (!hasModels() && fs.existsSync(legacyModels)) {
        copyDirRec(legacyModels, MODELS_DIR);
      }
    }
  } catch (err) {
    console.error('[migrate]', err);
  }
}

function writeSettings(settings) {
  ensureDirs();
  const current = readSettings();
  // 与现有设置合并后统一规范化：数组整体替换、未知字段丢弃、越界值收敛
  const next = normalizeSettings(deepMerge(current, settings || {}), DEFAULT_SETTINGS);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ------------------------------------------------------------
// 本地静态文件服务（Live2D 模型 / 头像），解决 file:// 下 fetch/wasm 受限问题
// ------------------------------------------------------------
const MIME = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.moc3': 'application/octet-stream',
  '.mtn': 'application/octet-stream',
  '.tga': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

let modelServer = null;
let modelBaseUrl = 'http://127.0.0.1:0';

function startModelServer() {
  return new Promise((resolve) => {
    modelServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath = null;
      if (urlPath.startsWith('/models/')) {
        filePath = path.join(MODELS_DIR, urlPath.slice('/models/'.length));
      } else if (urlPath.startsWith('/avatars/')) {
        filePath = path.join(AVATARS_DIR, urlPath.slice('/avatars/'.length));
      }
      if (!filePath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      const resolved = path.normalize(filePath);
      const insideModels = resolved === MODELS_DIR || resolved.startsWith(MODELS_DIR + path.sep);
      const insideAvatars = resolved === AVATARS_DIR || resolved.startsWith(AVATARS_DIR + path.sep);
      if (!insideModels && !insideAvatars) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      fs.stat(resolved, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        const ext = path.extname(resolved).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(resolved).pipe(res);
      });
    });
    modelServer.listen(0, '127.0.0.1', () => {
      modelBaseUrl = 'http://127.0.0.1:' + modelServer.address().port;
      resolve();
    });
  });
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
  ipcMain.handle('overlay:status', () => ({
    visible: !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()),
    interactive: overlayInteractive,
  }));
  ipcMain.handle('overlay:toggle', () => toggleOverlayWindow());
  ipcMain.handle('overlay:hide', () => { destroyOverlayWindow(); return false; });
  ipcMain.handle('overlay:hitArea', (_e, rect) => {
    if (!rect || typeof rect !== 'object') { overlayHit = null; return null; }
    overlayHit = {
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      w: Math.max(0, Number(rect.w) || 0),
      h: Math.max(0, Number(rect.h) || 0),
    };
    return overlayHit;
  });
  ipcMain.handle('overlay:setIgnore', (_e, ignore) => {
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
  ipcMain.handle('overlay:interactive', (_e, on) => {
    overlayInteractive = !!on;
    // 只影响本次运行，不写进设置（见上面的理由）
    setOverlayIgnore(!overlayShouldCapture());
    broadcastOverlayState();
    return overlayInteractive;
  });
  ipcMain.handle('overlay:setModel', (_e, model) => {
    overlayModel = model && model.url ? { url: String(model.url), name: String(model.name || '') } : null;
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:model', overlayModel);
    return true;
  });
  ipcMain.handle('overlay:getState', () => ({
    model: overlayModel,
    overlay: overlaySettings(),
    theme: readSettings().theme || {},
    language: readSettings().language || 'en',
  }));
  ipcMain.handle('overlay:resize', async (_e, payload) => {
    const dw = Math.round((payload && payload.dw) || 0);
    const dh = Math.round((payload && payload.dh) || 0);
    return resizeOverlayBy(dw, dh);
  });
  ipcMain.handle('overlay:reset', async () => {
    if (!overlayWin || overlayWin.isDestroyed()) return null;
    const width = 380;
    const height = 640;
    const area = screen.getPrimaryDisplay().workArea;
    const x = area.x + area.width - width - 28;
    const y = area.y + area.height - height - 28;
    writeSettings({ overlay: { x: null, y: null, width, height } });
    return await applyOverlayBounds({ x, y, width, height });
  });
  ipcMain.handle('overlay:dragStart', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return false;
    const pt = screen.getCursorScreenPoint();
    const b = overlayWin.getBounds();
    overlayDrag = { dx: pt.x - b.x, dy: pt.y - b.y };
    armDragTimeout();
    setOverlayIgnore(false);
    return true;
  });
  ipcMain.handle('overlay:dragMove', () => {
    if (!overlayDrag || !overlayWin || overlayWin.isDestroyed()) return false;
    const pt = screen.getCursorScreenPoint();
    overlayWin.setPosition(Math.round(pt.x - overlayDrag.dx), Math.round(pt.y - overlayDrag.dy));
    armDragTimeout();
    return true;
  });
  ipcMain.handle('overlay:dragEnd', () => {
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
  ipcMain.handle('mc:connect', (_e, opts) => mcBot.connect(opts));
  ipcMain.handle('mc:disconnect', () => mcBot.disconnect());
  ipcMain.handle('mc:status', () => mcBot.status());
  ipcMain.handle('mc:say', (_e, text) => mcBot.say(text));
  ipcMain.handle('mc:follow', (_e, name) => mcBot.follow(name));
  ipcMain.handle('mc:stopFollow', () => mcBot.stopFollow());
  ipcMain.handle('mc:step', (_e, payload) => mcBot.step(payload && payload.dir, payload && payload.ms));
  ipcMain.handle('mc:jump', () => mcBot.jump());
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

  // 自检模式：AILEEN_SELFTEST=1 时加载完成后截图 + 收集诊断信息并退出（用于无头验证）
  if (process.env.AILEEN_SELFTEST) {
    const consoleLines = [];
    win.webContents.on('console-message', (event, ...args) => {
      const params = args[0];
      const message = params && typeof params === 'object' && 'message' in params ? params.message : args[1];
      consoleLines.push(String(message));
    });
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const SELFTEST_DIR = process.env.AILEEN_SELFTEST_DIR || path.join(USER_DATA_DIR, 'selftest');
          fs.mkdirSync(SELFTEST_DIR, { recursive: true });
          // AILEEN_SELFTEST_SHOT=<弹窗名> 时先把那个弹窗打开再截图，方便肉眼看排版（例如 char 看人设生成那一行）
          const shotModal = process.env.AILEEN_SELFTEST_SHOT;
          if (shotModal) {
            // 走渲染层自己的 open 函数（这样表单/选项才会被真正填好），没有的才退化成直接显示
            const okShot = await win.webContents.executeJavaScript(
              'window.__AILEEN_OPEN ? window.__AILEEN_OPEN(' + JSON.stringify(shotModal) + ') : false',
            ).catch(() => false);
            console.log('[selftest] shot modal ' + shotModal + ': ' + okShot);
            await new Promise((r) => setTimeout(r, 800));
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(SELFTEST_DIR, 'shot.png'), img.toPNG());
          console.log('[selftest] saved shot.png to ' + SELFTEST_DIR);
        } catch (e) {
          console.error('[selftest] capture failed:', e);
        }
        try {
          const diag = await win.webContents.executeJavaScript(`(async () => {
            await new Promise((r) => setTimeout(r, 400));
            const q = (s) => document.querySelectorAll(s);
            const stage = document.getElementById('stage-container');
            const canvas = stage ? stage.querySelector('canvas') : null;
            // 点击测试：新建角色按钮 → 角色弹窗应打开
            let modalOpensOnNewCard = false;
            const newCardBtn = document.getElementById('btn-new-card');
            if (newCardBtn) {
              newCardBtn.click();
              modalOpensOnNewCard = !document.getElementById('modal-char').classList.contains('hidden');
              const cancel = document.getElementById('f-cancel');
              if (cancel) cancel.click();
            }
            // 点击测试：设置菜单 → 各设置弹窗
            const modalOpens = { menu: false, llm: false, tts: false, stt: false, model: false, theme: false, perform: false };
            const menuBtn = document.getElementById('btn-settings-menu');
            if (menuBtn) {
              menuBtn.click();
              modalOpens.menu = !document.getElementById('modal-menu').classList.contains('hidden');
            }
            document.querySelectorAll('#modal-menu .menu-list button[data-target]').forEach((btn) => {
              const target = btn.dataset.target;
              btn.click();
              if (target) modalOpens[target.replace('modal-', '')] = !document.getElementById(target).classList.contains('hidden');
            });
            // 收尾：强制关掉被点开的弹窗，回到干净状态再做行为断言
            ['modal-about', 'modal-llm', 'modal-tts', 'modal-stt', 'modal-model', 'modal-theme', 'modal-perform', 'modal-persona', 'modal-menu'].forEach((id) => {
              const el = document.getElementById(id);
              if (el) el.classList.add('hidden');
            });
            // 行为断言①：从设置菜单进子页面，关闭后应退回菜单（旧版会直接甩回聊天界面）
            let subModalReturnsToMenu = false;
            const llmEntry = document.querySelector('#modal-menu .menu-list button[data-target="modal-llm"]');
            if (llmEntry) {
              llmEntry.click();
              const llmWasOpen = !document.getElementById('modal-llm').classList.contains('hidden');
              document.getElementById('s-llm-cancel').click();
              subModalReturnsToMenu = llmWasOpen && !document.getElementById('modal-menu').classList.contains('hidden');
            }
            // 行为断言②：外观调色是即时预览，「取消」必须把颜色还原（旧版取消后颜色不回滚）
            let themeCancelRestores = false;
            const themeEntry = document.querySelector('#modal-menu .menu-list button[data-target="modal-theme"]');
            if (themeEntry) {
              const accentBefore = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
              themeEntry.click();
              const pIn = document.getElementById('t-primary');
              pIn.value = '#00ff00';
              pIn.dispatchEvent(new Event('input', { bubbles: true }));
              const preview = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
              document.getElementById('t-cancel').click();
              const accentAfter = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
              themeCancelRestores = preview !== accentBefore && accentAfter === accentBefore;
            }
            // 行为断言③：Minecraft 伙伴弹窗能打开，主进程 IPC 可用
            let mcStatusOk = false;
            let mcModalOk = false;
            try {
              const mst = await window.api.mcStatus();
              mcStatusOk = !!mst && typeof mst.connected === 'boolean';
              const mcEntry = document.querySelector('#modal-menu .menu-list button[data-action="mc"]');
              if (mcEntry) {
                mcEntry.click();
                mcModalOk = !document.getElementById('modal-mc').classList.contains('hidden');
                document.getElementById('mc-close').click();
              }
            } catch (err) { window.__AILEEN_ERRORS.push('mcTest: ' + String((err && err.message) || err)); }
            // 行为断言④：i18n 与象棋 —— 默认英文、语言切换器在、没有漏翻的 key、棋盘 64 格
            // 行为断言⑥：加载完 #typing（正在思考…）必须是隐藏的
            const typingHidden = document.getElementById('typing').classList.contains('hidden');
            let langOk = false;
            let repLangAttr = '';
            let repLangWant = '';
            let i18nMissing = 0;
            let langSwitchCount = 0;
            let chessModalOk = false;
            let chessSquares = 0;
            try {
              const lsBox = document.getElementById('lang-switch');
              langSwitchCount = lsBox ? lsBox.children.length : 0;
              document.querySelectorAll('[data-i18n]').forEach((el) => {
                if (el.textContent.trim() === el.getAttribute('data-i18n')) i18nMissing += 1;
              });
              const chessEntry = document.querySelector('#modal-menu .menu-list button[data-action="chess"]');
              if (chessEntry) {
                chessEntry.click();
                chessSquares = document.querySelectorAll('#chess-board .csq').length;
                chessModalOk = !document.getElementById('modal-chess').classList.contains('hidden') && chessSquares === 64;
                document.getElementById('chess-close').click();
              }
              const curLang = ((await window.api.getSettings()) || {}).language || 'en';
              const wantLang = curLang === 'zh' ? 'zh-CN' : curLang;
              repLangAttr = document.documentElement.lang;
              repLangWant = wantLang;
              langOk = document.documentElement.lang === wantLang;
            } catch (err) { window.__AILEEN_ERRORS.push('i18nTest: ' + String((err && err.message) || err)); }
            // 行为断言⑤：语言切换真的生效（日文 / 中文 / 英文各点一遍，并检查有无回退到 key）
            let langSwitchWorks = false;
            let jaText = '';
            let zhText = '';
            let jaMissingKeys = -1;
            try {
              const pickBtn = (i) => document.querySelectorAll('#lang-switch button')[i];
              const probe = () => document.querySelector('[data-i18n="menu.mc"]');
              if (pickBtn(0) && pickBtn(1) && pickBtn(2)) {
                pickBtn(1).click();
                await new Promise((r) => setTimeout(r, 500));
                jaText = probe() ? probe().textContent : '';
                jaMissingKeys = Array.from(document.querySelectorAll('[data-i18n]')).filter((el) => el.textContent.trim() === el.getAttribute('data-i18n')).length;
                pickBtn(2).click();
                await new Promise((r) => setTimeout(r, 500));
                zhText = probe() ? probe().textContent : '';
                pickBtn(0).click();
                await new Promise((r) => setTimeout(r, 500));
                langSwitchWorks = !!jaText && !!zhText && jaText !== zhText && jaMissingKeys === 0;
              }
            } catch (err) { window.__AILEEN_ERRORS.push('langTest: ' + String((err && err.message) || err)); }
            // 行为断言⑦：新界面 —— 折叠、搜索过滤、舞台换模型/缩放、重新生成、状态点
            // 行为断言⑧：对话内核 —— 标记解析在打包产物里可用（标记跨 chunk + 摘除）
            // 行为断言⑨：表演设置可调 —— 打开弹窗、改档位、保存后设置真的变了
            // 行为断言⑩：界面没有被隐形元素遮挡（「点都点不了」探测器）
            // 用 elementFromPoint 在几个关键位置做命中测试，命中的元素必须落在 #app 里。
            // 如果某个固定定位的弹窗/遮罩没被正确隐藏，这里就会抓到。
            // 行为断言⑬：不使用模型 —— 这一档必须真的把舞台清空
            let noModelOk = false;
            let noModelDetail = null;
            try {
              noModelDetail = typeof window.__AILEEN_PROBE_NOMODEL === 'function' ? await window.__AILEEN_PROBE_NOMODEL() : null;
              noModelOk = !!noModelDetail && noModelDetail.hasOption === true && noModelDetail.stageHasOption === true
                && noModelDetail.modelIsNull === true && noModelDetail.disabledFlag === true
                && noModelDetail.stageCleared === true && noModelDetail.placeholder === true;
            } catch (err) { window.__AILEEN_ERRORS.push('noModelTest: ' + String((err && err.message) || err)); }
            // 行为断言⑫：人设生成室 —— 设置入口 / 原型选择 / 锁定真的改变提示词
            let studioOk = false;
            let studioDetail = null;
            try {
              studioDetail = typeof window.__AILEEN_PROBE_STUDIO === 'function' ? window.__AILEEN_PROBE_STUDIO() : null;
              studioOk = !!studioDetail && studioDetail.hasEntry === true && studioDetail.opened === true
                && studioDetail.chips >= 11 && studioDetail.roleChips >= 11 && studioDetail.genders >= 4
                && studioDetail.hasLock === true && studioDetail.hasSeed === true
                && studioDetail.lockedHasRule === true && studioDetail.softHasRule === true
                && studioDetail.lockedNotSoft === true && studioDetail.canUnpick === true
                && studioDetail.unpicked === true && !!studioDetail.picked
                && studioDetail.knownVisible === true && studioDetail.originalHidden === true
                && studioDetail.relOptions >= 9 && studioDetail.formMode === 'known'
                && studioDetail.formChar === '凉宫春日' && studioDetail.formRel === 'lover'
                && studioDetail.formUser === '小满'
                && studioDetail.knownPromptOk === true && studioDetail.relPromptOk === true
                && studioDetail.knownNoArchetype === true && studioDetail.backToOriginal === true;
            } catch (err) { window.__AILEEN_ERRORS.push('studioTest: ' + String((err && err.message) || err)); }
            // 行为断言⑪：自动生成人设 —— 解析器容错 + 生成结果能回填进编辑器
            let personaOk = false;
            let personaDetail = null;
            try {
              const parseProbe = typeof window.__AILEEN_PROBE_PERSONA === 'function' ? window.__AILEEN_PROBE_PERSONA() : null;
              let pcOpened = false;
              let filled = '';
              if (typeof window.__AILEEN_PROBE_PERSONA_APPLY === 'function') {
                document.getElementById('btn-new-card').click();
                pcOpened = !document.getElementById('modal-char').classList.contains('hidden');
                window.__AILEEN_PROBE_PERSONA_APPLY({ name: 'PROBE', description: 'D', personality: 'P', scenario: 'S', first_mes: 'F', mes_example: 'M' });
                filled = ['f-name', 'f-desc', 'f-personality', 'f-scenario', 'f-first', 'f-example'].map((id) => document.getElementById(id).value).join('|');
                document.getElementById('f-cancel').click();
              }
              personaDetail = {
                parsed: parseProbe, opened: pcOpened, filled,
                hasSeed: !!document.getElementById('f-seed'),
                hasBtn: !!document.getElementById('f-generate'),
              };
              personaOk = !!parseProbe && parseProbe.name === '阿岚' && !parseProbe.scenario
                && pcOpened && filled === 'PROBE|D|P|S|F|M' && personaDetail.hasSeed && personaDetail.hasBtn;
            } catch (err) { window.__AILEEN_ERRORS.push('personaTest: ' + String((err && err.message) || err)); }
            let uiBlockedBy = [];
            try {
              // 先回到「静止状态」：把所有弹窗关掉，再测有没有东西挡住界面
              document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
              const pts = [[160, 60], [200, 300], [420, 120], [420, 500], [900, 80], [900, 400], [1150, 300]];
              for (const p of pts) {
                const el = document.elementFromPoint(p[0], p[1]);
                if (!el) continue;
                if (el === document.body || el === document.documentElement) continue;
                if (!el.closest('#app')) {
                  uiBlockedBy.push((el.id || el.className || el.tagName) + '@' + p[0] + ',' + p[1]);
                }
              }
            } catch (err) { window.__AILEEN_ERRORS.push('hitTest: ' + String((err && err.message) || err)); }
            let performOk = false;
            let performDetail = null;
            try {
              const entry = document.querySelector('#modal-menu .menu-list button[data-target="modal-perform"]');
              if (entry) {
                entry.click();
                const opened = !document.getElementById('modal-perform').classList.contains('hidden');
                const narrOpts = document.querySelectorAll('#p-narration option').length;
                const paceOpts = document.querySelectorAll('#p-pacing option').length;
                const before = (((await window.api.getSettings()) || {}).behavior) || {};
                document.getElementById('p-narration').value = 'off';
                document.getElementById('p-pacing').value = 'rare';
                document.getElementById('p-save').click();
                await new Promise((r) => setTimeout(r, 500));
                const after = (((await window.api.getSettings()) || {}).behavior) || {};
                performDetail = { opened, narrOpts, paceOpts, before: before.narration, after: after.narration, afterPace: after.pacing };
                performOk = opened && narrOpts === 4 && paceOpts === 3 && after.narration === 'off' && after.pacing === 'rare';
                // 还原成默认，别把用户设置留在测试档位
                document.getElementById('p-narration').value = 'natural';
                document.getElementById('p-pacing').value = 'natural';
                document.getElementById('p-save').click();
                await new Promise((r) => setTimeout(r, 500));
              }
            } catch (err) { window.__AILEEN_ERRORS.push('performTest: ' + String((err && err.message) || err)); }
            let pacerProbeOk = false;
            let pacerProbeDetail = null;
            try {
              if (typeof window.__AILEEN_PROBE_PACER === 'function') {
                const pp = await window.__AILEEN_PROBE_PACER();
                pacerProbeDetail = pp;
                pacerProbeOk = pp.text === '在？算了没事' && pp.breaks === 1 && pp.waits.join(',') === '2000';
              }
            } catch (err) { window.__AILEEN_ERRORS.push('pacerProbe: ' + String((err && err.message) || err)); }
            let markerProbeOk = false;
            let markerProbeDetail = null;
            try {
              if (typeof window.__AILEEN_PROBE_MARKERS === 'function') {
                const pr = window.__AILEEN_PROBE_MARKERS();
                markerProbeDetail = pr;
                markerProbeOk = pr.text === 'ABC' && pr.kinds.join(',') === 'motion,expr';
              }
            } catch (err) { window.__AILEEN_ERRORS.push('markerProbe: ' + String((err && err.message) || err)); }
            let uiElementsOk = false;
            let sideCollapseOk = false;
            let searchFilterOk = false;
            try {
              uiElementsOk = ['btn-regen', 'stage-model', 'stage-scale', 'chat-status', 'char-search', 'drop-hint', 'btn-expand-sidebar', 'btn-expand-stage']
                .every((id) => !!document.getElementById(id));
              const app = document.getElementById('app');
              const cs = document.getElementById('btn-collapse-sidebar');
              cs.click();
              const collapsed = app.classList.contains('side-collapsed');
              const handleShown = !document.getElementById('btn-expand-sidebar').classList.contains('hidden');
              cs.click();
              sideCollapseOk = collapsed && handleShown && !app.classList.contains('side-collapsed');
              // CI 用的是全新数据目录，可能一张角色卡都没有 ——
              // 那就先自己造一张，否则这个断言在空列表下是空转，还会误报失败。
              let before = document.querySelectorAll('#char-list .char-item').length;
              let tempFile = null;
              if (before === 0) {
                const wr = await window.api.writeCharacter('_uifilter', { name: 'UI filter probe', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', system_prompt: '', model: '', voice: '', createdAt: Date.now(), updatedAt: Date.now() }, 'create');
                tempFile = (wr && wr.file) || '_uifilter.json';
                if (typeof window.__AILEEN_REFRESH === 'function') await window.__AILEEN_REFRESH();
                await new Promise((r) => setTimeout(r, 250));
                before = document.querySelectorAll('#char-list .char-item').length;
              }
              const searchEl = document.getElementById('char-search');
              searchEl.value = 'zzz-no-such-character';
              searchEl.dispatchEvent(new Event('input', { bubbles: true }));
              const none = document.querySelectorAll('#char-list .char-item').length;
              searchEl.value = '';
              searchEl.dispatchEvent(new Event('input', { bubbles: true }));
              const all = document.querySelectorAll('#char-list .char-item').length;
              searchFilterOk = before > 0 && none === 0 && all === before;
              if (tempFile) {
                await window.api.deleteCharacter(tempFile);
                if (typeof window.__AILEEN_REFRESH === 'function') await window.__AILEEN_REFRESH();
              }
            } catch (err) { window.__AILEEN_ERRORS.push('uiTest: ' + String((err && err.message) || err)); }
            ['t-cancel', 'm-cancel', 'menu-cancel'].forEach((id) => {
              const el = document.getElementById(id);
              if (el) el.click();
            });
            const themeVar = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
            // 角色卡菜单 + 快捷更换测试（临时建卡→点⋯→菜单→更换→清理）
            let charMenuOk = false;
            let quickModalOk = false;
            let menuSubText = '';
            try {
              const writeRes = await window.api.writeCharacter('_selftest', { name: '自检角色', description: '测试', personality: '', scenario: '', first_mes: '', mes_example: '', system_prompt: '', model: '', voice: '', createdAt: Date.now(), updatedAt: Date.now() }, 'create');
              const testFileName = (writeRes && writeRes.file) ? writeRes.file : '_selftest.json';
              if (typeof window.__AILEEN_REFRESH === 'function') await window.__AILEEN_REFRESH();
              await new Promise((r) => setTimeout(r, 200));
              const testItem = Array.from(document.querySelectorAll('#char-list .char-item')).find((it) => it.dataset.file === testFileName);
              if (testItem) {
                const moreBtn = testItem.querySelector('.ci-more');
                if (moreBtn) {
                  moreBtn.click();
                  charMenuOk = !document.getElementById('char-menu').classList.contains('hidden');
                  const quickBtn = Array.from(document.querySelectorAll('#char-menu button[data-act]')).find((b) => b.dataset.act === 'quick');
                  if (quickBtn) { quickBtn.click(); quickModalOk = !document.getElementById('modal-quick').classList.contains('hidden'); }
                }
              }
              await window.api.deleteCharacter(testFileName);
              if (typeof window.__AILEEN_REFRESH === 'function') await window.__AILEEN_REFRESH();
              const subLlm = document.getElementById('menu-sub-llm');
              if (subLlm) menuSubText = subLlm.textContent.trim();
            } catch (err) { window.__AILEEN_ERRORS.push('charMenuTest: ' + String(err && err.message || err)); }
            // 设置持久化测试：写入 apiKey → 读回 → 还原
            let settingsPersist = false;
            try {
              const cur = await window.api.getSettings();
              const testKey = 'test-key-' + Date.now();
              const merged = Object.assign({}, cur, { llm: Object.assign({}, cur.llm, { apiKey: testKey }) });
              await window.api.setSettings(merged);
              const back = await window.api.getSettings();
              settingsPersist = !!(back && back.llm && back.llm.apiKey === testKey);
              await window.api.setSettings(cur);
            } catch (err) { window.__AILEEN_ERRORS.push('settingsTest: ' + String(err && err.message || err)); }
            // Base URL 默认收起（未勾选自定义时输入框应隐藏）
            let llmBaseHidden = 'n/a';
            const wLlm = document.getElementById('wrap-llm-base');
            if (wLlm) {
              const menuBtn2 = document.getElementById('btn-settings-menu');
              if (menuBtn2) menuBtn2.click();
              const target = document.querySelector('#modal-menu .menu-list button[data-target="modal-llm"]');
              if (target) target.click();
              llmBaseHidden = wLlm.classList.contains('hidden');
              const llmCancel = document.getElementById('s-llm-cancel');
              if (llmCancel) llmCancel.click();
            }
            const stageRect = stage ? { w: stage.clientWidth, h: stage.clientHeight } : null;
            const providerOptions = q('#s-llm-provider option').length;
            const ttsLangOptions = q('#s-tts-language option').length;
            const sttLangOptions = q('#s-stt-language option').length;
            const realtimeBtn = !!document.getElementById('btn-realtime');
            const screenshotBtn = !!document.getElementById('btn-screenshot');
            const addModelBtn = !!document.getElementById('btn-add-model');
            const modalsExist =
              !!document.getElementById('modal-llm') && !!document.getElementById('modal-tts') && !!document.getElementById('modal-stt');
            const datalistLlm = q('#dl-llm-models option').length;
            let screenSources = 'n/a';
            try {
              const sr = await window.api.captureScreen();
              screenSources = Array.isArray(sr) ? sr.length : (sr && sr.error ? 'ERR:' + sr.error : 'none');
            } catch (err) { screenSources = 'EXC:' + String(err && err.message || err); }
            return {
              title: document.title,
              chatName: (document.getElementById('chat-name') || {}).textContent || '',
              charCount: q('#char-list .char-item').length,
              charNames: Array.from(q('#char-list .ci-name')).map((e) => e.textContent),
              modelOptions: q('#m-model option').length,
              modelSelectValue: (document.getElementById('m-model') || {}).value,
              motionChips: q('#motion-chips .chip').length,
              motionGroups: Array.from(q('#motion-chips .chip')).map((e) => e.dataset.motion),
              exprChips: q('#expr-chips .chip').length,
              stageChildren: stage ? stage.children.length : 0,
              canvasCount: q('canvas').length,
              canvasSize: canvas ? canvas.width + 'x' + canvas.height : 'none',
              stageRect,
              canvasPosition: canvas ? (canvas.getBoundingClientRect().width + 'x' + canvas.getBoundingClientRect().height) : 'none',
              messages: q('#messages .msg').length,
              firstMessage: (q('#messages .msg')[0] || {}).textContent || '',
              emptyHint: (q('#messages .msg')[0] || {}).textContent || '',
              modalOpensOnNewCard,
              modalOpens,
              subModalReturnsToMenu,
              themeCancelRestores,
              mcStatusOk,
              mcModalOk,
              typingHidden,
              langOk,
              langAttr: repLangAttr,
              langWant: repLangWant,
              i18nMissing,
              langSwitchCount,
              chessModalOk,
              chessSquares,
              langSwitchWorks,
              uiElementsOk,
              markerProbeOk,
              markerProbeDetail,
              pacerProbeOk,
              pacerProbeDetail,
              performOk,
              performDetail,
              personaOk,
              personaDetail,
              studioOk,
              studioDetail,
              noModelOk,
              noModelDetail,
              uiBlockedBy,
              sideCollapseOk,
              searchFilterOk,
              jaText,
              zhText,
              jaMissingKeys,
              themeVar,
              llmBaseHidden,
              charMenuOk,
              quickModalOk,
              menuSubText,
              settingsPersist,
              providerOptions,
              ttsLangOptions,
              sttLangOptions,
              realtimeBtn,
              screenshotBtn,
              addModelBtn,
              modalsExist,
              datalistLlm,
              screenSources,
              errors: (window.__AILEEN_ERRORS || []).slice(0, 10),
              modelReady: typeof window.__AILEEN_MODEL_READY === 'function' ? !!window.__AILEEN_MODEL_READY() : 'n/a',
            };
          })()`);
          const SELFTEST_DIR2 = process.env.AILEEN_SELFTEST_DIR || path.join(USER_DATA_DIR, 'selftest');
          fs.writeFileSync(path.join(SELFTEST_DIR2, 'shot.json'), JSON.stringify(diag, null, 2));
          fs.writeFileSync(path.join(SELFTEST_DIR2, 'console.log'), consoleLines.join('\n'));
        } catch (e) {
          console.error('[selftest] diag failed:', e);
        }
        // 无边框悬浮展台自检：真的开一个窗口，验证可见性、热区上报、穿透状态、可移动、可截图
        try {
          const DIR3 = process.env.AILEEN_SELFTEST_DIR || path.join(USER_DATA_DIR, 'selftest');
          const rep = {
            opened: false, visible: false, title: '', bounds: null, hitArea: null,
            ignoringByDefault: null, toolsExists: false, gripExists: false,
            canvasCount: 0, moved: false, modelSynced: false, errors: [],
            // 打包门禁：证明运行期依赖真的被塞进 asar 且能在 Electron 里 require 成功
            mineflayer: (function () { try { require('mineflayer'); return true; } catch (e) { return String((e && e.message) || e); } })(),
            pathfinder: (function () { try { require('mineflayer-pathfinder'); return true; } catch (e) { return String((e && e.message) || e); } })(),
          };
          // 删除本地模型：真建一个临时模型目录，走 IPC 删掉，再确认它真的没了；
          // 顺便把所有越界路径试一遍 —— 这是唯一会真删用户文件的接口，必须挡住。
          try {
            // CI 用的是全新数据目录，一个模型都没有 —— 先记下来，后面决定哪些断言可以跳过
            rep.modelsAvailable = scanModels(MODELS_DIR, '').length > 0;
            const tmpDir = path.join(MODELS_DIR, '__selftest_del');
            fs.mkdirSync(tmpDir, { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'model.json'), '{"version":"Sample 1.0.0"}');
            rep.modelDeleteBefore = scanModels(MODELS_DIR, '').length;
            const after = await win.webContents.executeJavaScript('window.api.deleteModel({ dir: "__selftest_del" })');
            rep.modelDeleteOk = !fs.existsSync(tmpDir) && Array.isArray(after) && !after.some((m) => String(m.file).indexOf('__selftest_del') === 0);
            rep.modelDeleteAfter = Array.isArray(after) ? after.length : null;
            const guard = await win.webContents.executeJavaScript(
              '(async function(){ var tries=["..","../characters","characters","C:/Windows","__nope__"]; var out=[];'
              + ' for (var i=0;i<tries.length;i++){ try { await window.api.deleteModel({dir:tries[i]}); out.push([tries[i],"ALLOWED"]); }'
              + ' catch (e) { out.push([tries[i],"blocked"]); } } return out; })()',
            );
            rep.modelDeleteGuard = guard;
            rep.modelDeleteGuardOk = Array.isArray(guard) && guard.every((x) => x[1] === 'blocked');
            rep.charactersDirIntact = fs.existsSync(CHARACTERS_DIR);
          } catch (err) { rep.errors.push('model delete: ' + String((err && err.message) || err)); }
          // F11 全屏：1) 菜单里必须真的绑了 F11；2) 全屏开关本身必须有效
          try {
            const menu = Menu.getApplicationMenu();
            const items = [];
            const walk = (m) => { if (m && m.items) m.items.forEach((it) => { items.push(it); if (it.submenu) walk(it.submenu); }); };
            walk(menu);
            const fsItem = items.find((it) => it.role === 'togglefullscreen' || String(it.accelerator || '').toUpperCase() === 'F11');
            rep.fullscreenItem = fsItem ? { role: fsItem.role, accelerator: fsItem.accelerator } : null;
            rep.fullscreenAccelOk = !!(fsItem && String(fsItem.accelerator || '').toUpperCase() === 'F11');
            const wasFull = win.isFullScreen();
            win.setFullScreen(!wasFull);
            await new Promise((r) => setTimeout(r, 500));
            rep.fullscreenToggleOk = win.isFullScreen() === !wasFull;
            win.setFullScreen(wasFull);
            await new Promise((r) => setTimeout(r, 400));
          } catch (err) { rep.errors.push('fullscreen: ' + String((err && err.message) || err)); }
          if (process.env.AILEEN_SELFTEST_OVERLAY) {
            const w = createOverlayWindow();
            rep.opened = !!w;
            if (w) {
              // 展台的报错只在它自己的控制台里，主进程默认看不到 —— 收进来，否则永远查不出「模型出不来」
              rep.consoleLines = [];
              w.webContents.on('console-message', (event, ...args) => {
                const params = args[0];
                const msg = params && typeof params === 'object' && 'message' in params ? params.message : args[1];
                if (rep.consoleLines.length < 40) rep.consoleLines.push(String(msg));
              });
              await new Promise((r) => setTimeout(r, 5000));
              rep.visible = w.isVisible();
              rep.title = w.getTitle();
              rep.bounds = w.getBounds();
              rep.hitArea = overlayHit;
              rep.ignoringByDefault = overlayIgnoring;
              rep.interactiveMode = overlayInteractive;
              rep.cursorInHit = overlayCursorInHit();
              rep.hitAreaSizeOk = !!(overlayHit && overlayHit.w > 20 && overlayHit.h > 10);
              rep.watchRunning = !!overlayWatch;
              rep.shouldCapture = overlayShouldCapture();
              rep.rendererIgnoreRequests = overlayIgnoreRequests;
              rep.modelSynced = !!overlayModel;
              try {
                rep.toolsExists = await w.webContents.executeJavaScript('!!document.getElementById("ov-tools")');
                rep.gripExists = await w.webContents.executeJavaScript('!!document.getElementById("ov-grip")');
                rep.canvasCount = await w.webContents.executeJavaScript('document.querySelectorAll("#ov-stage canvas").length');
                rep.bodyPointerEvents = await w.webContents.executeJavaScript('getComputedStyle(document.body).pointerEvents');
              } catch (err) { rep.errors.push(String((err && err.message) || err)); }
              // ① −/＋ 走的程序化缩放通道必须有效（applyOverlayBounds 就是按钮的入口）
              try {
                const b0 = w.getBounds();
                await applyOverlayBounds({ x: b0.x, y: b0.y, width: b0.width + 40, height: b0.height + 64 });
                await new Promise((r) => setTimeout(r, 300));
                const b1 = w.getBounds();
                // Windows 会给无边框窗口加隐形边框，回读值允许几像素误差
                const near = (a, b2, tol) => Math.abs(a - b2) <= tol;
                rep.programmaticResizeOk = near(b1.width, b0.width + 40, 6) && near(b1.height, b0.height + 64, 6);
                // 关键：改完尺寸必须回到「用户不能缩放」状态
                rep.userResizeDisabled = !w.isResizable();
                rep.resizeProbe = {
                  b0: [b0.width, b0.height],
                  b1: [b1.width, b1.height],
                  want: [b0.width + 40, b0.height + 64],
                  expected: overlayExpectedSize ? [overlayExpectedSize.width, overlayExpectedSize.height] : null,
                  persisted: [overlaySettings().width, overlaySettings().height],
                };
                rep.userResizable = w.isResizable();
                // 关键不变量：交互热区必须离窗口边缘足够远
                rep.hitMarginRight = overlayHit ? Math.round(b1.width - (overlayHit.x + overlayHit.w)) : -1;
                rep.hitMarginBottom = overlayHit ? Math.round(b1.height - (overlayHit.y + overlayHit.h)) : -1;
                // 改完尺寸后必须仍然是穿透的（setResizable 会重置 Windows 窗口样式）
                rep.ignoringAfterResize = overlayIgnoring;
                // ② 模拟系统把窗口意外放大（Aero Snap / 拖动越界），兜底必须把它弹回去
                const beforeGuard = w.getBounds();
                overlayProgrammaticUntil = 0;
                w.setBounds({ x: beforeGuard.x, y: beforeGuard.y, width: beforeGuard.width + 300, height: beforeGuard.height + 200 });
                await new Promise((r) => setTimeout(r, 1300));
                const afterGuard = w.getBounds();
                // 弹回允许几像素误差（无边框窗口的隐形边框），但要确认确实缩小回来了
                rep.snapBackOk = near(afterGuard.width, beforeGuard.width, 10) && near(afterGuard.height, beforeGuard.height, 10);
                await applyOverlayBounds(b0);
              } catch (err) { rep.errors.push('resize: ' + String((err && err.message) || err)); }
              const before = w.getBounds();
              overlayDrag = { dx: 10, dy: 10 };
              w.setPosition(before.x - 60, before.y - 40);
              const after = w.getBounds();
              rep.moved = after.x !== before.x || after.y !== before.y;
              // 移动/拖拽之后也必须仍然是穿透的
              rep.ignoringAfterMove = overlayIgnoring;
              overlayDrag = null;
              // 自检改过尺寸，把持久化值复位成创建时的尺寸，避免跑多轮后越漂越大
              if (rep.bounds) {
                try { writeSettings({ overlay: { width: rep.bounds.width, height: rep.bounds.height } }); } catch (err) { /* ignore */ }
              }
              // ③ 展台必须**真的把模型画出来**：只看 canvas 存不存在不够 ——
              //    曾经出现过 canvas 在、画面一片空白的情况。
              try {
                rep.canvasMetrics = await w.webContents.executeJavaScript('(function(){'
                  + 'var c = document.querySelector("#ov-stage canvas");'
                  + 'if (!c) return null;'
                  + 'var r = c.getBoundingClientRect(); var cs = getComputedStyle(c);'
                  + 'var s = document.getElementById("ov-stage"); var b = s.getBoundingClientRect();'
                  + 'return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],'
                  + ' attr: [c.width, c.height],'
                  + ' css: { position: cs.position, left: cs.left, top: cs.top, width: cs.width, height: cs.height, transform: cs.transform, display: cs.display, zIndex: cs.zIndex },'
                  + ' stage: [Math.round(b.width), Math.round(b.height)],'
                  + ' inner: [window.innerWidth, window.innerHeight],'
                  + ' empty: !!document.querySelector(".ov-empty") };'
                  + '})()');
              } catch (err) { rep.errors.push('canvas metrics: ' + String((err && err.message) || err)); }
              try {
                // 模型加载是异步的：先轮询等它真的挂上去再断言（固定等待会时快时慢地误报）。
                // 上限给到 30 秒 —— CI runner 比本机慢，宁可多等也不要假红。
                for (let i = 0; i < 60; i += 1) {
                  const ready = await w.webContents.executeJavaScript('window.__AILEEN_OVERLAY_READY ? window.__AILEEN_OVERLAY_READY() : false').catch(() => false);
                  if (ready) break;
                  await new Promise((r) => setTimeout(r, 500));
                }
                rep.overlayProbe = await w.webContents.executeJavaScript('window.__AILEEN_OVERLAY_PROBE ? window.__AILEEN_OVERLAY_PROBE() : null');
                // 「模型画出来了」这条断言只在真的装了模型时才有意义：
                // CI 是全新技术目录（零模型），硬要求像素就等于要求一个不可能的事。
                // 但「展台不该被当成手机」这条任何环境都必须成立 —— 那才是模型完全不加载的元凶。
                rep.modelRenderedOk = rep.modelsAvailable
                  ? !!(rep.overlayProbe && rep.overlayProbe.renderedOk === true && rep.overlayProbe.stageChildren > 0)
                  : 'skipped:no-model-installed';
                rep.overlayMqOk = !!(rep.overlayProbe && rep.overlayProbe.mqMobile === false);
                rep.overlayEmptyOk = rep.modelsAvailable ? null : !!(rep.overlayProbe && rep.overlayProbe.emptyHint === true);
                rep.mainWindowMq = await win.webContents.executeJavaScript('({ mq: window.matchMedia("screen and (max-width: 768px)").matches, screen: [window.screen.width, window.screen.height] })').catch(() => null);
              } catch (err) { rep.errors.push('overlay probe: ' + String((err && err.message) || err)); }
              await new Promise((r) => setTimeout(r, 400));
              try {
                const shot = await w.webContents.capturePage();
                fs.writeFileSync(path.join(DIR3, 'overlay.png'), shot.toPNG());
                // 展台整窗除了模型和右下角工具条之外全是透明的，
                // 所以「画面中段出现不透明像素」就等于模型真的画出来了（工具条在底部，按 y 切开）
                const bmp = shot.toBitmap();
                const size = shot.getSize();
                let painted = 0;
                let paintedCenter = 0;
                for (let y = 0; y < size.height; y += 2) {
                  for (let x = 0; x < size.width; x += 2) {
                    if (bmp[(y * size.width + x) * 4 + 3] > 8) {
                      painted += 1;
                      if (y < size.height * 0.75) paintedCenter += 1;
                    }
                  }
                }
                rep.paintedPixels = painted;
                rep.paintedCenter = paintedCenter;
                // capturePage 抓不到透明窗口里的 WebGL 图层，所以它只作参考；
                // 「模型真的画出来了」以渲染器自己的帧缓冲为准（见上面的 fb 探针）。
                rep.modelPaintedOk = paintedCenter > 500;
              } catch (err) { rep.errors.push('capture: ' + String((err && err.message) || err)); }
              destroyOverlayWindow();
            }
          }
          fs.writeFileSync(path.join(DIR3, 'overlay.json'), JSON.stringify(rep, null, 2));
          console.log('[selftest] overlay report: ' + JSON.stringify(rep));
        } catch (e) {
          console.error('[selftest] overlay failed:', e);
        }
        app.quit();
      }, Number(process.env.AILEEN_SELFTEST_MS || 9000));
    });
  }
  return win;
}

// ------------------------------------------------------------
// IPC
// ------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    modelBaseUrl,
    modelsDir: MODELS_DIR,
    charactersDir: CHARACTERS_DIR,
    avatarsDir: AVATARS_DIR,
    dataDir: DATA_DIR,
    userDataDir: USER_DATA_DIR,
    appRoot: APP_ROOT,
    version: app.getVersion(),
  }));

  ipcMain.handle('models:list', () => {
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
  ipcMain.handle('models:addFolder', async () => {
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
  ipcMain.handle('models:addUrl', (_e, payload) => {
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
  ipcMain.handle('models:removeUrl', (_e, url) => {
    const s = readSettings();
    s.extraModels = (s.extraModels || []).filter((m) => m.url !== String(url || ''));
    writeSettings(s);
    return [...scanModels(MODELS_DIR, ''), ...s.extraModels.map((m) => ({ name: m.name, file: m.url, url: m.url, source: 'url' }))];
  });

  // 删除本地模型：连同磁盘上的文件夹一起删。
  // 这是唯一一个会真删用户文件的接口，所以路径校验必须死板：
  // 只接受 models/ 下第一层目录名，绝不允许越出 models 之外。
  ipcMain.handle('models:delete', (_e, target) => {
    const raw = String((target && (target.dir || target.file || target.name)) || '').trim();
    if (!raw) throw new Error('无效的模型路径');
    const first = raw.split(/[\\/]+/).filter(Boolean)[0];
    if (!first || first === '.' || first === '..') throw new Error('无效的模型路径');
    const modelsRoot = path.normalize(MODELS_DIR);
    const dir = path.normalize(path.join(MODELS_DIR, first));
    if (dir === modelsRoot || !dir.startsWith(modelsRoot + path.sep)) {
      throw new Error('拒绝操作 models 目录以外的路径');
    }
    if (!fs.existsSync(dir)) throw new Error('模型文件夹不存在');
    // 二次保险：确认它真的是个模型目录，别让手滑删掉别的什么
    const looksLikeModel = scanModels(dir, '').length > 0;
    if (!looksLikeModel) throw new Error('这个文件夹里没有 Live2D 模型文件，已中止');
    fs.rmSync(dir, { recursive: true, force: true });
    return scanModels(MODELS_DIR, '');
  });

  // 屏幕捕获（视觉功能）
  ipcMain.handle('screen:capture', async () => {
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

  ipcMain.handle('characters:list', () => listCharacters());

  ipcMain.handle('characters:write', (_e, payload) => {
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

  ipcMain.handle('characters:delete', (_e, file) => {
    const safe = path.basename(String(file || ''));
    const full = path.join(CHARACTERS_DIR, safe);
    if (full.startsWith(CHARACTERS_DIR + path.sep) && fs.existsSync(full)) {
      fs.unlinkSync(full);
    }
    return true;
  });

  ipcMain.handle('characters:chooseAvatar', async () => {
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

  ipcMain.handle('characters:export', async (_e, data) => {
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

  ipcMain.handle('characters:import', async () => {
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

  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', (_e, settings) => {
    const next = writeSettings(settings);
    // 语言变了要重建原生菜单
    if (next && next.language !== appMenuLang) { appMenuLang = next.language; buildAppMenu(appMenuLang); }
    return next;
  });

  registerOverlayIpc();
  registerMcIpc();

  // 仅允许打开用户数据目录内的路径（防止渲染层被利用打开任意程序/文件）
  ipcMain.handle('shell:openPath', async (_e, p) => {
    if (typeof p !== 'string' || !p) return false;
    const target = path.resolve(p);
    if (!isInsidePath(target, USER_DATA_DIR) && !isInsidePath(target, APP_ROOT)) return false;
    return shell.openPath(target);
  });

  // 聊天记录持久化（按角色存文件，避免 localStorage 容量/清缓存丢失）
  ipcMain.handle('chat:read', (_e, file) => {
    const safe = sanitizeFileName(String(file || '').replace(/\.json$/, ''));
    const full = path.join(CHATS_DIR, safe + '.json');
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  });

  ipcMain.handle('chat:write', (_e, payload) => {
    const { file, messages } = payload || {};
    const safe = sanitizeFileName(String(file || '').replace(/\.json$/, ''));
    const full = path.join(CHATS_DIR, safe + '.json');
    if (!isInsidePath(full, CHATS_DIR)) throw new Error('非法路径');
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    const list = Array.isArray(messages) ? messages.slice(-2000) : [];
    fs.writeFileSync(full, JSON.stringify(list), 'utf8');
    return true;
  });

  ipcMain.handle('chat:clear', (_e, file) => {
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
