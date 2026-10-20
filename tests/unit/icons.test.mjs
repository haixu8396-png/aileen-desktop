// @vitest-environment jsdom
// ============================================================
// 图标集（内联 SVG）
//
// 两条硬约束：
//   1. HTML 里写下的每个 data-icon 都必须在 icons.js 里有真图形 ——
//      写错名字不会报错，只会**静默画出一个空按钮**（和 IPC 字段名那个坑同源）；
//   2. applyIcons 只能替「纯图标占位」，绝不能吞掉按钮上的可读文字。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { iconSvg, applyIcons, ICON_NAMES } from '../../src/lib/icons.js';

// jsdom 环境下 import.meta.url 不是 file:// ，所以用工作目录定位仓库根
const root = process.cwd();

function scanIcons(file) {
  const html = readFileSync(resolve(root, file), 'utf8');
  return [...html.matchAll(/data-icon="([^"]+)"/g)].map((m) => m[1]);
}

describe('图标覆盖：HTML 里用到的名字都必须有图形', () => {
  for (const file of ['src/index.html', 'src/overlay.html']) {
    it(`${file} 没有拼错的 data-icon`, () => {
      const used = scanIcons(file);
      expect(used.length).toBeGreaterThan(0);
      const unknown = used.filter((n) => !ICON_NAMES.includes(n));
      expect(unknown).toEqual([]);
    });
  }

  it('空状态等 JS 里用到的图标名也存在', () => {
    for (const name of ['mark', 'plus', 'import', 'search', 'settings', 'agent', 'desktop', 'folder', 'speaker', 'mic', 'send', 'close', 'play', 'pause', 'skip', 'bolt', 'plug', 'link', 'layers', 'brain', 'gamepad', 'pawn', 'globe', 'info', 'person', 'spark', 'mask', 'palette', 'frame', 'window', 'pointer', 'lock', 'heart', 'food', 'music', 'trash', 'regenerate', 'copy', 'pencil', 'export', 'check', 'dot', 'more', 'waveform', 'camera', 'chat', 'minus', 'arrowDown', 'book']) {
      expect({ name, known: ICON_NAMES.includes(name) }).toEqual({ name, known: true });
    }
  });
});

describe('iconSvg', () => {
  it('生成 24×24、继承 currentColor、无外部引用的 SVG', () => {
    const svg = iconSvg('settings', 18);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('width="18"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).not.toContain('http');
  });

  it('未知名字给空串（宁可没图标，也不画半个）', () => {
    expect(iconSvg('nope')).toBe('');
  });
});

describe('applyIcons', () => {
  it('空占位会被替换成 SVG；未知名字保持原样', () => {
    document.body.innerHTML = '<button id="a"><span data-icon="plus"></span></button>'
      + '<button id="b"><span data-icon="tpyo"></span></button>';
    const n = applyIcons(document.body);
    expect(n).toBe(1);
    expect(document.querySelector('#a svg')).toBeTruthy();
    expect(document.querySelector('#b svg')).toBe(null);
  });

  it('里面本来有可读文字的按钮不会被吞掉', () => {
    document.body.innerHTML = '<button id="c"><span data-icon="plus">New Character</span></button>';
    applyIcons(document.body);
    expect(document.querySelector('#c').textContent).toBe('New Character');
    expect(document.querySelector('#c svg')).toBe(null);
  });

  it('只放了一个 Emoji 的按钮会被替换（迁移期的那些）', () => {
    document.body.innerHTML = '<button id="d"><span data-icon="trash">🗑</span></button>';
    applyIcons(document.body);
    expect(document.querySelector('#d svg')).toBeTruthy();
    expect(document.querySelector('#d').textContent).toBe('');
  });
});
