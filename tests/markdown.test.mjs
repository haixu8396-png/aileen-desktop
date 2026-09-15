// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown, safeHref } from '../src/lib/markdown.js';

const BT = String.fromCharCode(96); // 反引号，避免被模板/编辑器处理

describe('renderMarkdown 安全性', () => {
  it('原始 HTML 标签被转义而非执行', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    const div = document.createElement('div');
    div.innerHTML = html;
    // 真实安全属性：DOM 里没有 img/script 元素，也没有任何 on* 事件属性
    expect(div.querySelector('img')).toBeNull();
    expect(div.querySelector('script')).toBeNull();
    const hasHandler = Array.from(div.querySelectorAll('*')).some((el) =>
      Array.from(el.attributes).some((a) => /^on/i.test(a.name)),
    );
    expect(hasHandler).toBe(false);
    // 内容以纯文本形式展示
    expect(div.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('script 标签被清理', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html.toLowerCase()).not.toContain('<script');
  });

  it('链接里的属性逃逸被阻止', () => {
    const html = renderMarkdown('[x](https://a.com/\"onmouseover=\"alert(1))');
    // 恶意引号被剔除，无法逃逸出 href 形成新属性
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    const tag = html.match(/<a[^>]*>/);
    expect(tag).toBeTruthy();
    expect(tag[0]).not.toContain('\"onmouseover');
  });

  it('非 http(s) 链接不生成 a 标签', () => {
    const html = renderMarkdown('[x](javascript:alert(1))');
    expect(html).not.toContain('<a');
  });

  it('正常 markdown 仍然渲染', () => {
    const src = '**加粗** 和 ' + BT + '代码' + BT + '\n\n- 一\n- 二';
    const html = renderMarkdown(src);
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<code>代码</code>');
    expect(html).toContain('<li>一</li>');
  });

  it('safeHref 只放行 http/https', () => {
    expect(safeHref('https://a.com/x')).toBe('https://a.com/x');
    expect(safeHref('javascript:alert(1)')).toBe('');
    expect(safeHref('https://a.com/\"x')).toBe('https://a.com/x');
  });
});
