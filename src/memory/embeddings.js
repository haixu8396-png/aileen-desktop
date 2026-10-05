// ============================================================
// Memory ↔ Embedding 的薄封装
//
// 为什么要有这一层，而不是直接让 retriever 去引 shared/embeddings.cjs：
//   1) 那份是 **CommonJS**（主进程也要 require 它），渲染层按常规 ESM 引进来即可，
//      **不要用 node:module 的 createRequire** —— 那会把 node 内置模块拖进页面，
//      整个渲染层 bundle 会在加载时直接抛错（"createRequire is not a function"）；
//   2) 「记忆文本怎么变成向量」是 memory 模块自己的约定（前缀、缓存、批量），
//      **向量数学仍然全部来自 shared**，这里一个公式都不重复实现；
//   3) 归一化/取整/维度对齐这类脏活集中在一处，检索侧就只剩余弦比较。
//
// 后端是「可配置 OpenAI 兼容 embeddings」，没有配置就自动降级本地词频向量
// （降级原因在 stats().lastFallbackReason 里，界面可以据此提示）。
// ============================================================
import shared from '../../shared/embeddings.cjs';

/** 直接把 shared 里的纯函数转出去 —— 不重写，避免出现第二套向量数学 */
export const { tokenize, localEmbed, normalize, cosine, toArray, keywordScore, STOPWORDS } = shared;

/** 测试/降级判据：向量长度非零即视为「有向量」 */
export function hasVector(vec) {
  return Array.isArray(vec) && vec.some((n) => Number(n) !== 0);
}

/**
 * 记忆侧的配置「取用」。
 *
 * **这个文件不读配置、更不碰任何密钥** —— `src/` 是渲染层，密钥只允许存在于主进程
 * （scripts/lint.mjs 的规则 B 就是这么卡的）。所以：
 *   · getConfig 由**调用方注入**（主进程那边负责从设置里取地址/模型/密钥）；
 *   · 这里只做形状兜底：拿到什么就传什么，取不到就当「没配置」→ 自动降级本地向量。
 * shared/embeddings.cjs 认的是 { baseUrl, apiKey, model, enabled } 四个字段。
 */
export function defaultEmbedConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  // 只对「形状」负责：地址与模型保证是字符串，enabled 保证是布尔。
  // 其余字段（密钥之类）**原样透传**给 shared，这一层不读、不判断、不落盘。
  const out = { baseUrl: String(cfg.baseUrl || '') };
  for (const [key, value] of Object.entries(cfg)) {
    if (key === 'baseUrl') continue;
    if (value !== undefined) out[key] = value;
  }
  out.model = String(cfg.model || 'text-embedding-3-small');
  // 默认「只要配了地址和密钥就启用」；显式 enabled:false 则强制离线
  out.enabled = cfg.enabled !== false;
  return out;
}

/**
 * 建一个 memory 专用 embedder。
 *
 * @param {object} opts
 *   getConfig()   **由调用方注入**：返回 shared 认的那份配置形状
 *                 （主进程负责从设置里取地址/模型/密钥，这里不碰）
 *   config        直接给一份静态配置（与 getConfig 二选一，测试常用）
 *   fetchImpl     注入的 fetch（单测里传假的，绝不打网络）
 *   localOnly     true 时强制离线（等价于 enabled:false）
 *   onFallback    降级回调（reason 字符串）
 *   cache         是否缓存文本→向量（默认开；同一句话反复嵌入没有意义）
 * @returns {{ embed(texts), embedOne(text), stats(), mode(), localFor(text), vectorOf(record) }}
 */
export function createMemoryEmbedder(opts = {}) {
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : null;
  const staticConfig = opts.config || null;
  const useCache = opts.cache !== false;
  const cache = new Map();
  const localOnly = opts.localOnly === true;
  let fallbacks = 0;

  const inner = shared.createEmbedder({
    getConfig: () => {
      if (localOnly) return { enabled: false };
      // 注意：这里不能用 `getConfig ? getConfig() : staticConfig` 直接传给
      // defaultEmbedConfig —— 两者都没有时必须回落到 undefined（而不是 {}），
      // 否则「没配置」会被当成「有配置但地址为空」，降级原因也会从 no-config 变味。
      // 行为上都是降级，但排查时理由必须准确。
      const raw = getConfig ? getConfig() : staticConfig;
      if (!raw) return undefined;
      return defaultEmbedConfig(raw);
    },
    fetchImpl: opts.fetchImpl || null,
    onFallback: (reason) => {
      fallbacks += 1;
      if (typeof opts.onFallback === 'function') opts.onFallback(reason);
    },
  });

  async function embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((x) => String(x == null ? '' : x));
    if (!useCache) return inner.embed(list);
    const out = new Array(list.length);
    const missing = [];
    const missingIdx = [];
    for (let i = 0; i < list.length; i += 1) {
      const hit = cache.get(list[i]);
      if (hit) out[i] = hit;
      else { missing.push(list[i]); missingIdx.push(i); }
    }
    if (missing.length) {
      const vecs = await inner.embed(missing);
      for (let i = 0; i < missing.length; i += 1) {
        const vec = vecs[i] || toArray(localEmbed(missing[i]));
        cache.set(missing[i], vec);
        out[missingIdx[i]] = vec;
      }
    }
    return out;
  }

  return {
    embed,
    async embedOne(text) {
      const [vec] = await embed([text]);
      return vec || toArray(localEmbed(text));
    },
    /** 明确要求「本地向量」时用（离线路径、以及 embedding 维度不匹配时的兜底） */
    localFor(text) {
      return toArray(localEmbed(text));
    },
    /** 取记录自带向量；没有（或全零）就现算一个本地向量，保证检索不会因为缺向量而空手而归 */
    async vectorOf(record) {
      const own = record && Array.isArray(record.embedding) ? record.embedding : null;
      if (hasVector(own)) return own;
      return localFor(record ? record.content : '');
    },
    stats() {
      return Object.assign({ fallbacks, cached: cache.size }, inner.stats());
    },
    mode: () => inner.mode(),
  };
}

export { shared as sharedEmbeddings };
