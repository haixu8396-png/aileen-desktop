// ============================================================
// Knowledge Base：Engine —— 对外唯一门面
//
// 这一层只做**编排**：读进来 → 解析 → 切块 → 算向量 → 落库，
// 以及 查询 → 改写 → 召回 → 精排 → 组装结果。
// 每一步的实现都在各自文件里（parser/chunker/store/retriever/reranker），
// 所以这里没有算法，只有顺序和状态。
//
// 与 Long-term Memory 的边界（刻意划清，不要合并）：
//   · Memory  = 「用户/AI 关系的长期信息」：偏好、约定、发生过的事；
//   · Knowledge = 「AI 可以去查的外部资料」：文档、手册、笔记。
//   两者共用 shared/embeddings.cjs 的向量数学，但**存储、生命周期、
//   检索语义完全不同**（记忆要随对话演化，知识库只随文件变更）。
//   所以这里不 import 任何 memory 模块，也不把 chunk 写进记忆库。
//
// 注入项（全部可替换，便于单测与主进程接线）：
//   fs / dir / getConfig / fetchImpl / onFallback / embedder / store / now
// ============================================================

import { createStore, createNodeFs } from './store.js';
import { createKnowledgeEmbedder } from './embeddings.js';
import { loadSource } from './loader.js';
import { normalizeSource, SOURCE_KIND, sourceId } from './sources.js';
import {
  retrieve, rewriteQuery, formatCitation, formatCitations, buildContext,
  DEFAULT_K, DEFAULT_MIN_SCORE,
} from './retriever.js';
import { rerank } from './reranker.js';
import { estimateTokens, DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS } from './chunker.js';

/**
 * 造一个知识库。
 * @param {object} options
 *   fs          注入的文件系统（默认 node:fs 适配器）
 *   dir         存储目录（JSON 文件都放这儿）
 *   getConfig   () => { baseUrl, apiKey, model, enabled }（embedding 后端配置）
 *   fetchImpl   注入的 fetch（主进程代发请求 / 单测假 fetch）
 *   chunking    { maxTokens, overlapTokens }
 *   retrieval   { k, candidateK, minScore }
 *   rerank      { weights, halfLifeDays }
 *   now         () => ISO 字符串（单测可以注入固定时间）
 */
