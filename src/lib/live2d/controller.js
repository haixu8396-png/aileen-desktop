// ============================================================
// Live2D 控制器（兼容层核心）
//
// 职责边界：
//   · 引擎调用只走这里（参数全部按下标、部件按下标）；
//   · 表达式/热键/部件的「当前状态」只有一份，就是本对象；
//   · 网络与解析通过注入的 fetchJson，便于单测；
//   · 失败必须有原因，不允许把失败伪装成成功。
//
// 渲染层每帧只调 `apply(coreModel)`：它负责把「激活中的表达式」和「被隐藏的部件」
// 重新压到模型上（模型的动作/物理每帧都会改这些值，压一次是不行的）。
// ============================================================
import {
  buildParamTable, buildPartTable, hasParam, paramIndex, readParam, writeParamIndex,
  writePartOpacity, readPartOpacity, clampParam,
} from './driver.js';
import {
  parseExpression, mergeExpressions, parseHotkeys, parseParts,
  resolveModelFileUrl, modelDirUrl, modelBaseUrl,
} from './vts-format.js';

const CLIENTS = {
  // localStorage 里存的键（不同模型必须隔离）
  //
  // ⚠️ 这里**不能**用模型 URL 当键：展台模型的 URL 带着本地静态服务的端口，
  // 而那个端口是 `listen(0)` 每次启动随机分配的（实测 55048 → 50614 → 49276…）。
  // 用 URL 当键 = 每开一次应用就是一份新存档，用户看到的就是「热键状态记不住、时好时坏」。
  // 所以键用「相对 models/ 的稳定路径」（主进程 scanModels 给的 file 字段）。
  stateKey: (id) => 'aileen.live2d.v2.' + String(id || ''),
  legacyHotkeysKey: (id) => 'aileen.hotkeys.' + String(id || ''),
  legacyPartsKey: (id) => 'aileen.parts.' + String(id || ''),
};

/** 老存档（用整个 URL 当键）长这样：aileen.live2d.v2.http://127.0.0.1:55048/models/x/y.model3.json */
const LEGACY_URL_PREFIXES = ['aileen.live2d.v2.http://', 'aileen.live2d.v2.https://', 'aileen.hotkeys.http://', 'aileen.hotkeys.https://', 'aileen.parts.http://', 'aileen.parts.https://'];

function safeParse(raw, dflt) {
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? dflt : v;
  } catch (err) {
    return dflt;
  }
}

