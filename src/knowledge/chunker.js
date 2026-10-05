// ============================================================
// Knowledge Base：切块（Chunker）
//
// 三条规矩，按优先级：
//   1) **优先在语义边界切**：段落 > 句子 > 硬切。中文没有空格，
//      所以句子边界靠标点（。！？；…）与换行，不靠空白。
//   2) **有重叠**：相邻块共享尾部若干整句，避免「答案正好横跨切口」
//      导致两块都召不回。重叠按**整句**搬，不切句子中间 —— 半句话既伤检索也伤引用。
//   3) **有上限**：每块 token 数不超过配置值（默认 400）。
//      唯一的例外是超长代码围栏（见下），它会打上 oversized 标记。
//
// token 估算方式（**不是真实分词**，用于预算控制）：
//   · CJK 字符（中日韩）每个算 1 token；
//   · 拉丁/数字词每个算 1 token（经验值 ≈ 4 字符 1 token）；
//   · 其余字符（标点、空白、符号）每 4 个算 1 token。
// 这是偏保守的上限估算：真实模型分词通常比这个少，所以不会超预算。
// ============================================================

import { chunkId } from './sources.js';

/** 每块 token 上限（默认值；engine 可覆盖） */
export const DEFAULT_MAX_TOKENS = 400;

/** 相邻块重叠的 token 数（默认值） */
export const DEFAULT_OVERLAP_TOKENS = 60;

/** 块数上限：防止一份畸形文档把内存打爆 */
export const DEFAULT_MAX_CHUNKS = 20000;

/** 超过 maxTokens 这么多倍的代码围栏才允许被硬切（否则整块保留） */
const OVERSIZE_HARD_FACTOR = 4;

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const CJK_ALL = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
const LATIN_WORD = /[A-Za-z0-9_]+/g;

/** 估算 token 数（见文件头说明）。空白不计入，标点按 4 字符 1 token 折算 */
export function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  const cjk = (s.match(CJK_ALL) || []).length;
  const words = s.match(LATIN_WORD) || [];
  const latinChars = words.reduce((n, w) => n + w.length, 0);
  const visible = s.replace(/\s+/g, '').length;
  const rest = Math.max(0, visible - cjk - latinChars);
  return cjk + words.length + Math.ceil(rest / 4);
}

/** 单元：切块的最小搬运单位。sep 是「拼进块时它前面要加什么」 */
function unit(text, sep, extra) {
  return Object.assign({ text, sep, tokens: estimateTokens(text), protected: false, oversized: false }, extra || {});
}

/**
 * 把一段普通文本拆成句子级单元。
 * 句末标点连同后面的收尾引号/括号一起留住，避免出现「他说：“……」」被切开。
 */
