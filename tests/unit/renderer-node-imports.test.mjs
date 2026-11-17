// ============================================================
// 守卫：渲染层（src/）不许 import Node 内置模块
//
// 真事故：`src/agent/executor.js` 里 `import nodePath from 'node:path'`，
// Vite 把它换成 stub，真机上所有文件工具都抛
// `nodePath.resolve is not a function`；而单测跑在 Node 上全绿 —— 抓不到。
//
// 已知且刻意保留的例外（只 import、只在函数体内用，真机走桥接注入）：
//   src/knowledge/parser.js  `node:zlib`   （PDF 解析，浏览器端不调用）
//   src/knowledge/sources.js `node:crypto` （同样）
//   src/knowledge/store.js   `node:fs/promises`
//   src/memory/store.js      `node:fs/promises`
// 除这些之外，任何 `from 'node:...'` 都算回归。
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../src');

const ALLOWED = new Set([
  'knowledge/parser.js',
  'knowledge/sources.js',
  'knowledge/store.js',
  'memory/store.js',
]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('渲染层不许直接 import Node 内置模块', () => {
  it('src/ 里没有未登记的 node: 导入', () => {
    const offenders = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const hits = text.match(/^import[^\n]*from\s+['"]node:[^'"]+['"]/gm) || [];
      if (hits.length) offenders.push(rel + ' -> ' + hits.join(', '));
    }
    expect(offenders).toEqual([]);
  });

  it('executor 用的是纯 JS 路径工具（这起事故的现场）', () => {
    const text = fs.readFileSync(path.join(ROOT, 'agent/executor.js'), 'utf8');
    expect(text).not.toMatch(/^import[^\n]*from\s+['"]node:/m);
    expect(text).toContain("from '../../shared/path-util.cjs'");
  });
});
