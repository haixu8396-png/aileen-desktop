// ============================================================
// Knowledge Base：embedding 薄封装
//
// 向量数学与后端调用**只有一份实现**（shared/embeddings.cjs，Memory 也用它），
// 这里只做三件事：
//   1) 用普通的 ESM 默认导入把那份 CommonJS 模块引进来 —— 它不能改成 ESM，
//      否则主进程（CJS）那边就 require 不到了。**不要用 node:module 的
//      createRequire**：那会把 node 内置模块拖进渲染层 bundle，页面加载即崩；
//   2) 把「配置从哪来」变成**注入项**：知识库这一层根本不认识 API Key，
//      它只拿到一个 getConfig()，Key 始终留在主进程手里（项目硬规矩）；
//   3) 提供 offlineConfig()，让单测和离线场景一键关掉远端。
//
// 为什么不在这里再写一份 tokenize/cosine：两份实现迟早会漂，
// 于是「检索质量取决于走的哪条路径」，这是最难查的一类 bug。
// ============================================================

import core from '../../shared/embeddings.cjs';

// 直接转出去，下游（retriever / reranker）不用各自再引一次
export const {
  LOCAL_DIM, tokenize, localEmbed, normalize, cosine, toArray, keywordScore,
} = core;

/** 离线配置：显式关掉远端，本地词频向量顶上 */
export function offlineConfig() {
  return { enabled: false };
}

/**
 * 造一个「本来就没配」的配置读取器。
 * 默认走离线是刻意的：没有显式给 getConfig 的情况下，
 * 知识库绝不该自己去猜一个远端地址出来。
 */
export function configFrom(getConfig) {
  return typeof getConfig === 'function' ? getConfig : offlineConfig;
}

/**
 * 知识库用的 embedder。参数与 shared 的 createEmbedder 一致：
 *   getConfig()  => { baseUrl, apiKey, model, enabled }
 *   fetchImpl    (url, init) => Promise<Response>   注入以便单测/主进程代发
 *   onFallback   (reason) => void                   降级通知（界面提示用）
 * 返回 { embed, embedOne, stats, mode }；**永远不会因为后端不可用而抛错**，
 * 失败会自己退回本地向量，并在 stats().lastFallbackReason 里写明原因。
 */
export function createKnowledgeEmbedder(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return core.createEmbedder({
    getConfig: configFrom(o.getConfig),
    fetchImpl: o.fetchImpl,
    onFallback: typeof o.onFallback === 'function' ? o.onFallback : undefined,
  });
}

/** 判断一个向量能不能用来算余弦（维度必须和查询向量一致，否则算出来是噪声） */
export function isUsableVector(vec, dim) {
  if (!Array.isArray(vec) || !vec.length) return false;
  if (Number.isFinite(dim) && dim > 0 && vec.length !== dim) return false;
  return true;
}
