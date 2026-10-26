// ============================================================
// 共享纯函数（主进程与单元测试共用，CommonJS）
// ============================================================
'use strict';

const nodePath = require('path');

/** 深合并：对象递归，数组/标量直接替换（不保留旧值） */
function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source || {})) {
    if (
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key]) &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

/** 文件名安全化：按 Unicode 字母/数字放行（含中日文、假名），其余替换为下划线 */
function sanitizeFileName(name, fallback = 'character') {
  const s = String(name == null ? '' : name).trim();
  const cleaned = s
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^[._\-\s]+|[._\-\s]+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

/** 仅允许 http/https 链接 */
function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** child 是否位于 parent 目录内（Windows 大小写不敏感） */
function isInsidePath(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return false;
  if (child.includes('\0') || parent.includes('\0')) return false;
  const norm = (p) => {
    const r = nodePath.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + nodePath.sep);
}

const LLM_PROVIDERS = ['deepseek', 'openai', 'moonshot', 'siliconflow', 'groq', 'zhipu', 'qwen', 'xiaomi', 'openrouter', 'ollama', 'custom'];
// none = 明确不用（默认）。用户要求：除了对话 LLM，其它模型类型都要有「（无）」并且默认就是它。
const TTS_PROVIDERS = ['none', 'web', 'openai', 'fish', 'xiaomi'];
const STT_PROVIDERS = ['none', 'openai', 'xiaomi', 'web'];
// 嵌入模型供应商：只用于「长期记忆 / 知识库」的语义检索。
// 与对话用的 LLM 分开配置 —— 算向量用便宜的小模型就够。
const EMBEDDING_PROVIDERS = ['none', 'openai', 'siliconflow', 'qwen', 'zhipu', 'ollama', 'custom'];
const TTS_LANGS = ['zh', 'en', 'ja', 'es'];
const STT_LANGS = ['auto', 'zh', 'en', 'ja', 'es'];
const UI_LANGS = ['en', 'ja', 'zh'];
const CHESS_SIDES = ['white', 'black'];
const NARRATION_LEVELS = ['off', 'rare', 'natural', 'rich'];
const PACING_LEVELS = ['off', 'rare', 'natural'];
// 外观：三种主题模式 + 四个预设强调色（custom = 用户自己挑的两个颜色）
const APPEARANCE_MODES = ['light', 'dark', 'system'];
const ACCENT_IDS = ['rose', 'sage', 'lavender', 'amber', 'custom'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
// Live2D 渲染精细控制（展台窗口里「怎么画」的那几个开关）
const LIVE2D_QUALITY = ['auto', '1', '1.5', '2'];
const LIVE2D_LOD = ['auto', 'full', 'off'];
const LIVE2D_MASK = ['auto', 'high', 'normal'];

const asStr = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const asBool = (v, dflt = false) => (typeof v === 'boolean' ? v : dflt);
const asNum = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const asOneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const asUrl = (v) => {
  const s = asStr(v, 500).trim();
  return s === '' || isHttpUrl(s) ? s : '';
};
const asHex = (v, dflt) => (HEX_COLOR.test(String(v)) ? String(v) : dflt);

/**
 * 设置规范化（白名单 + 类型/范围校验 + 显式替换语义）：
 * 未知字段一律丢弃，数组整体替换，数值越界自动收敛。
 */
/** 可空数字：非法值返回 null（用于「跟随默认位置」的坐标） */
function numOrNull(v, min, max) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** 每个模型最多记这么多条；模型数量也有上限，避免设置文件被撑爆 */
const LIVE2D_STATE_MAX_MODELS = 50;
const LIVE2D_STATE_MAX_ITEMS = 400;
const LIVE2D_STATE_MAX_KEY = 300;

const asStrList = (v, max) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x && x.length <= 200).slice(0, max) : []);

/**
 * Live2D 状态存档：{ byModel: { [稳定模型标识]: { activeExpressions, hiddenParts, updatedAt } } }
 * 只保留最近的 LIVE2D_STATE_MAX_MODELS 个模型（按 updatedAt），数组长度也有限制。
 */
/**
 * 「上次用多大」的存档：每个模型一条，最多 50 条，只留有限位的数字。
 * 打开展台时先按它恢复（不测量、不重算），只有第一次或用户点「按当前姿势适配」才重新量。
 */
