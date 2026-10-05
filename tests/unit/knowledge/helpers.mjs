// ============================================================
// knowledge 测试的公共工具（**不是测试文件**，vitest 只收 *.test.mjs）
//
// 三样东西：
//   · createMemoryFs  —— 注入用的内存文件系统，单测因此完全不碰磁盘
//   · makeClock       —— 可控时钟，让 created_at/updated_at 的断言稳定
//   · buildSimplePdf  —— 现场拼一个最小 PDF（含 FlateDecode 文本流），
//                        不依赖任何外部样本文件
// ============================================================

import zlib from 'node:zlib';
import { createKnowledgeEngine } from '../../../src/knowledge/engine.js';

// ------------------------------------------------------------
// 内存 fs：实现 store/loader 需要的那 8 个方法
// ------------------------------------------------------------

function enoent(p) {
  const err = new Error('ENOENT: no such file, open ' + p);
  err.code = 'ENOENT';
  return err;
}

const norm = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '') || '/';

export function createMemoryFs(initial = {}) {
  const files = new Map();
  const dirs = new Set(['/']);

  const put = (p, content) => {
    files.set(norm(p), Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content), 'utf8'));
  };
  for (const [p, c] of Object.entries(initial)) put(p, c);

  return {
    files,
    /** 测试直接塞内容（模拟"用户在磁盘上改了文件"） */
    set(p, content) {
      put(p, content);
    },
    dump() {
      return Object.fromEntries([...files].map(([k, v]) => [k, v.toString('utf8')]));
    },
    async readText(p) {
      const buf = files.get(norm(p));
      if (!buf) throw enoent(p);
      return buf.toString('utf8');
    },
    async readBytes(p) {
      const buf = files.get(norm(p));
      if (!buf) throw enoent(p);
      return Buffer.from(buf);
    },
    async writeText(p, text) {
      put(p, text);
    },
    async exists(p) {
      const key = norm(p);
      return files.has(key) || dirs.has(key);
    },
    async mkdirp(p) {
      dirs.add(norm(p));
    },
    async rename(from, to) {
      const key = norm(from);
      const buf = files.get(key);
      if (!buf) throw enoent(from);
      files.set(norm(to), buf);
      files.delete(key);
    },
    async remove(p) {
      const key = norm(p);
      files.delete(key);
      for (const k of [...files.keys()]) {
        if (k.startsWith(key + '/')) files.delete(k);
      }
      dirs.delete(key);
    },
    async list(p) {
      const prefix = norm(p) === '/' ? '/' : norm(p) + '/';
      const out = new Set();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes('/')) out.add(rest);
      }
      return [...out];
    },
  };
}

// ------------------------------------------------------------
// 可控时钟
// ------------------------------------------------------------

export function makeClock(startIso = '2024-01-01T00:00:00.000Z') {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t).toISOString(),
    advanceDays(days) {
      t += days * 86400000;
      return new Date(t).toISOString();
    },
    advanceMs(ms) {
      t += ms;
      return new Date(t).toISOString();
    },
    set(iso) {
      t = Date.parse(iso);
      return new Date(t).toISOString();
    },
    get time() {
      return t;
    },
  };
}

// ------------------------------------------------------------
// 引擎工厂：默认离线（enabled:false），永远不打网络
// ------------------------------------------------------------

export function makeEngine(options = {}) {
  const fs = options.fs || createMemoryFs(options.files || {});
  const clock = options.clock || makeClock(options.startIso);
  const kb = createKnowledgeEngine({
    fs,
    dir: options.dir || '/kb',
    now: clock.now,
    chunking: options.chunking,
    retrieval: options.retrieval,
    rerank: options.rerank,
    getConfig: options.getConfig || (() => ({ enabled: false })),
    fetchImpl: options.fetchImpl,
    onFallback: options.onFallback,
  });
  return { kb, fs, clock };
}

/** 造一个假 fetch：按顺序返回给定响应 */
export function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const spec = Array.isArray(responses) ? responses[Math.min(i, responses.length - 1)] : responses;
    i += 1;
    if (spec && spec.throw) throw new Error(spec.throw);
    return {
      ok: spec && spec.ok !== undefined ? spec.ok : true,
      status: (spec && spec.status) || 200,
      async json() {
        if (spec && spec.json) return spec.json;
        const body = calls[calls.length - 1].body;
        const inputs = (body && body.input) || [];
        return { data: inputs.map((_, idx) => ({ index: idx, embedding: unitVector(64, idx) })) };
      },
    };
  };
  fn.calls = calls;
  return fn;
}

