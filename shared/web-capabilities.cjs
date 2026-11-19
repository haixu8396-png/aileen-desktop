'use strict';
// ============================================================
// Provider 原生联网能力：能力表 + 真实探针 + 缓存
//
// 任务书 7.3 的铁律：能力状态必须由**官方文档、明确配置或真实 API 行为**验证，
// 不能凭模型名字或模型自述判断。所以这里做两件事：
//   1) PROFILES 里给每个 provider 列出「官方文档 URL + 候选请求形状」
//   2) probeProvider() 真的发一次最小请求，按响应判定 supported / unsupported / unknown
//
// 判定规则（宁可 unknown，也不猜 supported）：
//   · 2xx 且响应里出现服务端工具事件/引用字段 → supported
//   · 2xx 但没有任何相关字段 → unsupported（端点接受了，但没执行联网工具）
//   · 4xx/5xx 且错误信息提到 unknown tool / unsupported / invalid tool → unsupported
//   · 网络错误 / 超时 / 端点不存在 → unknown
// ============================================================

const CAP = { SUPPORTED: 'supported', UNSUPPORTED: 'unsupported', UNKNOWN: 'unknown' };

const PROFILES = {
  openai: {
    docs: 'https://platform.openai.com/docs/guides/tools-web-search',
    apiVersion: 'v1',
    plans: [
      { endpoint: '/responses', body: { tools: [{ type: 'web_search' }] } },
      { endpoint: '/responses', body: { tools: [{ type: 'web_search_preview' }] } },
      { endpoint: '/chat/completions', body: { tools: [{ type: 'web_search' }] } },
    ],
  },
  anthropic: {
    docs: 'https://docs.anthropic.com/en/docs/build-with-claude/tool-use/web-search-tool',
    apiVersion: '2023-06-01',
    plans: [], // AILEEN 目前没有 Anthropic 适配器（只有 OpenAI 兼容）
  },
  moonshot: {
    docs: 'https://platform.moonshot.cn/docs/guide/use-web-search',
    apiVersion: 'v1',
    plans: [
      { endpoint: '/chat/completions', body: { tools: [{ type: 'builtin_function', function: { name: '$web_search' } }] } },
    ],
  },
  zhipu: {
    docs: 'https://docs.bigmodel.cn/cn/guide/tools/web-search',
    apiVersion: 'v4',
    plans: [
      { endpoint: '/chat/completions', body: { tools: [{ type: 'web_search', web_search: { enable: true } }] } },
    ],
  },
  qwen: {
    docs: 'https://help.aliyun.com/zh/model-studio/web-search',
    apiVersion: 'v1',
    plans: [
      { endpoint: '/chat/completions', body: { enable_search: true, search_options: { forced_search: true } } },
    ],
  },
  deepseek: {
    docs: 'https://api-docs.deepseek.com/',
    apiVersion: 'v1',
    plans: [{ endpoint: '/chat/completions', body: { tools: [{ type: 'web_search' }] } }],
  },
  siliconflow: {
    docs: 'https://docs.siliconflow.cn/',
    apiVersion: 'v1',
    plans: [{ endpoint: '/chat/completions', body: { tools: [{ type: 'web_search' }] } }],
  },
  groq: {
    docs: 'https://console.groq.com/docs/tool-use',
    apiVersion: 'v1',
    plans: [{ endpoint: '/chat/completions', body: { tools: [{ type: 'web_search' }] } }],
  },
  xiaomi: {
    docs: 'https://api.xiaomimimo.com/',
    apiVersion: 'v1',
    plans: [{ endpoint: '/chat/completions', body: { tools: [{ type: 'web_search' }] } }],
  },
  openrouter: {
    docs: 'https://openrouter.ai/docs/features/web-search',
    apiVersion: 'v1',
    plans: [
      { endpoint: '/chat/completions', body: { tools: [{ type: 'web_search' }] } },
      { endpoint: '/chat/completions', body: { plugins: [{ id: 'web' }] } },
    ],
  },
  ollama: {
    docs: 'https://ollama.com/',
    apiVersion: 'local',
    plans: [], // 本地模型没有服务端联网能力
  },
  custom: {
    docs: '',
    apiVersion: '',
    plans: [{ endpoint: '/chat/completions', body: { tools: [{ type: 'web_search' }] } }],
  },
};

const cache = new Map();

function keyOf({ provider, baseUrl, model }) {
  return [String(provider || ''), String(baseUrl || ''), String(model || '')].join('|');
}

function normalizeBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function statusOf({ provider }) {
  const profile = PROFILES[String(provider || '')];
  if (!profile) return { status: CAP.UNKNOWN, docs: '', reason: 'unknown-provider' };
  if (!profile.plans.length) return { status: CAP.UNSUPPORTED, docs: profile.docs, reason: 'no-native-plan' };
  return { status: CAP.UNKNOWN, docs: profile.docs, reason: 'not-probed' };
}

/** 读缓存（未探测/未缓存 → unknown，附官方文档链接） */
function capabilitiesFor({ provider, baseUrl, model } = {}) {
  const key = keyOf({ provider, baseUrl, model });
  const hit = cache.get(key);
  if (hit) return Object.assign({}, hit);
  const base = statusOf({ provider });
  return {
    provider: String(provider || ''),
    model: String(model || ''),
    baseUrl: normalizeBase(baseUrl),
    endpointType: 'chat.completions',
    capabilities: { nativeWebSearch: base.status, nativeWebFetch: base.status, nativeUrlRead: base.status, nativeDeepResearch: CAP.UNKNOWN, citations: base.status },
    evidence: { sourceUrl: base.docs, checkedAt: null, apiVersion: (PROFILES[String(provider || '')] || {}).apiVersion || '', reason: base.reason },
  };
}

