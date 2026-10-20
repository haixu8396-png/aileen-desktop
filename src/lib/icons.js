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

// 重复用的形状单独提出来，别在两处抄同一串 path
const MOON = '<path d="M20 13.2A8.2 8.2 0 0 1 10.8 4a8.4 8.4 0 1 0 9.2 9.2Z"/>';

const P = {
  // 品牌标识：圆环里一颗四角星（和 Live2D 展台、README 的 ✦ 一脉相承，但不是 Emoji 字形）
  mark: '<circle cx="12" cy="12" r="9" stroke-width="1.4"/><path d="M12 6.6c.5 2.6 1.4 3.5 4 4-2.6.5-3.5 1.4-4 4-.5-2.6-1.4-3.5-4-4 2.6-.5 3.5-1.4 4-4Z" fill="currentColor" stroke="none"/>',
  // 新建 / 放大
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  // 缩小
  minus: '<path d="M5 12h14"/>',
  // 设置（齿轮的简化版：一圈齿用短线段表示，别画太细）
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"/>',
  // Agent（芯片）
  agent: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/><path d="M10 10h4v4h-4z"/><path d="M12 3.5V6.5M12 17.5v3M3.5 12h3M17.5 12h3M6.5 4.5v0M17.5 19.5v0"/>',
  // 电脑控制（显示器）
  desktop: '<rect x="3.5" y="5" width="17" height="11" rx="2"/><path d="M9.5 20h5"/><path d="M12 16v4"/>',
  // 数据目录（文件夹）
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z"/>',
  // 导入（箭头落进托盘）
  import: '<path d="M12 4v10"/><path d="M7.5 9.5 12 14l4.5-4.5"/><path d="M4.5 17.5v1A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-1"/>',
  // 导出（箭头离开托盘）
  export: '<path d="M12 14.5v-10"/><path d="M7.5 9 12 4.5 16.5 9"/><path d="M4.5 17.5v1A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-1"/>',
  // 搜索
  search: '<circle cx="11" cy="11" r="6.2"/><path d="m16 16 4 4"/>',
  // 发送：纸飞机
  send: '<path d="M3.5 11.2 20 4.5a.6.6 0 0 1 .8.8L14 21.8a.6.6 0 0 1-1.1-.1l-2-6.1-6.1-2a.6.6 0 0 1-.1-1.1Z"/><path d="M20.5 5 11 14.5"/>',
  // 麦克风
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>',
  // 相机（截图）
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/>',
  // 喇叭（朗读 / TTS）
  speaker: '<path d="M4 10v4h3l4 3.5v-11L7 10H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  // 重新生成 / 刷新（同一个回转箭头，语义都是「重来一遍」）
  regenerate: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>',
  // 停止
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  // 开始 / 继续（三角）
  play: '<path d="M8.5 5.8 18.8 11.6a.5.5 0 0 1 0 .8L8.5 18.2a.5.5 0 0 1-.8-.4V6.2a.5.5 0 0 1 .8-.4Z"/>',
  // 暂停
  pause: '<rect x="8.2" y="6" width="2.6" height="12" rx="1"/><rect x="13.2" y="6" width="2.6" height="12" rx="1"/>',
  // 继续下一段（跳过）
  skip: '<path d="M6.5 6.4 15 11.6a.5.5 0 0 1 0 .8L6.5 17.6a.5.5 0 0 1-.8-.4V6.8a.5.5 0 0 1 .8-.4Z"/><path d="M18 6.2v11.6"/>',
  // 清空
  trash: '<path d="M4 7h16"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10.5 11v5.5M13.5 11v5.5"/>',
  // 更多
  more: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
  // 实时语音
  waveform: '<path d="M5 10v4"/><path d="M9 7.5v9"/><path d="M13 5.5v13"/><path d="M17 9v6"/><path d="M21 10.5v3"/>',
  // 下箭头（滚到底）
  arrowDown: '<path d="M12 5v13"/><path d="M6.5 12.5 12 18l5.5-5.5"/>',
  // 关闭
  close: '<path d="M6.5 6.5 17.5 17.5"/><path d="M17.5 6.5 6.5 17.5"/>',
  // 勾选 / 状态点
  check: '<path d="M5 12.5 9.5 17 19 7.5"/>',
  dot: '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>',
  // 编辑角色卡
  pencil: '<path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5v3Z"/><path d="M14.5 7.5 17.5 10.5"/>',
  // 复制（做一张同样的卡）
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  // 取模型列表（闪电）
  bolt: '<path d="M13.2 3 5.8 13.4h5l-1 7.6L18.2 10.6h-5.1Z"/>',
  // 测连通（插头）
  plug: '<path d="M9 3.5v4M15 3.5v4"/><path d="M7 7.5h10v3.6a5 5 0 0 1-10 0Z"/><path d="M12 16.6V20.5"/>',
  // 从 URL 载入（链环）
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M12.5 6.5 14 5a3.6 3.6 0 0 1 5.1 5.1l-1.6 1.6"/><path d="M11.5 17.5 10 19a3.6 3.6 0 0 1-5.1-5.1l1.6-1.6"/>',
  // 对话设置（气泡）
  chat: '<path d="M20.5 12.2c0 4-3.8 7.3-8.5 7.3-1 0-2-.1-2.9-.4L4.5 20.5l1.4-3.7A6.9 6.9 0 0 1 3.5 12.2C3.5 8.2 7.3 5 12 5s8.5 3.2 8.5 7.2Z"/>',
  // 角色卡（头像）
  person: '<circle cx="12" cy="8.4" r="3.6"/><path d="M5 20.5c0-3.6 3.1-6 7-6s7 2.4 7 6"/>',
  // 人设生成（星芒）
  spark: '<path d="M11.5 3.5c.7 3.9 2.1 5.3 6 6-3.9.7-5.3 2.1-6 6-.7-3.9-2.1-5.3-6-6 3.9-.7 5.3-2.1 6-6Z"/><path d="M18 15.3c.4 1.9 1.1 2.6 3 3-1.9.4-2.6 1.1-3 3-.4-1.9-1.1-2.6-3-3 1.9-.4 2.6-1.1 3-3Z"/>',
  // 演出（面具）
  mask: '<path d="M4 5.5h16v5.6c0 4.4-3.6 8-8 8s-8-3.6-8-8Z"/><circle cx="9" cy="10.2" r="1"/><circle cx="15" cy="10.2" r="1"/><path d="M9 14c1.8 1.2 4.2 1.2 6 0"/>',
  // Live2D（叠层 / 换装）
  layers: '<path d="M12 3.5 3.5 8l8.5 4.5L20.5 8Z"/><path d="M3.5 12.4 12 16.9l8.5-4.5"/><path d="M3.5 16.6 12 21.1l8.5-4.5"/>',
  // 外观（调色盘）
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.9 2-1.8 0-1.4-1.2-1.7-1.2-2.9 0-.7.6-1.3 1.5-1.3h1.6a4.6 4.6 0 0 0 4.6-4.6C20.5 6 16.7 3.5 12 3.5Z"/><circle cx="8" cy="9.2" r="1"/><circle cx="12" cy="7.6" r="1"/><circle cx="15.8" cy="9.6" r="1"/>',
  // 无边框展台（取景框）
  frame: '<path d="M4 8.5V6a2 2 0 0 1 2-2h2.5"/><path d="M15.5 4H18a2 2 0 0 1 2 2v2.5"/><path d="M20 15.5V18a2 2 0 0 1-2 2h-2.5"/><path d="M8.5 20H6a2 2 0 0 1-2-2v-2.5"/>',
  // 记忆与知识库（大脑）
  brain: '<path d="M12 4.8v14.4"/><path d="M12 6.6a2.6 2.6 0 0 0-5.1-.7A2.7 2.7 0 0 0 4.7 9.2a2.9 2.9 0 0 0 .9 4.5 2.8 2.8 0 0 0 2.7 4A2.7 2.7 0 0 0 12 18.6"/><path d="M12 6.6a2.6 2.6 0 0 1 5.1-.7 2.7 2.7 0 0 1 2.2 3.3 2.9 2.9 0 0 1-.9 4.5 2.8 2.8 0 0 1-2.7 4A2.7 2.7 0 0 1 12 18.6"/>',
  // Minecraft（手柄）
  gamepad: '<rect x="2.8" y="8.2" width="18.4" height="8.8" rx="4.4"/><path d="M7.2 12.6h3M8.7 11.1v3"/><circle cx="16" cy="11.8" r="1"/><circle cx="18" cy="13.8" r="1"/>',
  // 国际象棋（兵）
  pawn: '<circle cx="12" cy="6.4" r="2.4"/><path d="M9.8 9.8c.3 1.6 1.2 2.6 1.6 4.2h1.2c.4-1.6 1.3-2.6 1.6-4.2"/><path d="M9.6 14h4.8l.8 3.2H8.8Z"/><path d="M6.5 20.5h11"/>',
  // 语言（地球）
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.4 3.9 5.4 3.9 8.5s-1.4 6.1-3.9 8.5c-2.5-2.4-3.9-5.4-3.9-8.5s1.4-6.1 3.9-8.5Z"/>',
  // 关于（信息）
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.6"/><path d="M12 7.8v.4"/>',
  // 打开主窗口
  window: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 9h17"/>',
  // 鼠标指针（未锁定拖拽）
  pointer: '<path d="M5.6 3.8 18 11.4l-5.5 1.2-2.5 5.2Z"/>',
  // 锁定
  lock: '<rect x="4.8" y="10.4" width="14.4" height="9.6" rx="2.2"/><path d="M8.4 10.4V7.8a3.6 3.6 0 0 1 7.2 0v2.6"/>',
  // Minecraft 生命 / 饥饿
  heart: '<path d="M12 20.4 4.9 13.3a4.6 4.6 0 0 1 6.5-6.5l.6.6.6-.6a4.6 4.6 0 0 1 6.5 6.5Z"/>',
  food: '<path d="M13.5 3.5 6.6 12h4.2l-1 8.5 7-8.5h-4.2Z"/>',
  // 音色列表（音符）
  music: '<circle cx="7" cy="17.4" r="2.6"/><circle cx="17.8" cy="15.2" r="2.6"/><path d="M9.6 17.4V6.2l10.8-2v11"/>',
  // 知识库（书）
  book: '<path d="M12 6.6C9.4 4.6 6.4 4.6 4 5.6v13c2.4-1 5.4-1 8 1 2.6-2 5.6-2 8-1v-13c-2.4-1-5.4-1-8 1Z"/><path d="M12 6.6v13"/>',
  // 夜间 / 睡眠（(>_<) 之类的夜间氛围用）
  moon: MOON,
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
  const scope = root || (typeof document === 'undefined' ? null : document);
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
