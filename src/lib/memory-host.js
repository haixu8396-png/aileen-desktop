// ============================================================
// 长期记忆 / 知识库的宿主接线（渲染层）
//
// 引擎本身（`src/memory/`、`src/knowledge/`）是**纯逻辑 + 注入依赖**，
// 这里负责把三样东西接上去：
//   1) **存储**：渲染层没有 Node fs，走 main 的 `store:fs`（只放行
//      <userData>/memory 与 /knowledge 两个目录）；
//   2) **嵌入模型**：走 `shared/embeddings.cjs` 的 createEmbedder ——
//      向量数学在本地、推理经可配置的 OpenAI 兼容接口、没配就降级成本地词频向量；
//   3) **配置**：从设置里现取（用户在设置页改完立刻生效，不用重启）。
//
// 为什么建在这里而不是让引擎各自去拿 window.api：
// 引擎要保持可单测（它们现在注入 fs / fetch 就能跑），宿主细节不该渗进去。
// ============================================================
import { createMemoryEngine } from '../memory/engine.js';
import { createKnowledgeEngine } from '../knowledge/engine.js';
import { createEmbedder } from '../../shared/embeddings.cjs';
import { getSettings } from './settings.js';
import { state } from './state.js';

/** 主进程允许的两个根，名字与 shared/store-ipc.cjs 的 ROOTS 对应 */
const ROOT_MEMORY = 'memory';
const ROOT_KNOWLEDGE = 'knowledge';

/**
 * 「文件不存在」必须带上 `code: 'ENOENT'`。
 *
 * 记忆库是靠这个 code 区分「首次运行、空库、正常」和「文件真的坏了」的
 * （见 memory/store.js 的 load）。走 IPC 桥时如果只抛一个光秃秃的 Error，
 * 新用户第一次打开就会被判成 corrupted + 记一条载入异常 —— 真机自测抓到过。
 */
function missingFile(p) {
  const err = new Error('文件不存在：' + p);
  err.code = 'ENOENT';
  return err;
}

/**
 * 把 `store:fs` 包成 memory 的 store 要的形状。
 * 方法名按引擎的 FS_METHODS（readFile/writeFile/mkdir/rename/exists）——
 * 接口不匹配会在建仓时就抛「缺少方法」，比运行时莫名失败好查得多。
 */
export function createMemoryFsBridge() {
  const call = (op, path, extra) => window.api.storeFs(Object.assign({ op, root: ROOT_MEMORY, path }, extra || {}));
  return {
    async readFile(p) {
      const res = await call('readText', p);
      if (res && res.missing) throw missingFile(p);
      return res.text;
    },
    async writeFile(p, text) {
      await call('writeText', p, { text: String(text == null ? '' : text) });
    },
    async mkdir(p) {
      await call('mkdir', p);
    },
    async rename(from, to) {
      await call('rename', from, { to });
    },
    async exists(p) {
      const res = await call('exists', p);
      return !!(res && res.exists);
    },
  };
}