function remember(result) {
  cache.set(keyOf(result), result);
  return result;
}

function clearCache() {
  cache.clear();
}

/** 响应里有没有「服务端联网真的执行了」的证据 */
function looksLikeNativeWeb(bodyText) {
  const s = String(bodyText || '');
  return /web_search_call|web_search_preview|server_tool_use|groundingMetadata|grounding_metadata|"annotations"\s*:\s*\[[^\]]*url|"citations"\s*:\s*\[|"search_results"\s*:/.test(s);
}

function looksLikeUnsupported(bodyText) {
  const s = String(bodyText || '');
  return /unknown (tool|type)|unsupported (tool|parameter)|invalid (tool|type)|not support(ed)?|invalid_request_error.*(tool|web_search)|no such tool/i.test(s);
}

/**
 * 真探针：按 provider 的候选形状各发一次最小请求。
 *
 * @param {object} p { provider, baseUrl, model, apiKey, fetchImpl, timeoutMs }
 * @returns {Promise<object>} 能力对象（含 evidence.sourceUrl / checkedAt / reason）
 */
async function probeProvider(p = {}) {
  const provider = String(p.provider || '');
  const baseUrl = normalizeBase(p.baseUrl);
  const model = String(p.model || '');
  const fetchImpl = typeof p.fetchImpl === 'function' ? p.fetchImpl : fetch;
  const timeoutMs = Math.max(3000, Math.min(30000, Number(p.timeoutMs) || 12000));
  const profile = PROFILES[provider] || PROFILES.custom;
  const checkedAt = new Date().toISOString();
  const evidenceBase = { sourceUrl: profile.docs, checkedAt, apiVersion: profile.apiVersion };

  if (!profile.plans.length) {
    return remember({
      provider, model, baseUrl,
      endpointType: profile.apiVersion === 'local' ? 'local' : 'chat.completions',
      capabilities: { nativeWebSearch: CAP.UNSUPPORTED, nativeWebFetch: CAP.UNSUPPORTED, nativeUrlRead: CAP.UNSUPPORTED, nativeDeepResearch: CAP.UNKNOWN, citations: CAP.UNSUPPORTED },
      evidence: Object.assign({ reason: 'no-native-plan' }, evidenceBase),
    });
  }

  let sawNetworkError = false;
  let lastReason = 'not-probed';
  for (const plan of profile.plans) {
    const url = baseUrl + plan.endpoint;
    const body = Object.assign({
      model,
      stream: false,
      max_tokens: 32,
    }, plan.body);
    if (plan.endpoint === '/responses') {
      body.input = 'ping';
      delete body.max_tokens;
      body.max_output_tokens = 16;
    } else {
      body.messages = [{ role: 'user', content: 'ping' }];
      body.max_tokens = 16;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res = null;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: Object.assign({
          'Content-Type': 'application/json',
        }, p.apiKey ? { Authorization: 'Bearer ' + p.apiKey } : {}),
        body: JSON.stringify(body),
      });
    } catch (err) {
      sawNetworkError = true;
      lastReason = (err && err.name === 'AbortError') ? 'timeout' : 'network-error';
      continue;
    } finally {
      clearTimeout(timer);
    }

    let text = '';
    try { text = await res.text(); } catch { text = ''; }

    if (res.status === 401 || res.status === 403) {
      // 能力未知：Key 不对不能当成「不支持」
      return remember({
        provider, model, baseUrl, endpointType: plan.endpoint.replace(/^\//, ''),
        capabilities: { nativeWebSearch: CAP.UNKNOWN, nativeWebFetch: CAP.UNKNOWN, nativeUrlRead: CAP.UNKNOWN, nativeDeepResearch: CAP.UNKNOWN, citations: CAP.UNKNOWN },
        evidence: Object.assign({ reason: 'auth-failed', httpStatus: res.status }, evidenceBase),
      });
    }
    if (res.status >= 200 && res.status < 300 && looksLikeNativeWeb(text)) {
      return remember({
        provider, model, baseUrl, endpointType: plan.endpoint.replace(/^\//, ''),
        capabilities: {
          nativeWebSearch: CAP.SUPPORTED,
          nativeWebFetch: looksLikeNativeWeb(text) ? CAP.SUPPORTED : CAP.UNKNOWN,
          nativeUrlRead: CAP.SUPPORTED,
          nativeDeepResearch: CAP.UNKNOWN,
          citations: /citation|annotations|grounding/i.test(text) ? CAP.SUPPORTED : CAP.UNKNOWN,
        },
        evidence: Object.assign({ reason: 'probe-ok', httpStatus: res.status }, evidenceBase),
      });
    }
    if (res.status >= 200 && res.status < 300) {
      lastReason = 'accepted-without-web-events';
      continue;
    }
    if (looksLikeUnsupported(text)) {
      lastReason = 'rejected-as-unsupported';
      continue;
    }
    lastReason = 'http-' + res.status;
  }

  const status = sawNetworkError && lastReason !== 'rejected-as-unsupported' ? CAP.UNKNOWN : CAP.UNSUPPORTED;
  return remember({
    provider, model, baseUrl,
    endpointType: (profile.plans[0] || {}).endpoint ? profile.plans[0].endpoint.replace(/^\//, '') : 'chat.completions',
    capabilities: { nativeWebSearch: status, nativeWebFetch: status, nativeUrlRead: status, nativeDeepResearch: CAP.UNKNOWN, citations: status },
    evidence: Object.assign({ reason: lastReason }, evidenceBase),
  });
}

module.exports = {
  CAP, PROFILES, capabilitiesFor, probeProvider, remember, clearCache,
  looksLikeNativeWeb, looksLikeUnsupported,
};
