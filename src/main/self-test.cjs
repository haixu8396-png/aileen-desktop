'use strict';
// ============================================================
// 自检（diagnostics / self-test）—— **不属于生产逻辑**
//
// 为什么单独一个文件：
//   · 它只在 AILEEN_SELFTEST=1 时执行，平时一行都不该跑；
//   · 它要读一堆窗口与 overlay 的内部状态，混在 createWindow 里会让
//     「窗口创建」和「无头验证」纠缠在一起，谁也不敢改；
//   · 它是一整套断言（几十项），放在主流程文件里把真正的业务流程淹没了。
//
// 依赖全部**注入**进来（见 deps），所以这个文件不认识主进程的内部变量，
// 也不需要在主进程里为它开一堆导出。
//
// 产物：<SELFTEST_DIR>/shot.png、shot.json、console.log、overlay.json
// 常用环境变量：
//   AILEEN_SELFTEST=1            开自检
//   AILEEN_SELFTEST_MS           等界面就绪的毫秒数（默认 9000）
//   AILEEN_SELFTEST_DIR          产物目录
//   AILEEN_SELFTEST_SHOT=<名字>   截图前先打开某个弹窗/界面
//   AILEEN_SELFTEST_OVERLAY=1    额外跑无边框展台自检
//   AILEEN_SELFTEST_LIVE_LLM=1   额外打一次真实 LLM 链路
// ============================================================

/**
 * 挂上自检：界面加载完成后截图 + 收集诊断 + （可选）展台自检，然后退出。
 * @param {object} win   BrowserWindow
 * @param {object} deps  注入的依赖
 * @param {object} deps.opts        { userDataDir, appRoot, distIndex }
 * @param {object} deps.settings    { readSettings, writeSettings, settingsForRenderer, settingsFile,
 *                                    encryptionAvailable, secretPrefix, secretClear, resolveSecretPatch }
 * @param {object} deps.overlay     overlay 内部状态与操作（hitArea/ignoring/... 见下）
 * @param {object} deps.models      { modelsDir, charactersDir, scanModels }
 */
function attachSelfTest(win, deps) {
// 把注入进来的依赖摊成局部名字：下面这一大段是从 main.js 原样搬过来的，
// 它读的就是这些名字（readSettings / MODELS_DIR / overlayHit …）。
// overlay 的内部状态一律走取值函数 —— 它们会变，直接传值会快照过期数据。
const { opts = {}, settings = {}, models = {}, overlay = {}, deps: host = {} } = deps || {};
const { fs, path, crypto, Menu, app } = host;
const {
  readSettings, writeSettings, settingsForRenderer,
  settingsFile: SETTINGS_FILE, encryptionAvailable,
  secretPrefix: SECRET_PREFIX, secretClear: SECRET_CLEAR, resolveSecretPatch,
} = settings;
const { modelsDir: MODELS_DIR, charactersDir: CHARACTERS_DIR, scanModels } = models;
// ZIP 导入探针要调 models.importZip（和「从 ZIP 导入」按钮同一条安装路径）
const { userDataDir: USER_DATA_DIR } = opts;
// 注意：这些是 main.js 注入进来的**取值函数**（getter），用的时候必须调用！
// 曾经这里把它们当值用（rep.hitArea = overlayHit），于是
//   · JSON.stringify 把函数整个丢掉 → 报告里字段直接消失；
//   · `overlayHit.w > 20` 永远 false → 热区断言永远失败；
//   · `!!overlayWatch` 永远 true → 假绿灯。
// 一条 `overlayDrag = ...` 的赋值还会直接抛 TypeError，把整个展台自检打死。
const getOverlayHit = overlay.getHit;
const getOverlayIgnoring = overlay.getIgnoring;
const getOverlayInteractive = overlay.getInteractive;
const getOverlayModel = overlay.getModel;
const getOverlayWatch = overlay.getWatch;
const getOverlayExpectedSize = overlay.getExpectedSize;
const getOverlayIgnoreRequests = overlay.getIgnoreRequests;
const overlayCursorInHit = overlay.getCursorInHit;
const overlayShouldCapture = overlay.getShouldCapture;
const overlaySettings = overlay.getSettings;
const setProgrammaticUntil = overlay.setProgrammaticUntil;
const setOverlayDrag = overlay.setDrag;
// 假光标：拖动回归用（真机没法托着鼠标跑脚本）
const setOverlayCursor = overlay.setCursor;
const applyOverlayBounds = overlay.applyBounds;
const setOverlaySize = overlay.setSize;
const clampOverlaySizeFn = overlay.clampSize;
const getOverlayBounds = overlay.getBounds;
// 拖动提示框（拖动时只有它在动，展台原地不动）
const getOverlayGhost = overlay.getGhost;
const getOverlayGhostVisible = overlay.getGhostVisible;
const getWorkArea = overlay.getWorkArea;
const pushOverlayLive2D = overlay.pushLive2D || (() => false);
const getOverlayLive2D = overlay.getLive2D || (() => ({}));
const createOverlayWindow = overlay.createWindow;
const destroyOverlayWindow = overlay.destroyWindow;

// ------------------------------------------------------------
// 「从 ZIP 导入模型」端到端探针（真机路径，不弹对话框）
//
// 造一个最小的 zip（store 方式，含 haru/haru.model3.json + moc3 + 贴图），
// 走和按钮同一条 importModelZipFile()，然后确认：目录建出来了、scanModels 能扫到、
// 清理之后又消失。坏包也要验：没有 model3.json 的 zip 必须被拒且不留残留目录。
// ------------------------------------------------------------
function makeStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localOffset = offset;
    locals.push(local, nameBuf, raw);
    offset += 30 + nameBuf.length + raw.length;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, nameBuf);
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), cdBuf, eocd]);
}