export function createLive2DController({ fetchJson, storage, persist } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const getJson = typeof fetchJson === 'function' ? fetchJson : async () => null;
  // 落盘适配器（主进程写设置文件）。localStorage 只在「正常退出」时才保证写盘，
  // 强杀 / 崩溃就丢 —— 所以状态以它为准，localStorage 当缓存和老数据来源。
  const durable = persist && typeof persist === 'object' ? persist : null;
  let durablePending = null;

  const ctl = {
    // 模型与表
    modelUrl: '',
    modelKey: '',      // 稳定标识（相对 models/ 的路径）；存档键用它，不用带随机端口的 URL
    dirUrl: '',
    paramTable: buildParamTable(null),
    partTable: buildPartTable(null),
    // 热键
    hotkeys: [],            // [{ name, file, kind, supported, reason, params, error, warnings, loaded }]
    unsupported: [],        // 明确不支持的动作（带原因）
    active: new Set(),      // 激活中的热键（按 file）
    expressionCache: new Map(), // file -> { ok, params, error, warnings }
    // 部件
    parts: [],
    hiddenParts: new Map(), // id -> { index, original }
    // 参数基线
    baseValues: new Map(),  // id -> 不含表达式时的原始值
    lastWritten: new Map(), // id -> 我们上一帧写进去的值
    errors: [],             // [{ scope, message }]
  };

  const pushError = (scope, message) => {
    ctl.errors.push({ scope, message: String(message) });
    if (ctl.errors.length > 40) ctl.errors.shift();
  };

  ctl.report = () => ({ errors: ctl.errors.slice(-10) });

  /** 读一个参数（走 id→下标表） */
  ctl.readParamValue = (coreModel, id) => readParam(ctl.paramTable, coreModel, id);

  /** 按名字写参数（内部一定走下标） */
  ctl.setParamValue = (coreModel, id, value) => {
    const idx = paramIndex(ctl.paramTable, id);
    if (idx < 0) return null;
    return writeParamIndex(ctl.paramTable, coreModel, idx, value);
  };

  /**
   * 切模型：清掉一切与上一个模型有关的东西（缓存、激活、隐藏记录、基线）。
   * 这是「切换模型后旧缓存污染」的根因所在，必须整块清。
   */
  ctl.reset = () => {
    ctl.modelUrl = '';
    ctl.modelKey = '';
    ctl.dirUrl = '';
    ctl.paramTable = buildParamTable(null);
    ctl.partTable = buildPartTable(null);
    ctl.hotkeys = [];
    ctl.unsupported = [];
    ctl.active.clear();
    ctl.expressionCache.clear();
    ctl.parts = [];
    ctl.hiddenParts.clear();
    ctl.baseValues.clear();
    ctl.lastWritten.clear();
    ctl.errors = [];
  };

  /**
   * 挂上模型：建表 → 读 .vtube.json / .cdi3.json → 恢复上次的状态。
   * @param {{ url:string, name?:string, key?:string }} model
   *        key = 相对 models/ 的稳定路径（主进程 scanModels 的 file）；没有就退回 url
   * @param {object} coreModel 引擎 coreModel
   * @returns {Promise<{ hotkeys:number, parts:number, restored:{ expressions:number, parts:number }, errors:object[] }>}
   */
  ctl._loadGen = 0;
  ctl.load = async (model, coreModel) => {
    ctl.reset();
    const gen = (ctl._loadGen += 1);      // 加载代际：旧的加载不许覆盖新模型
    if (!model || !model.url || !coreModel) return { hotkeys: 0, parts: 0, restored: { expressions: 0, parts: 0 }, errors: ctl.errors };
    ctl.modelUrl = String(model.url);
    ctl.modelKey = String(model.key || '') || ctl.modelUrl;
    ctl.dirUrl = modelDirUrl(ctl.modelUrl);
    ctl.paramTable = buildParamTable(coreModel);
    ctl.partTable = buildPartTable(coreModel);
    ctl.coreModelRef = coreModel;   // 恢复状态（部件/表达式）发生在第一帧之前，这里就得有引用
    if (!ctl.paramTable.count) pushError('model', '模型参数表为空，Live2D 可能没有加载成功');

    // --- 热键表 ---
    const base = modelBaseUrl(ctl.modelUrl);
    const vtube = await getJson(base + '.vtube.json');
    if (gen !== ctl._loadGen) return { stale: true, hotkeys: 0, parts: 0, restored: { expressions: 0, parts: 0 }, errors: [] };
    const parsed = parseHotkeys(vtube);
    // 没有 .vtube.json 不算错误（不是所有模型都带 VTS 配置），只是没有热键
    ctl.hotkeys = parsed.hotkeys.map((h) => ({ ...h, params: null, error: null, warnings: [], loaded: false }));
    ctl.unsupported = parsed.unsupported;

    // --- 部件表 ---
    const cdi3 = await getJson(base + '.cdi3.json');
    if (gen !== ctl._loadGen) return { stale: true, hotkeys: 0, parts: 0, restored: { expressions: 0, parts: 0 }, errors: [] };
    ctl.parts = parseParts(cdi3, ctl.partTable.index);

    // --- 恢复上次状态（必须是「真的恢复」，不能只恢复按钮） ---
    const restored = { expressions: 0, parts: 0 };
    const saved = await ctl.readState();
    for (const file of saved.activeExpressions) {
      const hk = ctl.hotkeys.find((h) => h.file === file);
      if (!hk) continue;
      const r = await ctl.setHotkeyActive(hk, true, { silent: true });
      if (r.ok) restored.expressions += 1;
      if (gen !== ctl._loadGen) return { stale: true, hotkeys: 0, parts: 0, restored: { expressions: 0, parts: 0 }, errors: [] };
    }
    for (const id of saved.hiddenParts) {
      const p = ctl.parts.find((x) => x.id === id);
      if (!p) continue;
      ctl.hidePart(p, { silent: true });
      restored.parts += 1;
    }
    ctl.apply(coreModel);
    return { hotkeys: ctl.hotkeys.length, parts: ctl.parts.length, restored, errors: ctl.errors };
  };

  // ---------------- 持久化 ----------------
  /**
   * 当前模型的存档标识：优先用主进程给的稳定 key（相对 models/ 的路径），
   * 没有 key 的老调用点才退回 URL（会带随机端口，属于已知的退化情况）。
   */
  ctl.stateId = () => String(ctl.modelKey || ctl.modelUrl || '');

  /** URL 里 /models/ 之后的那段（迁移老存档时用它做「同一个模型」的判据） */
  function urlTail(url) {
    const u = String(url || '');
    const i = u.indexOf('/models/');
    return i >= 0 ? u.slice(i) : '';
  }

  function parseState(v) {
    if (!v || typeof v !== 'object') return null;
    return {
      activeExpressions: Array.isArray(v.activeExpressions) ? v.activeExpressions.filter((x) => typeof x === 'string') : [],
      hiddenParts: Array.isArray(v.hiddenParts) ? v.hiddenParts.filter((x) => typeof x === 'string') : [],
    };
  }

  /**
   * 迁移「用整个 URL 当键」的老存档（0.7.6 之前写下的，键里带随机端口）。
   * 判据：键以 http(s):// 开头的老前缀，且 URL 尾部（/models/... 之后）和当前模型一致。
   * 迁移完把老键删掉，避免以后两份存档各说各话。
   */
  /** 列出 storage 里所有键（浏览器 localStorage 用 length/key；单测替身也照这个实现） */
  function storeKeys() {
    const out = [];
    try {
      if (store && typeof store.length === 'number' && typeof store.key === 'function') {
        for (let i = 0; i < store.length; i += 1) {
          const k = store.key(i);
          if (typeof k === 'string' && k) out.push(k);
        }
        return out;
      }
      for (const k of Object.keys(store || {})) {
        if (typeof k === 'string' && k.startsWith('aileen.')) out.push(k);
      }
    } catch (err) { /* 隐私模式 / 半实现的对象：当没有老存档 */ }
    return out;
  }

  ctl.migrateLegacyState = () => {
    const out = { activeExpressions: [], hiddenParts: [], migratedKeys: [] };
    if (!store) return out;
    const tail = urlTail(ctl.modelUrl);
    for (const k of storeKeys()) {
      if (!LEGACY_URL_PREFIXES.some((p) => k.startsWith(p))) continue;
      if (tail && !k.endsWith(tail)) continue;      // 不是这个模型的，别动
      const v = safeParse(store.getItem(k), null);
      let a = [];
      let p = [];
      if (k.startsWith('aileen.live2d.v2.')) {
        const parsed = parseState(v);
        if (!parsed) continue;
        a = parsed.activeExpressions;
        p = parsed.hiddenParts;
      } else if (k.startsWith('aileen.hotkeys.')) {
        if (!Array.isArray(v)) continue;
        a = v.filter((x) => typeof x === 'string');
      } else if (k.startsWith('aileen.parts.')) {
        if (!Array.isArray(v)) continue;
        p = v.filter((x) => typeof x === 'string');
      } else continue;
      for (const x of a) if (!out.activeExpressions.includes(x)) out.activeExpressions.push(x);
      for (const x of p) if (!out.hiddenParts.includes(x)) out.hiddenParts.push(x);
      out.migratedKeys.push(k);
    }
    if (out.migratedKeys.length) {
      try {
        for (const k of out.migratedKeys) store.removeItem(k);
      } catch (err) { /* 隐私模式删不掉就留着，不影响读取 */ }
    }
    return out;
  };

  /** 只读 localStorage（同步），给调试/自检用 */
  ctl.readStateLocal = () => {
    const empty = { activeExpressions: [], hiddenParts: [] };
    if (!store || !ctl.stateId()) return empty;
    const raw = store.getItem(CLIENTS.stateKey(ctl.stateId()));
    if (raw) {
      const parsed = parseState(safeParse(raw, null));
      if (parsed) return parsed;
    }
    return empty;
  };

  /**
   * 读存档：主进程设置文件优先，localStorage 兜底，最后才迁移「带随机端口」的老键。
   * 三个来源都空就是空（不要编一个「有状态」出来）。
   */
  ctl.readState = async () => {
    const empty = { activeExpressions: [], hiddenParts: [] };
    if (!ctl.stateId()) return empty;
    if (durable && typeof durable.load === 'function') {
      try {
        const remote = parseState(await durable.load(ctl.stateId()));
        if (remote && (remote.activeExpressions.length || remote.hiddenParts.length)) return remote;
      } catch (err) { /* 主进程没起来 / 通道还没注册：退回本地 */ }
    }
    const local = ctl.readStateLocal();
    if (local.activeExpressions.length || local.hiddenParts.length) return local;
    // 老存档（用整个 URL 当键，带随机端口）→ 迁移到稳定键
    const legacy = ctl.migrateLegacyState();
    if (legacy.migratedKeys.length) {
      const value = { version: 2, activeExpressions: legacy.activeExpressions, hiddenParts: legacy.hiddenParts };
      try { store.setItem(CLIENTS.stateKey(ctl.stateId()), JSON.stringify(value)); } catch (err) { /* 写不进去下次再迁 */ }
      ctl.saveState();   // 顺手把它写进设置文件，以后不依赖 localStorage
      return { activeExpressions: legacy.activeExpressions, hiddenParts: legacy.hiddenParts };
    }
    return empty;
  };

  ctl.saveState = () => {
    const id = ctl.stateId();
    if (!id) return false;
    const snapshot = {
      activeExpressions: [...ctl.active],
      hiddenParts: [...ctl.hiddenParts.keys()],
    };
    let localOk = false;
    if (store) {
      try {
        store.setItem(CLIENTS.stateKey(id), JSON.stringify(Object.assign({ version: 2 }, snapshot)));
        localOk = true;
      } catch (err) {
        pushError('state', 'localStorage 写入失败：' + ((err && err.message) || err));
      }
    }
    // 落盘到主进程设置文件：localStorage 只在正常退出时才写盘，靠不住
    if (durable && typeof durable.save === 'function') {
      try {
        const p = durable.save(id, snapshot);
        if (p && typeof p.catch === 'function') p.catch(() => { /* 主进程写失败不影响本次运行 */ });
      } catch (err) { /* 同上 */ }
    }
    return localOk;
  };

  // ---------------- 表达式 ----------------
  /** 读一个表达式文件并解析；结果带缓存（按文件，模型切换时整块清空） */
  ctl.loadExpression = async (file) => {
    if (!file) return { ok: false, params: [], error: '没有表达式文件名', warnings: [] };
    if (ctl.expressionCache.has(file)) return ctl.expressionCache.get(file);
    const url = resolveModelFileUrl(ctl.dirUrl, file);
    if (!url) {
      const bad = { ok: false, params: [], error: '表达式路径非法：' + file, warnings: [] };
      ctl.expressionCache.set(file, bad);
      return bad;
    }
    const json = await getJson(url);
    if (json === null) {
      const miss = { ok: false, params: [], error: '表达式文件读取失败（不存在或不是合法 JSON）：' + file, warnings: [] };
      ctl.expressionCache.set(file, miss);
      return miss;
    }
    const parsedExp = parseExpression(json);
    ctl.expressionCache.set(file, parsedExp);
    return parsedExp;
  };

  /** 打开/关闭一个热键（异步：会去读表达式文件）；返回 { ok, error, missing } */
  ctl.setHotkeyActive = async (hk, on, { silent = false } = {}) => {
    if (!hk) return { ok: false, error: '热键不存在' };
    if (!hk.supported) return { ok: false, error: hk.reason || '这个热键 VTS 动作暂不支持' };
    // RemoveAllExpressions 是「清空全部」而不是一个可开可关的表达式（VTS 也是这么语义）
    if (hk.kind === 'remove-all') {
      if (on) ctl.clearHotkeys();
      return { ok: true, missing: [] };
    }
    const urlAtStart = ctl.modelUrl;      // 读文件期间模型可能被换掉，回来先核对
    if (on) {
      const exp = await ctl.loadExpression(hk.file);
      if (urlAtStart !== ctl.modelUrl) return { ok: false, error: '模型已切换，忽略这次表达式' };
      hk.warnings = exp.warnings || [];
      if (!exp.ok) {
        hk.error = exp.error;
        if (!silent) pushError('expression', hk.name + '：' + exp.error);
        return { ok: false, error: exp.error };
      }
      // 参数必须真的在这个模型里 —— 否则就是「按钮亮了、模型不动」的假成功
      const missing = exp.params.filter((p) => !hasParam(ctl.paramTable, p.id)).map((p) => p.id);
      hk.params = exp.params;
      hk.error = missing.length ? ('模型里没有这些参数：' + missing.join(', ')) : null;
      hk.loaded = true;
      ctl.active.add(hk.file);
      ctl.saveState();
      if (missing.length) {
        if (!silent) pushError('expression', hk.name + '：' + hk.error);
        // 仍然保持激活（能用上的参数照常生效），但把失败原因报出去，不伪装成成功
        return { ok: false, error: hk.error, missing };
      }
      return { ok: true, missing: [] };
    }
    ctl.active.delete(hk.file);
    // 关掉之后要把「我们写过的参数」还原成基线，否则模型卡在上一次的形态
    ctl.releaseParameters(hk.params);
    hk.params = null;
    hk.error = null;
    ctl.saveState();
    return { ok: true, missing: [] };
  };

  /** 把某个表达式写过的参数恢复成基线值（不依赖引擎的 default，用我们记录的基线） */
  ctl.releaseParameters = (params) => {
    const core = ctl.coreModelRef;
    if (!core) return 0;
    let n = 0;
    for (const p of (params || [])) {
      const id = String(p.id);
      const idx = paramIndex(ctl.paramTable, id);
      if (idx < 0) continue;
      const base = ctl.baseValues.has(id) ? ctl.baseValues.get(id) : ctl.paramTable.def[idx];
      if (writeParamIndex(ctl.paramTable, core, idx, base) === null) continue;
      ctl.lastWritten.delete(id);
      ctl.baseValues.delete(id);
      n += 1;
    }
    return n;
  };

  /** 清空全部表达式 */
  ctl.clearHotkeys = () => {
    for (const hk of ctl.hotkeys) {
      if (ctl.active.has(hk.file)) {
        ctl.active.delete(hk.file);
        ctl.releaseParameters(hk.params);
        hk.params = null;
        hk.error = null;
      }
    }
    ctl.active.clear();
    ctl.baseValues.clear();
    ctl.lastWritten.clear();
    ctl.saveState();
    return true;
  };

  // ---------------- 部件 ----------------
  /** 隐藏一个部件：先记录原始不透明度，再压 0 */
  ctl.hidePart = (part, { silent = false } = {}) => {
    if (!part || part.index < 0) return { ok: false, error: '部件不存在' };
    const core = ctl.coreModelRef;
    if (!core) return { ok: false, error: '模型还没就绪' };
    const original = readPartOpacity(core, part.index);
    ctl.hiddenParts.set(part.id, { index: part.index, original });
    const after = writePartOpacity(core, part.index, 0);
    if (after === null) {
      ctl.hiddenParts.delete(part.id);
      const err = '这个部件没法改不透明度（引擎接口不可用）';
      if (!silent) pushError('part', part.label + '：' + err);
      return { ok: false, error: err };
    }
    ctl.saveState();
    return { ok: true, original };
  };

  /** 恢复一个部件：写回记录下来的原始不透明度 */
  ctl.showPart = (part) => {
    if (!part) return { ok: false, error: '部件不存在' };
    const rec = ctl.hiddenParts.get(part.id);
    const core = ctl.coreModelRef;
    if (!rec || !core) {
      ctl.hiddenParts.delete(part.id);
      return { ok: true, restored: null };
    }
    const restored = writePartOpacity(core, rec.index, rec.original === null ? 1 : rec.original);
    ctl.hiddenParts.delete(part.id);
    ctl.saveState();
    return { ok: true, restored };
  };

  /** 全部显示：真的把每个部件的原始不透明度写回去，不只是清记录 */
  ctl.showAllParts = () => {
    const core = ctl.coreModelRef;
    let n = 0;
    for (const [id, rec] of ctl.hiddenParts) {
      if (core) writePartOpacity(core, rec.index, rec.original === null ? 1 : rec.original);
      n += 1;
    }
    ctl.hiddenParts.clear();
    ctl.saveState();
    return n;
  };

  ctl.isPartHidden = (id) => ctl.hiddenParts.has(String(id));

  // ---------------- 每帧应用 ----------------
  /**
   * 每帧调用（beforeModelUpdate）：
   *   1) 把被隐藏的部件持续压到 0（动作/物理每帧都会改它们）；
   *   2) 计算激活表达式的合成值（Overwrite/Add/Multiply 按激活顺序），写成参数；
   * 基线怎么来：如果当前值等于我们上一帧写进去的值，说明这一帧没人动过它，
   * 基线就沿用记录值；否则说明动作/物理改过它，把当前值当新基线（这样加/乘不会越叠越大）。
   */
  ctl.apply = (coreModel) => {
    if (!coreModel) return { parts: 0, params: 0 };
    ctl.coreModelRef = coreModel;
    let parts = 0;
    for (const [, rec] of ctl.hiddenParts) {
      if (writePartOpacity(coreModel, rec.index, 0) !== null) parts += 1;
    }
    const activeList = [];
    for (const file of ctl.active) {
      const hk = ctl.hotkeys.find((h) => h.file === file);
      const exp = hk && hk.params ? hk : null;
      if (exp) activeList.push({ id: hk.name, params: hk.params });
    }
    if (!activeList.length) return { parts, params: 0 };
    const merged = mergeExpressions(activeList, (id) => {
      const cur = readParam(ctl.paramTable, coreModel, id);
      const last = ctl.lastWritten.get(String(id));
      if (last !== undefined && cur !== null && Math.abs(cur - last) < 1e-6) {
        return ctl.baseValues.has(String(id)) ? ctl.baseValues.get(String(id)) : cur;
      }
      if (cur !== null) ctl.baseValues.set(String(id), cur);
      return cur === null ? 0 : cur;
    });
    let params = 0;
    for (const id of merged.order) {
      const idx = paramIndex(ctl.paramTable, id);
      if (idx < 0) continue;
      const want = clampParam(ctl.paramTable, idx, merged.values[id]);
      const after = writeParamIndex(ctl.paramTable, coreModel, idx, want);
      if (after === null) continue;
      ctl.lastWritten.set(String(id), after);
      params += 1;
    }
    return { parts, params };
  };

  /** 自检/调试用的快照（不含引擎对象本身） */
  ctl.snapshot = () => ({
    modelUrl: ctl.modelUrl,
    params: ctl.paramTable.count,
    parts: ctl.parts.length,
    hotkeys: ctl.hotkeys.map((h) => ({ name: h.name, file: h.file, supported: h.supported, active: ctl.active.has(h.file), error: h.error, params: h.params ? h.params.length : 0 })),
    unsupported: ctl.unsupported.map((u) => ({ name: u.name, action: u.action, reason: u.reason })),
    active: [...ctl.active],
    hiddenParts: [...ctl.hiddenParts.entries()].map(([id, rec]) => ({ id, index: rec.index, original: rec.original })),
    errors: ctl.errors.slice(-10).map((e) => ({ scope: e.scope, message: e.message })),
  });

  return ctl;
}

/** 直接用 VTS 的 hotkey 动作字符串判断「能不能做」（UI 灰按钮用） */
export function hotkeySupported(action) {
  return action === 'ToggleExpression' || action === 'RemoveAllExpressions';
}