const LIVE2D_LAYOUT_MAX_MODELS = 50;

function normalizeLive2dLayout(raw) {
  const out = { byModel: {} };
  const src = raw && typeof raw === 'object' && raw.byModel && typeof raw.byModel === 'object' ? raw.byModel : {};
  const entries = [];
  for (const [key, v] of Object.entries(src)) {
    if (typeof key !== 'string' || !key || key.length > LIVE2D_STATE_MAX_KEY) continue;
    if (!v || typeof v !== 'object') continue;
    const scale = Number(v.scale);
    const fx = Number(v.fx);
    const fy = Number(v.fy);
    if (!Number.isFinite(scale) || scale <= 0 || scale > 64) continue;
    if (!Number.isFinite(fx) || fx < -1 || fx > 2) continue;
    if (!Number.isFinite(fy) || fy < -1 || fy > 2) continue;
    const drawn = Array.isArray(v.drawn)
      ? [Math.max(0, Math.round(Number(v.drawn[0]) || 0)), Math.max(0, Math.round(Number(v.drawn[1]) || 0))]
      : null;
    entries.push([key, {
      scale: Number(scale.toFixed(8)),
      fx: Number(fx.toFixed(6)),
      fy: Number(fy.toFixed(6)),
      drawn,
      updatedAt: Number.isFinite(Number(v.updatedAt)) ? Number(v.updatedAt) : 0,
    }]);
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [key, v] of entries.slice(0, LIVE2D_LAYOUT_MAX_MODELS)) out.byModel[key] = v;
  return out;
}

function normalizeLive2dState(raw) {
  const out = { byModel: {} };
  const src = raw && typeof raw === 'object' && raw.byModel && typeof raw.byModel === 'object' ? raw.byModel : {};
  const entries = [];
  for (const [key, v] of Object.entries(src)) {
    if (typeof key !== 'string' || !key || key.length > LIVE2D_STATE_MAX_KEY) continue;
    if (!v || typeof v !== 'object') continue;
    entries.push([
      key,
      {
        activeExpressions: asStrList(v.activeExpressions, LIVE2D_STATE_MAX_ITEMS),
        hiddenParts: asStrList(v.hiddenParts, LIVE2D_STATE_MAX_ITEMS),
        updatedAt: Number.isFinite(Number(v.updatedAt)) ? Number(v.updatedAt) : 0,
      },
    ]);
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [key, v] of entries.slice(0, LIVE2D_STATE_MAX_MODELS)) out.byModel[key] = v;
  return out;
}