/** 造一个可区分的假向量（同一 idx 维度固定 → 同文本同向量） */
export function unitVector(dim, seed) {
  const vec = new Array(dim).fill(0);
  vec[Math.abs(Number(seed) || 0) % dim] = 1;
  return vec;
}

// ------------------------------------------------------------
// 现场造最小 PDF（不依赖外部文件、不装库）
// ------------------------------------------------------------

const latin1 = (s) => Buffer.from(String(s), 'latin1').toString('latin1');

/** 把 UTF-8 文本变成"字节串"，用来模拟 PDF 里被当单字节存的中文 */
export function utf8AsLatin1(s) {
  return Buffer.from(String(s), 'utf8').toString('latin1');
}

/**
 * 拼一个最小 PDF：
 *   pages        每页的内容流（未压缩的 PDF 操作符字符串）
 *   compress     是否用 FlateDecode 压缩内容流（默认 true）
 *   encrypted    是否带 /Encrypt（用来测"加密 → 给 warnings 而不是抛错"）
 *   imageOnly    页面内容只画一张图（测"无文本层"）
 *   rawOverride  直接给整个文件的字符串（测"不是 PDF"）
 * 注意：parser 刻意**不依赖 xref**（只扫 obj/stream），这里仍然写了一份
 * 合法的 xref，好让样本本身是"真 PDF"。
 */
export function buildSimplePdf(options = {}) {
  const pages = options.pages && options.pages.length ? options.pages : ['BT /F1 24 Tf 72 700 Td (Hello Knowledge Base) Tj ET'];
  const compress = options.compress !== false;
  const objects = [];
  const fontNum = 3 + pages.length * 2;
  const imageNum = fontNum + 1;

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => (3 + i * 2) + ' 0 R');
  objects[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>';

  pages.forEach((content, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    const resources = options.imageOnly
      ? '<< /XObject << /Im1 ' + imageNum + ' 0 R >> >>'
      : '<< /Font << /F1 ' + fontNum + ' 0 R >> >>';
    objects[pageNum] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ' + resources + ' /Contents ' + contentNum + ' 0 R >>';
    const body = compress ? zlib.deflateSync(Buffer.from(String(content), 'latin1')).toString('latin1') : String(content);
    objects[contentNum] = '<< /Length ' + Buffer.byteLength(body, 'latin1') + (compress ? ' /Filter /FlateDecode' : '') + ' >>\nstream\n' + body + '\nendstream';
  });

  objects[fontNum] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  if (options.imageOnly) {
    const img = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('latin1');
    objects[imageNum] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.length + ' >>\nstream\n' + img + '\nendstream';
  }

  let trailer = '';
  if (options.encrypted) {
    const encNum = imageNum + 1;
    objects[encNum] = '<< /Filter /Standard /V 2 /R 3 /O <' + 'ab'.repeat(32) + '> /U <' + 'cd'.repeat(32) + '> /P -1 >>';
    trailer = '/Encrypt ' + encNum + ' 0 R ';
  }

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objects.length; i += 1) {
    if (!objects[i]) continue;
    offsets[i] = out.length;
    out += i + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  const xrefPos = out.length;
  const size = objects.length;
  out += 'xref\n0 ' + size + '\n0000000000 65535 f \n';
  for (let i = 1; i < size; i += 1) {
    out += String(offsets[i] || 0).padStart(10, '0') + ' 00000 n \n';
  }
  out += 'trailer\n<< /Size ' + size + ' /Root 1 0 R ' + trailer + '>>\nstartxref\n' + xrefPos + '\n%%EOF\n';
  return Buffer.from(latin1(out), 'latin1');
}

/** 常用内容流片段 */
export const PDF_CONTENT = {
  /** 普通 Tj + 八进制转义 + TJ 数组（含字距空格） */
  simple: 'BT /F1 24 Tf 72 700 Td (Hello Knowledge Base) Tj ET',
  escaped: 'BT /F1 12 Tf 72 700 Td (A\\101B \\(paren\\) C) Tj ET',
  array: 'BT /F1 12 Tf 72 700 Td [(Alpha) -300 (Beta) -50 (Gamma)] TJ ET',
  twoLines: 'BT /F1 12 Tf 72 700 Td (First line) Tj 0 -20 Td (Second line) Tj ET',
  chinese: 'BT /F1 24 Tf 72 700 Td (' + utf8AsLatin1('你好，知识库系统') + ') Tj ET',
  imageOnly: 'q 100 0 0 100 0 0 cm /Im1 Do Q',
};
