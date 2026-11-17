'use strict';
// ============================================================
// 纯 JS 路径工具（渲染层可用）
//
// 为什么需要它：渲染层的 Agent executor 在**浏览器 bundle** 里跑，`node:path`
// 会被 Vite 换成 stub，调用时抛 `nodePath.resolve is not a function` ——
// 真机表现就是「写文件 / 打补丁 / 列目录 / 读文件全部同一个内部错误」。
// 单测跑在 Node 上，`node:path` 完全正常，所以这个 bug 单测永远抓不到。
//
// 约定：
//   · 内部统一用 `/`（Windows 也认）；输出的路径同样用 `/`。
//   · 大小写不敏感的包含判断只给 Windows 用（`isInside`）。
//   · 不解析符号链接 —— 真正的边界校验在主进程（`agent:fs` 的 resolveSafe）。
// ============================================================

function toSlash(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}

/** 是否是绝对路径（`C:/x`、`C:x` 之外、`/x`） */
function isAbsolute(p) {
  const s = toSlash(p);
  return s.startsWith('/') || /^[a-zA-Z]:\//.test(s) || /^[a-zA-Z]:$/.test(s);
}

/** 拆出「根前缀」（`C:/`、`//server/`、`/`、空）与剩下的段 */
function splitRoot(p) {
  const s = toSlash(p);
  const drive = s.match(/^([a-zA-Z]:)(\/|$)/);
  if (drive) return { root: drive[1].toUpperCase() + '/', rest: s.slice(drive[0].length) };
  if (s.startsWith('//')) {
    const m = s.match(/^\/\/([^/]+)\/?([^/]*)\/?/);
    if (m) return { root: '//' + m[1] + '/' + (m[2] || '') + '/', rest: s.slice(m[0].length) };
  }
  if (s.startsWith('/')) return { root: '/', rest: s.slice(1) };
  return { root: '', rest: s };
}

/** 输出用本机习惯的分隔符：盘符路径用 `\`（和 node:path 一致），其余保持 `/` */
function toNative(p) {
  if (typeof p !== 'string') return p;
  return /^[a-zA-Z]:\//.test(p) ? p.replace(/\//g, '\\') : p;
}

/** 归一化：折叠 `.` / `..` / 重复分隔符；输出用本机习惯的分隔符 */
function normalize(p) {
  const raw = toSlash(p);
  if (!raw) return '.';
  const { root, rest } = splitRoot(raw);
  const out = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!root) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = root + out.join('/');
  return toNative(joined || (root || '.'));
}

/** 拼接（等同于 path.join 的宽松版：不规范化 `..` 之外的语义） */
function join(...parts) {
  return normalize(parts.filter((x) => x != null && x !== '').join('/'));
}

/** 取绝对路径：target 是绝对路径就用它，否则相对 base */
function resolve(base, target) {
  const t = toSlash(target == null ? '' : target).trim() || '.';
  if (isAbsolute(t)) return normalize(t);
  return normalize((base || '') + '/' + t);
}

/** 相对路径（root → abs）；跨盘/不在 root 下时回退成 abs */
function relative(root, abs) {
  const r = toSlash(normalize(root));
  const a = toSlash(normalize(abs));
  if (r === a) return '';
  const rr = r.endsWith('/') ? r : r + '/';
  const lower = (s) => (process_likeWin() ? s.toLowerCase() : s);
  if (lower(a).startsWith(lower(rr))) return a.slice(rr.length);
  return a;
}

/** 父目录 */
function dirname(p) {
  const n = toSlash(p);
  const root = splitRoot(n).root;
  const idx = n.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  const cut = n.slice(0, idx);
  // `C:/x` 的父目录是 `C:/`，不能退成 `C:`
  if (/^[a-zA-Z]:$/.test(cut)) return toNative(cut + '/');
  if (!cut || cut === root.replace(/\/$/, '')) return toNative(root || '/');
  return toNative(cut);
}

/** 最后一段 */
function basename(p) {
  const n = toSlash(p);
  const idx = n.lastIndexOf('/');
  return idx < 0 ? n : n.slice(idx + 1);
}

function process_likeWin() {
  // 浏览器里没有 process；Windows 盘的绝对路径本身就是最可靠的信号
  try {
    if (typeof process !== 'undefined' && process.platform) return process.platform === 'win32';
  } catch { /* 浏览器 */ }
  return true;
}

/** child 是否位于 parent 之内（Windows 大小写不敏感，和 shared/util.cjs 一致） */
function isInside(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return false;
  if (child.includes('\0') || parent.includes('\0')) return false;
  const win = process_likeWin();
  const norm = (s) => toSlash(normalize(s));
  const c = win ? norm(child).toLowerCase() : norm(child);
  const p = win ? norm(parent).toLowerCase() : norm(parent);
  const pr = p.endsWith('/') ? p : p + '/';
  return c === p || c.startsWith(pr);
}

module.exports = {
  toSlash,
  toNative,
  isAbsolute,
  normalize,
  join,
  resolve,
  relative,
  dirname,
  basename,
  isInside,
};
