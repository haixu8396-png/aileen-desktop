// ============================================================
// Knowledge Base：来源（source）类型定义与规范化
//
// 为什么要单独一层：
//   · 知识库的输入有两种截然不同的东西 —— 磁盘上的文件、以及界面上直接
//     贴进来的一段文本。后面所有环节（解析、切块、引用）都必须能同样对待
//     它们，所以先把「来源」收敛成一个固定 schema，别让下游到处 if。
//   · 文档 id 必须**确定**（同一个文件重复导入 = 更新而不是新增），
//     否则删一个文件留下的孤儿 chunk 永远清不掉。所以 id 由来源位置派生，
//     不是随机数。
//   · 格式只认第一阶段的五种，遇到别的立刻报错，而不是塞进 txt 里蒙混过去
//     —— 悄悄用错解析器产出的垃圾文本，比直接报错难查一百倍。
// ============================================================

import crypto from 'node:crypto';

/** 来源种类：磁盘文件 / 直接给的文本 */
export const SOURCE_KIND = { FILE: 'file', TEXT: 'text' };

/** 第一阶段支持的格式（新增格式要同时补 parser 与测试） */
export const FORMAT = { TXT: 'txt', MD: 'md', HTML: 'html', JSON: 'json', PDF: 'pdf' };

export const SUPPORTED_FORMATS = [FORMAT.TXT, FORMAT.MD, FORMAT.HTML, FORMAT.JSON, FORMAT.PDF];

/** 扩展名 → 格式。别名一律映射到五种规范格式之一 */
const EXTENSION_FORMAT = {
  txt: FORMAT.TXT, text: FORMAT.TXT, log: FORMAT.TXT,
  md: FORMAT.MD, markdown: FORMAT.MD, mdx: FORMAT.MD,
  html: FORMAT.HTML, htm: FORMAT.HTML, xhtml: FORMAT.HTML,
  json: FORMAT.JSON,
  pdf: FORMAT.PDF,
};

/** MIME 只是给界面看的提示，不参与解析决策 */
const FORMAT_MIME = {
  [FORMAT.TXT]: 'text/plain',
  [FORMAT.MD]: 'text/markdown',
  [FORMAT.HTML]: 'text/html',
  [FORMAT.JSON]: 'application/json',
  [FORMAT.PDF]: 'application/pdf',
};

const EXTENSION_MIME = {
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', json: 'application/json', pdf: 'application/pdf',
};

const FORMAT_EXTENSION = { [FORMAT.TXT]: 'txt', [FORMAT.MD]: 'md', [FORMAT.HTML]: 'html', [FORMAT.JSON]: 'json', [FORMAT.PDF]: 'pdf' };

