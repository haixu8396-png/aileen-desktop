// ============================================================
// Knowledge Base：解析（Parser + Cleaner 两个阶段）
//
// 职责边界：**这里只把字节/文本变成「纯文本 + 元数据 + 可切块的 block」**，
// 不切块、不算向量、不碰存储。这样每种格式的问题都能单独单测，
// 而且新增格式时不会牵动下游。
//
// 三件刻意的事：
//   · HTML 不用第三方库 —— 一个够用的状态机扫描器（注释、自闭合、属性里的 `>`、
//     script/style 整段剔除、实体解码）比引入 cheerio/jsdom 便宜得多，
//     也不会给打包体积和攻击面添东西。
//   · PDF 不装库 —— 只做「最小可用」：解析 stream、FlateDecode 解压、
//     抽 Tj/TJ/'/" 里的字符串。明确不支持的（加密、扫描件、CID 编码、
//     非 Flate 滤镜）**写进 warnings**，宁可空着也不假装成功。
//   · 解析失败**不抛异常**（除了调用方给错参数）—— 一份坏文件不该弄死整个导入流程，
//     要给 warnings 并让它降级成纯文本。
// ============================================================

import zlib from 'node:zlib';
import { FORMAT, detectFormat, basenameOf } from './sources.js';

/** 统一告警结构：code 供程序判断，message 供人看 */
function warn(code, message) {
  return { code, message };
}

export function formatWarnings(warnings) {
  return (Array.isArray(warnings) ? warnings : []).map((x) => (x && x.message) || String(x)).join('；');
}

// ------------------------------------------------------------
// Cleaner：所有解析器的最后一道
// ------------------------------------------------------------

/**
 * 清洗：统一换行、去掉控制字符、折叠行内空白、压缩连续空行。
 * 为什么必须做：PDF/HTML 出来的文本里全是 `\n \n`、`\u00a0`、零宽字符，
 * 直接拿去切块会切出一堆垃圾块，而且引用（citation）看起来也很脏。
 */
export function cleanText(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    // 保留 \n 与 \t，其余控制字符（含零宽/BOM）一律清除
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 只清洗「围栏外面」的文本：``` 代码块内部原样保留。
 * 切块器靠围栏做不可切分边界，清洗阶段先把它弄坏了就白做了。
 */
function cleanPreservingFences(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let buf = [];
  let fence = null;
  const isFence = (line) => /^[ \t]{0,3}(```+|~~~+)/.exec(line);
  const flush = () => {
    if (buf.length) {
      out.push(cleanText(buf.join('\n')));
      buf = [];
    }
  };
  for (const line of lines) {
    const m = isFence(line);
    if (fence) {
      buf.push(line);
      if (m && m[1][0] === fence[0]) {
        fence = null;
        flush();
      }
      continue;
    }
    if (m) {
      flush();
      fence = m[1];
      buf.push(line);
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.join('\n');
}

// ------------------------------------------------------------
// 字节解码
// ------------------------------------------------------------

/**
 * 字节 → 文本。只认三种真实存在的情况：UTF-8（默认）、带 BOM 的 UTF-8、UTF-16。
 * 为什么不做 GBK 猜测：没有内置解码器，猜错会把整份文档变成乱码，
 * 而且用户看不出是"解析错了"还是"文档本来就这样"。
 */
export function decodeBytes(raw) {
  if (typeof raw === 'string') return { text: raw, encoding: 'utf8', warnings: [] };
  const buf = toBuffer(raw);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8-bom', warnings: [] };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le', warnings: [] };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, buf.length - ((buf.length - 2) % 2)));
    body.swap16();
    return { text: body.toString('utf16le'), encoding: 'utf16be', warnings: [] };
  }
  const warnings = [];
  if (buf.includes(0)) {
    warnings.push(warn('binary-content', '文件里出现 NUL 字节，可能不是文本文件；已按 UTF-8 尽力解码'));
  }
  return { text: buf.toString('utf8'), encoding: 'utf8', warnings };
}

function toBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) return Buffer.from(raw);
  return Buffer.from(String(raw == null ? '' : raw), 'utf8');
}

// ------------------------------------------------------------
// txt
// ------------------------------------------------------------

export function parseTxt(raw, opts = {}) {
  const decoded = decodeBytes(raw);
  const text = cleanText(decoded.text);
  return {
    format: FORMAT.TXT,
    text,
    title: firstLineTitle(text) || opts.fallbackTitle || null,
    blocks: [],
    warnings: decoded.warnings.slice(),
    metadata: { encoding: decoded.encoding, line_count: text ? text.split('\n').length : 0 },
  };
}