function normalizeSettings(raw, defaults) {
  const base = (defaults && typeof defaults === 'object') ? defaults : {};
  const r = (raw && typeof raw === 'object') ? raw : {};
  const pick = (key) => (r[key] && typeof r[key] === 'object' && !Array.isArray(r[key])) ? r[key] : ((base[key] && typeof base[key] === 'object') ? base[key] : {});
  const llm = pick('llm');
  const tts = pick('tts');
  const stt = pick('stt');
  const behavior = pick('behavior');
  const theme = pick('theme');
  const overlay = pick('overlay');
  const mc = pick('mc');
  const chess = pick('chess');
  const stage = pick('stage');
  const live2d = pick('live2d');
  const agent = pick('agent');
  const embedding = pick('embedding');
  const memoryCfg = pick('memoryCfg');
  const knowledgeCfg = pick('knowledgeCfg');
  const appearance = pick('appearance');
  const general = pick('general');

  const extraModels = Array.isArray(r.extraModels)
    ? r.extraModels
        .filter((m) => m && typeof m === 'object' && isHttpUrl(m.url))
        .slice(0, 50)
        .map((m) => ({ name: asStr(m.name, 80) || 'URL 模型', url: asStr(m.url, 500) }))
    : [];

  return {
    // 界面语言：默认简体中文（写作与文案以中文为准，英/日紧随其后）
    language: asOneOf(r.language, UI_LANGS, 'zh'),
    // 外观：浅色暖纸是默认；强调色只换主色，不动结构性令牌
    appearance: {
      mode: asOneOf(appearance.mode, APPEARANCE_MODES, 'light'),
      accent: asOneOf(appearance.accent, ACCENT_IDS, 'rose'),
      reduceMotion: asBool(appearance.reduceMotion, false),
      custom: appearance.custom && typeof appearance.custom === 'object'
        ? { primary: asHex(appearance.custom.primary, '#c87898'), secondary: asHex(appearance.custom.secondary, '#a99ac7') }
        : null,
    },
    llm: {
      provider: asOneOf(llm.provider, LLM_PROVIDERS, 'deepseek'),
      baseUrl: asUrl(llm.baseUrl),
      customBaseUrl: asBool(llm.customBaseUrl, false),
      // 4000 而不是 300：现在这里存的是 safeStorage 密文（safe:v1: + base64），
      // 300 会把密钥截断成一个解不开的串 —— 那等于把用户的 Key 弄丢。
      apiKey: asStr(llm.apiKey, 4000),
      model: asStr(llm.model, 120),
      temperature: asNum(llm.temperature, 0, 2, 0.8),
      maxTokens: Math.round(asNum(llm.maxTokens, 1, 8192, 1024)),
    },
    tts: {
      provider: asOneOf(tts.provider, TTS_PROVIDERS, 'none'),
      language: asOneOf(tts.language, TTS_LANGS, 'zh'),
      baseUrl: asUrl(tts.baseUrl),
      customBaseUrl: asBool(tts.customBaseUrl, false),
      apiKey: asStr(tts.apiKey, 4000),   // 同上：这里是密文，不是明文
      model: asStr(tts.model, 120),
      voice: asStr(tts.voice, 200),
      rate: asNum(tts.rate, 0.25, 4, 1),
      autoPlay: asBool(tts.autoPlay, true),
    },
    stt: {
      provider: asOneOf(stt.provider, STT_PROVIDERS, 'none'),
      language: asOneOf(stt.language, STT_LANGS, 'zh'),
      baseUrl: asUrl(stt.baseUrl),
      customBaseUrl: asBool(stt.customBaseUrl, false),
      apiKey: asStr(stt.apiKey, 4000),   // 同上：这里是密文，不是明文
      model: asStr(stt.model, 120),
    },
    behavior: {
      greetingOnLoad: asBool(behavior.greetingOnLoad, true),
      autoScroll: asBool(behavior.autoScroll, true),
      // 括号里的动作/心理活动写得有多频繁
      narration: asOneOf(behavior.narration, NARRATION_LEVELS, 'natural'),
      // 回复是否可以带停顿拆成多条
      pacing: asOneOf(behavior.pacing, PACING_LEVELS, 'natural'),
    },
    extraModels,
    theme: {
      primary: asHex(theme.primary, '#ff7eb3'),
      secondary: asHex(theme.secondary, '#38b0de'),
    },
    // 无边框 Live2D 悬浮展台
    overlay: {
      visible: asBool(overlay.visible, false),
      x: numOrNull(overlay.x, -20000, 20000),
      y: numOrNull(overlay.y, -20000, 20000),
      width: Math.round(asNum(overlay.width, 180, 1400, 380)),
      height: Math.round(asNum(overlay.height, 220, 1600, 640)),
      scale: asNum(overlay.scale, 0.1, 3, 0.45),
      opacity: asNum(overlay.opacity, 0.15, 1, 1),
      interactive: asBool(overlay.interactive, false),
    },
    // Minecraft AI 伙伴（mineflayer, MIT）
    mc: {
      host: asStr(mc.host, 200),
      port: Math.round(asNum(mc.port, 1, 65535, 25565)),
      username: asStr(mc.username, 16) || 'AILEEN',
      autoReply: asBool(mc.autoReply, false),
    },
    // 国际象棋（js-chess-engine, MIT）
    chess: {
      level: Math.round(asNum(chess.level, 1, 5, 3)),
      playerColor: asOneOf(chess.playerColor, CHESS_SIDES, 'white'),
      banter: asBool(chess.banter, false),
      fenStack: Array.isArray(chess.fenStack)
        ? chess.fenStack
            .filter((f) => typeof f === 'string' && f.length > 0 && f.length <= 120)
            .slice(-200)
        : [],
    },
    // Live2D 舞台视图偏好
    stage: {
      scale: asNum(stage.scale, 0.15, 1.5, 0.3),
    },
    // Live2D 渲染精细控制（展台窗口的渲染层直接读这一组）
    //
    // 为什么单独一组而不是塞进 overlay：overlay 存的是「窗口在哪、多大、透不透明」，
    // 这里存的是「角色怎么画」—— 换渲染引擎、调口型、调画质都只动这里。
    //   fit      模型在窗口里的基线占比（1 = 刚好铺满，>1 允许略微出血）
    //   zoom     展台工具条面板里的临时微调倍率（乘在 fit 上，也会落盘）
    //   offsetY  垂直偏移，单位是窗口高度（负数向上）
    live2d: {
      fit: asNum(live2d.fit, 0.5, 1.15, 0.95),
      zoom: asNum(live2d.zoom, 0.4, 1.25, 1),
      offsetY: asNum(live2d.offsetY, -0.3, 0.3, 0),
      // 口型同步：主窗口把 TTS 的音量包络送过来，展台拿它驱动嘴部参数
      lipsync: asBool(live2d.lipsync, true),
      lipsyncGain: asNum(live2d.lipsyncGain, 0.3, 3, 1.2),
      // 待机动作：每隔一段时间随机播一次 Idle 组里的动作
      idleMotion: asBool(live2d.idleMotion, true),
      idleInterval: Math.round(asNum(live2d.idleInterval, 3, 180, 14)),
      // 视线跟随：跟随真实鼠标（主进程把光标位置送进展台窗口）
      focusFollow: asBool(live2d.focusFollow, true),
      // 物理（头发/衣服摆动）
      physics: asBool(live2d.physics, true),
      // 渲染倍率（devicePixelRatio 的替代值，auto = 跟随屏幕但最多 2x）
      quality: asOneOf(live2d.quality, LIVE2D_QUALITY, 'auto'),
      // 帧率上限（省电；0 在设置里不开放，最低 15）
      fps: Math.round(asNum(live2d.fps, 15, 60, 60)),
      // 大图集的纹理 LOD：auto = 按实际屏幕尺寸降采样，full = 原始分辨率
      lod: asOneOf(live2d.lod, LIVE2D_LOD, 'auto'),
      // 遮罩精度：auto = 引擎自己判断，high = 强制高精度（复杂模型才有毛边）
      mask: asOneOf(live2d.mask, LIVE2D_MASK, 'auto'),
    },
    // 常规行为开关（设置 → 外观与常规）
    general: {
      // 时间感知：把「现在几点/今天几号」交给角色（接在人格之后，不替换人格）
      timeAwareness: asBool(general.timeAwareness, true),
    },
    // 展台「上次用多大」—— 打开时按它恢复，不再自动重新适配。
    // { byModel: { [稳定模型标识]: { scale, fx, fy, drawn:[w,h], updatedAt } } }
    //   scale = 模型缩放；fx / fy = 画布中心在窗口里的相对位置（0~1），窗口尺寸变了按比例走
    live2dLayout: normalizeLive2dLayout(raw.live2dLayout),
    // Live2D 热键 / 部件状态的落盘（按模型分开）。
    // 为什么不放 localStorage：file:// 下的 localStorage 只在**正常退出**时才落盘，
    // 强杀 / 崩溃 / 直接关机就全丢（实测过），用户看到的就是「热键记不住」。这里写进设置文件，
    // 由主进程原子写，稳。
    live2dState: normalizeLive2dState(raw.live2dState),
    // 长期记忆与知识库的语义检索：**与对话用的 LLM 分开配置**
    // （算向量用便宜的小模型就够，没必要用对话模型）
    embedding: {
      // 关掉也能用：检索退化成关键词匹配（离线可用，只是语义能力弱）
      enabled: asBool(embedding.enabled, true),
      provider: asOneOf(embedding.provider, EMBEDDING_PROVIDERS, 'none'),
      baseUrl: asUrl(embedding.baseUrl),
      customBaseUrl: asBool(embedding.customBaseUrl, false),
      // 与其他分组一致：这里存的是 safeStorage 密文，不是明文
      apiKey: asStr(embedding.apiKey, 4000),
      model: asStr(embedding.model, 120),
      // 一次请求最多带多少条文本算向量（太大容易被服务端拒）
      batchSize: Math.round(asNum(embedding.batchSize, 1, 64, 16)),
    },
    // 长期记忆：与 Chat History 分开（History = 发生过什么；Memory = 什么值得记住）
    memoryCfg: {
      enabled: asBool(memoryCfg.enabled, true),
      maxContextTokens: Math.round(asNum(memoryCfg.maxContextTokens, 0, 8000, 800)),
      minImportance: asNum(memoryCfg.minImportance, 0, 1, 0.45),
      // 每个角色一份记忆（关掉就是全局共享一份）
      perCharacter: asBool(memoryCfg.perCharacter, true),
    },
    // 知识库：外部资料，只读检索
    knowledgeCfg: {
      enabled: asBool(knowledgeCfg.enabled, true),
      maxContextTokens: Math.round(asNum(knowledgeCfg.maxContextTokens, 0, 12000, 1200)),
      topK: Math.round(asNum(knowledgeCfg.topK, 1, 20, 5)),
      chunkTokens: Math.round(asNum(knowledgeCfg.chunkTokens, 100, 2000, 500)),
      chunkOverlapTokens: Math.round(asNum(knowledgeCfg.chunkOverlapTokens, 0, 500, 80)),
    },
    // Coding Agent（第一版：单 Agent + Tool Calling）
    // 只认这两个字段：workspace 是绑定目录，requireMedium 决定
    // 「写文件 / 打补丁 / git commit」要不要用户点头。
    // **刻意没有** allowHighRisk / whitelist 之类的字段：
    // HIGH 风险（跑命令、删除、push）永远要确认，不允许从设置里绕过去。
    agent: {
      workspace: asStr(agent.workspace, 500),
      requireMedium: asBool(agent.requireMedium, true),
      // 电脑控制总开关：开 = 对话走 Agent（Chat 作入口），关 = 纯聊天。
      // 它只决定「要不要给模型工具」，不绕过任何权限。
      computerUse: asBool(agent.computerUse, false),
      // ---- 0.8：授权模式（有范围、有期限、可撤销）----
      // 注意：allowHighRisk 只影响「完全信任模式下 **非不可逆** 的 HIGH 操作」，
      // 不可逆操作（删除 / push / 装包 / shell / 危险命令 / 敏感路径 / 越界）
      // 在任何模式下都要单独确认 —— permission.js 那条硬约束没有被放宽。
      authorization: normalizeAuthorizationCfg(agent.authorization),
      // ---- 0.8：预算与恢复 ----
      maxRounds: Math.round(asNum(agent.maxRounds, 1, 50, 20)),          // 单「段」轮数
      roundBudget: Math.round(asNum(agent.roundBudget, 1, 400, 60)),      // 任务总预算
      maxRetries: Math.round(asNum(agent.maxRetries, 0, 3, 1)),           // 只读工具失败重试
      readOnlyParallel: asBool(agent.readOnlyParallel, true),             // 只读工具受控并行
    },
  };
}

