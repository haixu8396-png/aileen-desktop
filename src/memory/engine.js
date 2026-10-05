// ============================================================
// Memory Engine：对外唯一门面
//
// 上层（Agent / Chat / 未来的工具）只认这一层的 API：
//
//   memory.search(query, { k, types, statuses, budgetTokens })
//   memory.remember(candidate, { source })
//   memory.update(id, patch)
//   memory.forget(id)              // 软删除：status='deleted'，行仍在
//   memory.forgetBelow(threshold)  // 按 importance 批量归档
//   memory.stats()
//
// 内部装配关系（每一步都能单独测）：
//   Extractor → Candidate → Embedding → Consolidator(与旧记忆比对) → Store
//   Query → Retriever(召回) → Reranker(精排) → Budget(裁剪) → Top memories
//
// 三条工程约束：
//   1) **召回与精排分开**（两个函数、两步），这里只是把它们串起来，不合并；
//   2) **离线必须可用**：embedder 拿不到后端时自动降级本地向量，检索仍然工作；
//   3) **写盘原子**：store 负责写临时文件再 rename；本层只在成功变更后 save。
// ============================================================
import { createStore, createNodeFs, createMemoryFs, MEMORY_FILE_NAME } from './store.js';
import { createMemoryEmbedder, cosine } from './embeddings.js';
import { extract, shouldRemember } from './extractor.js';
import { rewriteQuery, extractKeywords, recall, filterByMetadata, keywordRelevance } from './retriever.js';
import { rerank, toRecords, RERANK_WEIGHTS } from './reranker.js';
import { planConsolidation, CONSOLIDATE_ACTION } from './consolidator.js';
import { fitToBudget, estimateTokens, DEFAULT_BUDGET_TOKENS } from './budget.js';
import {
  MEMORY_TYPES, MEMORY_STATUS, makeRecord, normalizeRecord, toSummary, clamp01,
} from './types.js';

/** 允许被 update() 改的字段：id/embedding 不在其中（改了会破坏追溯链） */
export const PATCHABLE_FIELDS = ['content', 'type', 'importance', 'confidence', 'source', 'status', 'relations'];

/** 检索默认值 */
export const SEARCH_DEFAULTS = {
  k: 5,
  statuses: ['active'],
  budgetTokens: DEFAULT_BUDGET_TOKENS,
};

/**
 * 建一个 Memory Engine。
 *
 * @param {object} opts
 *   filePath      记忆文件路径（默认 memory.json）
 *   fs            注入的文件系统（默认 node:fs 适配器；单测传 createMemoryFs()）
 *   embedder      直接注入一个 embedder（测试常用）
 *   embedConfig   静态 embedding 配置（{ baseUrl, model, enabled, ... }）
 *   getEmbedConfig 动态配置函数（优先于 embedConfig）
 *   fetchImpl     注入 fetch
 *   now           取当前时间的函数（测试可控）
 *   autoSave      变更后自动落盘（默认 true）
 *   logger        日志回调（错误原因会经过它，便于界面提示）
 */