/** 用第一行当标题：纯文本没有别的结构性线索，总比 null 强 */
function firstLineTitle(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > 80 ? line.slice(0, 80) + '…' : line;
}

// ------------------------------------------------------------
// markdown
// ------------------------------------------------------------

const HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

export function parseMarkdown(raw, opts = {}) {
  const decoded = decodeBytes(raw);
  const warnings = decoded.warnings.slice();
  let body = decoded.text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');

  // front matter 单独抽出来进元数据：它是元数据，不该混进正文被切成 chunk
  let frontMatter = null;
  const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/.exec(body);
  if (fm) {
    frontMatter = parseFrontMatter(fm[1]);
    body = body.slice(fm[0].length);
  }

  const lines = body.split('\n');
  const sections = [];
  let curTitle = null;
  let cur = [];
  let inFence = null;

  const flush = () => {
    const text = cleanPreservingFences(cur.join('\n'));
    if (text) sections.push({ title: curTitle, text });
    cur = [];
  };

  for (const line of lines) {
    const fence = /^[ \t]{0,3}(```+|~~~+)/.exec(line);
    if (fence) {
      if (inFence) {
        if (fence[1][0] === inFence[0]) inFence = null;
      } else {
        inFence = fence[1];
      }
      cur.push(line);
      continue;
    }
    if (!inFence) {
      const h = HEADING_RE.exec(line);
      if (h) {
        flush();
        curTitle = cleanText(h[2]) || null;
        cur = [line];
        continue;
      }
    }
    cur.push(line);
  }
  flush();
  if (inFence) warnings.push(warn('markdown-unclosed-fence', '有未闭合的代码围栏，已按原文处理'));

  const docTitle = (sections.find((s) => s.title) || {}).title || opts.fallbackTitle || null;
  const blocks = sections.map((s) => ({
    text: s.text,
    title: s.title || docTitle,
    path: null,
    page: null,
    // 章节不跨块合并：标题是引用的一部分，合起来会让"这段来自哪一节"变糊
    merge: false,
  }));

  return {
    format: FORMAT.MD,
    text: cleanPreservingFences(body),
    title: docTitle,
    blocks,
    warnings,
    metadata: {
      encoding: decoded.encoding,
      heading_count: sections.filter((s) => s.title).length,
      front_matter: frontMatter,
    },
  };
}

function parseFrontMatter(raw) {
  const out = {};
  for (const line of String(raw || '').split('\n')) {
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2].trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return Object.keys(out).length ? out : null;
}

// ------------------------------------------------------------
// html（自己写的标签剥离器）
// ------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'ul',
]);

/** 整段内容都不该进正文的标签（含 head：title 另外单独取） */
const SKIP_CONTENT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'head', 'object', 'embed']);

/** HTML 命名实体（常用子集；不认识的实体原样保留，猜错比不猜更糟） */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷', plusmn: '±',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•', sect: '§', para: '¶',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  larr: '←', rarr: '→', harr: '↔', ne: '≠', le: '≤', ge: '≥', infin: '∞',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', omega: 'ω', sigma: 'σ',
  emsp: ' ', ensp: ' ', thinsp: ' ', zwj: '', zwnj: '',
};

/** 解实体：命名 + 十进制 + 十六进制；未识别的原样返回 */
export function decodeEntities(text) {
  return String(text == null ? '' : text).replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

/**
 * 标签剥离器（状态机，不引库）。
 * 处理：注释、CDATA、`<!doctype>`、`<?pi?>`、自闭合标签、**属性里的 `>`**、
 * script/style 等整段丢弃、块级标签转换行、td/th 转制表符、实体解码、空白折叠。
 * pre/code 会被包成 ``` 围栏 —— 切块器认得围栏，于是代码块不会被切碎。
 */
export function stripHtml(html) {
  const s = String(html == null ? '' : html);
  const n = s.length;
  let out = '';
  let i = 0;
  let skipUntilClose = null;
  let preDepth = 0;
  let inPreFence = false;

  while (i < n) {
    const ch = s[i];

    if (skipUntilClose) {
      const m = new RegExp('</[ \\t]*' + skipUntilClose + '[ \\t]*>', 'i').exec(s.slice(i));
      if (!m) {
        i = n;
      } else {
        i += m.index + m[0].length;
      }
      skipUntilClose = null;
      continue;
    }

    if (ch === '<') {
      // 注释
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      // CDATA：内容算正文
      if (s.startsWith('<![CDATA[', i)) {
        const end = s.indexOf(']]>', i + 9);
        out += s.slice(i + 9, end === -1 ? n : end);
        i = end === -1 ? n : end + 3;
        continue;
      }
      // doctype / 其它声明
      if (s.startsWith('<!', i)) {
        const end = s.indexOf('>', i + 2);
        i = end === -1 ? n : end + 1;
        continue;
      }
      // 处理指令
      if (s.startsWith('<?', i)) {
        const end = s.indexOf('?>', i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }

      // 普通标签：找 '>' 时必须跳过引号内的内容（属性里出现 > 是合法的）
      let j = i + 1;
      let quote = '';
      while (j < n) {
        const c = s[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === '>') {
          break;
        }
        j += 1;
      }
      const inner = s.slice(i + 1, j);
      const selfClosing = /\/[ \t]*$/.test(inner);
      const closing = inner.trim().startsWith('/');
      const nameMatch = /^[ \t]*\/?[ \t]*([A-Za-z][A-Za-z0-9:._-]*)/.exec(inner);
      const name = nameMatch ? nameMatch[1].toLowerCase() : '';
      i = j + 1;

      if (!closing && SKIP_CONTENT_TAGS.has(name)) {
        skipUntilClose = name;
        continue;
      }
      if (name === 'pre' && !closing && !selfClosing) {
        preDepth += 1;
        if (!inPreFence) {
          out += '\n```\n';
          inPreFence = true;
        }
        continue;
      }
      if (name === 'pre' && closing) {
        preDepth = Math.max(0, preDepth - 1);
        if (preDepth === 0 && inPreFence) {
          out += '\n```\n';
          inPreFence = false;
        }
        continue;
      }
      if (BLOCK_TAGS.has(name)) {
        out += name === 'td' || name === 'th' ? '\t' : '\n';
      }
      continue;
    }

    if (ch === '&') {
      const m = /^&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(s.slice(i, i + 40));
      if (m) {
        out += decodeEntities(m[0]);
        i += m[0].length;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  if (inPreFence) out += '\n```\n';
  return cleanText(out);
}

/** 取某个标签的纯文本内容（用于 <title>） */
function tagText(html, tag) {
  const m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '\\s*>', 'i').exec(String(html || ''));
  return m ? cleanText(decodeEntities(stripHtml(m[1]))) : null;
}

export function parseHtml(raw, opts = {}) {
  const decoded = decodeBytes(raw);
  const warnings = decoded.warnings.slice();
  const text = stripHtml(decoded.text);
  const title = tagText(decoded.text, 'title') || firstLineTitle(text) || opts.fallbackTitle || null;
  return {
    format: FORMAT.HTML,
    text,
    title,
    blocks: [],
    warnings,
    metadata: { encoding: decoded.encoding },
  };
}

// ------------------------------------------------------------
// json
// ------------------------------------------------------------

const JSON_MAX_BLOCKS = 5000;
const JSON_MAX_LINES = 20000;
const JSON_MAX_DEPTH = 12;
const JSON_MAX_VALUE_CHARS = 4000;

export function parseJson(raw, opts = {}) {
  const decoded = decodeBytes(raw);
  const warnings = decoded.warnings.slice();
  let data;
  try {
    data = JSON.parse(decoded.text);
  } catch (err) {
    warnings.push(warn('json-parse-failed', 'JSON 解析失败（' + String((err && err.message) || err) + '），已按纯文本处理'));
    const text = cleanText(decoded.text);
    return {
      format: FORMAT.JSON,
      text,
      title: opts.fallbackTitle || null,
      blocks: text ? [{ text, title: opts.fallbackTitle || null, path: null, page: null, merge: true }] : [],
      warnings,
      metadata: { encoding: decoded.encoding, json_valid: false },
    };
  }

  const budget = { lines: JSON_MAX_LINES, blocks: JSON_MAX_BLOCKS, truncated: false };
  const blocks = [];
  const pushBlock = (path, lines) => {
    if (blocks.length >= budget.blocks) {
      budget.truncated = true;
      return;
    }
    const text = lines.join('\n').trim();
    if (!text) return;
    blocks.push({ text, title: null, path, page: null, merge: true });
  };

  if (Array.isArray(data)) {
    data.forEach((item, idx) => pushBlock('$[' + idx + ']', flattenLines(item, '$[' + idx + ']', 0, budget)));
  } else if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      pushBlock('$.' + key, flattenLines(value, '$.' + key, 0, budget));
    }
  } else {
    pushBlock('$', ['$: ' + scalarText(data)]);
  }

  if (budget.truncated) {
    warnings.push(warn('json-truncated', 'JSON 条目过多，只索引了前 ' + JSON_MAX_BLOCKS + ' 块（其余内容未进知识库）'));
  }

  const text = blocks.map((b) => b.text).join('\n\n');
  const title = (data && typeof data === 'object' && !Array.isArray(data) && (data.title || data.name)) || opts.fallbackTitle || null;
  return {
    format: FORMAT.JSON,
    text,
    title: title ? cleanText(String(title)) : null,
    blocks,
    warnings,
    metadata: {
      encoding: decoded.encoding,
      json_valid: true,
      json_root: Array.isArray(data) ? 'array' : (data && typeof data === 'object' ? 'object' : 'scalar'),
      json_keys: data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 50) : [],
    },
  };
}

/**
 * 把 JSON 展平成「一行一个叶子」的可读文本，并把 key 路径写在每行前面。
 * 为什么把路径重复写在正文里：切块后正文可能离开结构，
 * 路径留在正文里，检索和引用都能看出「这句话来自哪个字段」。
 */
function flattenLines(value, path, depth, budget) {
  if (budget.lines <= 0) {
    budget.truncated = true;
    return [];
  }
  if (depth > JSON_MAX_DEPTH) return [path + ': …（层级过深，已省略）'];
  const out = [];
  const emit = (line) => {
    if (budget.lines <= 0) {
      budget.truncated = true;
      return;
    }
    budget.lines -= 1;
    out.push(line);
  };
  if (value === null || value === undefined || typeof value !== 'object') {
    emit(path + ': ' + scalarText(value));
    return out;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      emit(path + ': []');
      return out;
    }
    value.forEach((item, idx) => {
      for (const line of flattenLines(item, path + '[' + idx + ']', depth + 1, budget)) out.push(line);
    });
    return out;
  }
  const keys = Object.keys(value);
  if (!keys.length) {
    emit(path + ': {}');
    return out;
  }
  for (const key of keys) {
    for (const line of flattenLines(value[key], path + '.' + key, depth + 1, budget)) out.push(line);
  }
  return out;
}

function scalarText(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const s = value.replace(/\r?\n/g, ' \\n ');
    return s.length > JSON_MAX_VALUE_CHARS ? s.slice(0, JSON_MAX_VALUE_CHARS) + '…' : s;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ------------------------------------------------------------
// pdf（自己写的最小提取器）
// ------------------------------------------------------------

/** PDF 相关的告警码 —— 测试与界面都按这些码判断，别去比字符串消息 */
export const PDF_WARNING = {
  NOT_PDF: 'pdf-not-pdf',
  ENCRYPTED: 'pdf-encrypted',
  NO_TEXT: 'pdf-no-text',
  IMAGE_ONLY: 'pdf-image-only',
  UNSUPPORTED_FILTER: 'pdf-unsupported-filter',
  DECODE_FAILED: 'pdf-stream-decode-failed',
  CID_FONT: 'pdf-cid-font',
  PAGE_ORDER_GUESS: 'pdf-page-order-guessed',
  NO_PAGES: 'pdf-no-pages',
  UTF8_HEURISTIC: 'pdf-utf8-heuristic',
  OBJECT_STREAM: 'pdf-object-stream',
};

const SUPPORTED_PDF_FILTERS = new Set(['FlateDecode', 'Fl']);

export function parsePdf(raw, opts = {}) {
  const bytes = toBuffer(raw);
  const warnings = [];
  const text = bytes.subarray(0, Math.min(bytes.length, 1024)).toString('latin1');
  if (!/%PDF-\d/.test(text)) {
    warnings.push(warn(PDF_WARNING.NOT_PDF, '文件头不是 %PDF-：可能不是 PDF，或文件已损坏'));
  }
  // latin1 解码保证「1 字符 = 1 字节」，字符串下标可以直接当字节偏移用
  const bin = bytes.toString('latin1');

  if (/\/Encrypt\b/.test(bin)) {
    warnings.push(warn(PDF_WARNING.ENCRYPTED, 'PDF 带 /Encrypt（加密）：本实现不解密，无法提取文本；请先用工具去除加密后再导入'));
    return pdfResult([], warnings, opts, { encrypted: true });
  }
  if (/\/Type\s*\/ObjStm\b/.test(bin)) {
    warnings.push(warn(PDF_WARNING.OBJECT_STREAM, 'PDF 使用对象流（ObjStm）：本实现不解析交叉引用流/对象流，可能漏掉部分内容'));
  }
  if (/\/Identity-H\b|\/Type0\b/.test(bin)) {
    warnings.push(warn(PDF_WARNING.CID_FONT, 'PDF 使用 Type0/CID 字体：本实现不做 CMap/ToUnicode 映射，非 ASCII 文本可能是乱码'));
  }

  const objects = collectPdfObjects(bin);
  if (!objects.size) {
    warnings.push(warn(PDF_WARNING.NO_TEXT, '没有在 PDF 里找到任何对象（可能是不完整文件），未提取到文本'));
    return pdfResult([], warnings, opts, { objects: 0 });
  }

  // 逐流解码：图片流跳过，受支持的滤镜解压，其余记警告
  const streamText = new Map();
  const unsupportedFilters = new Set();
  let imageStreams = 0;
  for (const obj of objects.values()) {
    if (obj.streamStart < 0 || obj.streamEnd < 0) continue;
    if (/\/Subtype\s*\/Image\b/.test(obj.dict)) {
      imageStreams += 1;
      continue;
    }
    const filters = pdfFilters(obj.dict);
    const unsupported = filters.filter((f) => !SUPPORTED_PDF_FILTERS.has(f));
    if (unsupported.length) {
      for (const f of unsupported) unsupportedFilters.add(f);
      continue;
    }
    const decoded = decodePdfStream(bytes.subarray(obj.streamStart, obj.streamEnd), filters);
    if (decoded === null) {
      warnings.push(warn(PDF_WARNING.DECODE_FAILED, '第 ' + obj.num + ' 号对象的流解压失败，已跳过该流'));
      continue;
    }
    streamText.set(obj.num, extractPdfTextOperators(decoded));
  }
  for (const f of unsupportedFilters) {
    warnings.push(warn(PDF_WARNING.UNSUPPORTED_FILTER, '暂不支持 PDF 滤镜 /' + f + '，该流的内容未提取'));
  }
  if (imageStreams > 0) {
    warnings.push(warn(PDF_WARNING.IMAGE_ONLY, 'PDF 里有 ' + imageStreams + ' 个图片流：本实现不 OCR，图片里的文字提取不到'));
  }

  // 页面顺序：先按 Catalog → Pages → Kids 走；走不通再退回文件顺序
  const pageInfo = resolvePdfPages(objects);
  if (pageInfo.how === 'file-order') {
    warnings.push(warn(PDF_WARNING.PAGE_ORDER_GUESS, '无法沿 /Pages 树确定页序，页码按对象出现顺序推测（可能不准）'));
  }
  let pages = [];
  let utf8Heuristic = false;
  const cleanPage = (raw) => {
    const cleaned = cleanPdfText(raw);
    if (cleaned.utf8) utf8Heuristic = true;
    return cleaned.text;
  };
  if (pageInfo.pages.length) {
    pages = pageInfo.pages.map((pageObj, idx) => {
      const refs = pdfContentRefs(pageObj.dict);
      const pieces = refs.map((num) => streamText.get(num) || '').filter(Boolean);
      return { page: idx + 1, text: cleanPage(pieces.join('\n')) };
    });
  } else if (streamText.size) {
    warnings.push(warn(PDF_WARNING.NO_PAGES, '找不到 /Type /Page 对象，无法给出页码；已把全部内容当成一页处理'));
    pages = [{ page: null, text: cleanPage([...streamText.values()].join('\n')) }];
  }
  if (utf8Heuristic) {
    warnings.push(warn(PDF_WARNING.UTF8_HEURISTIC, 'PDF 字符串里的字节序列本身是合法 UTF-8，已按 UTF-8 重新解码（启发式，非标准做法）'));
  }

  if (pages.length && pages.every((p) => !p.text)) {
    warnings.push(warn(PDF_WARNING.NO_TEXT, 'PDF 里没有可提取的文本层（常见于扫描件/纯图片 PDF），文本为空'));
  } else if (!pages.length) {
    warnings.push(warn(PDF_WARNING.NO_TEXT, 'PDF 里没有解析出任何内容流，文本为空'));
  }

  return pdfResult(pages, warnings, opts, {
    objects: objects.size,
    image_streams: imageStreams,
    page_map: pageInfo.how,
  });
}

function pdfResult(pages, warnings, opts, extra) {
  const nonEmpty = pages.filter((p) => p.text);
  const text = nonEmpty.map((p) => p.text).join('\n\n');
  const blocks = nonEmpty.map((p) => ({
    text: p.text,
    title: opts.fallbackTitle || null,
    path: null,
    page: p.page,
    // 页不跨块合并：页码要精确，合并了就说不清这段来自第几页
    merge: false,
  }));
  const title = blocks.length ? (firstLineTitle(blocks[0].text) || opts.fallbackTitle || null) : (opts.fallbackTitle || null);
  return {
    format: FORMAT.PDF,
    text: cleanText(text),
    title,
    blocks,
    warnings,
    metadata: Object.assign({ pages: pages.length, text_pages: nonEmpty.length, encoding: 'latin1' }, extra || {}),
  };
}

/** 扫出所有 `n 0 obj ... [stream ... endstream] ... endobj`；字典与流的字节偏移都记下来 */
function collectPdfObjects(bin) {
  const re = /(\d+)[ \t]+(\d+)[ \t]+obj\b/g;
  const hits = [];
  let m;
  while ((m = re.exec(bin))) hits.push({ num: Number(m[1]), start: m.index, afterObj: m.index + m[0].length });
  const objects = new Map();
  for (let i = 0; i < hits.length; i += 1) {
    const end = i + 1 < hits.length ? hits[i + 1].start : bin.length;
    const chunk = bin.slice(hits[i].afterObj, end);
    const sm = /\bstream(\r\n|\r|\n)/.exec(chunk);
    let dict;
    let streamStart = -1;
    let streamEnd = -1;
    if (sm) {
      dict = chunk.slice(0, sm.index);
      streamStart = hits[i].afterObj + sm.index + sm[0].length;
      const em = bin.indexOf('endstream', streamStart);
      streamEnd = em === -1 ? -1 : em;
      // 去掉 stream 与数据之间可能多的一个换行
      if (bin[streamStart] === '\n') streamStart += 1;
    } else {
      const eo = chunk.indexOf('endobj');
      dict = eo === -1 ? chunk : chunk.slice(0, eo);
    }
    objects.set(hits[i].num, { num: hits[i].num, dict, streamStart, streamEnd });
  }
  return objects;
}

function pdfFilters(dict) {
  const m = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  if (!m) return [];
  return (m[1].match(/\/[A-Za-z0-9]+/g) || []).map((s) => s.slice(1));
}

/** 解压单个流：只支持无滤镜与 FlateDecode；失败返回 null（由调用方记警告） */
function decodePdfStream(buf, filters) {
  if (!filters.length) return buf.toString('latin1');
  if (filters.length === 1 && SUPPORTED_PDF_FILTERS.has(filters[0])) {
    try {
      return zlib.inflateSync(buf).toString('latin1');
    } catch {
      // 有些生成器写的是裸 deflate（少了 zlib 头），再试一次
      try {
        return zlib.inflateRawSync(buf).toString('latin1');
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 页面对象按 /Pages 树排好序；失败时按文件顺序 */
function resolvePdfPages(objects) {
  const isPage = (o) => /\/Type\s*\/Page\b/.test(o.dict) && !/\/Type\s*\/Pages\b/.test(o.dict);
  const catalog = [...objects.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.dict));
  if (catalog) {
    const rootRef = refOf(catalog.dict, 'Pages');
    if (rootRef !== null) {
      const ordered = [];
      walkPageTree(objects, rootRef, ordered, new Set(), isPage);
      if (ordered.length) return { pages: ordered, how: 'kids' };
    }
  }
  const flat = [...objects.values()].filter(isPage);
  return { pages: flat, how: flat.length ? 'file-order' : 'none' };
}

function walkPageTree(objects, num, out, seen, isPage) {
  if (seen.has(num)) return;
  seen.add(num);
  const obj = objects.get(num);
  if (!obj) return;
  if (isPage(obj)) {
    out.push(obj);
    return;
  }
  const kids = arrayOfRefs(obj.dict, 'Kids');
  for (const kid of kids) walkPageTree(objects, kid, out, seen, isPage);
}

function refOf(dict, key) {
  const m = new RegExp('/' + key + '\\s+(\\d+)\\s+\\d+\\s+R\\b').exec(dict);
  return m ? Number(m[1]) : null;
}

function arrayOfRefs(dict, key) {
  const m = new RegExp('/' + key + '\\s*\\[([^\\]]*)\\]').exec(dict);
  if (!m) return [];
  return (m[1].match(/(\d+)\s+\d+\s+R\b/g) || []).map((s) => Number(/(\d+)/.exec(s)[1]));
}

/** 页面的 /Contents：单个引用或引用数组 */
function pdfContentRefs(dict) {
  const direct = refOf(dict, 'Contents');
  if (direct !== null) return [direct];
  return arrayOfRefs(dict, 'Contents');
}

/** PDF 文本行的清洗：先做 UTF-8 启发式**再**折叠空白 */
function cleanPdfText(text) {
  // 顺序很关键：0xA0 既是 NBSP 又是「你」的 UTF-8 末字节，
  // 先折叠空白会把字节序列改坏，之后的 UTF-8 还原就再也认不出来了
  const heuristic = preferUtf8IfCleaner(String(text || ''));
  const stripped = heuristic.text
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
  return { text: cleanText(stripped), utf8: heuristic.changed };
}

/**
 * UTF-8 启发式：PDF 字符串按单字节存储，中文通常是「UTF-8 字节被当成单字节」。
 * 如果把这些字节重新按 UTF-8 解一遍，能得到合法且包含 CJK 的结果，
 * 就采用它 —— 否则（拉丁文、WinAnsi 重音字符）保持原样。
 * 这是启发式，不是标准做法；识别不了的情况由 CID_FONT 警告说明。
 */
function preferUtf8IfCleaner(text) {
  if (!text || !/[\u0080-\u00ff]/.test(text)) return { text, changed: false };
  let asUtf8;
  try {
    asUtf8 = Buffer.from(text, 'latin1').toString('utf8');
  } catch {
    return { text, changed: false };
  }
  const bad = (s) => (s.match(/\uFFFD/g) || []).length;
  const hasCjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(asUtf8);
  if (hasCjk && bad(asUtf8) === 0) return { text: asUtf8, changed: true };
  return { text, changed: false };
}

/**
 * 从内容流里抽文本：只认 Tj / TJ / ' / " 四种显示操作符，
 * Td/TD/T* /BT/ET 当换行，其余操作符一律清空操作数栈。
 * 这忽略字距/字号/CTM，所以**读出来的正文可靠，但排版信息全丢**。
 */
export function extractPdfTextOperators(content) {
  const s = String(content == null ? '' : content);
  const n = s.length;
  const pieces = [];
  let stack = [];
  let i = 0;

  const pushText = (t) => {
    if (t) pieces.push(t);
  };
  const pushNewline = () => {
    if (pieces.length && !pieces[pieces.length - 1].endsWith('\n')) pieces.push('\n');
  };
  const pushOperand = (op) => {
    const top = stack[stack.length - 1];
    if (top && top.t === 'arr') top.v.push(op);
    else stack.push(op);
  };

  while (i < n) {
    const c = s[i];
    if (c === '(') {
      const r = readPdfLiteralString(s, i);
      pushOperand({ t: 'str', v: r.value });
      i = r.next;
      continue;
    }
    if (c === '<') {
      if (s[i + 1] === '<') {
        i = skipPdfDict(s, i);
        continue;
      }
      const r = readPdfHexString(s, i);
      pushOperand({ t: 'str', v: r.value });
      i = r.next;
      continue;
    }
    if (c === '[') {
      stack.push({ t: 'arr', v: [] });
      i += 1;
      continue;
    }
    if (c === ']') {
      i += 1;
      continue;
    }
    if (c === '/') {
      i = skipPdfName(s, i);
      continue;
    }
    if (c === '%') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\u0000') {
      i += 1;
      continue;
    }

    NUM_RE.lastIndex = i;
    const num = NUM_RE.exec(s);
    if (num) {
      pushOperand({ t: 'num', v: Number(num[0]) });
      i = NUM_RE.lastIndex;
      continue;
    }

    OP_RE.lastIndex = i;
    const opMatch = OP_RE.exec(s);
    if (!opMatch || !opMatch[0]) {
      i += 1;
      continue;
    }
    const op = opMatch[0];
    i = OP_RE.lastIndex;

    if (op === 'Tj' || op === "'" || op === '"') {
      if (op !== 'Tj') pushNewline();
      const str = [...stack].reverse().find((o) => o && o.t === 'str');
      if (str) pushText(str.v);
    } else if (op === 'TJ') {
      const arr = [...stack].reverse().find((o) => o && o.t === 'arr');
      if (arr) {
        for (const item of arr.v) {
          if (item && item.t === 'str') pushText(item.v);
          // 数组里的负数表示字距拉大，通常是空格；-100 是经验阈值
          else if (item && item.t === 'num' && item.v < -100) pushText(' ');
        }
      }
    } else if (op === 'Td' || op === 'TD') {
      const nums = stack.filter((o) => o && o.t === 'num');
      const ty = nums.length >= 2 ? nums[nums.length - 1].v : null;
      if (ty === null || ty !== 0) pushNewline();
      else pushText(' ');
    } else if (op === 'T*' || op === 'BT' || op === 'ET') {
      pushNewline();
    }
    stack = [];
  }
  return pieces.join('');
}

const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)/y;
// 操作符：连续的非空白、非分隔符字符（' 与 " 也是操作符）
const OP_RE = /[^\s()<>[\]{}/%]+/y;

/** PDF 字面量字符串：处理 \( \) \\ \n \r \t \b \f、1~3 位八进制、反斜杠续行 */
function readPdfLiteralString(s, start) {
  let i = start + 1;
  let depth = 1;
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const next = s[i + 1];
      if (next === undefined) {
        i += 1;
        break;
      }
      if (next === 'n') { out += '\n'; i += 2; continue; }
      if (next === 'r') { out += '\r'; i += 2; continue; }
      if (next === 't') { out += '\t'; i += 2; continue; }
      if (next === 'b') { out += '\b'; i += 2; continue; }
      if (next === 'f') { out += '\f'; i += 2; continue; }
      if (next === '\n') { i += 2; continue; }
      if (next === '\r') { i += s[i + 2] === '\n' ? 3 : 2; continue; }
      if (next >= '0' && next <= '7') {
        let oct = '';
        let k = i + 1;
        while (k < s.length && oct.length < 3 && s[k] >= '0' && s[k] <= '7') {
          oct += s[k];
          k += 1;
        }
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        i = k;
        continue;
      }
      out += next;
      i += 2;
      continue;
    }
    if (c === '(') {
      depth += 1;
      out += c;
      i += 1;
      continue;
    }
    if (c === ')') {
      depth -= 1;
      i += 1;
      if (depth === 0) break;
      out += c;
      continue;
    }
    out += c;
    i += 1;
  }
  return { value: out, next: i };
}

/** PDF 十六进制字符串 <48656C6C6F> */
function readPdfHexString(s, start) {
  const end = s.indexOf('>', start + 1);
  if (end === -1) return { value: '', next: s.length };
  const body = s.slice(start + 1, end).replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i + 1 < body.length; i += 2) out += String.fromCharCode(parseInt(body.slice(i, i + 2), 16));
  if (body.length % 2 === 1) out += String.fromCharCode(parseInt(body[body.length - 1] + '0', 16));
  return { value: out, next: end + 1 };
}

/** 跳过 << ... >>（字体/资源字典，正文提取用不到） */
function skipPdfDict(s, start) {
  let i = start;
  let depth = 0;
  while (i < s.length) {
    if (s[i] === '<' && s[i + 1] === '<') { depth += 1; i += 2; continue; }
    if (s[i] === '>' && s[i + 1] === '>') { depth -= 1; i += 2; if (depth <= 0) return i; continue; }
    if (s[i] === '(') { i = readPdfLiteralString(s, i).next; continue; }
    i += 1;
  }
  return i;
}

function skipPdfName(s, start) {
  let i = start + 1;
  while (i < s.length && !/[\s()<>[\]{}/%]/.test(s[i])) i += 1;
  return i;
}

// ------------------------------------------------------------
// 统一入口
// ------------------------------------------------------------

/**
 * 解析：raw 可以是 Buffer/Uint8Array/字符串。
 * opts.format 显式指定格式；否则按 opts.filename 的扩展名推断；再不行按 txt。
 */
export function parse(raw, opts = {}) {
  const format = String(opts.format || detectFormat({ path: opts.filename || opts.name || '' }) || FORMAT.TXT).toLowerCase();
  const fallbackTitle = opts.fallbackTitle || (opts.filename ? basenameOf(opts.filename).replace(/\.[^.]+$/, '') : null);
  const base = { fallbackTitle: fallbackTitle || null, filename: opts.filename || null };
  switch (format) {
    case FORMAT.MD: return parseMarkdown(raw, base);
    case FORMAT.HTML: return parseHtml(raw, base);
    case FORMAT.JSON: return parseJson(raw, base);
    case FORMAT.PDF: return parsePdf(raw, base);
    case FORMAT.TXT:
    default: return parseTxt(raw, base);
  }
}
