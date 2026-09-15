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
const TTS_LANGS = ['zh', 'en', 'ja', 'es'];
const STT_LANGS = ['auto', 'zh', 'en', 'ja', 'es'];
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
function normalizeSettings(raw, defaults) {
  const base = (defaults && typeof defaults === 'object') ? defaults : {};
  const r = (raw && typeof raw === 'object') ? raw : {};
  const pick = (key) => (r[key] && typeof r[key] === 'object' && !Array.isArray(r[key])) ? r[key] : ((base[key] && typeof base[key] === 'object') ? base[key] : {});
  const llm = pick('llm');
  const tts = pick('tts');
  const stt = pick('stt');
  const behavior = pick('behavior');
  const theme = pick('theme');

  const extraModels = Array.isArray(r.extraModels)
    ? r.extraModels
        .filter((m) => m && typeof m === 'object' && isHttpUrl(m.url))
        .slice(0, 50)
        .map((m) => ({ name: asStr(m.name, 80) || 'URL 模型', url: asStr(m.url, 500) }))
    : [];

  return {
    llm: {
      provider: asOneOf(llm.provider, LLM_PROVIDERS, 'deepseek'),
      baseUrl: asUrl(llm.baseUrl),
      customBaseUrl: asBool(llm.customBaseUrl, false),
      apiKey: asStr(llm.apiKey, 300),
      model: asStr(llm.model, 120),
      temperature: asNum(llm.temperature, 0, 2, 0.8),
      maxTokens: Math.round(asNum(llm.maxTokens, 1, 8192, 1024)),
    },
    tts: {
      provider: asOneOf(tts.provider, TTS_PROVIDERS, 'web'),
      language: asOneOf(tts.language, TTS_LANGS, 'zh'),
      baseUrl: asUrl(tts.baseUrl),
      customBaseUrl: asBool(tts.customBaseUrl, false),
      apiKey: asStr(tts.apiKey, 300),
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
      apiKey: asStr(stt.apiKey, 300),
      model: asStr(stt.model, 120),
    },
    behavior: {
      greetingOnLoad: asBool(behavior.greetingOnLoad, true),
      autoScroll: asBool(behavior.autoScroll, true),
    },
    extraModels,
    theme: {
      primary: asHex(theme.primary, '#ff7eb3'),
      secondary: asHex(theme.secondary, '#38b0de'),
    },
  };
}

module.exports = { deepMerge, sanitizeFileName, isHttpUrl, isInsidePath, normalizeSettings };