/** 授权配置归一化（CJS 侧；规则与 src/agent/authorization.js 保持一致） */
function normalizeAuthorizationCfg(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const MODES = ['manual', 'batch', 'trust'];
  const mode = MODES.includes(r.mode) ? r.mode : 'manual';
  const scope = r.scope === 'persistent' ? 'persistent' : 'task';
  return {
    mode,
    scope,
    allowHighRisk: r.allowHighRisk === true,
    tools: Array.isArray(r.tools)
      ? r.tools.map((x) => String(x)).filter((x) => x && x.length <= 64).slice(0, 64)
      : null,
    workspace: asStr(r.workspace, 1000),
    expiresAt: Number.isFinite(r.expiresAt) ? Number(r.expiresAt) : null,
    grantedAt: Number.isFinite(r.grantedAt) ? Number(r.grantedAt) : null,
    revokedAt: Number.isFinite(r.revokedAt) ? Number(r.revokedAt) : null,
  };
}

module.exports = {
  deepMerge, sanitizeFileName, isHttpUrl, isInsidePath, normalizeSettings, UI_LANGS,
  APPEARANCE_MODES, ACCENT_IDS,
  LLM_PROVIDERS, TTS_PROVIDERS, STT_PROVIDERS, EMBEDDING_PROVIDERS,
};
