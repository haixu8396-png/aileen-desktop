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
    } else if (entry.isFile() && /.(model3|model).json$/i.test(entry.name)) {
      const rel = (prefix ? prefix + '/' : '') + entry.name;
      results.push({
        name: prefix || entry.name.replace(/\.(model3|model)\.json$/i, ''),
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

function persistOverlayBounds() {
  if (overlayPersistTimer) clearTimeout(overlayPersistTimer);
  overlayPersistTimer = setTimeout(() => {
    overlayPersistTimer = null;
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const b = overlayWin.getBounds();
    try { writeSettings({ overlay: { x: b.x, y: b.y, width: b.width, height: b.height } }); }
    catch (err) { console.error('[overlay] persist failed:', err); }
  }, 400);
}

function broadcastOverlayState() {
  const visible = !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible());
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('overlay:state', { visible, interactive: overlayInteractive });
  }
}

function setOverlayIgnore(ignore) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayIgnoring === ignore) return;
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
  overlayInteractive = !!overlaySettings().interactive;
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
    // 拖动「越拖越大」的根因：手柄贴在窗口右下角，正好压在 Windows 无边框窗口的
    // 缩放手柄上，按住它系统就当缩放处理。解决办法不是禁用缩放（那样 setBounds 也会失效，
    // −/＋ 按钮就废了），而是把工具条从边缘内缩 20px，彻底避开缩放边框（见 overlay.css）。
    resizable: true,
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
    writeSettings({ overlay: { interactive: overlayInteractive } });
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
  ipcMain.handle('overlay:resize', (_e, payload) => {
    if (!overlayWin || overlayWin.isDestroyed()) return null;
    const b = overlayWin.getBounds();
    const dw = Math.round((payload && payload.dw) || 0);
    const dh = Math.round((payload && payload.dh) || 0);
    const width = Math.min(1400, Math.max(220, b.width + dw));
    const height = Math.min(1600, Math.max(260, b.height + dh));
    // 以右下角为锚点缩放
    const next = { x: b.x + (b.width - width), y: b.y + (b.height - height), width, height };
    overlayWin.setBounds(next);
    persistOverlayBounds();
    return overlayWin.getBounds();
  });
  ipcMain.handle('overlay:reset', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return null;
    const width = 380;
    const height = 640;
    const area = screen.getPrimaryDisplay().workArea;
    const x = area.x + area.width - width - 28;
    const y = area.y + area.height - height - 28;
    writeSettings({ overlay: { x: null, y: null, width, height } });
    overlayWin.setBounds({ x, y, width, height });
    return overlayWin.getBounds();
  });
  ipcMain.handle('overlay:dragStart', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return false;
    const pt = screen.getCursorScreenPoint();
    const b = overlayWin.getBounds();
    overlayDrag = { dx: pt.x - b.x, dy: pt.y - b.y };
    setOverlayIgnore(false);
    return true;
  });
  ipcMain.handle('overlay:dragMove', () => {
    if (!overlayDrag || !overlayWin || overlayWin.isDestroyed()) return false;
    const pt = screen.getCursorScreenPoint();
    overlayWin.setPosition(Math.round(pt.x - overlayDrag.dx), Math.round(pt.y - overlayDrag.dy));
    return true;
  });
  ipcMain.handle('overlay:dragEnd', () => {
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
        { label: M.model, click: () => sendMenuAction('model') },
        { label: M.theme, click: () => sendMenuAction('theme') },
      ],
    },
    {
      label: M.stageGroup,
      submenu: [
        { label: M.toggleStage, accelerator: 'CmdOrCtrl+Shift+S', click: () => toggleOverlayWindow() },
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
        { role: 'togglefullscreen', label: M.fullscreen },
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
            const modalOpens = { menu: false, llm: false, tts: false, stt: false, model: false, theme: false };
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
            ['modal-about', 'modal-llm', 'modal-tts', 'modal-stt', 'modal-model', 'modal-theme', 'modal-menu'].forEach((id) => {
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
              langOk = document.documentElement.lang === 'en';
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
              i18nMissing,
              langSwitchCount,
              chessModalOk,
              chessSquares,
              langSwitchWorks,
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
          if (process.env.AILEEN_SELFTEST_OVERLAY) {
            const w = createOverlayWindow();
            rep.opened = !!w;
            if (w) {
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
              // resizable:false 之后 −/＋ 仍必须能改尺寸（走 setBounds）
              try {
                const b0 = w.getBounds();
                w.setBounds({ x: b0.x, y: b0.y, width: b0.width + 40, height: b0.height + 64 });
                const b1 = w.getBounds();
                rep.programmaticResizeOk = (b1.width === b0.width + 40 && b1.height === b0.height + 64);
                rep.userResizable = w.isResizable();
                // 关键不变量：交互热区必须离窗口边缘足够远，否则会压到系统的缩放手柄上
                rep.hitMarginRight = overlayHit ? Math.round(b1.width - (overlayHit.x + overlayHit.w)) : -1;
                rep.hitMarginBottom = overlayHit ? Math.round(b1.height - (overlayHit.y + overlayHit.h)) : -1;
                w.setBounds(b0);
              } catch (err) { rep.errors.push('resize: ' + String((err && err.message) || err)); }
              const before = w.getBounds();
              overlayDrag = { dx: 10, dy: 10 };
              w.setPosition(before.x - 60, before.y - 40);
              const after = w.getBounds();
              rep.moved = after.x !== before.x || after.y !== before.y;
              overlayDrag = null;
              try {
                const shot = await w.webContents.capturePage();
                fs.writeFileSync(path.join(DIR3, 'overlay.png'), shot.toPNG());
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