export function createKnowledgeEngine(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();
  const fs = opts.fs || createNodeFs();
  const chunkOpts = Object.assign({}, opts.chunking);
  const maxTokens = Number.isFinite(Number(chunkOpts.maxTokens)) && Number(chunkOpts.maxTokens) > 0
    ? Number(chunkOpts.maxTokens) : DEFAULT_MAX_TOKENS;
  const overlapTokens = chunkOpts.overlapTokens === undefined ? DEFAULT_OVERLAP_TOKENS : chunkOpts.overlapTokens;
  const retrievalOpts = Object.assign({}, opts.retrieval);
  const rerankOpts = Object.assign({}, opts.rerank);

  const store = opts.store || createStore({ fs, dir: opts.dir, now });
  const embedder = opts.embedder || createKnowledgeEmbedder({
    getConfig: opts.getConfig,
    fetchImpl: opts.fetchImpl,
    onFallback: opts.onFallback,
  });

  /** chunk 缓存：检索是热路径，每次 search 都去读 JSON 文件太浪费 */
  let cacheLoaded = false;
  let chunkCache = [];
  let lastSearchInfo = null;
  let readyPromise = null;

  function invalidate() {
    cacheLoaded = false;
    chunkCache = [];
  }

  async function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        await store.init();
        invalidate();
      })();
    }
    return readyPromise;
  }

  async function allChunks() {
    if (!cacheLoaded) {
      chunkCache = await store.iterChunks();
      cacheLoaded = true;
    }
    return chunkCache;
  }

  /** 送进 embedding 的文本：标题 + 正文（标题本身就是强语义信号） */
  function embeddingText(chunk) {
    return chunk.title ? chunk.title + '\n' + chunk.content : chunk.content;
  }

  /** 算向量：失败不抛错，退回 null（检索会自动用关键词兜底） */
  async function embedChunks(chunks, warnings) {
    if (!chunks.length) return { dim: 0, vectorized: 0 };
    let vectors = null;
    try {
      vectors = await embedder.embed(chunks.map(embeddingText));
    } catch (err) {
      warnings.push({ code: 'embedding-failed', message: '向量化失败，已退化为关键词检索：' + String((err && err.message) || err) });
    }
    let dim = 0;
    let vectorized = 0;
    chunks.forEach((chunk, i) => {
      const vec = vectors && Array.isArray(vectors[i]) && vectors[i].length ? vectors[i].map(Number) : null;
      chunk.embedding = vec;
      if (vec) {
        vectorized += 1;
        dim = vec.length;
      }
    });
    return { dim, vectorized };
  }

  /** 把 loader 的结果正式入库（新增与更新共用同一条路径，行为才一致） */
  async function storeLoaded(loaded, existing, extraWarnings, flags = {}) {
    const warnings = loaded.warnings.slice().concat(extraWarnings || []);
    const stamp = now();
    const embedInfo = await embedChunks(loaded.chunks, warnings);
    if (embedInfo.vectorized && embedInfo.vectorized < loaded.chunks.length) {
      warnings.push({ code: 'partial-vectors', message: '部分 chunk 没有向量（' + (loaded.chunks.length - embedInfo.vectorized) + '/' + loaded.chunks.length + '），这部分只能靠关键词召回' });
    }
    // 重新索引时必须沿用文档身份（kind/path/名字），否则一个"文件"文档会因为
    // 退回存储文本重切而变成"文本"文档，用户会看到来源凭空变了
    const identity = flags.keepIdentity && existing ? existing : loaded.source;
    const document = {
      id: loaded.documentId,
      kind: identity.kind,
      name: identity.name,
      filename: identity.filename,
      path: identity.path,
      extension: identity.extension,
      format: loaded.source.format || identity.format,
      mime: identity.mime,
      size: identity.size,
      modified_at: identity.modified_at,
      title: loaded.parsed.title || null,
      metadata: identity.metadata || {},
      content_hash: loaded.content_hash,
      chunk_count: loaded.chunks.length,
      vectorized_chunks: embedInfo.vectorized,
      embedding_dim: embedInfo.dim,
      warnings,
      created_at: (existing && existing.created_at) || stamp,
      updated_at: stamp,
    };
    // 先写正文/chunks，再写索引：中途失败时索引里不会出现"有文档没内容"的状态，
    // 而且 saveContent 是整体覆盖 + 原子 rename，旧 chunks 不会有残留
    await store.saveContent(document.id, {
      raw_text: loaded.raw_text,
      title: document.title,
      format: document.format,
      warnings,
      chunks: loaded.chunks,
    });
    await store.upsertDocument(document);
    invalidate();
    return {
      id: document.id,
      chunk_count: document.chunk_count,
      vectorized_chunks: document.vectorized_chunks,
      replaced: Boolean(existing),
      changed: !existing || existing.content_hash !== document.content_hash,
      mode: embedder.mode(),
      warnings,
    };
  }

  async function addDocument(source) {
    await ensureReady();
    const loaded = await loadSource(source, { fs, now: now(), maxTokens, overlapTokens });
    const existing = store.getDocument(loaded.documentId);
    return await storeLoaded(loaded, existing);
  }

  async function addText(input) {
    const payload = typeof input === 'string' ? { text: input } : (input || {});
    await ensureReady();
    const loaded = await loadSource(
      Object.assign({ kind: SOURCE_KIND.TEXT }, payload, { text: String(payload.text == null ? '' : payload.text) }),
      { fs, now: now(), maxTokens, overlapTokens },
    );
    const existing = store.getDocument(loaded.documentId);
    return await storeLoaded(loaded, existing);
  }

  async function removeDocument(id) {
    await ensureReady();
    const doc = store.getDocument(id);
    if (!doc) return { id: String(id), removed: false, removed_chunks: 0 };
    await store.deleteDocument(id);
    invalidate();
    return { id: String(id), removed: true, removed_chunks: Number(doc.chunk_count) || 0 };
  }

  /**
   * 重新索引：不换文档 id，重新解析/切块/算向量并**整体替换**旧的 chunks。
   * 文件来源优先重新读盘（真的重解析）；读不到时退回导入时保存的文本，
   * 并在返回的 warnings 里说明（不假装重新解析过）。
   */
  async function reindexDocument(id) {
    await ensureReady();
    const doc = store.getDocument(id);
    if (!doc) throw new Error('知识库没有这篇文档：' + id);
    const warnings = [];
    let loaded = null;
    let fromFile = false;

    if (doc.kind === SOURCE_KIND.FILE && doc.path) {
      try {
        loaded = await loadSource(
          { kind: SOURCE_KIND.FILE, path: doc.path, name: doc.name, filename: doc.filename, format: doc.format, metadata: doc.metadata },
          { fs, now: now(), documentId: doc.id, maxTokens, overlapTokens },
        );
        fromFile = true;
      } catch (err) {
        warnings.push({
          code: 'reindex-file-read-failed',
          message: '重新读取原文件失败（' + String((err && err.message) || err) + '），改用导入时保存的文本重新切块',
        });
      }
    }

    if (!loaded) {
      const content = await store.readContent(doc.id);
      const raw = content && typeof content.raw_text === 'string' ? content.raw_text : null;
      if (raw === null) throw new Error('这篇文档没有可重新切块的内容（存储缺失）：' + id);
      warnings.push({
        code: 'reindexed-from-store',
        message: '按导入时保存的文本重新切块（不再重新解析原文件）',
      });
      loaded = await loadSource(
        { kind: SOURCE_KIND.TEXT, text: raw, name: doc.filename || doc.name, filename: doc.filename || doc.name, format: doc.format, metadata: doc.metadata },
        { fs, now: now(), documentId: doc.id, maxTokens, overlapTokens },
      );
    }

    const result = await storeLoaded(loaded, doc, warnings, { keepIdentity: true });
    return Object.assign(result, { reindexed: true, from_file: fromFile });
  }

  /**
   * 更新：内容变了就重建 chunks 与向量，**文档 id 不变**。
   * 旧 chunks 不是"追加"而是整体替换，所以不会残留（测试里专门盯这一点）。
   */
  async function updateDocument(id, source) {
    await ensureReady();
    const doc = store.getDocument(id);
    if (!doc) throw new Error('知识库没有这篇文档：' + id);
    const loaded = await loadSource(source, { fs, now: now(), documentId: doc.id, maxTokens, overlapTokens });
    const result = await storeLoaded(loaded, doc);
    return Object.assign(result, { updated: true, previous_chunks: Number(doc.chunk_count) || 0 });
  }

  function documentStatus(doc) {
    const total = Number(doc.chunk_count) || 0;
    const vectorized = Number(doc.vectorized_chunks) || 0;
    return {
      id: doc.id,
      name: doc.name,
      filename: doc.filename,
      path: doc.path,
      kind: doc.kind,
      format: doc.format,
      extension: doc.extension,
      title: doc.title || null,
      size: doc.size,
      chunk_count: total,
      vectorized_chunks: vectorized,
      vectorized: total > 0 && vectorized === total,
      embedding_dim: doc.embedding_dim || 0,
      status: total === 0 ? 'empty' : (vectorized === total ? 'indexed' : 'partially-indexed'),
      content_hash: doc.content_hash || null,
      warning_count: Array.isArray(doc.warnings) ? doc.warnings.length : 0,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    };
  }

  function listDocuments() {
    return store.documents().map(documentStatus);
  }

  function getDocument(id) {
    const doc = store.getDocument(id);
    return doc ? Object.assign(documentStatus(doc), { metadata: doc.metadata || {}, warnings: doc.warnings || [] }) : null;
  }

  async function indexStatus() {
    await ensureReady();
    const chunks = await allChunks();
    const vectorized = chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length).length;
    return {
      dir: store.dir,
      documents: store.documents().length,
      chunks: chunks.length,
      vectorized_chunks: vectorized,
      vectorized: chunks.length > 0 && vectorized === chunks.length,
      embedding: {
        mode: embedder.mode(),
        stats: embedder.stats(),
        dim: chunks.find((c) => Array.isArray(c.embedding) && c.embedding.length)?.embedding.length || 0,
      },
      chunking: { max_tokens: maxTokens, overlap_tokens: overlapTokens },
      errors: store.errors(),
    };
  }

  /** 把候选整理成对外结果（引用字段齐全，这是"来源追踪"的落点） */
  function toResult(item, rank) {
    const chunk = item.chunk;
    const src = chunk.source || {};
    const tokens = Number(chunk.metadata && chunk.metadata.token_count);
    const result = {
      rank,
      chunk_id: chunk.id,
      document_id: chunk.document_id,
      content: chunk.content,
      title: chunk.title || null,
      filename: src.filename || src.name || null,
      page: chunk.page === undefined ? null : chunk.page,
      chunk_index: chunk.chunk_index,
      extension: src.extension || null,
      path: src.path || null,
      source: {
        kind: src.kind || null,
        name: src.name || null,
        filename: src.filename || null,
        path: src.path || null,
        extension: src.extension || null,
        format: src.format || null,
      },
      token_count: Number.isFinite(tokens) ? tokens : estimateTokens(chunk.content),
      created_at: chunk.created_at || null,
      updated_at: chunk.updated_at || null,
      score: item.final_score,
      scores: {
        retrieval: item.score,
        dense: item.dense,
        keyword: item.keyword,
        rerank: item.rerank ? item.rerank.score : null,
        parts: item.rerank ? item.rerank.parts : null,
      },
    };
    result.citation = formatCitation(result);
    return result;
  }

  /**
   * 检索：召回（retriever）与精排（reranker）是两趟，这里只是把两趟串起来。
   * opts: { k, filters, budgetTokens, candidateK, minScore, weights, now }
   * budgetTokens 生效方式：按精排顺序累加，装不下的跳过（继续看后面更小的），
   * 这样预算不会被一个超大块白白吃掉。
   */
  async function search(query, searchOpts = {}) {
    await ensureReady();
    const o = searchOpts || {};
    const k = Number.isFinite(Number(o.k)) && Number(o.k) > 0 ? Math.floor(Number(o.k)) : (Number(retrievalOpts.k) || DEFAULT_K);
    const rewritten = rewriteQuery(query);
    const chunks = await allChunks();

    let queryVector = null;
    try {
      queryVector = await embedder.embedOne(rewritten.rewritten || rewritten.original);
    } catch (err) {
      queryVector = null;
      // 查询向量拿不到不算致命：关键词通道仍然能把结果召回来
    }

    const recall = retrieve({
      query: rewritten,
      queryVector,
      chunks,
      k,
      candidateK: o.candidateK !== undefined ? o.candidateK : retrievalOpts.candidateK,
      filters: o.filters,
      mode: embedder.mode(),
      minScore: o.minScore !== undefined ? o.minScore
        : (retrievalOpts.minScore !== undefined ? retrievalOpts.minScore : DEFAULT_MIN_SCORE),
    });

    const ranked = rerank(recall.candidates, {
      query: rewritten,
      k,
      now: o.now,
      weights: o.weights || rerankOpts.weights,
      halfLifeDays: o.halfLifeDays !== undefined ? o.halfLifeDays : rerankOpts.halfLifeDays,
      minScore: o.rerankMinScore,
    });

    const budget = Number(o.budgetTokens);
    const results = [];
    let used = 0;
    for (const item of ranked) {
      const result = toResult(item, results.length + 1);
      if (Number.isFinite(budget) && budget > 0 && used + result.token_count > budget) continue;
      used += result.token_count;
      results.push(result);
    }

    lastSearchInfo = {
      query: rewritten,
      mode: recall.mode,
      dim: recall.dim,
      scanned: recall.scanned,
      filtered: recall.filtered,
      matched: recall.matched,
      candidates: recall.candidates.length,
      returned: results.length,
      used_tokens: used,
      budget_tokens: Number.isFinite(budget) ? budget : null,
      weights: recall.weights,
    };
    return results;
  }

  /** 来源追踪：拿到 chunk id 就能回答「这句话来自哪个文档的哪一段」 */
  async function getSource(chunkId) {
    await ensureReady();
    const key = String(chunkId);
    const chunk = (await allChunks()).find((c) => c.id === key);
    if (!chunk) return null;
    const src = chunk.source || {};
    return {
      chunk_id: chunk.id,
      document_id: chunk.document_id,
      filename: src.filename || src.name || null,
      source: {
        kind: src.kind || null,
        name: src.name || null,
        filename: src.filename || null,
        path: src.path || null,
        extension: src.extension || null,
        format: src.format || null,
      },
      page: chunk.page === undefined ? null : chunk.page,
      chunk_index: chunk.chunk_index,
      title: chunk.title || null,
      path: src.path || null,
      updated_at: chunk.updated_at || null,
      token_count: Number(chunk.metadata && chunk.metadata.token_count) || estimateTokens(chunk.content),
      excerpt: String(chunk.content || '').slice(0, 200),
    };
  }

  return {
    // 生命周期
    init: ensureReady,
    // 写入
    addDocument,
    addText,
    removeDocument,
    reindexDocument,
    updateDocument,
    // 读
    listDocuments,
    getDocument,
    indexStatus,
    search,
    getSource,
    // 组装（Context Builder 与引用）
    formatCitation,
    formatCitations,
    buildContext,
    // 调试信息（最近一次检索的召回/精排统计）
    lastSearch: () => lastSearchInfo,
    // 内部件（主进程要做更细的编排时用；测试也直接拿它）
    store,
    embedder,
    options: { dir: store.dir, max_tokens: maxTokens, overlap_tokens: overlapTokens },
  };
}

/** 供上层做"这是文本还是文件"的判断 */
export { SOURCE_KIND, normalizeSource, sourceId };
