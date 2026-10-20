// ============================================================
// 图标集（内联 SVG，零依赖、零图片资源）
//
// 为什么要它：界面里大量按钮用 Emoji 当图标（🔊 ↻ ⏹ 🗑 ⋯ 📷 🎤 ➤），
// Emoji 在不同系统上字形、基线、颜色都不一致，看起来像「随手拼的」。
// 这里给一组**统一的线性图标**（1.6 描边、圆角端点、继承 currentColor），
// 用 `<span data-icon="name">` 挂上去，init 时替换成真正的 SVG。
//
// 约束：
//   · 只用 path/line/polyline/circle/rect，不引任何外部资源（CSP 友好）；
//   · viewBox 统一 24×24，尺寸由 CSS 决定（默认 16px），跟随字号基线对齐；
//   · 图标是**装饰**：按钮的可读名称仍然来自 aria-label / title。
// ============================================================

const P = {
  // 发送：纸飞机
  send: '<path d="M3.5 11.2 20 4.5a.6.6 0 0 1 .8.8L14 21.8a.6.6 0 0 1-1.1-.1l-2-6.1-6.1-2a.6.6 0 0 1-.1-1.1Z"/><path d="M20.5 5 11 14.5"/>',
  // 麦克风
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>',
  // 相机（截图）
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/>',
  // 喇叭（朗读）
  speaker: '<path d="M4 10v4h3l4 3.5v-11L7 10H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  // 重新生成
  regenerate: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>',
  // 停止
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  // 清空
  trash: '<path d="M4 7h16"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10.5 11v5.5M13.5 11v5.5"/>',
  // 更多
  more: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
  // 实时语音
  waveform: '<path d="M5 10v4"/><path d="M9 7.5v9"/><path d="M13 5.5v13"/><path d="M17 9v6"/><path d="M21 10.5v3"/>',
  // 下箭头（滚到底）
  arrowDown: '<path d="M12 5v13"/><path d="M6.5 12.5 12 18l5.5-5.5"/>',
};

/** 生成一段 SVG 标记（字符串）。只在 init 时用到。 */
export function iconSvg(name, size = 16) {
  const body = P[name];
  if (!body) return '';
  return '<svg class="ico" viewBox="0 0 24 24" width="' + size + '" height="' + size + '"'
    + ' fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
    + ' aria-hidden="true" focusable="false">' + body + '</svg>';
}

/**
 * 把根节点里所有 `[data-icon]` 元素的**图标部分**替换成 SVG。
 *
 * 只在元素没有子元素时整段替换（那类按钮的 emoji 就是它的全部内容）；
 * 已有文本的按钮不会被覆盖 —— 宁可少替换，也不要吞掉可读文字。
 */
export function applyIcons(root) {
  const scope = root || document;
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  let n = 0;
  scope.querySelectorAll('[data-icon]').forEach((el) => {
    const svg = iconSvg(el.getAttribute('data-icon'), Number(el.getAttribute('data-icon-size')) || 16);
    if (!svg) return;
    const text = String(el.textContent || '').trim();
    // 只有在「只放了一个图标占位」或「内容是 Emoji」时才替换，避免吞掉标题文字
    if (!el.firstElementChild && (text === '' || /^[\u2190-\u21FF\u2600-\u27BF\uFE0F\u{1F300}-\u{1FAFF}\uFF0B\u2212]+$/u.test(text))) {
      el.innerHTML = svg;
      n += 1;
    }
  });
  return n;
}

export const ICON_NAMES = Object.keys(P);
