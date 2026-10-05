// ============================================================
// Knowledge Base：加载（读取 → 解析 → 清洗 → 切块 → 交给 engine）
//
// 为什么单独一层还注入 fs：
//   · 让「取字节」这件事只有一处实现，单测塞内存 fs 就能覆盖全部格式，
//     不必往磁盘里丢 fixture；
//   · engine 因此只关心「文档、向量、存储」，读文件/解析失败的处理
//     都在这里收口（错误信息直接告诉用户是哪个路径读不到）。
//
// 这一层**不做 embedding、不碰存储**：那两件事属于 engine 的调度。
// ============================================================

import { normalizeSource, sourceId, contentHash, SOURCE_KIND, basenameOf } from './sources.js';
import { parse } from './parser.js';
import { chunkDocument, DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS } from './chunker.js';

/** 去掉扩展名的文件名，用作标题兜底 */
function titleFromName(name) {
  const base = basenameOf(name || '');
  return base ? base.replace(/\.[^.]+$/, '') : null;
}

/** 取第一个真正的数字（用于 authority/priority：0 也是合法值，所以不能用 || ） */
function firstFinite(...values) {
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * 把一份来源读成「文档 + 解析结果 + chunks」。
 * 抛错只发生在**调用方能修的情况**：路径读不到、fs 没注入。
 * 内容层面的问题（PDF 提不出文本、JSON 坏了）一律走 warnings。
 */
export async function loadSource(input, ctx = {}) {
  const source = normalizeSource(input);
  const now = ctx.now || new Date().toISOString();
  const documentId = ctx.documentId || sourceId(source);
  const fallbackTitle = titleFromName(source.filename || source.name);

  let raw;
  if (source.kind === SOURCE_KIND.TEXT) {
    raw = typeof input === 'object' && input && typeof input.text === 'string' ? input.text : '';
  } else {
    const fs = ctx.fs;
    if (!fs || typeof fs.readBytes !== 'function') {
      throw new Error('读取文件需要注入 fs（缺少 readBytes）：' + source.path);
    }
    try {
      raw = await fs.readBytes(source.path);
    } catch (err) {
      throw new Error('读不到知识库文件：' + source.path + '（' + String((err && err.message) || err) + '）');
    }
    if (raw === undefined || raw === null) {
      throw new Error('读不到知识库文件：' + source.path);
    }
  }

  const parsed = parse(raw, { format: source.format, filename: source.filename, fallbackTitle });
  const chunked = chunkDocument(parsed, {
    documentId,
    source,
    now,
    maxTokens: ctx.maxTokens === undefined ? DEFAULT_MAX_TOKENS : ctx.maxTokens,
    overlapTokens: ctx.overlapTokens === undefined ? DEFAULT_OVERLAP_TOKENS : ctx.overlapTokens,
    maxChunks: ctx.maxChunks,
    // 权威性来自文档元数据（用户/上层可以标"这份资料优先"），精排会用到
    authority: firstFinite(source.metadata && source.metadata.authority, source.metadata && source.metadata.priority),
  });

  return {
    source,
    documentId,
    parsed,
    chunks: chunked.chunks,
    warnings: parsed.warnings.concat(chunked.warnings),
    content_hash: contentHash(parsed.text),
    raw_text: parsed.text,
  };
}

/**
 * 直接给文本时的糖：等价于 loadSource({ kind:'text', text, name, ... })。
 */
export async function loadText(text, ctx = {}) {
  const input = Object.assign({ kind: SOURCE_KIND.TEXT }, ctx.source || {}, { text: String(text == null ? '' : text) });
  return await loadSource(input, ctx);
}