export function createMemoryEngine(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const autoSave = opts.autoSave !== false;
  const logger = typeof opts.logger === 'function' ? opts.logger : () => {};
  const filePath = opts.filePath || MEMORY_FILE_NAME;

  const fs = opts.fs || createNodeFs();
  const store = createStore({ fs, filePath });

  const embedder = opts.embedder || createMemoryEmbedder({
    getConfig: typeof opts.getEmbedConfig === 'function' ? opts.getEmbedConfig : null,
    config: opts.embedConfig || null,
    fetchImpl: opts.fetchImpl || null,
    onFallback: (reason) => logger('embedding 降级到本地向量：' + reason),
  });

  let loadResult = null;
  const counters = { remembered: 0, merged: 0, superseded: 0, duplicates: 0, searches: 0 };

  /** 懒加载：第一次用到才读盘，读坏了也只是空库 + lastError */
  async function ensureLoaded() {
    if (!loadResult) {
      loadResult = await store.load(filePath);
      if (loadResult.error) logger('记忆库载入异常：' + loadResult.error);
    }
    return loadResult;
  }

  async function persist() {
    if (!autoSave) return null;
    try {
      return await store.save(filePath);
    } catch (err) {
      // 存盘失败不能让对话崩掉：记录原因，内存里的记忆仍然可用
      const msg = '记忆写盘失败：' + String((err && err.message) || err);
      logger(msg);
      return { error: msg };
    }
  }

  /** 给候选补上 embedding（没有后端时是本地向量，同样能用） */
  async function withEmbedding(record) {
    if (Array.isArray(record.embedding) && record.embedding.some((n) => n !== 0)) return record;
    const vec = await embedder.embedOne(record.content);
    return Object.assign({}, record, { embedding: vec });
  }

  const engine = {
    // ------------------------------------------------------------
    // 写入侧
    // ------------------------------------------------------------

    /**
     * 记住一条候选。
     *
     * @param {object} candidate { content, type, importance, confidence, reasons? }
     * @param {object} options { source, skipConsolidation }
     * @returns {Promise<object>} 落库后的记忆记录（带 consolidate 字段说明发生了什么）
     */
    async remember(candidate, options = {}) {
      await ensureLoaded();
      const input = candidate && typeof candidate === 'object' ? candidate : { content: candidate };
      const content = String(input.content == null ? '' : input.content).trim();
      if (!content) throw new Error('remember 需要非空的 content');

      let record = makeRecord({
        content,
        type: input.type,
        importance: input.importance,
        confidence: input.confidence,
        source: options.source || input.source || 'conversation',
        relations: input.relations || [],
      }, now());
      record = await withEmbedding(record);

      // —— 与旧记忆比对：新增 / 合并 / 冲突
      let plan = null;
      if (!options.skipConsolidation) {
        const existing = store.all({ statuses: ['active'] });
        plan = await planConsolidation(record, existing, {
          embedder,
          now: now(),
          keywordScore: keywordRelevance,
          thresholds: options.thresholds,
        });
      }

      let stored = record;
      if (plan && plan.action === CONSOLIDATE_ACTION.DUPLICATE) {
        counters.duplicates += 1;
        const kept = store.replace(plan.target.id, {
          confidence: clamp01(Math.max(plan.target.confidence, record.confidence) + 0.02, plan.target.confidence),
          updated_at: now(),
          importance: Math.max(plan.target.importance, record.importance),
        });
        stored = kept || plan.target;
      } else if (plan && plan.action === CONSOLIDATE_ACTION.SUPERSEDE) {
        counters.superseded += 1;
        // 旧的先落地（状态变更），新的再写入 —— 两笔都留痕
        store.replace(plan.superseded.id, plan.superseded);
        store.upsert(plan.kept);
        stored = store.getById(plan.kept.id);
      } else if (plan && plan.action === CONSOLIDATE_ACTION.MERGE) {
        counters.merged += 1;
        store.replace(plan.target.id, plan.kept);
        stored = store.getById(plan.target.id);
      } else {
        store.upsert(plan ? plan.kept : record);
        stored = store.getById((plan && plan.kept && plan.kept.id) || record.id) || record;
      }

      counters.remembered += 1;
      await persist();
      return Object.assign({}, stored, {
        consolidate: plan
          ? { action: plan.action, reason: plan.reason, target: plan.target ? plan.target.id : null }
          : { action: CONSOLIDATE_ACTION.INSERT, reason: '未做合并检查（skipConsolidation）', target: null },
      });
    },

    /**
     * 从对话里提取并写入（完整 Pipeline）。
     * @returns {Promise<{ stored:Array, candidates:Array, rejected:Array }>}
     */
    async ingest(conversation, options = {}) {
      const result = extract(conversation, { now: now(), threshold: options.threshold });
      const stored = [];
      for (const candidate of result.candidates) {
        stored.push(await engine.remember(candidate, { source: options.source || 'conversation' }));
      }
      return { stored, candidates: result.candidates, rejected: result.rejected };
    },

    /** 只判不写：给上层预览「这句值不值得记」 */
    judge(text, options = {}) {
      return shouldRemember(text, { now: now(), ...options });
    },

    /**
     * 局部更新。
     * 改 content 会**重新算 embedding**（否则向量和文本对不上，检索就废了）。
     */
    async update(id, patch = {}) {
      await ensureLoaded();
      const target = store.getById(id);
      if (!target) throw new Error('找不到记忆：' + id);
      const clean = {};
      for (const [key, value] of Object.entries(patch || {})) {
        if (!PATCHABLE_FIELDS.includes(key)) continue;
        clean[key] = value;
      }
      let next = Object.assign({}, target, clean, { updated_at: now() });
      if (clean.content != null && String(clean.content) !== target.content) {
        next.embedding = [];
        next = await withEmbedding(normalizeRecord(next, now()));
      }
      const stored = store.replace(id, next);
      await persist();
      return stored;
    },

    /**
     * 软删除：status='deleted'，记录仍在库里（可追溯、可恢复）。
     * 为什么不真删：记忆的价值在于「长期」，硬删一次就可能把用户的重要信息烧掉。
     */
    async forget(id) {
      await ensureLoaded();
      const target = store.getById(id);
      if (!target) return null;
      if (target.status === 'deleted') return target;
      const stored = store.replace(id, { status: 'deleted', updated_at: now() });
      await persist();
      return stored;
    },

    /**
     * 批量归档：importance 低于阈值的 active 记忆 → archived。
     * archived 与 deleted 的区别：归档是「暂时不用」，删是「别再提了」。
     */
    async forgetBelow(threshold) {
      await ensureLoaded();
      const limit = clamp01(threshold, 0);
      const targets = store.all({ statuses: ['active'] }).filter((r) => r.importance < limit);
      const archived = [];
      for (const rec of targets) {
        archived.push(store.replace(rec.id, { status: 'archived', updated_at: now() }));
      }
      if (archived.length) await persist();
      return { threshold: limit, archived, count: archived.length };
    },

    // ------------------------------------------------------------
    // 读取侧
    // ------------------------------------------------------------

    /**
     * 检索。完整两步：recall（宽）→ rerank（精排）→ budget（裁剪）。
     *
     * @param {string} query
     * @param {object} options { k, types, statuses, budgetTokens, minRelevance, includeComponents }
     * @returns {Promise<Array>} 记忆记录数组（按分数降序，已裁剪到预算内）
     */
    async search(query, options = {}) {
      const detail = await engine.searchDetailed(query, options);
      return detail.memories;
    },

    /** 与 search 相同，但把中间过程也返回（测试 / 调试 / 界面展示「为什么是这几条」） */
    async searchDetailed(query, options = {}) {
      await ensureLoaded();
      counters.searches += 1;
      const k = Number.isFinite(options.k) && options.k > 0 ? Math.floor(options.k) : SEARCH_DEFAULTS.k;
      const statuses = options.statuses || SEARCH_DEFAULTS.statuses;
      const budgetTokens = Number.isFinite(options.budgetTokens) ? options.budgetTokens : SEARCH_DEFAULTS.budgetTokens;
      const budget = Number.isFinite(options.budget) ? options.budget : budgetTokens;

      const rewritten = rewriteQuery(query);
      const candidatesPool = filterByMetadata(store.raw(), {
        statuses,
        types: options.types || null,
        since: options.since,
        until: options.until,
      });

      // ① 召回（宽口径，多取一些给精排）
      const queryVector = await embedder.embedOne(rewritten.rewritten);
      const recalled = await recall(rewritten, {
        records: candidatesPool,
        embedder,
        queryVector,
        topK: options.recallTopK || Math.max(k * 4, k + 10),
        minRelevance: options.minRelevance,
        now: now(),
      });

      // ② 精排（relevance + importance + recency + confidence）
      const ranked = rerank(recalled, { now: now(), weights: options.weights });

      // ③ 取 top-k 之后按 token 预算从低分端裁
      const top = ranked.slice(0, k);
      const fitted = fitToBudget(top, budget);

      // ④ 记一次「被取用」（只动 last_retrieved_at，**不动 updated_at**）
      //    为什么：updated_at 表达「这条记忆上次被改写是什么时候」，
      //    检索不是改写。若检索也刷新 updated_at，按时间范围过滤就会被
      //    「谁最近被搜过」污染，recency 也会被搜索行为带偏。
      const touched = [];
      for (const item of fitted.kept) {
        const next = Object.assign({}, item.record, { last_retrieved_at: now() });
        const updated = store.replace(item.record.id, next);
        if (updated) touched.push(updated.id);
      }
      if (touched.length) await persist();

      const memories = toRecords(fitted.kept);
      return {
        memories,
        query: rewritten,
        keywords: rewritten.keywords,
        recalled: recalled.length,
        ranked,
        dropped: fitted.dropped,
        usedTokens: fitted.usedTokens,
        budgetTokens: fitted.budgetTokens,
        embeddingMode: embedder.mode(),
        weights: RERANK_WEIGHTS,
      };
    },

    // ------------------------------------------------------------
    // 维护 / 自查
    // ------------------------------------------------------------

    /** 库统计：给界面与测试看 */
    async stats() {
      await ensureLoaded();
      const counts = store.counts();
      const active = store.all({ statuses: ['active'] });
      const avgImportance = active.length
        ? active.reduce((sum, r) => sum + r.importance, 0) / active.length
        : 0;
      return {
        total: counts.total,
        byStatus: counts.byStatus,
        byType: counts.byType,
        active: active.length,
        avgImportance,
        embedding: embedder.stats(),
        embeddingMode: embedder.mode(),
        filePath,
        loadError: loadResult ? loadResult.error : null,
        corrupted: !!(loadResult && loadResult.corrupted),
        counters: Object.assign({}, counters),
        types: MEMORY_TYPES.slice(),
        statuses: MEMORY_STATUS.slice(),
      };
    },

    /** 全部（默认含所有状态；给「记忆管理」界面用） */
    async allRecords(options = {}) {
      await ensureLoaded();
      return store.all(options);
    },

    /** 摘要列表（不带 embedding，界面用） */
    async list(options = {}) {
      const list = await engine.allRecords(options);
      return list.map(toSummary);
    },

    /** 取一条 */
    async get(id) {
      await ensureLoaded();
      return store.getById(id);
    },

    /** 从对话抽候选（不写库） */
    extractCandidates(conversation, options = {}) {
      return extract(conversation, { now: now(), threshold: options.threshold });
    },

    /** 显式落盘（autoSave:false 时用） */
    async flush() {
      await ensureLoaded();
      return persist();
    },

    /** 内部件：需要精细控制时用（测试里会直接摸它） */
    internals: {
      store,
      embedder,
      estimateTokens,
      cosine,
      extractKeywords,
      rewriteQuery,
    },
  };

  return engine;
}

// 便捷再导出：上层 import 一次 engine.js 就能拿到全套（避免各处记路径）
export { createStore, createMemoryFs, MEMORY_FILE_NAME } from './store.js';
export { extract, shouldRemember, DECISION_THRESHOLD } from './extractor.js';
export { rewriteQuery, extractKeywords, recall, filterByMetadata } from './retriever.js';
export { rerank, RERANK_WEIGHTS, recencyScore } from './reranker.js';
export { planConsolidation, CONSOLIDATE_ACTION, detectConflict } from './consolidator.js';
export { fitToBudget, estimateTokens, DEFAULT_BUDGET_TOKENS } from './budget.js';