/** 同上，按 knowledge store 的 createNodeFs 形状 */
export function createKnowledgeFsBridge() {
  const call = (op, path, extra) => window.api.storeFs(Object.assign({ op, root: ROOT_KNOWLEDGE, path }, extra || {}));
  const bytesToBase64 = (base64) => {
    const bin = atob(base64 || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  };
  return {
    async readText(p) {
      const res = await call('readText', p);
      if (res && res.missing) throw missingFile(p);
      return res.text;
    },
    async readBytes(p) {
      const res = await call('readBytes', p);
      if (res && res.missing) throw missingFile(p);
      return bytesToBase64(res.base64);
    },
    async writeText(p, text) {
      await call('writeText', p, { text: String(text == null ? '' : text) });
    },
    async exists(p) {
      const res = await call('exists', p);
      return !!(res && res.exists);
    },
    async mkdirp(p) {
      await call('mkdir', p);
    },
    async rename(from, to) {
      await call('rename', from, { to });
    },
    async remove(p) {
      await call('remove', p);
    },
    async list(p) {
      const res = await call('list', p);
      return (res && res.entries) || [];
    },
  };
}

/**
 * 从设置里取 embedding 配置（引擎每次调用都现取，改完立刻生效）。
 *
 * **注意这里没有 apiKey**：渲染层拿到的设置本来就是脱敏副本（Key 被清空、
 * 只留 apiKeySet 标记），真正的 Key 由主进程在发送请求时自己取。
 * 所以这里不可能、也不需要传出密钥 —— 这是「Key 不出主进程」的结构性保证。
 */
function embedConfig() {
  const s = getSettings() || {};
  const e = s.embedding || {};
  return {
    enabled: e.enabled !== false,
    baseUrl: e.baseUrl || '',
    model: e.model || '',
    batchSize: e.batchSize || 16,
  };
}

/** 建一个共用 embedder（记忆与知识库共用同一份数学与降级逻辑） */
let sharedEmbedder = null;
function getEmbedder(onFallback) {
  if (!sharedEmbedder) {
    sharedEmbedder = createEmbedder({
      getConfig: embedConfig,
      // **请求由主进程发出**：渲染层只送文本、收向量。
      // 直接在这里 fetch 的话，嵌入服务的 Key 就得留在页面里 —— 与
      // 「API Key 不出主进程」这条铁律冲突（第一版就是这么写错的，改掉了）。
      embedFn: async (texts, cfg) => {
        const res = await window.api.embeddingEmbed({
          texts,
          baseUrl: cfg.baseUrl,
          model: cfg.model,
        });
        return (res && res.vectors) || [];
      },
      onFallback,
    });
  }
  return sharedEmbedder;
}

/** 当前记忆库绑定的角色文件（每个角色一份记忆） */
function currentCharFile() {
  // 直接从全局状态读「现在是谁」，不在角色切换处插钩子 ——
  // 少一个必须记得调用的接线点，就少一处会漏的地方。
  try {
    const cur = state && state.current;
    return String((cur && cur.file) || 'default');
  } catch {
    return 'default';
  }
}

/** 记住上次建引擎时用的是哪个角色，以便换角色后自动重建 */
let engineCharFile = null;

let memoryEngine = null;
let knowledgeEngine = null;
let initError = null;

/**
 * 懒初始化。**失败不抛穿**：记忆/知识库挂了不该让整个对话用不了。
 * 失败原因记在 lastError() 里，设置页可以显示。
 */
export function ensureEngines() {
  const s = getSettings() || {};
  const charFile = currentCharFile();
  // 换角色 = 换记忆库文件：把引擎丢掉重建（这就是「每个角色一份记忆」）
  const perChar = !s.memoryCfg || s.memoryCfg.perCharacter !== false;
  if (memoryEngine && perChar && engineCharFile !== charFile) {
    memoryEngine = null;
  }
  if (memoryEngine && knowledgeEngine) return { memory: memoryEngine, knowledge: knowledgeEngine };
  initError = null;
  try {
    const fallbackLog = (msg) => console.warn('[memory]', msg);
    if (!memoryEngine) {
      const charId = perChar ? charFile : 'default';
      // 角色文件名本身就带 .json（例如 svdb.json），直接拼会得到 memory-svdb.json.json
      const safeId = String(charId).replace(/\.json$/i, '').replace(/[^\w.-]+/g, '_') || 'default';
      engineCharFile = charFile;
      memoryEngine = createMemoryEngine({
        fs: createMemoryFsBridge(),
        // 每个角色一份记忆：换角色不会把另一个人的事记到这个人头上
        filePath: 'memory-' + safeId + '.json',
        embedder: getEmbedder(fallbackLog),
        logger: fallbackLog,
      });
    }
    if (!knowledgeEngine) {
      knowledgeEngine = createKnowledgeEngine({
        fs: createKnowledgeFsBridge(),
        dir: '.',
        embedder: getEmbedder(fallbackLog),
      });
    }
  } catch (err) {
    initError = String((err && err.message) || err);
    console.warn('[memory] 引擎初始化失败（会退化成不检索）：', initError);
  }
  return { memory: memoryEngine, knowledge: knowledgeEngine };
}

export function lastError() {
  return initError;
}
export function createRetrievalAdapters() {
  return {
    memory: {
      async search(query, opts = {}) {
        const { memory } = ensureEngines();
        if (!memory) return [];
        const cfg = (getSettings() || {}).memoryCfg || {};
        if (cfg.enabled === false) return [];
        const found = await memory.search(query, {
          k: opts.k || 6,
          budgetTokens: opts.budgetTokens || cfg.maxContextTokens || 800,
        });
        return (found || []).map((r) => ({
          text: r.content,
          relevance: r.relevance,
          importance: r.importance,
          confidence: r.confidence,
          type: r.type,
          id: r.id,
        }));
      },
    },
    knowledge: {
      async search(query, opts = {}) {
        const { knowledge } = ensureEngines();
        if (!knowledge) return [];
        const cfg = (getSettings() || {}).knowledgeCfg || {};
        if (cfg.enabled === false) return [];
        const found = await knowledge.search(query, {
          k: opts.k || cfg.topK || 5,
          budgetTokens: opts.budgetTokens || cfg.maxContextTokens || 1200,
        });
        const list = Array.isArray(found) ? found : (found && found.results) || [];
        return list.map((r) => ({
          text: r.content || r.text,
          relevance: r.relevance || r.score,
          source: r.source && (r.source.filename || r.source.name) ? r.source.filename || r.source.name : undefined,
          document_id: r.document_id,
          chunk_id: r.id || r.chunk_id,
        }));
      },
    },
  };
}
