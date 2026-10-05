'use strict';
// ============================================================
// Embedding 与向量数学（Memory 与 Knowledge 共用，**只此一份**）
//
// 分工（这是刻意的）：
//   · **向量数学全在本地** —— 余弦相似度、归一化、top-k、关键词打分都是纯函数，
//     零依赖、可单测、离线可用。
//   · **推理经可配置后端** —— 真正把文本变成向量要模型，走 OpenAI 兼容的
//     POST {baseUrl}/embeddings（和项目里 LLM/TTS/STT 一样：请求在主进程发出，
//     Key 不出主进程）。
//   · **离线自动降级** —— 没有 Key / 网络不通 / 后端报错时，退回本地**词频向量**
//     （hashed bag-of-words）。语义检索变弱，但功能不消失，也不会把记忆丢掉。
//
// 为什么不做本地模型：那要新增原生依赖或百兆级权重文件，会拖垮打包与 CI，
// 与「零新依赖」的项目规矩冲突。接口留好了，将来想插本地模型只换 embed()。
// ============================================================

/** 向量维度：本地降级用的哈希空间（后端返回多少维就用多少维） */
const LOCAL_DIM = 512;

/** 常见中英文停用词 —— 降级检索时它们只会拉低区分度 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing',
  'have', 'has', 'had', 'having', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'of', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'about', 'as', 'from', 'into', 'like', 'so', 'not', 'no', 'yes', 'just', 'very',
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '与', '就', '都', '也', '很',
  '有', '没有', '这个', '那个', '一个', '什么', '怎么', '吗', '呢', '吧', '啊',
  'の', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'です', 'ます', 'した', 'する',
]);

/**
 * 分词：中英日混排都能用。
 *   · 拉丁字母/数字 → 按词切，转小写
 *   · CJK（中日文）→ **按字切**并保留相邻双字（bigram）——
 *     中文没有空格，按字切能保证「任何子串都能匹配上」，bigram 补一点语序信息
 */
function tokenize(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  const out = [];
  // 先按「非字母数字、非 CJK」切开
  const parts = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const part of parts) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(part)) {
      const chars = Array.from(part);
      for (let i = 0; i < chars.length; i += 1) {
        out.push(chars[i]);
        if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1]);
      }
    } else {
      if (!STOPWORDS.has(part)) out.push(part);
    }
  }
  return out;
}

/** 32 位 FNV-1a：给 token 分配哈希桶（本地降级用） */
function hashToken(token) {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 本地词频向量（降级用，也是「离线也能检索」的底气）。
 * 带上符号：哈希撞桶时符号相反会互相抵消，比同号累加更不容易被高频噪声带偏。
 */
function localEmbed(text) {
  const vec = new Float64Array(LOCAL_DIM);
  for (const token of tokenize(text)) {
    const h = hashToken(token);
    const idx = h % LOCAL_DIM;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    vec[idx] += sign;
  }
  return normalize(vec);
}

/** L2 归一化（原地返回新数组；零向量原样返回） */
function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const len = Math.sqrt(sum);
  const out = new Float64Array(vec.length);
  if (len === 0) return out;
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / len;
  return out;
}

/** 余弦相似度。两个向量都已归一化时就是点积，这里仍然处理未归一化的情况。 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 数组/类数组 → 普通 number[]（存 JSON 用） */
function toArray(vec) {
  return Array.from(vec || [], (n) => Number(n) || 0);
}

/**
 * 关键词重合度（BM25 的极简版，用于离线 rerank 与「无向量时也不瞎排」）。
 * 返回 0~1。
 */
function keywordScore(query, text) {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const t = tokenize(text);
  if (t.length === 0) return 0;
  let hit = 0;
  const seen = new Set();
  for (const token of t) {
    if (q.has(token) && !seen.has(token)) { hit += 1; seen.add(token); }
  }
  // 查询里的词命中了多少比例（而不是文本里有多少比例命中）
  return hit / q.size;
}

/** 拼 embedding 请求（OpenAI 兼容；批量传数组） */
function buildEmbedRequest({ baseUrl, model, input }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('缺少 embedding 服务地址');
  return {
    url: base + '/embeddings',
    body: {
      model: String(model || 'text-embedding-3-small'),
      input: Array.isArray(input) ? input : [String(input == null ? '' : input)],
      encoding_format: 'float',
    },
  };
}