function splitSentences(paragraph) {
  const out = [];
  let buf = '';
  const closers = '」』”’"\')）】]';
  for (let i = 0; i < paragraph.length; i += 1) {
    const c = paragraph[i];
    if (c === '\n') {
      if (buf.trim()) out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
    const isEnder = c === '。' || c === '！' || c === '？' || c === '；' || c === '…' || c === '!' || c === '?' || c === ';'
      || (c === '.' && !/\d/.test(paragraph[i - 1] || '') && /[\s)）"'\]]|$/.test(paragraph[i + 1] || ''));
    if (!isEnder) continue;
    while (i + 1 < paragraph.length && closers.includes(paragraph[i + 1])) {
      buf += paragraph[i + 1];
      i += 1;
    }
    if (paragraph[i + 1] === ' ') {
      buf += ' ';
      i += 1;
    }
    out.push(buf);
    buf = '';
  }
  if (buf.trim()) out.push(buf);
  return out.length ? out : [paragraph];
}

/** 硬切：一个句子长到超过上限时，按同一套字符权重线性切开 */
function hardSplit(text, maxTokens) {
  const out = [];
  let cur = '';
  let weight = 0;
  for (const ch of text) {
    // 与 estimateTokens 同一套权重（空白不计）
    const w = CJK_CHAR.test(ch) ? 1 : (/\s/.test(ch) ? 0 : 0.25);
    if (cur && weight + w > maxTokens) {
      out.push(cur);
      cur = '';
      weight = 0;
    }
    cur += ch;
    weight += w;
  }
  if (cur) out.push(cur);
  return out;
}

/** 段落 → 句子 → 硬切 */
function splitPlainText(text, maxTokens) {
  const units = [];
  for (const para of String(text == null ? '' : text).split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (estimateTokens(trimmed) <= maxTokens) {
      units.push(unit(trimmed, '\n\n'));
      continue;
    }
    const sentences = splitSentences(trimmed);
    for (const sentence of sentences) {
      const s = sentence.trim();
      if (!s) continue;
      if (estimateTokens(s) <= maxTokens) {
        units.push(unit(s, ''));
        continue;
      }
      // 单句仍然超长 → 硬切，并在块上留下 oversized 标记
      for (const piece of hardSplit(s, maxTokens)) {
        units.push(unit(piece.trim(), '', { oversized: true }));
      }
    }
  }
  return units;
}

/**
 * 全文拆成单元，**代码围栏整块保留**。
 * 为什么不许在围栏里切：一段代码被切两半之后，
 * 检索出来的是「半截代码」，模型会照着补出错误结论 —— 比不召回更糟。
 */
export function splitIntoUnits(text, opts = {}) {
  const maxTokens = positive(opts.maxTokens, DEFAULT_MAX_TOKENS);
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const units = [];
  let fence = null;
  let fenceBuf = [];
  let buf = [];

  const flushNormal = () => {
    if (!buf.length) return;
    const block = buf.join('\n');
    buf = [];
    for (const u of splitPlainText(block, maxTokens)) units.push(u);
  };
  const flushFence = () => {
    const block = fenceBuf.join('\n').trim();
    fenceBuf = [];
    if (!block) return;
    const tokens = estimateTokens(block);
    if (tokens <= maxTokens * OVERSIZE_HARD_FACTOR) {
      units.push(unit(block, '\n\n', { protected: true, oversized: tokens > maxTokens }));
      return;
    }
    // 围栏大到离谱（> 4 倍上限）：只能硬切，并明确标记出来
    for (const piece of hardSplit(block, maxTokens)) {
      units.push(unit(piece, '\n\n', { protected: true, oversized: true }));
    }
  };

  for (const line of lines) {
    const m = /^[ \t]{0,3}(```+|~~~+)/.exec(line);
    if (fence) {
      fenceBuf.push(line);
      if (m && m[1][0] === fence[0]) {
        fence = null;
        flushFence();
      }
      continue;
    }
    if (m) {
      flushNormal();
      fence = m[1];
      fenceBuf = [line];
      continue;
    }
    buf.push(line);
  }
  if (fence) flushFence();
  flushNormal();
  return units;
}

/**
 * 装块：贪心装到上限，切下一块时从上一块**尾部整单元**搬重叠。
 * 约束：搬重叠时必须给新单元留位置，否则新块会超上限。
 */
function packUnits(units, opts) {
  const maxTokens = positive(opts.maxTokens, DEFAULT_MAX_TOKENS);
  // 注意：这里不能用 positive()，否则 overlapTokens=0（"不要重叠"）会被当成
  // "没配置"而退回默认值 —— 0 是合法配置，必须原样尊重
  const rawOverlap = opts.overlapTokens === undefined ? DEFAULT_OVERLAP_TOKENS : Number(opts.overlapTokens);
  const overlapTokens = Number.isFinite(rawOverlap)
    ? Math.max(0, Math.min(Math.floor(rawOverlap), maxTokens - 1))
    : DEFAULT_OVERLAP_TOKENS;
  const chunks = [];
  let cur = [];
  let curTokens = 0;

  const emit = () => {
    if (!cur.length) return;
    chunks.push({ units: cur.slice(), tokens: cur.reduce((n, u) => n + u.tokens, 0) });
  };

  for (const u of units) {
    if (cur.length && curTokens + u.tokens > maxTokens) {
      emit();
      const tail = [];
      let acc = 0;
      // i >= 1：至少丢掉块首那个单元，不然新块和刚切出去的块会一模一样（自我复制）
      for (let i = cur.length - 1; i >= 1; i -= 1) {
        const t = cur[i].tokens;
        if (acc + t > overlapTokens) break;
        if (acc + t + u.tokens > maxTokens) break;
        tail.unshift(cur[i]);
        acc += t;
      }
      cur = tail;
      curTokens = acc;
    }
    cur.push(u);
    curTokens += u.tokens;
  }
  emit();
  return chunks;
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 单元拼回正文：首单元不吃分隔符，其余按自己的 sep 接上 */
function joinUnits(units) {
  return units.map((u, i) => (i === 0 ? u.text : u.sep + u.text)).join('');
}

/**
 * 纯文本切块（不含 document 元数据），单测直接用这个验证重叠/上限/顺序。
 * 返回 [{ content, token_count, oversized, unit_count }]
 */
export function chunkPlainText(text, opts = {}) {
  const maxTokens = positive(opts.maxTokens, DEFAULT_MAX_TOKENS);
  const units = splitIntoUnits(text, { maxTokens });
  return packUnits(units, { maxTokens, overlapTokens: opts.overlapTokens }).map((packed) => {
    const content = joinUnits(packed.units);
    return {
      content,
      token_count: estimateTokens(content),
      oversized: packed.units.some((u) => u.oversized),
      unit_count: packed.units.length,
    };
  });
}

/**
 * 把 block 分组成「块级单元」：
 *   · 没有 blocks 的解析结果（txt/html）→ 整篇当一个组，走语义切分
 *   · 有 blocks 的（md 章节 / json 条目 / pdf 页）→ 可合并的相邻 block 先合到上限
 * 为什么 pdf 页不合并：页码是引用的一部分，合了就说不清来自第几页。
 */
function buildGroups(parsed, maxTokens) {
  const blocks = (Array.isArray(parsed.blocks) ? parsed.blocks : []).filter((b) => b && String(b.text || '').trim());
  if (!blocks.length) {
    const text = String(parsed.text || '');
    return text.trim()
      ? [{ text, title: parsed.title || null, page: null, paths: [], titles: [], mergeable: true }]
      : [];
  }
  const groups = [];
  let cur = null;
  for (const b of blocks) {
    const text = String(b.text).trim();
    const tokens = estimateTokens(text);
    const page = b.page === undefined || b.page === null ? null : b.page;
    const path = b.path === undefined || b.path === null ? null : b.path;
    const mergeable = b.merge !== false;
    if (cur && mergeable && cur.mergeable && cur.page === page && estimateTokens(cur.text) + tokens <= maxTokens) {
      cur.text += '\n\n' + text;
      if (path) cur.paths.push(path);
      if (b.title && b.title !== cur.title) cur.titles.push(b.title);
      continue;
    }
    cur = { text, title: b.title || parsed.title || null, page, paths: path ? [path] : [], titles: [], mergeable };
    groups.push(cur);
  }
  return groups;
}

/**
 * 文档级切块：产出符合 chunk schema 的完整对象（embedding 先留 null，由 engine 填）。
 * 返回 { chunks, warnings }。
 */
export function chunkDocument(parsed, ctx = {}) {
  const maxTokens = positive(ctx.maxTokens, DEFAULT_MAX_TOKENS);
  const overlapTokens = ctx.overlapTokens === undefined ? DEFAULT_OVERLAP_TOKENS : ctx.overlapTokens;
  const maxChunks = positive(ctx.maxChunks, DEFAULT_MAX_CHUNKS);
  const now = ctx.now || new Date().toISOString();
  const documentId = String(ctx.documentId || 'doc');
  const source = ctx.source || {};
  const warnings = [];
  const chunks = [];

  const groups = buildGroups(parsed || {}, maxTokens);
  for (const group of groups) {
    if (chunks.length >= maxChunks) {
      warnings.push({ code: 'chunk-limit-reached', message: '文档过大，只索引了前 ' + maxChunks + ' 块' });
      break;
    }
    const units = splitIntoUnits(group.text, { maxTokens });
    for (const packed of packUnits(units, { maxTokens, overlapTokens })) {
      if (chunks.length >= maxChunks) break;
      const content = joinUnits(packed.units);
      const index = chunks.length;
      chunks.push({
        id: chunkId(documentId, index),
        document_id: documentId,
        content,
        title: group.title || null,
        source: {
          kind: source.kind || 'text',
          name: source.name || source.filename || null,
          filename: source.filename || source.name || null,
          path: source.path || null,
          extension: source.extension || null,
          format: source.format || parsed.format || null,
        },
        chunk_index: index,
        page: group.page,
        metadata: {
          token_count: estimateTokens(content),
          format: (parsed && parsed.format) || source.format || null,
          page: group.page,
          json_path: group.paths.length === 1 ? group.paths[0] : (group.paths.length ? group.paths.slice(0, 20) : null),
          section_titles: group.titles.length ? group.titles.slice(0, 5) : undefined,
          oversized: packed.units.some((u) => u.oversized) || undefined,
          authority: Number.isFinite(Number(ctx.authority)) ? Number(ctx.authority) : undefined,
          unit_count: packed.units.length,
        },
        created_at: now,
        updated_at: now,
        embedding: null,
      });
    }
  }
  return { chunks, warnings };
}
