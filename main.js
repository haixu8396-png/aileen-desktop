// ============================================================
// Elysia — Electron 主进程
// 职责: 窗口管理 / 本地静态文件服务(模型与头像) / 角色卡与设置持久化
// ============================================================
const { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const { sanitizeFileName, deepMerge, isInsidePath, normalizeSettings } = require('./shared/util.cjs');

const APP_ROOT = __dirname;
const DIST_INDEX = path.join(APP_ROOT, 'dist', 'index.html');

// 用户数据目录：使用 Electron userData，应用升级/重装/移动都不会丢失设置、角色卡、模型
app.setName('Elysia');
const DEFAULT_USER_DATA = app.getPath('userData');

// 数据目录优先级：环境变量 ELYSIA_DATA_DIR > D:\ElysiaData（仅当 D 盘存在）> 系统默认 userData
function resolveUserDataDir() {
  const envDir = process.env.ELYSIA_DATA_DIR;
  if (typeof envDir === 'string' && envDir.trim()) return envDir.trim();
  try {
    if (fs.existsSync('D:\\')) return 'D:/ElysiaData';
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

// 首次启动时，把旧版（应用目录内）的数据迁移到 userData，之后以 userData 为准
function migrateLegacyData() {
  try {
    // 从旧版默认 userData（%APPDATA%\Elysia）迁移到当前目录（如 D:\ElysiaData）
    const oldUserData = path.join(process.env.APPDATA || '', 'Elysia');
    if (oldUserData !== USER_DATA_DIR && fs.existsSync(oldUserData)) {
      const oldSettings = path.join(oldUserData, 'data', 'settings.json');
      if (!fs.existsSync(SETTINGS_FILE) && fs.existsSync(oldSettings)) {
        fs.copyFileSync(oldSettings, SETTINGS_FILE);
      }
      const oldChars = path.join(oldUserData, 'characters');
      const hasChars = fs.existsSync(CHARACTERS_DIR) && fs.readdirSync(CHARACTERS_DIR).some((n) => n.endsWith('.json'));
      if (!hasChars && fs.existsSync(oldChars)) {
        copyDirRec(oldChars, CHARACTERS_DIR);
      }
      const oldModels = path.join(oldUserData, 'models');
      const hasModels = fs.existsSync(MODELS_DIR) && fs.readdirSync(MODELS_DIR).length > 0;
      if (!hasModels && fs.existsSync(oldModels)) {
        copyDirRec(oldModels, MODELS_DIR);
      }
    }
    const legacySettings = path.join(APP_ROOT, 'data', 'settings.json');
    if (!fs.existsSync(SETTINGS_FILE) && fs.existsSync(legacySettings)) {
      fs.copyFileSync(legacySettings, SETTINGS_FILE);
    }
    const legacyChars = path.join(APP_ROOT, 'characters');
    const hasChars = fs.existsSync(CHARACTERS_DIR) && fs.readdirSync(CHARACTERS_DIR).some((n) => n.endsWith('.json'));
    if (!hasChars && fs.existsSync(legacyChars)) {
      copyDirRec(legacyChars, CHARACTERS_DIR);
    }
    const legacyModels = path.join(APP_ROOT, 'models');
    const hasModels = fs.existsSync(MODELS_DIR) && fs.readdirSync(MODELS_DIR).length > 0;
    if (!hasModels && fs.existsSync(legacyModels)) {
      copyDirRec(legacyModels, MODELS_DIR);
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
function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    title: 'Elysia',
    backgroundColor: '#14151a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELYSIA_DEV_URL) {
    win.loadURL(process.env.ELYSIA_DEV_URL);
  } else if (fs.existsSync(DIST_INDEX)) {
    win.loadFile(DIST_INDEX);
  } else {
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<h3 style="font-family:sans-serif">未找到构建产物，请先运行 <code>npm run build</code></h3>'
    ));
  }

  // 自检模式：ELYSIA_SELFTEST=1 时加载完成后截图 + 收集诊断信息并退出（用于无头验证）
  if (process.env.ELYSIA_SELFTEST) {
    const consoleLines = [];
    win.webContents.on('console-message', (event, ...args) => {
      const params = args[0];
      const message = params && typeof params === 'object' && 'message' in params ? params.message : args[1];
      consoleLines.push(String(message));
    });
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const SELFTEST_DIR = process.env.ELYSIA_SELFTEST_DIR || path.join(USER_DATA_DIR, 'selftest');
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
            document.querySelectorAll('#modal-menu .menu-list button').forEach((btn) => {
              const target = btn.dataset.target;
              btn.click();
              if (target) modalOpens[target.replace('modal-', '')] = !document.getElementById(target).classList.contains('hidden');
            });
            ['menu-cancel', 'm-cancel', 't-cancel'].forEach((id) => {
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
              if (typeof window.__ELYSIA_REFRESH === 'function') await window.__ELYSIA_REFRESH();
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
              if (typeof window.__ELYSIA_REFRESH === 'function') await window.__ELYSIA_REFRESH();
              const subLlm = document.getElementById('menu-sub-llm');
              if (subLlm) menuSubText = subLlm.textContent.trim();
            } catch (err) { window.__ELYSIA_ERRORS.push('charMenuTest: ' + String(err && err.message || err)); }
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
            } catch (err) { window.__ELYSIA_ERRORS.push('settingsTest: ' + String(err && err.message || err)); }
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
              errors: (window.__ELYSIA_ERRORS || []).slice(0, 10),
              modelReady: typeof window.__ELYSIA_MODEL_READY === 'function' ? !!window.__ELYSIA_MODEL_READY() : 'n/a',
            };
          })()`);
          const SELFTEST_DIR2 = process.env.ELYSIA_SELFTEST_DIR || path.join(USER_DATA_DIR, 'selftest');
          fs.writeFileSync(path.join(SELFTEST_DIR2, 'shot.json'), JSON.stringify(diag, null, 2));
          fs.writeFileSync(path.join(SELFTEST_DIR2, 'console.log'), consoleLines.join('\n'));
        } catch (e) {
          console.error('[selftest] diag failed:', e);
        }
        app.quit();
      }, Number(process.env.ELYSIA_SELFTEST_MS || 9000));
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

  ipcMain.handle('characters:read', (_e, file) => {
    const safe = path.basename(String(file || ''));
    const full = path.join(CHARACTERS_DIR, safe);
    if (!full.startsWith(CHARACTERS_DIR + path.sep) || !fs.existsSync(full)) return null;
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  });

  // 写入角色卡：mode='update' 覆盖指定文件；否则同名自动加序号，绝不静默覆盖
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
  ipcMain.handle('settings:set', (_e, settings) => writeSettings(settings));

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

  // 授予麦克风权限
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (modelServer) modelServer.close();
});
