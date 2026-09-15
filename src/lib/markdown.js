// 轻量 Markdown 渲染（输出统一经 DOMPurify 消毒，防止 XSS）
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3'];
const ALLOWED_ATTR = ['href', 'target', 'rel'];

let purifier = null;
function getPurifier() {
  if (!purifier) purifier = DOMPurify(window);
  return purifier;
}

export function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 只放行 http/https，并剔除可逃逸 HTML 属性的字符 */
export function safeHref(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return '';
  return u.replace(/["'<>`\\\s]/g, '');
}

function inline(t) {
  return t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = safeHref(url);
      if (!href) return label;
      return '<a href="' + href + '" target="_blank" rel="noreferrer">' + label + '</a>';
    });
}

export function renderMarkdown(src) {
  if (!src) return '';
  let s = escapeHtml(src);
  // 代码块
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => '<pre><code>' + code.trim() + '</code></pre>');
  const blocks = s.split(/\n{2,}/);
  const html = blocks.map((block) => {
    const b = block.trim();
    if (!b) return '';
    const heading = b.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const lvl = heading[1].length;
      return '<h' + lvl + '>' + inline(heading[2]) + '</h' + lvl + '>';
    }
    if (b.startsWith('- ') || b.startsWith('* ')) {
      const items = b.split(/\n/).filter((l) => l.trim()).map((l) => '<li>' + inline(l.replace(/^[-*]\s+/, '')) + '</li>');
      return '<ul>' + items.join('') + '</ul>';
    }
    if (/^\d+\.\s/.test(b)) {
      const items = b.split(/\n/).filter((l) => l.trim()).map((l) => '<li>' + inline(l.replace(/^\d+\.\s+/, '')) + '</li>');
      return '<ol>' + items.join('') + '</ol>';
    }
    const lines = b.split(/\n/).map((l) => inline(l));
    return '<p>' + lines.join('<br>') + '</p>';
  }).join('');
  // 最后统一消毒：即使上面的转义有漏网之鱼，也不会执行脚本/事件属性
  return getPurifier().sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}
