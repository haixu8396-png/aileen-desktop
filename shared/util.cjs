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
const TTS_PROVIDERS = ['web', 'openai', 'fish', 'xiaomi'];
const STT_PROVIDERS = ['openai', 'xiaomi', 'web'];
// 嵌入模型供应商：只用于「长期记忆 / 知识库」的语义检索。
// 与对话用的 LLM 分开配置 —— 算向量用便宜的小模型就够。
const EMBEDDING_PROVIDERS = ['openai', 'siliconflow', 'qwen', 'zhipu', 'ollama', 'custom'];
const TTS_LANGS = ['zh', 'en', 'ja', 'es'];
const STT_LANGS = ['auto', 'zh', 'en', 'ja', 'es'];
const UI_LANGS = ['en', 'ja', 'zh'];
const CHESS_SIDES = ['white', 'black'];
const NARRATION_LEVELS = ['off', 'rare', 'natural', 'rich'];
const PACING_LEVELS = ['off', 'rare', 'natural'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

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
  const agent = pick('agent');
  const embedding = pick('embedding');
  const memoryCfg = pick('memoryCfg');
  const knowledgeCfg = pick('knowledgeCfg');

  const extraModels = Array.isArray(r.extraModels)
    ? r.extraModels
        .filter((m) => m && typeof m === 'object' && isHttpUrl(m.url))
        .slice(0, 50)
        .map((m) => ({ name: asStr(m.name, 80) || 'URL 模型', url: asStr(m.url, 500) }))
    : [];

  return {
    // 界面语言：默认英文，另有日文与简体中文
    language: asOneOf(r.language, UI_LANGS, 'en'),
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
      provider: asOneOf(tts.provider, TTS_PROVIDERS, 'web'),
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
      provider: asOneOf(stt.provider, STT_PROVIDERS, 'openai'),
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
    // 长期记忆与知识库的语义检索：**与对话用的 LLM 分开配置**
    // （算向量用便宜的小模型就够，没必要用对话模型）
    embedding: {
      // 关掉也能用：检索退化成关键词匹配（离线可用，只是语义能力弱）
      enabled: asBool(embedding.enabled, true),
      provider: asOneOf(embedding.provider, EMBEDDING_PROVIDERS, 'openai'),
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
    },
  };
}

module.exports = {
  deepMerge, sanitizeFileName, isHttpUrl, isInsidePath, normalizeSettings, UI_LANGS,
  LLM_PROVIDERS, TTS_PROVIDERS, STT_PROVIDERS, EMBEDDING_PROVIDERS,
};
