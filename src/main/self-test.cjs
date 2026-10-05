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
const { userDataDir: USER_DATA_DIR } = opts;
const overlayHit = overlay.getHit;
const overlayIgnoring = overlay.getIgnoring;
const overlayInteractive = overlay.getInteractive;
const overlayModel = overlay.getModel;
const overlayWatch = overlay.getWatch;
const overlayDrag = overlay.getDrag;
const overlayCursorInHit = overlay.getCursorInHit;
const overlayShouldCapture = overlay.getShouldCapture;
const overlaySettings = overlay.getSettings;
const overlayExpectedSize = overlay.getExpectedSize;
const overlayProgrammaticUntil = overlay.getProgrammaticUntil;
const overlayIgnoreRequests = overlay.getIgnoreRequests;
const applyOverlayBounds = overlay.applyBounds;
const createOverlayWindow = overlay.createWindow;
const destroyOverlayWindow = overlay.destroyWindow;

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
        // Agent 面板截图：顺带把审批卡片摆出来，让它在图里可见
        // （交互断言用的探针在截图之后才跑，这里只做视觉准备）
        if (shotModal === 'agent') {
          try {
            await win.webContents.executeJavaScript(
              'window.__AILEEN_PREVIEW_APPROVAL ? window.__AILEEN_PREVIEW_APPROVAL() : false',
            );
          } catch (err) { console.warn('[selftest] agent preview failed:', err); }
        }
        // Dashboard 截图：把它摆到「正在执行 + 等确认」的状态
        if (shotModal === 'dashboard') {
          try {
            await win.webContents.executeJavaScript(
              'window.__AILEEN_PREVIEW_DASHBOARD ? window.__AILEEN_PREVIEW_DASHBOARD() : false',
            );
          } catch (err) { console.warn('[selftest] dashboard preview failed:', err); }
        }
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
          noModelOk = !!noModelDetail && noModelDetail.hasOption === true && noModelDetail.stageHasOption === true
            && noModelDetail.modelIsNull === true && noModelDetail.disabledFlag === true
            && noModelDetail.stageCleared === true && noModelDetail.placeholder === true;
        } catch (err) { window.__AILEEN_ERRORS.push('noModelTest: ' + String((err && err.message) || err)); }
        // 行为断言⑮：点亮「电脑控制」开关要立刻转蓝 + 立刻换成 Dashboard
        let toggleOk = false;
        let toggleDetail = null;
        try {
          toggleDetail = typeof window.__AILEEN_PROBE_COMPUTER_TOGGLE === 'function'
            ? await window.__AILEEN_PROBE_COMPUTER_TOGGLE() : null;
          toggleOk = !!toggleDetail && toggleDetail.error === undefined
            && toggleDetail.baselineDashboardHidden === true
            && toggleDetail.baselineStageVisible === true
            && toggleDetail.settingOn === true
            && toggleDetail.btnHighlighted === true
            && toggleDetail.modeClassOn === true
            && toggleDetail.accentBlue === true
            && toggleDetail.startBtnBlue === true
            && toggleDetail.dashboardShown === true
            && toggleDetail.stageHidden === true
            && !!toggleDetail.afterOff
            && toggleDetail.afterOff.settingOff === true
            && toggleDetail.afterOff.modeClassOff === true
            && toggleDetail.afterOff.dashboardHidden === true
            && toggleDetail.afterOff.stageBack === true;
        } catch (err) { window.__AILEEN_ERRORS.push('toggleTest: ' + String((err && err.message) || err)); }

        // 行为断言⑭：Agent Control Dashboard + 角色人格保留
        let dashOk = false;
        let dashDetail = null;
        try {
          dashDetail = typeof window.__AILEEN_PROBE_DASHBOARD === 'function'
            ? window.__AILEEN_PROBE_DASHBOARD() : null;
          dashOk = !!dashDetail && dashDetail.error === undefined
            && dashDetail.personaFound === true
            && dashDetail.personaFirst === true
            && dashDetail.assertOk === true
            && dashDetail.personaChars > 20
            && dashDetail.toolCount >= 17
            && dashDetail.hiddenBeforeRun === true
            && dashDetail.visibleDuringRun === true
            && dashDetail.stageHiddenDuringRun === true
            && dashDetail.approvalShown === true
            && dashDetail.logLines >= 3
            && dashDetail.approvalHiddenAfterFinish === true;
        } catch (err) { window.__AILEEN_ERRORS.push('dashTest: ' + String((err && err.message) || err)); }

        // 行为断言⑬：Agent 面板 —— 入口能开、控件在、审批卡片能画、拒绝按钮真的接上了
        let agentOk = false;
        let agentDetail = null;
        try {
          agentDetail = typeof window.__AILEEN_PROBE_AGENT === 'function' ? await window.__AILEEN_PROBE_AGENT() : null;
          // 截图已经拍完（审批卡片在里面），现在收尾：点拒绝，卡片必须消失
          const after = typeof window.__AILEEN_PROBE_AGENT_AFTER === 'function'
            ? window.__AILEEN_PROBE_AGENT_AFTER() : null;
          if (agentDetail) agentDetail.after = after;
          agentOk = !!agentDetail && agentDetail.panelOpen === true
            && agentDetail['ag-task'] === true && agentDetail['ag-start'] === true
            && agentDetail['ag-pause'] === true && agentDetail['ag-resume'] === true
            && agentDetail['ag-cancel'] === true && agentDetail['ag-log'] === true
            && agentDetail['ag-status'] === true && agentDetail['ag-workspace'] === true
            && agentDetail.approvalVisible === true
            && agentDetail.approvalRisk === 'HIGH'
            && typeof agentDetail.approvalText === 'string' && agentDetail.approvalText.length > 0
            && agentDetail.logLines >= 1
            && agentDetail.agentModeClass === true
            && agentDetail.accentIsBlue === true
            && agentDetail.startBtnIsBlue === true
            && !!after && after.visibleBeforeReject === true && after.hasReject === true
            && after.hiddenAfterReject === true
            && after.panelHiddenAfterClose === true && after.accentRestored === true;
        } catch (err) { window.__AILEEN_ERRORS.push('agentTest: ' + String((err && err.message) || err)); }
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
          agentOk,
          agentDetail,
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

module.exports = { attachSelfTest };