/** 取扩展名（小写、无点）；没有扩展名返回空串 */
export function extensionOf(name) {
  const s = String(name == null ? '' : name).trim().replace(/\\/g, '/');
  const base = s.slice(s.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** 文件名（去掉目录） */
export function basenameOf(p) {
  const s = String(p == null ? '' : p).trim().replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1) || s;
}

/** 扩展名 → 规范格式；不支持返回 null（调用方决定是报错还是兜底） */
export function formatForExtension(ext) {
  return EXTENSION_FORMAT[String(ext || '').toLowerCase()] || null;
}

/** 从文件名/路径/显式 format 推断格式；推断不出来返回 null */
export function detectFormat(input) {
  const src = input && typeof input === 'object' ? input : { path: input };
  const explicit = String(src.format || '').toLowerCase();
  if (SUPPORTED_FORMATS.includes(explicit)) return explicit;
  const fromMime = Object.keys(FORMAT_MIME).find((f) => FORMAT_MIME[f] === String(src.mime || '').toLowerCase());
  if (fromMime) return fromMime;
  if (String(src.mime || '').toLowerCase() === 'application/pdf') return FORMAT.PDF;
  return formatForExtension(extensionOf(src.path || src.filename || src.name || ''));
}

export function isSupportedFormat(format) {
  return SUPPORTED_FORMATS.includes(String(format || '').toLowerCase());
}

/** 不支持的格式统一从这里报错，错误信息带「支持哪些」，用户不用去翻文档 */
export function unsupportedFormatError(name, format) {
  const shown = format ? String(format) : (extensionOf(name) || '(无扩展名)');
  return new Error('不支持的知识库格式：' + shown + '（第一阶段只支持 ' + SUPPORTED_FORMATS.join(' / ') + '）');
}

/**
 * 规范化来源 schema。
 * 接受两种输入：
 *   · 字符串 —— 当成文件路径
 *   · 对象   —— { kind, path, name, text, format, mime, size, modified_at, metadata }
 * 返回的对象是**新的普通对象**，不含任何外部引用（可以安全落盘）。
 */
export function normalizeSource(input) {
  const raw = typeof input === 'string' ? { path: input } : (input && typeof input === 'object' ? input : {});
  const hasText = typeof raw.text === 'string';
  const kind = raw.kind === SOURCE_KIND.TEXT || (!raw.path && hasText) ? SOURCE_KIND.TEXT : SOURCE_KIND.FILE;

  if (kind === SOURCE_KIND.FILE) {
    const p = String(raw.path || raw.name || '').trim();
    if (!p) throw new Error('文件来源缺少 path');
    const format = detectFormat({ format: raw.format, mime: raw.mime, path: p });
    if (!format) throw unsupportedFormatError(p, raw.format);
    const ext = extensionOf(p);
    return {
      kind,
      path: p,
      name: String(raw.name || basenameOf(p)),
      filename: String(raw.filename || basenameOf(p)),
      extension: ext || FORMAT_EXTENSION[format],
      format,
      mime: String(raw.mime || EXTENSION_MIME[ext] || FORMAT_MIME[format] || 'application/octet-stream'),
      size: Number.isFinite(raw.size) ? Number(raw.size) : null,
      modified_at: raw.modified_at || null,
      metadata: plainMeta(raw.metadata),
    };
  }

  // 文本来源：没有文件名时给个稳定的占位名，否则 id 会随空字符串漂移
  const name = String(raw.name || raw.filename || '文本片段').trim() || '文本片段';
  const format = detectFormat({ format: raw.format, mime: raw.mime, name }) || FORMAT.TXT;
  const ext = extensionOf(name) || FORMAT_EXTENSION[format];
  return {
    kind,
    path: raw.path ? String(raw.path) : null,
    name,
    filename: String(raw.filename || name),
    extension: ext,
    format,
    mime: String(raw.mime || EXTENSION_MIME[ext] || FORMAT_MIME[format] || 'text/plain'),
    size: hasText ? Buffer.byteLength(String(raw.text), 'utf8') : (Number.isFinite(raw.size) ? Number(raw.size) : null),
    modified_at: raw.modified_at || null,
    metadata: plainMeta(raw.metadata),
  };
}

/** 只保留可 JSON 化的浅层元数据，避免把奇怪对象带进存储 */
function plainMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) out[k] = v.slice();
  }
  return out;
}

/**
 * 文档 id：由来源位置派生（文件看 path，文本看 name）。
 * 这样「同一个文件再导入一次」= 更新同一份文档，不会留下孤儿 chunk；
 * 内容是否变化另由 content_hash 判断（见 engine）。
 */
export function sourceId(source) {
  const s = normalizeSource(source);
  const locator = s.kind === SOURCE_KIND.FILE ? (s.path || s.name) : (s.path || s.name);
  const h = crypto.createHash('sha1').update(s.kind + '\n' + locator).digest('hex');
  return 'doc_' + h.slice(0, 16);
}

/** chunk id：文档内序号派生，稳定且能一眼看出属于谁 */
export function chunkId(documentId, index) {
  return String(documentId) + '#' + String(index).padStart(4, '0');
}

/** 给界面/日志用的一行描述 */
export function describeSource(source) {
  const s = typeof source === 'string' ? { kind: 'file', path: source } : (source || {});
  if (s.kind === SOURCE_KIND.TEXT) return '文本：' + (s.filename || s.name || '未命名');
  return '文件：' + (s.path || s.filename || s.name || '未知路径');
}

/** 内容指纹：用于判断「内容变了没有」，避免无谓地重算向量 */
export function contentHash(text) {
  return crypto.createHash('sha1').update(String(text == null ? '' : text), 'utf8').digest('hex');
}