async function probeModelZipImport() {
  const zipHost = require('node:os').tmpdir();
  const goodZip = path.join(zipHost, 'aileen-selftest-model-' + Date.now() + '.zip');
  const badZip = path.join(zipHost, 'aileen-selftest-bad-' + Date.now() + '.zip');
  const modelJson = JSON.stringify({ Version: 3, FileReferences: { Moc: 'haru.moc3', Textures: ['textures/00.png'] } });
  const good = makeStoredZip([
    { name: 'haru/haru.model3.json', data: modelJson },
    { name: 'haru/haru.moc3', data: Buffer.from([1, 2, 3, 4, 5]) },
    { name: 'haru/textures/00.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) },
  ]);
  const bad = makeStoredZip([{ name: 'notes.txt', data: 'no model here' }]);
  fs.writeFileSync(goodZip, good);
  fs.writeFileSync(badZip, bad);
  const out = { good: null, badRejected: false, cleanedUp: false };
  let importedDir = null;
  try {
    const res = models.importZip(goodZip);
    importedDir = path.join(models.modelsDir, res.name);
    const listed = models.scanModels(models.modelsDir, '');
    out.good = {
      name: res.name,
      file: res.file,
      files: res.files,
      dirExists: fs.existsSync(importedDir),
      configExists: fs.existsSync(path.join(importedDir, 'haru.model3.json')),
      textureExists: fs.existsSync(path.join(importedDir, 'textures', '00.png')),
      listed: listed.some((m) => m.name === res.name),
      noTempLeft: fs.readdirSync(models.modelsDir).every((n) => !n.startsWith('.import-')),
    };
    try { models.importZip(badZip); out.badError = null; } catch (err) { out.badRejected = /model3\.json|model\.json/.test(String(err && err.message)); out.badError = String(err && err.message); }
    out.noTempAfterBad = fs.readdirSync(models.modelsDir).every((n) => !n.startsWith('.import-'));
  } finally {
    try { fs.unlinkSync(goodZip); } catch (err) { /* ignore */ }
    try { fs.unlinkSync(badZip); } catch (err) { /* ignore */ }
    if (importedDir) { try { fs.rmSync(importedDir, { recursive: true, force: true }); } catch (err) { /* ignore */ } }
    out.cleanedUp = importedDir ? !fs.existsSync(importedDir) : true;
  }
  return out;
}
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
        // 「agent」截图：权限弹层 + 对话里的活动卡（含审批卡片）一起摆出来
        if (shotModal === 'agent') {
          try {
            await win.webContents.executeJavaScript(
              'window.__AILEEN_PREVIEW_APPROVAL ? window.__AILEEN_PREVIEW_APPROVAL() : false',
            );
            await win.webContents.executeJavaScript(
              'window.__AILEEN_OPEN ? window.__AILEEN_OPEN("agent-panel") : false',
            );
          } catch (err) { console.warn('[selftest] agent preview failed:', err); }
        }
        // 「dashboard」截图：只摆对话里的活动卡（正在执行 + 等确认）
        if (shotModal === 'dashboard') {
          try {
            await win.webContents.executeJavaScript(
              'window.__AILEEN_PREVIEW_DASHBOARD ? window.__AILEEN_PREVIEW_DASHBOARD() : false',
            );
          } catch (err) { console.warn('[selftest] dashboard preview failed:', err); }
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      // capturePage 偶发 UnknownVizError（窗口用 showInactive 显示、表面还没合成好）——
      // 重试几次，别因为一次截图失败就把整个自检判成「没生成诊断文件」。
      let img = null;
      for (let attempt = 0; attempt < 4 && !img; attempt += 1) {
        try {
          img = await win.webContents.capturePage();
        } catch (err) {
          console.warn('[selftest] capture retry ' + (attempt + 1) + ':', err && err.message);
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      if (!img) throw new Error('capturePage 连续失败');
      fs.writeFileSync(path.join(SELFTEST_DIR, 'shot.png'), img.toPNG());
      console.log('[selftest] saved shot.png to ' + SELFTEST_DIR);
    } catch (e) {
      console.error('[selftest] capture failed:', e);
    }
    // 窄窗口再量一次横向溢出：用户截图里那种「底部一条横向滚动条」只在窄窗口出现，
    // 宽窗口量不出来。量完把窗口尺寸还原，免得影响后面的断言与截图。
    let narrowScroll = null;
    try {
      const before = win.getBounds();
      win.setSize(920, 700);
      await new Promise((r) => setTimeout(r, 700));
      narrowScroll = await win.webContents.executeJavaScript(
        'window.__AILEEN_HSCROLL ? window.__AILEEN_HSCROLL() : null',
      );
      win.setBounds(before);
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.warn('[selftest] narrow scroll probe failed:', err && err.message);
    }
    // ZIP 导入模型：真机路径探针（结果注入到下面的诊断脚本里）
    let zipProbe = null;
    try { zipProbe = await probeModelZipImport(); } catch (err) { zipProbe = { error: String((err && err.message) || err) }; }
    try {
      const diag = await win.webContents.executeJavaScript(`(async () => {
        await new Promise((r) => setTimeout(r, 400));
        const q = (s) => document.querySelectorAll(s);
        const pageOn = (name) => {
          const el = document.getElementById('page-' + name);
          return !!el && el.classList.contains('on');
        };
        const secOn = (name) => {
          const el = document.getElementById('set-' + name);
          return !!el && el.classList.contains('on');
        };
        // 点击测试：新建角色 → 进入**角色编辑页**（不再是弹窗）
        let modalOpensOnNewCard = false;
        const newCardBtn = document.getElementById('btn-new-card');
        if (newCardBtn) {
          newCardBtn.click();
          modalOpensOnNewCard = pageOn('char-edit') && !!document.getElementById('f-name');
          const cancel = document.getElementById('f-cancel');
          if (cancel) cancel.click();
        }
        // 点击测试：设置入口 → 设置页；分类切换 → 对应的设置区块
        const modalOpens = { menu: false, llm: false, tts: false, stt: false, model: false, theme: false, perform: false };
        const menuBtn = document.getElementById('btn-settings-menu');
        if (menuBtn) {
          menuBtn.click();
          modalOpens.menu = pageOn('settings');
        }
        const pickSec = (sec) => {
          const b = document.querySelector('#settings-nav button[data-sec="' + sec + '"]');
          if (b) b.click();
          return secOn(sec);
        };
        modalOpens.llm = pickSec('models');
        modalOpens.theme = pickSec('appearance');
        modalOpens.perform = pickSec('companion');
        modalOpens.tts = pickSec('voice');
        modalOpens.stt = secOn('voice') && !!document.getElementById('s-stt-provider');
        modalOpens.model = pickSec('stage') && !!document.getElementById('m-model');
        // 行为断言①：设置页里切换分类，仍然停在设置页（不会甩回聊天）
        let subModalReturnsToMenu = false;
        try {
          pickSec('models');
          const wasSec = secOn('models');
          pickSec('appearance');
          subModalReturnsToMenu = wasSec && pageOn('settings') && secOn('appearance');
        } catch (err) { window.__AILEEN_ERRORS.push('settingsNav: ' + String((err && err.message) || err)); }
        // 行为断言②：主题是即时预览，「取消」必须把颜色还原
        let themeCancelRestores = false;
        let themeModeOk = false;
        let themeDetail = null;
        let colorInstantOk = false;
        let colorInstantDetail = null;
        try {
          pickSec('appearance');
          const root = document.documentElement;
          const accentBefore = getComputedStyle(root).getPropertyValue('--accent').trim();
          const pIn = document.getElementById('t-primary');
          pIn.value = '#00ff00';
          pIn.dispatchEvent(new Event('input', { bubbles: true }));
          const preview = getComputedStyle(root).getPropertyValue('--accent').trim();
          document.getElementById('t-cancel').click();
          const accentAfter = getComputedStyle(root).getPropertyValue('--accent').trim();
          themeDetail = { accentBefore, preview, accentAfter, inline: root.style.getPropertyValue('--accent'), accentAttr: root.getAttribute('data-accent') };
          themeCancelRestores = preview !== accentBefore && accentAfter === accentBefore;
          // 主题模式：点「暖暗色」→ data-theme=dark；点回原来的模式（别改用户的偏好）
          const origMode = (((await window.api.getSettings()) || {}).appearance || {}).mode || 'light';
          const darkBtn = document.querySelector('#theme-mode-switch button[data-mode="dark"]');
          const lightBtn = document.querySelector('#theme-mode-switch button[data-mode="light"]');
          const restoreBtn = document.querySelector('#theme-mode-switch button[data-mode="' + origMode + '"]');
          if (darkBtn && lightBtn) {
            darkBtn.click();
            await new Promise((r) => setTimeout(r, 120));
            const darkOk = root.getAttribute('data-theme') === 'dark';
            (restoreBtn || lightBtn).click();
            await new Promise((r) => setTimeout(r, 120));
            themeModeOk = darkOk && root.getAttribute('data-theme') === (origMode === 'dark' ? 'dark' : 'light');
          }
        } catch (err) { window.__AILEEN_ERRORS.push('themeTest: ' + String((err && err.message) || err)); }
        // 强调色必须**点下去当帧**就变，不能等 IPC 回来才刷新（否则看起来慢一拍）
        try {
          const sage = document.querySelector('#theme-presets .theme-swatch[data-accent="sage"]');
          const rose = document.querySelector('#theme-presets .theme-swatch[data-accent="rose"]');
          if (sage) {
            const before = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
            sage.click();
            await new Promise((r) => setTimeout(r, 60));
            const after = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
            const onList = Array.from(document.querySelectorAll('#theme-presets .theme-swatch.on')).map((x) => x.dataset.accent);
            colorInstantDetail = { before, after, onList, sageConnected: sage.isConnected };
            colorInstantOk = after !== before && onList.length === 1 && onList[0] === 'sage';
            if (rose) rose.click();
            await new Promise((r) => setTimeout(r, 300));
          }
        } catch (err) { window.__AILEEN_ERRORS.push('colorInstant: ' + String((err && err.message) || err)); }
        // 行为断言③：Minecraft / 国际象棋都在「设备与扩展」页里，IPC 可用
        let mcStatusOk = false;
        let mcModalOk = false;
        try {
          const mst = await window.api.mcStatus();
          mcStatusOk = !!mst && typeof mst.connected === 'boolean';
          document.querySelector('#side-nav .nav-item[data-page="devices"]').click();
          mcModalOk = pageOn('devices') && !!document.getElementById('mc-host') && !!document.getElementById('mc-connect');
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
          const chessBoard = document.getElementById('chess-board');
          chessSquares = chessBoard ? chessBoard.querySelectorAll('.csq').length : 0;
          chessModalOk = pageOn('devices') && chessSquares === 64;
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
          const probe = () => document.querySelector('[data-i18n="nav.chat"]');
          const origLang = (((await window.api.getSettings()) || {}).language) || 'en';
          const order = ['en', 'ja', 'zh'];
          const restoreIndex = Math.max(0, order.indexOf(origLang));
          if (pickBtn(0) && pickBtn(1) && pickBtn(2)) {
            pickBtn(1).click();
            await new Promise((r) => setTimeout(r, 500));
            jaText = probe() ? probe().textContent : '';
            jaMissingKeys = Array.from(document.querySelectorAll('[data-i18n]')).filter((el) => el.textContent.trim() === el.getAttribute('data-i18n')).length;
            pickBtn(2).click();
            await new Promise((r) => setTimeout(r, 500));
            zhText = probe() ? probe().textContent : '';
            // 切回**用户原来的语言**（别把语言测试结果当成用户偏好存下去）
            pickBtn(restoreIndex).click();
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
        // 行为断言⑭：聊天消息区必须真的能上下滚动（内容撑高后仍被限制在窗口内）
        let scrollOk = false;
        let scrollDetail = null;
        try {
          scrollDetail = typeof window.__AILEEN_PROBE_SCROLL === 'function' ? window.__AILEEN_PROBE_SCROLL() : null;
          scrollOk = !!scrollDetail && /auto|scroll/.test(String(scrollDetail.overflowY))
            && scrollDetail.contentTaller === true && scrollDetail.canScrollDown === true
            && scrollDetail.canScrollUp === true && scrollDetail.fitsWindow === true;
        } catch (err) { window.__AILEEN_ERRORS.push('scrollTest: ' + String((err && err.message) || err)); }
        // 行为断言⑬：不使用模型 —— 这一档必须真的把舞台清空
        let noModelOk = false;
        let noModelDetail = null;
        try {
          noModelDetail = typeof window.__AILEEN_PROBE_NOMODEL === 'function' ? await window.__AILEEN_PROBE_NOMODEL() : null;
          noModelOk = !!noModelDetail && noModelDetail.hasOption === true
            && noModelDetail.modelIsNull === true && noModelDetail.disabledFlag === true
            && noModelDetail.overlayModelIsNull === true && noModelDetail.restored === true;
        } catch (err) { window.__AILEEN_ERRORS.push('noModelTest: ' + String((err && err.message) || err)); }
        // 行为断言⑮：点亮「电脑控制」开关要立刻变 —— 输入区的 Agent 按钮跟着亮、
        // 弹层里的主开关跟着亮、**但桌面上不出现侧边控制台**
        let toggleOk = false;
        let toggleDetail = null;
        try {
          toggleDetail = typeof window.__AILEEN_PROBE_COMPUTER_TOGGLE === 'function'
            ? await window.__AILEEN_PROBE_COMPUTER_TOGGLE() : null;
          toggleOk = !!toggleDetail && toggleDetail.error === undefined
            && toggleDetail.baselineChipOff === true
            && toggleDetail.noSideConsole === true
            && toggleDetail.settingOn === true
            && toggleDetail.btnHighlighted === true
            && toggleDetail.chipOn === true
            && toggleDetail.mainWindowHasNoStage === true
            && toggleDetail.panelOpenedByChip === true
            && toggleDetail.panelMasterChecked === true
            && !!toggleDetail.afterOff
            && toggleDetail.afterOff.settingOff === true
            && toggleDetail.afterOff.chipOff === true
            && toggleDetail.afterOff.masterOff === true
            && toggleDetail.afterOff.stageAlwaysSeparate === true
            && toggleDetail.btnClickable === true;
        } catch (err) { window.__AILEEN_ERRORS.push('toggleTest: ' + String((err && err.message) || err)); }

        // 行为断言⑭：对话里的活动卡由状态驱动 + 角色人格保留
        let dashOk = false;
        let dashDetail = null;
        try {
          dashDetail = typeof window.__AILEEN_PROBE_DASHBOARD === 'function'
            ? await window.__AILEEN_PROBE_DASHBOARD() : null;
          dashOk = !!dashDetail && dashDetail.error === undefined
            && dashDetail.personaFound === true
            && dashDetail.personaFirst === true
            && dashDetail.assertOk === true
            && dashDetail.personaChars > 20
            && dashDetail.toolCount >= 17
            && dashDetail.cardHiddenBeforeRun === true
            && dashDetail.cardVisibleDuringRun === true
            && dashDetail.cardRunning === true
            && dashDetail.stageIsSeparateWindow === true
            && dashDetail.approvalShown === true
            && dashDetail.logLines >= 3
            && dashDetail.approvalHiddenAfterFinish === true
            && dashDetail.runningFalseAfterFinish === true
            && dashDetail.cardNotRunning === true;
        } catch (err) { window.__AILEEN_ERRORS.push('dashTest: ' + String((err && err.message) || err)); }

        // 行为断言⑬：Agent 权限弹层 —— 点按钮能开、控件齐、再点能收、第三次还能再开
        let agentOk = false;
        let agentDetail = null;
        try {
          agentDetail = typeof window.__AILEEN_PROBE_AGENT === 'function' ? await window.__AILEEN_PROBE_AGENT() : null;
          // 截图已经拍完（审批卡片在里面），现在收尾：点拒绝，卡片必须消失
          const after = typeof window.__AILEEN_PROBE_AGENT_AFTER === 'function'
            ? await window.__AILEEN_PROBE_AGENT_AFTER() : null;
          if (agentDetail) agentDetail.after = after;
          agentOk = !!agentDetail && agentDetail.panelOpen === true
            && agentDetail.chipExpanded === true
            && agentDetail.panelInComposer === true
            && agentDetail.noSideConsole === true
            && agentDetail['ap-enabled'] === true && agentDetail['ap-workspace-path'] === true
            && agentDetail['btn-ap-pick'] === true && agentDetail['btn-ap-open'] === true
            && agentDetail['ap-full'] === true && agentDetail['ap-skipwrite'] === true
            && agentDetail['ap-recent'] === true
            && agentDetail.cardVisible === true
            && agentDetail.cardRunning === true
            && typeof agentDetail.cardTask === 'string' && agentDetail.cardTask.length > 0
            && agentDetail.approvalVisible === true
            && agentDetail.approvalRisk === 'HIGH'
            && typeof agentDetail.approvalText === 'string' && agentDetail.approvalText.length > 0
            && agentDetail.stepLines >= 2
            && agentDetail.hasApprove === true && agentDetail.hasReject === true
            && agentDetail.accentResolved === true
            && !!after && after.visibleBeforeReject === true && after.hasReject === true
            && after.hiddenAfterReject === true
            && after.panelHiddenAfterClose === true
            && after.cardHiddenAfterReset === true;
        } catch (err) { window.__AILEEN_ERRORS.push('agentTest: ' + String((err && err.message) || err)); }
        // 行为断言：弹层收起之后必须还能从输入区再打开（曾经「收起就找不回来」）
        let panelReopenOk = false;
        let panelReopenDetail = null;
        try {
          const chip = document.getElementById('btn-agent-mode');
          const panel = document.getElementById('agent-panel');
          const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
          const visible = () => !!panel && !panel.classList.contains('hidden');
          chip.click();
          await waitMs(120);
          const opened = visible();
          chip.click();
          await waitMs(120);
          const closed = !visible();
          chip.click();
          await waitMs(120);
          const reopened = visible() && chip.getAttribute('aria-expanded') === 'true';
          panelReopenDetail = { opened, closed, reopened };
          panelReopenOk = opened && closed && reopened;
          if (reopened) { chip.click(); await waitMs(120); }
        } catch (err) { window.__AILEEN_ERRORS.push('panelReopen: ' + String((err && err.message) || err)); }
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
            pcOpened = pageOn('char-edit') && !!document.getElementById('f-name');
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
        // 主导航：五个页面 + 设置都能进得去，并且一次只显示一页
        let pageNavOk = false;
        try {
          const pages = ['characters', 'memory', 'tasks', 'devices'];
          let all = true;
          for (const p of pages) {
            const nav = document.querySelector('#side-nav .nav-item[data-page="' + p + '"]');
            if (!nav) { all = false; break; }
            nav.click();
            all = all && pageOn(p);
          }
          const setBtn = document.getElementById('btn-settings-menu');
          if (setBtn) { setBtn.click(); all = all && pageOn('settings'); }
          const chatNav = document.querySelector('#side-nav .nav-item[data-page="chat"]');
          if (chatNav) { chatNav.click(); all = all && pageOn('chat'); }
          pageNavOk = all && document.querySelectorAll('#content .page.on').length === 1;
        } catch (err) { window.__AILEEN_ERRORS.push('pageNav: ' + String((err && err.message) || err)); }
        try {
          // 先回到「静止状态」：关掉可能开着的弹层，再测有没有东西挡住界面
          document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
          document.querySelectorAll('.pop-menu').forEach((m) => m.classList.add('hidden'));
          document.querySelector('#side-nav .nav-item[data-page="chat"]').click();
          const pts = [[120, 60], [120, 420], [700, 90], [700, 500], [980, 400], [1050, 620]];
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
          const entry = document.querySelector('#settings-nav button[data-sec="companion"]');
          if (entry) {
            entry.click();
            const opened = secOn('companion');
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
        // 复制到剪贴板：渲染层 clipboard 在 file:// 下会失败，必须走主进程那条路
        let copyOk = false;
        let copyDetail = null;
        try {
          copyDetail = typeof window.__AILEEN_PROBE_COPY === 'function' ? await window.__AILEEN_PROBE_COPY() : null;
          copyOk = !!(copyDetail && copyDetail.ok === true);
        } catch (err) { window.__AILEEN_ERRORS.push('copyProbe: ' + String((err && err.message) || err)); }
        // 复制**入口**好不好找：按钮必须在消息下面、常驻可见、并且点得到
        // （用户反馈过「复制图标不在对话下面、有的时候不好找」）
        let copyUiOk = false;
        let copyUiDetail = null;
        try {
          const msg = document.querySelector('#messages .msg.assistant') || document.querySelector('#messages .msg');
          const btn = msg ? msg.querySelector('.msg-actions .msg-copy') : null;
          const acts = msg ? msg.querySelector('.msg-actions') : null;
          const body = msg ? msg.querySelector('.msg-body') : null;
          let clickable = false;
          let belowBody = false;
          let visible = false;
          if (btn && acts && body) {
            const r = btn.getBoundingClientRect();
            const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            clickable = !!(top && (top === btn || btn.contains(top)));
            belowBody = acts.getBoundingClientRect().top >= body.getBoundingClientRect().bottom - 3;
            visible = parseFloat(getComputedStyle(btn).opacity || '0') > 0.3;
          }
          let codeBtn = null;
          const firstPre = msg ? msg.querySelector('.code-block .code-copy') : null;
          if (firstPre) codeBtn = true;
          copyUiDetail = {
            hasBtn: !!btn,
            clickable, belowBody, visible, codeCopyInBlock: !!codeBtn,
          };
          copyUiOk = !!btn && clickable && belowBody && visible;
        } catch (err) { window.__AILEEN_ERRORS.push('copyUi: ' + String((err && err.message) || err)); }
        const modelZipProbe = ${JSON.stringify(zipProbe)};
        const modelZipOk = !!modelZipProbe && modelZipProbe.error === undefined
          && !!modelZipProbe.good && modelZipProbe.good.dirExists === true
          && modelZipProbe.good.configExists === true && modelZipProbe.good.textureExists === true
          && modelZipProbe.good.listed === true && modelZipProbe.good.noTempLeft === true
          && modelZipProbe.badRejected === true && modelZipProbe.noTempAfterBad === true
          && modelZipProbe.cleanedUp === true;
        let uiElementsOk = false;
        let sideCollapseOk = false;
        let searchFilterOk = false;
        try {
          uiElementsOk = ['btn-send', 'btn-stop', 'btn-float-stage', 'btn-char-actions', 'btn-realtime', 'btn-screenshot', 'btn-mic',
            'char-search', 'drop-hint', 'input', 'composer-box', 'btn-settings-menu', 'btn-collapse-sidebar',
            'agent-panel', 'chat-taskbar', 'btn-taskbar', 'btn-agent-mode', 'titlebar', 'titlebar-logo', 'theme-mode-switch', 'settings-nav']
            .every((id) => !!document.getElementById(id));
          const app = document.getElementById('app');
          const cs = document.getElementById('btn-collapse-sidebar');
          cs.click();
          const collapsed = app.classList.contains('side-collapsed');
          cs.click();
          sideCollapseOk = collapsed && !app.classList.contains('side-collapsed');
          // 搜索过滤在「角色」页的网格上验证（侧栏只放最近 6 个）
          document.querySelector('#side-nav .nav-item[data-page="characters"]').click();
          let before = document.querySelectorAll('#character-grid .char-card').length;
          let tempFile = null;
          if (before === 0) {
            const wr = await window.api.writeCharacter('_uifilter', { name: 'UI filter probe', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', system_prompt: '', model: '', voice: '', createdAt: Date.now(), updatedAt: Date.now() }, 'create');
            tempFile = (wr && wr.file) || '_uifilter.json';
            if (typeof window.__AILEEN_REFRESH === 'function') await window.__AILEEN_REFRESH();
            await new Promise((r) => setTimeout(r, 250));
            before = document.querySelectorAll('#character-grid .char-card').length;
          }
          const searchEl = document.getElementById('char-search');
          searchEl.value = 'zzz-no-such-character';
          searchEl.dispatchEvent(new Event('input', { bubbles: true }));
          const none = document.querySelectorAll('#character-grid .char-card').length;
          searchEl.value = '';
          searchEl.dispatchEvent(new Event('input', { bubbles: true }));
          const all = document.querySelectorAll('#character-grid .char-card').length;
          searchFilterOk = before > 0 && none === 0 && all === before;
          if (tempFile) {
            await window.api.deleteCharacter(tempFile);
            if (typeof window.__AILEEN_REFRESH === 'function') await window.__AILEEN_REFRESH();
          }
        } catch (err) { window.__AILEEN_ERRORS.push('uiTest: ' + String((err && err.message) || err)); }
        // 横向溢出：设置页/任务页/设备页曾有「内容比视口宽」的排版问题
        // （页面底部出现横向滚动条，右侧内容被切掉）。宽窗口 + 窄窗口各量一遍。
        let hScrollOk = false;
        let hScrollDetail = null;
        try {
          const wide = await window.__AILEEN_HSCROLL();
          const narrow = ${JSON.stringify(narrowScroll)};
          hScrollDetail = { wide, narrow };
          hScrollOk = !!wide && wide.offenders.length === 0
            && !!narrow && Array.isArray(narrow.offenders) && narrow.offenders.length === 0;
          const chatNav = document.querySelector('#side-nav .nav-item[data-page="chat"]');
          if (chatNav) chatNav.click();
        } catch (err) { window.__AILEEN_ERRORS.push('hScrollTest: ' + String((err && err.message) || err)); }
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
          const subLlm = document.getElementById('s-llm-model');
          if (subLlm) menuSubText = String(subLlm.value || '').trim();
        } catch (err) { window.__AILEEN_ERRORS.push('charMenuTest: ' + String(err && err.message || err)); }
        // API Key 脱敏测试：渲染层必须**永远**拿不到明文。
        // 加密落盘、回读一致、以及「留空=保持 / 哨兵=清除」的语义在主进程侧验证
        // （见 overlay.json 的 secret* 字段），这里只验渲染层看到的东西。
        let settingsPersist = false;
        let secretView = null;
        try {
          const cur = await window.api.getSettings();
          secretView = {
            llmKey: cur && cur.llm ? cur.llm.apiKey : '(no llm)',
            llmKeySet: cur && cur.llm ? cur.llm.apiKeySet : null,
            ttsKey: cur && cur.tts ? cur.tts.apiKey : '(no tts)',
            sttKey: cur && cur.stt ? cur.stt.apiKey : '(no stt)',
            encrypted: !!(cur && cur.secretsEncrypted),
          };
          settingsPersist = !!(cur && cur.llm && cur.llm.apiKey === '' && typeof cur.llm.apiKeySet === 'boolean'
            && cur.tts && cur.tts.apiKey === '' && cur.stt && cur.stt.apiKey === '');
          // 把设置（含内部的 apiKeySet 标记）原样送回去，不应该有任何异常，也不该把密钥弄丢
          const back = await window.api.setSettings({
            behavior: { autoScroll: !!(cur && cur.behavior && cur.behavior.autoScroll) },
          });
          settingsPersist = settingsPersist && !!(back && back.llm && back.llm.apiKey === '');
        } catch (err) { window.__AILEEN_ERRORS.push('settingsTest: ' + String(err && err.message || err)); }
        // Base URL 默认收起（未勾选自定义时输入框应隐藏）
        let llmBaseHidden = 'n/a';
        const wLlm = document.getElementById('wrap-llm-base');
        if (wLlm) {
          document.querySelector('#settings-nav button[data-sec="models"]').click();
          llmBaseHidden = wLlm.classList.contains('hidden');
        }
        const providerOptions = q('#s-llm-provider option').length;
        const ttsLangOptions = q('#s-tts-language option').length;
        const sttLangOptions = q('#s-stt-language option').length;
        const realtimeBtn = !!document.getElementById('btn-realtime');
        const screenshotBtn = !!document.getElementById('btn-screenshot');
        const addModelBtn = !!document.getElementById('btn-add-model');
        const modalsExist =
          !!document.getElementById('set-models') && !!document.getElementById('set-voice') && !!document.getElementById('set-appearance');
        const datalistLlm = q('#dl-llm-models option').length;
        let screenSources = 'n/a';
        try {
          const sr = await window.api.captureScreen();
          screenSources = Array.isArray(sr) ? sr.length : (sr && sr.error ? 'ERR:' + sr.error : 'none');
        } catch (err) { screenSources = 'EXC:' + String(err && err.message || err); }
        // 记忆库真机往返：写一条 → 落盘读回 → 检索到 → 删掉。
        // 单测全是内存 fs，只有这条能证明 store:fs 与向量链路在真机上真的通。
        let memoryProbe = null;
        try {
          memoryProbe = typeof window.__AILEEN_MEMORY_PROBE === 'function'
            ? await window.__AILEEN_MEMORY_PROBE()
            : { ok: false, error: '探针未挂载' };
        } catch (err) {
          memoryProbe = { ok: false, error: String((err && err.message) || err) };
        }
        const memoryOk = !!(memoryProbe && memoryProbe.ok === true);
        // Agent 检查点真机往返：保存 → 读回 → 清除（跨重启续跑的地基）
        let checkpointProbe = null;
        try {
          checkpointProbe = typeof window.__AILEEN_CHECKPOINT_PROBE === 'function'
            ? await window.__AILEEN_CHECKPOINT_PROBE()
            : { ok: false, error: '探针未挂载' };
        } catch (err) {
          checkpointProbe = { ok: false, error: String((err && err.message) || err) };
        }
        const checkpointOk = !!(checkpointProbe && checkpointProbe.ok === true);
        let devDetail = null;
        try {
          devDetail = typeof window.__AILEEN_PROBE_DEVICES === 'function' ? window.__AILEEN_PROBE_DEVICES() : null;
        } catch (err) { window.__AILEEN_ERRORS.push('devProbe: ' + String((err && err.message) || err)); }
        return {
          title: document.title,
          page: (document.querySelector('#content .page.on') || {}).id || '',
          mainWindowHasNoStage: !document.getElementById('stage-container'),
          chatName: (document.getElementById('chat-name') || {}).textContent || '',
          charCount: q('#char-list .char-item').length,
          charNames: Array.from(q('#char-list .ci-name')).map((e) => e.textContent),
          gridCards: q('#character-grid .char-card').length,
          modelOptions: q('#m-model option').length,
          modelSelectValue: (document.getElementById('m-model') || {}).value,
          motionChips: 0,
          exprChips: 0,
          stageChildren: 0,
          stageRect: null,
          canvasCount: q('#ov-stage canvas').length,
          canvasSize: 'none',
          canvasPosition: 'none',
          messages: q('#messages .msg').length,
          computerBtn: (() => {
            const b = document.getElementById('btn-computer');
            if (!b) return 'missing';
            const r = b.getBoundingClientRect();
            const cs = getComputedStyle(b);
            return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top), display: cs.display, color: cs.color, text: (b.textContent || '').trim() };
          })(),
          firstMessage: (q('#messages .msg')[0] || {}).textContent || '',
          emptyHint: (q('#messages .msg')[0] || {}).textContent || '',
          modalOpensOnNewCard,
          modalOpens,
          subModalReturnsToMenu,
          themeCancelRestores,
          themeModeOk,
          themeDetail,
          colorInstantOk,
          colorInstantDetail,
          pageNavOk,
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
          copyOk,
          copyDetail,
          copyUiOk,
          copyUiDetail,
          pacerProbeOk,
          pacerProbeDetail,
          performOk,
          performDetail,
          personaOk,
          personaDetail,
          studioOk,
          studioDetail,
          agentOk,
          agentDetail,
          panelReopenOk,
          panelReopenDetail,
          dashOk,
          dashDetail,
          toggleOk,
          toggleDetail,
          noModelOk,
          noModelDetail,
          scrollOk,
          scrollDetail,
          uiBlockedBy,
          sideCollapseOk,
          searchFilterOk,
          modelZipOk,
          modelZipProbe,
          hScrollOk,
          hScrollDetail,
          jaText,
          zhText,
          jaMissingKeys,
          themeVar,
          llmBaseHidden,
          charMenuOk,
          quickModalOk,
          menuSubText,
          settingsPersist,
          secretView,
          providerOptions,
          ttsLangOptions,
          sttLangOptions,
          realtimeBtn,
          screenshotBtn,
          addModelBtn,
          modalsExist,
          datalistLlm,
          screenSources,
          memoryOk,
          memoryProbe,
          checkpointOk,
          checkpointProbe,
          devDetail,
          errors: (window.__AILEEN_ERRORS || []).slice(0, 10),
          modelReady: typeof window.__AILEEN_MODEL_READY === 'function' ? !!window.__AILEEN_MODEL_READY() : 'n/a',
        };
      })()`);
      const SELFTEST_DIR2 = process.env.AILEEN_SELFTEST_DIR || path.join(USER_DATA_DIR, 'selftest');
      // 版本号也写进诊断：发布时 CI 可以直接断言「跑的就是要发的那个版本」，
      // 而不是靠人记得改这里改那里（曾经发版漏改过引用）。
      const version = (() => { try { return app.getVersion(); } catch { return 'unknown'; } })();
      const out = Object.assign({ appVersion: version }, diag);
      fs.writeFileSync(path.join(SELFTEST_DIR2, 'shot.json'), JSON.stringify(out, null, 2));
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
      // 真机链路（可选）：渲染层发起 → 主进程带 Key 发请求 → 流式回渲染层
      if (process.env.AILEEN_SELFTEST_LIVE_LLM) {
        try {
          rep.liveLlm = await win.webContents.executeJavaScript(
            'window.__AILEEN_PROBE_LIVE_LLM ? window.__AILEEN_PROBE_LIVE_LLM() : null',
          );
        } catch (err) { rep.errors.push('liveLlm: ' + String((err && err.message) || err)); }
      }
      // API Key：加密落盘 + 回读一致 + 渲染层拿不到明文
      try {
        const before = readSettings().llm.apiKey || '';
        const testKey = 'selftest-' + crypto.randomBytes(8).toString('hex');
        writeSettings({ llm: { apiKey: testKey } });
        rep.secretRoundTripOk = (readSettings().llm.apiKey || '') === testKey;
        const disk = fs.readFileSync(SETTINGS_FILE, 'utf8');
        rep.secretEncryptedOk = encryptionAvailable()
          ? (disk.indexOf(SECRET_PREFIX) >= 0 && disk.indexOf(testKey) < 0)
          : 'skipped:no-safeStorage';
        const view = settingsForRenderer(readSettings());
        rep.secretRedactedOk = !!(view && view.llm && view.llm.apiKey === '' && view.llm.apiKeySet === true
          && JSON.stringify(view).indexOf(testKey) < 0);
        // 「留空=保持」：这条语义要是坏了，用户改个模型就会把密钥弄丢
        const kept = resolveSecretPatch({ llm: { apiKey: '' } }, readSettings());
        rep.secretKeepOnEmptyOk = (kept.llm.apiKey || '') === testKey;
        // 「哨兵=清除」
        const cleared = resolveSecretPatch({ llm: { apiKey: SECRET_CLEAR } }, readSettings());
        rep.secretClearOk = cleared.llm.apiKey === '';
        // 还原原来的 Key（没有就清空）
        writeSettings({ llm: { apiKey: before } });
        rep.secretRestored = (readSettings().llm.apiKey || '') === before;
      } catch (err) { rep.errors.push('secret: ' + String((err && err.message) || err)); }
      // 删除本地模型：真建一个临时模型目录，走 IPC 删掉，再确认它真的没了；
      // 顺便把所有越界路径试一遍 —— 这是唯一会真删用户文件的接口，必须挡住。
      try {
        // CI 用的是全新数据目录，一个模型都没有 —— 先记下来，后面决定哪些断言可以跳过
        rep.modelsAvailable = scanModels(MODELS_DIR, '').length > 0;
        // 删除测试跑完之后，用户自己的模型必须一个不少（这条是为一次真实事故加的）
        const modelsBefore = scanModels(MODELS_DIR, '').map((m) => m.file).sort().join('|');
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
        rep.modelsSurvived = scanModels(MODELS_DIR, '').map((m) => m.file).sort().join('|') === modelsBefore;
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
          // 自检期间光标放远处（假光标）：穿透/吸附这些断言不能被真鼠标当时停在哪影响
          if (typeof setOverlayCursor === 'function') setOverlayCursor(() => ({ x: 5, y: 5 }));
          await new Promise((r) => setTimeout(r, 420));
          rep.visible = w.isVisible();
          rep.title = w.getTitle();
          rep.bounds = w.getBounds();
          rep.hitArea = getOverlayHit();
          rep.ignoringByDefault = getOverlayIgnoring();
          rep.interactiveMode = getOverlayInteractive();
          rep.cursorInHit = overlayCursorInHit();
          rep.hitAreaSizeOk = !!((function () { const h = getOverlayHit(); return h && h.w > 20 && h.h > 10; })());
          // 热区为空时到底是「渲染层没上报」还是「上报了但被参数校验拒了」——
          // 这两种在报告里长得一模一样，各错查一次太亏，直接把原因探出来。
          if (!rep.hitAreaSizeOk) {
            try {
              rep.hitAreaDiag = await w.webContents.executeJavaScript('(async function(){'
                + ' var t = document.getElementById("ov-tools");'
                + ' var r = t ? t.getBoundingClientRect() : null;'
                + ' var cs = t ? getComputedStyle(t) : null;'
                + ' var out = { hasTools: !!t, rect: r ? [r.left, r.top, r.width, r.height] : null,'
                + '   display: cs ? cs.display : null, opacity: cs ? cs.opacity : null,'
                + '   hasApi: !!(window.api && window.api.overlaySetHitArea), callOk: null, callErr: null };'
                + ' try { await window.api.overlaySetHitArea({ x: 1, y: 1, w: 50, h: 30 }); out.callOk = true; }'
                + ' catch (e) { out.callOk = false; out.callErr = String((e && e.message) || e); }'
                + ' return out; })()');
            } catch (err) { rep.hitAreaDiag = { error: String((err && err.message) || err) }; }
          }
          rep.watchRunning = !!getOverlayWatch();
          rep.shouldCapture = overlayShouldCapture();
          rep.rendererIgnoreRequests = getOverlayIgnoreRequests();
          rep.modelSynced = !!getOverlayModel();
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
              expected: (function () { const e = getOverlayExpectedSize(); return e ? [e.width, e.height] : null; })(),
              persisted: [overlaySettings().width, overlaySettings().height],
            };
            rep.userResizable = w.isResizable();
            // 关键不变量：交互热区必须离窗口边缘足够远
            const hitNow = getOverlayHit();
            rep.hitMarginRight = hitNow ? Math.round(b1.width - (hitNow.x + hitNow.w)) : -1;
            rep.hitMarginBottom = hitNow ? Math.round(b1.height - (hitNow.y + hitNow.h)) : -1;
            // 改完尺寸后必须仍然是穿透的（setResizable 会重置 Windows 窗口样式）
            rep.ignoringAfterResize = getOverlayIgnoring();
            // ② 模拟系统把窗口意外放大（Aero Snap / 拖动越界），兜底必须把它弹回去
            const beforeGuard = w.getBounds();
            if (typeof setProgrammaticUntil === 'function') setProgrammaticUntil(0);
            w.setBounds({ x: beforeGuard.x, y: beforeGuard.y, width: beforeGuard.width + 300, height: beforeGuard.height + 200 });
            await new Promise((r) => setTimeout(r, 1300));
            const afterGuard = w.getBounds();
            // 弹回允许几像素误差（无边框窗口的隐形边框），但要确认确实缩小回来了
            rep.snapBackOk = near(afterGuard.width, beforeGuard.width, 10) && near(afterGuard.height, beforeGuard.height, 10);
            await applyOverlayBounds(b0);
          } catch (err) { rep.errors.push('resize: ' + String((err && err.message) || err)); }
          // 先把光标挪到一个肯定不在窗口里的地方（假光标）：穿透判定不能依赖真鼠标当时停在哪
          if (typeof setOverlayCursor === 'function') setOverlayCursor(() => ({ x: 5, y: 5 }));
          const before = w.getBounds();
          w.setPosition(before.x - 60, before.y - 40);
          const after = w.getBounds();
          rep.moved = after.x !== before.x || after.y !== before.y;
          // 等穿透监控那一拍（250ms）再断言：光标在窗口外 → 移动之后必须还是穿透的
          await new Promise((r) => setTimeout(r, 320));
          rep.ignoringAfterMove = getOverlayIgnoring();
          // 展台大小边界：用户报过「直接占领了整个屏幕」，后来又报「最大值还是太小」。
          // 两条要求同时成立的方式是：**上限由 clampOverlaySize 说了算**，而且它自己必须在
          // 屏幕比例 + 绝对上限之内，并且窗口整个落在工作区里（底边留缝）。
          // 注意：这里不能把比例写死 —— CI 的虚拟屏只有 1024×720，写死就会假红（踩过一次）。
          try {
            const area = getWorkArea();
            const huge = clampOverlaySizeFn(99999, 99999);
            const tiny = clampOverlaySizeFn(1, 1);
            const beforeProbe = getOverlayBounds();
            await setOverlaySize(99999, 99999);
            await new Promise((r) => setTimeout(r, 260));
            const afterProbe = getOverlayBounds();
            rep.overlaySizeProbe = {
              area: [area.width, area.height],
              huge: [huge.width, huge.height],
              tiny: [tiny.width, tiny.height],
              applied: afterProbe ? [afterProbe.width, afterProbe.height] : null,
              caps: { ratioW: 0.72, ratioH: 0.92, absW: 1200, absH: 1280 },
            };
            const ratioCapW = Math.round(area.width * 0.72);
            const ratioCapH = Math.round(area.height * 0.92);
            const fitsScreen = !!afterProbe && afterProbe.width <= huge.width + 6
              && afterProbe.height <= huge.height + 6;
            const tinyFloored = tiny.width >= 240 && tiny.height >= 380;
            // 窗口必须整个落在工作区里：露到任务栏上就是「挡住任务栏」
            // 底边还要留一条缝：贴着工作区底边 = 脚踩在任务栏上（用户报过两次）
            const bottomGap = afterProbe ? (area.y + area.height) - (afterProbe.y + afterProbe.height) : -1;
            rep.overlayTaskbarGapProbe = { bottomGap, required: 20 };
            rep.overlayTaskbarGapOk = bottomGap >= 20;
            rep.overlayInWorkAreaOk = !!afterProbe
              && afterProbe.x >= area.x - 1 && afterProbe.y >= area.y - 1
              && afterProbe.x + afterProbe.width <= area.x + area.width + 6
              && afterProbe.y + afterProbe.height <= area.y + area.height + 6;
            // 上限既要「在比例/绝对上限之内」，也要真的比历史值（720×900）更大，
            // 否则等于这次「调大」没生效。小屏上被比例钳住是正常的，所以按 min 比较。
            const capWOk = huge.width <= Math.min(1200, ratioCapW) + 1;
            const capHOk = huge.height <= Math.min(1280, ratioCapH) + 1;
            const biggerWOk = huge.width >= Math.min(1200, ratioCapW) - 1 && huge.width > 320;
            const biggerHOk = huge.height >= Math.min(1280, ratioCapH) - 1 && huge.height > 380;
            rep.overlaySizeOk = capWOk && capHOk && tinyFloored && fitsScreen;
            rep.overlaySizeBiggerOk = biggerWOk && biggerHOk && capWOk && capHOk;
            // 「reset」的语义：大小也回到默认（400×640），不只是挪位置。
            // 注意默认值本身也要过 clamp：CI 的虚拟屏只有 1024×720，640 高会被钳到更小。
            const resetWant = clampOverlaySizeFn(400, 640);
            await setOverlaySize(resetWant.width, resetWant.height);
            await new Promise((r) => setTimeout(r, 220));
            const resetProbe = getOverlayBounds();
            rep.overlaySizeProbe.reset = resetProbe ? [resetProbe.width, resetProbe.height] : null;
            rep.overlaySizeProbe.resetWant = [resetWant.width, resetWant.height];
            rep.overlaySizeResetOk = !!resetProbe
              && Math.abs(resetProbe.width - resetWant.width) <= 6
              && Math.abs(resetProbe.height - resetWant.height) <= 6;
            if (beforeProbe) await applyOverlayBounds(beforeProbe);
          } catch (err) { rep.errors.push('overlaySize: ' + String((err && err.message) || err)); }
          // 模型连续性：改窗口尺寸（跨屏 DPI 也会触发 resize）不能把模型重建一遍，
          // 否则动作/表情/口型全断 —— 用户报过「每次移动位置模型都会重置」。
          try {
            const stageInfo = () => w.webContents.executeJavaScript(
              'window.__AILEEN_OVERLAY_STAGE_INFO ? window.__AILEEN_OVERLAY_STAGE_INFO() : null',
            );
            const beforeInfo = await stageInfo();
            const sizeNow = w.getBounds();
            await setOverlaySize(Math.max(260, sizeNow.width - 40), Math.max(400, sizeNow.height - 40));
            await new Promise((r) => setTimeout(r, 700));
            const afterInfo = await stageInfo();
            await setOverlaySize(sizeNow.width, sizeNow.height);
            await new Promise((r) => setTimeout(r, 400));
            rep.modelKeepsStateProbe = {
              modelsAvailable: !!rep.modelsAvailable,
              before: beforeInfo,
              after: afterInfo,
            };
            rep.modelKeepsStateOk = rep.modelsAvailable
              ? !!beforeInfo && !!afterInfo && afterInfo.renders === beforeInfo.renders && afterInfo.hasModel === true
              : 'skipped:no-model-installed';
          } catch (err) { rep.errors.push('modelKeepsState: ' + String((err && err.message) || err)); }
          // ④ 拖动：真机最容易翻车的地方（事件堆积 / 尺寸被拉扯 / 松手后还在飘）
          //    用渲染层**真实的事件入口**（PointerEvent on #ov-grip）驱动，
          //    光标用注入的假坐标，所以「窗口有没有精确跟到最新位置」能被确定性断言。
          try {
            const setCursor = setOverlayCursor;
            if (typeof setCursor !== 'function') throw new Error('setCursor 没有注入');
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const dragStart = await w.getBounds();
            // 拖动用例要求窗口上方有足够的余量（它固定往左上拖 120/60）：
            // 窗口一旦占满屏高（72% 上限下 816 高的工作区能到 ~750），y 被钳到 0，
            // 「往左上 60」就变成负坐标、被 clampOverlayPosition 钳平 —— 断言会假红。
            // 所以先用一个确定的小尺寸做这组用例，跑完再还原。
            const probeSize = { width: 420, height: 600 };
            await setOverlaySize(probeSize.width, probeSize.height);
            await sleep(300);
            // 先把窗口放到一个确定的坐标，省得受前面用例影响
            await applyOverlayBounds({ x: 900, y: 200, width: probeSize.width, height: probeSize.height });
            // 等 Windows 把「解除 resizable → setBounds → 锁回」这套收尾事件排空，
            // 否则那一次 resize 会算到「拖动期间」头上（假红过一次）。
            await sleep(450);
            const base = w.getBounds();
            let resizeEvents = 0;
            // 拖动期间「尺寸被拉扯」才是 bug：Windows 上切换鼠标穿透本身就会发一次
            // 同尺寸的 resize 事件（窗口样式重建），所以不能只数次数，要看宽高有没有变。
            const resizeLog = [];
            const countResize = () => {
              resizeEvents += 1;
              const bb = w.getBounds();
              resizeLog.push([bb.width, bb.height]);
            };
            w.on('resize', countResize);

            const stats = () => w.webContents.executeJavaScript(
              'window.__AILEEN_OVERLAY_DRAG_STATS ? window.__AILEEN_OVERLAY_DRAG_STATS() : null',
            );
            const dragging = () => w.webContents.executeJavaScript(
              'window.__AILEEN_OVERLAY_DRAGGING ? window.__AILEEN_OVERLAY_DRAGGING() : null',
            );
            const dispatch = (type) => w.webContents.executeJavaScript(
              'document.getElementById("ov-grip").dispatchEvent(new PointerEvent(' + JSON.stringify(type)
              + ', { bubbles: true, pointerId: 9, pointerType: "mouse", isPrimary: true, button: 0 }))',
            );

            // 按下把手（假光标在窗口左上角 +120/+80 的位置，模拟「抓住工具栏继续拖」）
            setCursor(() => ({ x: base.x + 120, y: base.y + 80 }));
            const before1 = await stats();
            resizeEvents = 0;   // 只统计「按下之后」的 resize（之前的程序化收尾不算）
            await dispatch('pointerdown');
            await sleep(120);
            rep.dragStarted = (await dragging()) === true;

            // 光标往左上移动 120/60（避开工作区边缘的钳制），然后在**同一帧**里砸 40 个 pointermove
            setCursor(() => ({ x: base.x, y: base.y + 20 }));
            await w.webContents.executeJavaScript(
              '(async () => { const g = document.getElementById("ov-grip");'
              + ' for (let i = 0; i < 40; i += 1) {'
              + '   g.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 9, pointerType: "mouse", isPrimary: true, buttons: 1 }));'
              + ' }'
              + ' await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));'
              + ' })()',
            );
            await sleep(220);
            const mid = w.getBounds();
            const midGhost = getOverlayGhost();
            const midGhostVisible = getOverlayGhostVisible();
            const midStats = await stats();

            // 松手
            await dispatch('pointerup');
            await sleep(260);
            const afterEndStats = await stats();
            rep.dragEnded = (await dragging()) === false;
            // 松手之后再动假光标：窗口绝不能继续跑
            setCursor(() => ({ x: base.x + 700, y: base.y + 500 }));
            await sleep(220);
            const settled = w.getBounds();
            const ghostAfter = getOverlayGhost();
            setCursor(() => ({ x: 5, y: 5 }));
            w.removeListener('resize', countResize);

            rep.dragProbe = {
              base: [base.x, base.y, base.width, base.height],
              mid: [mid.x, mid.y, mid.width, mid.height],
              settled: [settled.x, settled.y, settled.width, settled.height],
              want: [base.x - 120, base.y - 60],
              moveEvents: (midStats.moveEvents || 0) - (before1.moveEvents || 0),
              moveIpc: (midStats.calls || 0) - (before1.calls || 0),
              endCalls: (afterEndStats.endCalls || 0) - (before1.endCalls || 0),
              ghost: midGhost ? [midGhost.x, midGhost.y, midGhost.width, midGhost.height] : null,
              ghostVisible: midGhostVisible,
              ghostAfter: ghostAfter ? [ghostAfter.x, ghostAfter.y] : null,
              resizeEvents,
              statsAfterEnd: afterEndStats,
            };

            // 高频事件必须被合并：40 个事件最多换算成几个 IPC（以前是每个事件一个）
            rep.dragCoalesceOk = rep.dragProbe.moveEvents >= 20
              && rep.dragProbe.moveIpc >= 1
              && rep.dragProbe.moveIpc <= 4;
            const nearPx = (a, b2) => Math.abs(a - b2) <= 2;
            // 拖动过程中展台原地不动（用户要求：拖动不需要窗口和模型实时动，只留提示框）
            rep.dragNoLiveMoveOk = mid.x === base.x && mid.y === base.y;
            // 提示框跟到最新光标位置（这里就是松手后窗口该去的地方）
            rep.dragGhostOk = !!midGhost && midGhostVisible === true
              && nearPx(midGhost.x, base.x - 120) && nearPx(midGhost.y, base.y - 60)
              // 提示框只是「落点示意」，无边框窗口回读尺寸会差几个像素，允许宽一点
              && Math.abs(midGhost.width - base.width) <= 16 && Math.abs(midGhost.height - base.height) <= 16
              && ghostAfter === null;
            // 松手之后窗口才精确落到提示框的位置
            rep.dragPositionOk = nearPx(settled.x, base.x - 120) && nearPx(settled.y, base.y - 60);
            // 拖动只搬位置：宽高一动不动
            const nearSize = (a, b2) => Math.abs(a - b2) <= 2;
            rep.dragSizeStableOk = nearSize(mid.width, base.width) && nearSize(mid.height, base.height)
              && nearSize(settled.width, base.width) && nearSize(settled.height, base.height);
            // 拖动期间尺寸不能变（出现「宽高变了」就是被拉扯的那类问题）。
            // 注意不能要求「resize 事件数 === 0」：Windows 在切换鼠标穿透时会补发一次
            // 同尺寸的 resize，那是窗口样式重建，不是尺寸被拉扯。
            const resizeChangedSize = resizeLog.some((sz) => Math.abs(sz[0] - base.width) > 2 || Math.abs(sz[1] - base.height) > 2);
            rep.dragNoResizeOk = !resizeChangedSize;
            rep.dragResizeLog = resizeLog;
            // 结束一次且只一次，且没有残留的帧 / 在途请求
            rep.dragEndOk = rep.dragProbe.endCalls === 1 && rep.dragEnded === true
              && afterEndStats.active === false && afterEndStats.pending === false
              && afterEndStats.inFlight === false;
            // 松手之后窗口不再跟随（没有残留动画帧或过时位置）
            rep.dragNoResidualOk = settled.x === mid.x - 120 && settled.y === mid.y - 60;
            // 穿透要恢复：假光标被移到离热区很远的地方 → 应该重新穿透
            await sleep(400);
            rep.dragIgnoreRestored = getOverlayIgnoring();
            // 拖动后的落盘：位置跟到最终位置，尺寸**没有变胖**（否则重启一次大几像素）
            await sleep(500);
            const persistedAfterDrag = overlaySettings();
            rep.dragPersistProbe = {
              persisted: [persistedAfterDrag.x, persistedAfterDrag.y, persistedAfterDrag.width, persistedAfterDrag.height],
              wantPos: [settled.x, settled.y],
              wantSize: [base.width, base.height],
            };
            rep.dragPersistOk = Math.abs(Number(persistedAfterDrag.width) - base.width) <= 6
              && Math.abs(Number(persistedAfterDrag.height) - base.height) <= 6
              && Math.abs(Number(persistedAfterDrag.x) - settled.x) <= 2
              && Math.abs(Number(persistedAfterDrag.y) - settled.y) <= 2;

            // 再拖第二次：监听器若被重复绑定，IPC 次数会翻倍
            const before2 = await stats();
            setCursor(() => ({ x: base.x + 100, y: base.y + 60 }));
            await dispatch('pointerdown');
            await sleep(100);
            setCursor(() => ({ x: base.x + 160, y: base.y + 100 }));
            await w.webContents.executeJavaScript(
              '(async () => { const g = document.getElementById("ov-grip");'
              + ' for (let i = 0; i < 40; i += 1) {'
              + '   g.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 9, pointerType: "mouse", isPrimary: true, buttons: 1 }));'
              + ' }'
              + ' await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));'
              + ' })()',
            );
            await sleep(220);
            await dispatch('pointerup');
            await sleep(160);
            const after2 = await stats();
            setCursor(null);
            rep.dragProbe.second = {
              moveEvents: (after2.moveEvents || 0) - (before2.moveEvents || 0),
              moveIpc: (after2.calls || 0) - (before2.calls || 0),
              endCalls: (after2.endCalls || 0) - (before2.endCalls || 0),
            };
            // 第二轮每帧也最多一个 IPC（旧代码这里会是 2 的倍数，越拖越多）
            rep.dragListenerOnceOk = rep.dragProbe.second.moveIpc >= 1
              && rep.dragProbe.second.moveIpc <= 4
              && rep.dragProbe.second.endCalls === 1;

            // 还原：位置与尺寸回到拖动之前
            await applyOverlayBounds({ x: dragStart.x, y: dragStart.y, width: dragStart.width, height: dragStart.height });
            await sleep(150);
          } catch (err) { rep.errors.push('drag: ' + String((err && err.message) || err)); }

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
            rep.modelRenderedOk = rep.modelsAvailable
              ? !!(rep.overlayProbe && rep.overlayProbe.renderedOk === true && rep.overlayProbe.stageChildren > 0)
              : 'skipped:no-model-installed';
            // 零模型时反过来要验「空状态提示真的出来了」，否则展台会停在最后一个模型的残影上。
            rep.overlayEmptyOk = rep.modelsAvailable
              ? null
              : !!(rep.overlayProbe && rep.overlayProbe.emptyHint === true);
            // 换引擎之后：一定要真的用上新引擎（而不是悄悄回落到什么空实现）；
            // 装了模型时还要求 internalModel 挂上（Cubism Core 没加载成功时这里就是 no-internalModel）。
            rep.overlayEngineOk = !!(rep.overlayProbe
              && rep.overlayProbe.engine === 'untitled-pixi-live2d-engine'
              && (rep.modelsAvailable
                ? (rep.overlayProbe.hasPixiApp === true && rep.overlayProbe.status === 'internalModel-ok')
                : true));
            // 口型同步：灌一个包络进去，嘴部参数必须被驱动（只看「此刻的值」会被衰减骗过去，
            // 所以渲染层额外记了一个峰值）。
            if (rep.modelsAvailable) {
              try {
                await w.webContents.executeJavaScript('window.__AILEEN_OVERLAY_MOUTH ? window.__AILEEN_OVERLAY_MOUTH(0.95) : null');
                await new Promise((r) => setTimeout(r, 350));
                rep.lipsyncProbe = await w.webContents.executeJavaScript('window.__AILEEN_MOUTH_VALUE ? window.__AILEEN_MOUTH_VALUE() : null');
                rep.lipsyncOk = !!(rep.lipsyncProbe && Number(rep.lipsyncProbe.peak) > 0.2);
              } catch (err) { rep.lipsyncOk = 'err:' + String((err && err.message) || err); }
            } else {
              rep.lipsyncOk = 'skipped:no-model-installed';
            }
            // 口型 IPC 本身（主窗口渲染层 → 主进程 → 展台）也要能通：schema 不对会被静默拒绝
            try {
              const echoed = await w.webContents.executeJavaScript('window.api.overlayMouth ? window.api.overlayMouth(0.42) : null');
              rep.mouthIpcProbe = echoed;
              rep.mouthIpcOk = typeof echoed === 'number' && Math.abs(echoed - 0.42) < 0.001;
            } catch (err) { rep.mouthIpcOk = 'err:' + String((err && err.message) || err); }
            // 精细控制：改设置 → 主进程推给展台 → 展台立刻生效（帧率上限是最好观测的一个）
            try {
              const live2dBefore = getOverlayLive2D();
              writeSettings({ live2d: { fps: 30, fit: 1 } });
              const pushed = pushOverlayLive2D();
              await new Promise((r) => setTimeout(r, 420));
              const p2 = await w.webContents.executeJavaScript('window.__AILEEN_OVERLAY_PROBE ? window.__AILEEN_OVERLAY_PROBE() : null');
              const fitDebug2 = p2 && p2.fitDebug;
              rep.fineCtrlProbe = {
                pushed,
                fps: p2 && p2.ticker ? p2.ticker.maxFPS : null,
                fit: p2 && p2.hq ? p2.hq.fit : null,
                drawn: fitDebug2 ? fitDebug2.drawn : null,
                stage: fitDebug2 ? fitDebug2.stage : null,
                keys: live2dBefore ? Object.keys(live2dBefore).sort() : [],
              };
              // 「精细控制生效」要观测 fps/占比，这些只有真挂了模型才有意义（CI 是零模型目录）
              rep.fineCtrlOk = rep.modelsAvailable
                ? (!!p2 && p2.ticker && p2.ticker.maxFPS === 30
                  && Number(p2.hq.fit) === 1
                  && !!live2dBefore && ['fit', 'zoom', 'lipsync', 'idleMotion', 'focusFollow', 'physics', 'quality', 'fps', 'lod', 'mask']
                    .every((k) => Object.prototype.hasOwnProperty.call(live2dBefore, k)))
                : 'skipped:no-model-installed';
              // fit=1 时角色必须几乎铺满窗口（像素盒量的，和引擎内部包围盒无关）
              const drawnOk = !!(fitDebug2 && fitDebug2.drawn && fitDebug2.stage
                && (fitDebug2.drawn[1] >= Math.round(fitDebug2.stage[1] * 0.85)
                  || fitDebug2.drawn[0] >= Math.round(fitDebug2.stage[0] * 0.85)));
              rep.fitFillsOk = rep.modelsAvailable ? drawnOk : 'skipped:no-model-installed';
              // 还原刚才的自检改动
              writeSettings({ live2d: live2dBefore });
              pushOverlayLive2D();
              await new Promise((r) => setTimeout(r, 260));
            } catch (err) { rep.errors.push('fineCtrl: ' + String((err && err.message) || err)); }
            // VTS 热键表是异步 fetch 的，等它读完再断言
            await new Promise((r) => setTimeout(r, 3000));

            // VTube Studio 热键：模型目录里的 .vtube.json（没有就是 skipped）
            try {
              const hk = await w.webContents.executeJavaScript('window.__AILEEN_HOTKEYS ? window.__AILEEN_HOTKEYS() : null');
              rep.hotkeyProbe = hk;
              // 状态加载本身失败了（配置读不到 / 代码炸了）必须单独报，不能和「这个模型没有热键」混成一个样
              rep.live2dLoadOk = rep.modelsAvailable
                ? !(hk && hk.loadError)
                : 'skipped:no-model-installed';
              rep.hotkeyListOk = rep.modelsAvailable
                ? (!!hk && (hk.count > 0 || 'skipped:no-vts-config'))
                : 'skipped:no-model-installed';
              if (rep.modelsAvailable && hk && hk.count > 0) {
                const pick = (hk.names || []).find((n) => /school uniform/i.test(n))
                  || (hk.names || []).find((n) => !/remove all/i.test(n))
                  || (hk.names || [])[0];
                // 「画面真的变了」才是证据：参数值在帧外读到的永远是基线（引擎每帧 loadParameters 还原），
                // 所以这里用引擎画出来的部件/绘制不透明度指纹来判断。
                const vis = await w.webContents.executeJavaScript(
                  'window.__AILEEN_L2D_TEST_HOTKEY_VISUAL ? window.__AILEEN_L2D_TEST_HOTKEY_VISUAL(' + JSON.stringify(pick) + ') : null',
                );
                rep.hotkeyToggleProbe = { pick, visual: vis };
                if (vis && vis.ok === false && vis.error) rep.errors.push('hotkey visual: ' + vis.error);
                rep.hotkeyToggleOk = !!(vis && vis.ok);
              } else {
                rep.hotkeyToggleOk = 'skipped:no-vts-config';
              }
            } catch (err) { rep.hotkeyListOk = 'err:' + String((err && err.message) || err); }
            // 部件开关（cdi3 的中文部件名）：A 方案里「换装/去装饰」靠的就是这条
            try {
              const pt = await w.webContents.executeJavaScript('window.__AILEEN_PARTS ? window.__AILEEN_PARTS() : null');
              rep.partPanelProbe = pt ? { count: pt.count, sample: (pt.names || []).slice(0, 8) } : null;
              rep.partPanelOk = rep.modelsAvailable
                ? (!!pt && (pt.count > 0 || 'skipped:no-cdi3'))
                : 'skipped:no-model-installed';
              if (rep.modelsAvailable && pt && pt.count > 0) {
                // 状态现在是持久化的：先把上一轮遗留的隐藏清掉，否则「点一下」可能是「显示」而不是「隐藏」
              await w.webContents.executeJavaScript('window.__AILEEN_PARTS_RESET ? window.__AILEEN_PARTS_RESET() : null');
              await new Promise((r) => setTimeout(r, 250));
              const target = (pt.names || []).find((n) => /衣服|body|dress/i.test(n)) || (pt.names || [])[0];
                const beforeOpacity = await w.webContents.executeJavaScript('window.__AILEEN_PART_OPACITY(' + JSON.stringify(target) + ')');
                const hiddenOn = await w.webContents.executeJavaScript('window.__AILEEN_PART_TOGGLE(' + JSON.stringify(target) + ')');
                await new Promise((r) => setTimeout(r, 350));
                const afterOpacity = await w.webContents.executeJavaScript('window.__AILEEN_PART_OPACITY(' + JSON.stringify(target) + ')');
                const hiddenList = (await w.webContents.executeJavaScript('window.__AILEEN_PARTS()')).hidden;
                await w.webContents.executeJavaScript('window.__AILEEN_PART_TOGGLE(' + JSON.stringify(target) + ')');
                await new Promise((r) => setTimeout(r, 300));
                rep.partToggleProbe = { target, hiddenOn, beforeOpacity, afterOpacity, hidden: hiddenList };
                // 隐藏后不透明度必须真的变 0（这是「部件开关真的生效」的硬证据）
                rep.partToggleOk = hiddenOn === true && Array.isArray(hiddenList) && hiddenList.length > 0
                  && (afterOpacity === null || Number(afterOpacity) <= 0.05);
              } else {
                rep.partToggleOk = 'skipped:no-cdi3';
              }
            } catch (err) { rep.partPanelOk = 'err:' + String((err && err.message) || err); }
            // 鼠标拖右下角把手改展台大小（用户要的「手动拖边框」）：
            // 原生 resizable 仍然是关的（会和鼠标穿透打架），所以拖的是渲染层把手 → overlay:resizeTo
            try {
              // 先把窗口缩到 420×600 再拖：否则在本机（窗口已经贴到 92% 屏高）高度会被 clamp 住，
              // 拖角只能变宽 —— 那不是功能坏了，是没余量。和拖动那条用例同一个思路。
              const originSize = getOverlayBounds();
              await overlay.setSize(420, 600);
              await new Promise((r) => setTimeout(r, 400));
              const b0 = getOverlayBounds();
              const gripExists = await w.webContents.executeJavaScript('!!document.getElementById("ov-resize")');
              if (b0 && gripExists) {
                await w.webContents.executeJavaScript(`(function(){
                  var g = document.getElementById('ov-resize');
                  var mk = function (type, x, y) {
                    return new PointerEvent(type, { pointerId: 7, pointerType: 'mouse', bubbles: true, cancelable: true, screenX: x, screenY: y, clientX: x, clientY: y });
                  };
                  g.dispatchEvent(mk('pointerdown', 100, 100));
                  g.dispatchEvent(mk('pointermove', 100 + 110, 100 + 90));
                  g.dispatchEvent(mk('pointerup', 100 + 110, 100 + 90));
                  return true;
                })()`);
                await new Promise((r) => setTimeout(r, 700));
                const b1 = getOverlayBounds();
                const stats = await w.webContents.executeJavaScript('window.__AILEEN_OVERLAY_RESIZE_STATS ? window.__AILEEN_OVERLAY_RESIZE_STATS() : null');
                rep.resizeHandleProbe = { gripExists, before: b0, after: b1, stats };
                // 拖动应该让窗口变大（±40px 容差：会被 clampOverlaySize / 工作区钳一次）
                rep.resizeHandleOk = !!gripExists
                  && !!b1
                  && b1.width >= b0.width + 40
                  && b1.height >= b0.height + 30
                  && !!(stats && stats.calls >= 1);
                // 还原成拖之前的大小，别把后面的门禁带歪
                await overlay.setSize(
                  (originSize && originSize.width) || 400,
                  (originSize && originSize.height) || 640,
                );
                await new Promise((r) => setTimeout(r, 300));
              } else {
                rep.resizeHandleProbe = { gripExists, before: b0 };
                rep.resizeHandleOk = 'skipped:no-overlay';
              }
            } catch (err) { rep.resizeHandleOk = 'err:' + String((err && err.message) || err); }

            // Live2D 兼容层：这几个门禁看的是「引擎里的真实状态」，不是按钮亮没亮
            try {
              const pw = await w.webContents.executeJavaScript('window.__AILEEN_L2D_TEST_PARAM_WRITE ? window.__AILEEN_L2D_TEST_PARAM_WRITE() : null');
              rep.paramWriteProbe = pw;
              rep.paramWriteOk = rep.modelsAvailable ? !!(pw && pw.ok) : 'skipped:no-model-installed';

              const ex = await w.webContents.executeJavaScript('window.__AILEEN_L2D_TEST_EXPRESSION ? window.__AILEEN_L2D_TEST_EXPRESSION() : null');
              rep.expressionApplyProbe = ex;
              rep.expressionApplyOk = rep.modelsAvailable ? !!(ex && ex.ok) : 'skipped:no-model-installed';

              const mi = await w.webContents.executeJavaScript('window.__AILEEN_L2D_TEST_MISSING ? window.__AILEEN_L2D_TEST_MISSING() : null');
              rep.expressionMissingProbe = mi;
              rep.expressionMissingOk = rep.modelsAvailable ? !!(mi && mi.ok) : 'skipped:no-model-installed';

              const pr = await w.webContents.executeJavaScript('window.__AILEEN_L2D_TEST_PART_RESTORE ? window.__AILEEN_L2D_TEST_PART_RESTORE() : null');
              rep.partRestoreProbe = pr;
              rep.partRestoreOk = rep.modelsAvailable ? !!(pr && pr.ok) : 'skipped:no-model-installed';

              const st = await w.webContents.executeJavaScript('window.__AILEEN_L2D_TEST_STATE ? window.__AILEEN_L2D_TEST_STATE() : null');
              rep.live2dStateProbe = st;
              rep.live2dStateOk = rep.modelsAvailable ? !!(st && st.ok) : 'skipped:no-model-installed';

              // 打开时不要自动适配：走存档恢复，而且**不能触发测量**
              const lr = await w.webContents.executeJavaScript('window.__AILEEN_L2D_TEST_LAYOUT_RESTORE ? window.__AILEEN_L2D_TEST_LAYOUT_RESTORE() : null');
              rep.layoutRestoreProbe = lr;
              rep.layoutRestoreOk = rep.modelsAvailable ? !!(lr && lr.ok) : 'skipped:no-model-installed';
              if (rep.modelsAvailable && lr && lr.ok === false && lr.error) rep.errors.push('layout restore: ' + lr.error);

              // 热键/部件状态「下次打开还记不记得」：存档键不能带随机端口，重开与老存档都要能恢复
              const ps = await w.webContents.executeJavaScript('window.__AILEEN_L2D_TEST_PERSIST ? window.__AILEEN_L2D_TEST_PERSIST() : null');
              rep.persistProbe = ps;
              rep.persistOk = rep.modelsAvailable ? !!(ps && ps.ok) : 'skipped:no-model-installed';
              if (rep.modelsAvailable && ps && ps.ok === false && ps.error) rep.errors.push('persist: ' + ps.error);

              // 道具出框：**不自动改比例**，点「按当前姿势适配」才改（用户明确要求手动）
              const pf = await w.webContents.executeJavaScript('window.__AILEEN_L2D_TEST_PROP_FIT ? window.__AILEEN_L2D_TEST_PROP_FIT() : null');
              rep.propFitProbe = pf;
              rep.propFitOk = rep.modelsAvailable ? !!(pf && pf.ok) : 'skipped:no-model-installed';
              // 零模型时这条门禁本来就 skipped（没有道具热键可试），不要往 errors 里塞噪音
              if (rep.modelsAvailable && pf && pf.ok === false && pf.error) rep.errors.push('prop fit: ' + pf.error);
            } catch (err) { rep.errors.push('live2d compat: ' + String((err && err.message) || err)); }
            // 「⋯」面板必须能滚动：37 个热键 + 145 个部件一屏放不下，滚不动就等于下面那半截不存在
            try {
              const sc = await w.webContents.executeJavaScript(`(function(){
                var box = document.getElementById('ov-more');
                if (!box) return null;
                box.classList.remove('hidden');
                box.scrollTop = 0;
                var overflow = box.scrollHeight - box.clientHeight;
                box.scrollTop = box.scrollHeight;
                var r = box.getBoundingClientRect();
                var out = {
                  overflow: overflow, scrollTop: box.scrollTop, clientHeight: box.clientHeight, scrollHeight: box.scrollHeight,
                  overflowY: getComputedStyle(box).overflowY,
                  rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                  view: [window.innerWidth, window.innerHeight],
                };
                box.scrollTop = 0;   // 截图要拍面板顶部（热键那一栏），不是最底下
                return out;
              })()`);
              await new Promise((r) => setTimeout(r, 120));
              rep.panelScrollProbe = sc;
              rep.panelScrollOk = !!sc && sc.overflowY === 'auto'
                && (sc.overflow <= 0 || sc.scrollTop > 0);
              // 面板本身必须整个落在窗口里：贴到窗口上沿外面的话，上面那截永远点不到
              const inside = !!sc && Array.isArray(sc.rect) && Array.isArray(sc.view)
                && sc.rect[1] >= -1
                && sc.rect[1] + sc.rect[3] <= sc.view[1] + 1
                && sc.rect[0] >= -1
                && sc.rect[0] + sc.rect[2] <= sc.view[0] + 1;
              rep.panelInsideOk = rep.modelsAvailable ? inside : 'skipped:no-model-installed';
            } catch (err) { rep.panelScrollOk = 'err:' + String((err && err.message) || err); }
            rep.mainWindowMq = await win.webContents.executeJavaScript('({ mq: window.matchMedia("screen and (max-width: 768px)").matches, screen: [window.screen.width, window.screen.height] })').catch(() => null);
          } catch (err) { rep.errors.push('overlay probe: ' + String((err && err.message) || err)); }
          await new Promise((r) => setTimeout(r, 400));
          // 截图前可以把悬浮面板摆出来（核对排版用；正常运行不会调用）
          const panelName = process.env.AILEEN_SELFTEST_OVERLAY_PANEL;
          if (panelName) {
            try {
              rep.overlayPanel = await w.webContents.executeJavaScript(
                'window.__AILEEN_OVERLAY_PANEL ? window.__AILEEN_OVERLAY_PANEL(' + JSON.stringify(panelName) + ') : false',
              );
              await new Promise((r) => setTimeout(r, 300));
            } catch (err) { rep.errors.push('overlay panel: ' + String((err && err.message) || err)); }
          }
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

module.exports = { attachSelfTest };