/** 解析 embedding 响应 → number[][]（顺序与请求一致；乱序的按 index 排回去） */
function parseEmbedResponse(json) {
  const data = json && Array.isArray(json.data) ? json.data : null;
  if (!data || !data.length) throw new Error('embedding 响应里没有 data');
  const sorted = data.slice().sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  return sorted.map((item) => {
    const vec = item && (item.embedding || item.vector);
    if (!Array.isArray(vec) || !vec.length) throw new Error('embedding 元素为空');
    return vec.map((n) => Number(n) || 0);
  });
}

/**
 * 建立 embedding 服务：优先走后端，失败自动降级本地。
 *
 * @param {object} opts
 *   getConfig() => { baseUrl, apiKey, model, enabled }  每次调用现取（设置会变）
 *   embedFn    (texts, cfg) => Promise<number[][]>      **推荐**：真正的请求由宿主发出
 *              —— 主进程那条链路，Key 不出主进程；渲染层只拿到向量
 *   fetchImpl  (url, init) => Promise<Response>         备用：直接发请求（仅测试/本地工具用）
 *   onFallback (reason) => void                         降级时通知（便于界面提示）
 * @returns {{ embed(texts, opts) => Promise<number[][]>, embedOne(text) => Promise<number[]>,
 *             stats() => object, mode() => 'remote'|'local' }}
 */
function createEmbedder(opts = {}) {
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
  const embedFn = typeof opts.embedFn === 'function' ? opts.embedFn : null;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const onFallback = typeof opts.onFallback === 'function' ? opts.onFallback : () => {};
  const stats = { remote: 0, local: 0, errors: 0, lastFallbackReason: '' };
  let lastMode = 'local';

  function goLocal(texts, reason) {
    stats.local += texts.length;
    stats.lastFallbackReason = String(reason || '');
    if (reason) onFallback(reason);
    lastMode = 'local';
    return texts.map((t) => toArray(localEmbed(t)));
  }

  async function embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t == null ? '' : t));
    if (!list.length) return [];
    const cfg = getConfig() || {};
    const enabled = cfg.enabled !== false;
    // embedFn = **宿主代发**（渲染层 → 主进程）。这种情况下密钥在宿主那一侧，
    // 渲染层本来就不该拿到 apiKey —— 所以不能再要求 cfg.apiKey，否则渲染层永远
    // 走不到远端，检索会静默退化成本地词频向量（设置页看起来一切正常，最难查）。
    const hostSends = !!embedFn;
    // 没有 embedFn 也没有 fetchImpl 时不报错，直接走本地 —— 离线可用是硬要求
    if (!enabled || !cfg.baseUrl || (!hostSends && !cfg.apiKey) || (!embedFn && !fetchImpl)) {
      return goLocal(list, enabled ? 'no-config' : 'disabled');
    }
    try {
      let vecs;
      if (embedFn) {
        // 宿主发请求（主进程）：Key 不经过渲染层
        vecs = await embedFn(list, cfg);
      } else {
        const req = buildEmbedRequest({ baseUrl: cfg.baseUrl, model: cfg.model, input: list });
        const res = await fetchImpl(req.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
          body: JSON.stringify(req.body),
        });
        if (!res || !res.ok) {
          stats.errors += 1;
          return goLocal(list, 'http-' + (res ? res.status : 'no-response'));
        }
        vecs = parseEmbedResponse(await res.json());
      }
      if (!Array.isArray(vecs) || vecs.length !== list.length) {
        stats.errors += 1;
        return goLocal(list, 'count-mismatch');
      }
      stats.remote += list.length;
      lastMode = 'remote';
      return vecs;
    } catch (err) {
      stats.errors += 1;
      return goLocal(list, String((err && err.message) || err));
    }
  }

  return {
    embed,
    async embedOne(text) {
      const [vec] = await embed([text]);
      return vec || toArray(localEmbed(text));
    },
    stats: () => Object.assign({}, stats),
    mode: () => lastMode,
  };
}

module.exports = {
  LOCAL_DIM, STOPWORDS,
  tokenize, hashToken, localEmbed, normalize, cosine, toArray, keywordScore,
  buildEmbedRequest, parseEmbedResponse, createEmbedder,
};
