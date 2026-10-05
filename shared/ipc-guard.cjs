'use strict';
// ============================================================
// IPC 发送方鉴权
//
// 背景：渲染层能调用的 IPC 里有不少高权限操作（写文件、删模型、截屏、
// 打开路径、改设置、发网络请求…）。如果不校验「这个请求是谁发来的」，
// 那么任何一个能在我们的窗口里执行脚本的东西（比如被注入的 iframe、
// 或者将来不小心加载进来的第三方页面）都能直接调用这些接口。
//
// 这里只做两件事，都是纯函数，方便单测：
//   1) 发送方必须是我们的窗口之一（由调用方给出 webContents id 白名单）；
//   2) 页面 URL 必须是我们自己的页面（打包后的 dist 页面，或开发服务器）。
// ============================================================

/** 去掉 hash / query，便于比较 */
function normalizeUrl(u) {
  try {
    const x = new URL(String(u));
    x.hash = '';
    x.search = '';
    return x.toString();
  } catch {
    return '';
  }
}

/**
 * 页面 URL 是否被允许。
 * @param {string} url            发送方页面 URL
 * @param {string[]} allowedUrls  允许的完整 URL（file:// 打包页面）
 * @param {string} devUrl         开发服务器地址（可选）
 */
function isAllowedSenderUrl(url, allowedUrls, devUrl) {
  const raw = String(url || '');
  if (!raw || raw === 'about:blank') return false;
  const norm = normalizeUrl(raw);
  if (!norm) return false;
  for (const a of (Array.isArray(allowedUrls) ? allowedUrls : [])) {
    if (a && normalizeUrl(a) === norm) return true;
  }
  if (devUrl) {
    const base = normalizeUrl(devUrl);
    if (base && norm.startsWith(base)) return true;
  }
  return false;
}

/**
 * 造一个 assertTrustedSender(event)。
 * @param {object} opts
 * @param {() => number[]} opts.allowedWebContentsIds 当前允许的 webContents id
 * @param {() => string[]} opts.allowedUrls           允许的页面 URL
 * @param {() => string}   [opts.devUrl]              开发服务器地址
 * @param {(msg: string) => void} [opts.onReject]     被拒时的日志钩子
 */
function makeSenderGuard(opts) {
  const cfg = opts || {};
  const ids = typeof cfg.allowedWebContentsIds === 'function' ? cfg.allowedWebContentsIds : () => [];
  const urls = typeof cfg.allowedUrls === 'function' ? cfg.allowedUrls : () => [];
  const devUrlOf = typeof cfg.devUrl === 'function' ? cfg.devUrl : () => cfg.devUrl;
  const onReject = typeof cfg.onReject === 'function' ? cfg.onReject : () => {};

  return function assertTrustedSender(event) {
    const sender = event && event.sender;
    if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
      onReject('sender missing or destroyed');
      throw new Error('IPC 拒绝：发送方不可用');
    }
    const allowed = ids() || [];
    if (allowed.length === 0 || !allowed.includes(sender.id)) {
      onReject('untrusted webContents id=' + sender.id);
      throw new Error('IPC 拒绝：未知的发送方');
    }
    let url = '';
    try { url = sender.getURL ? sender.getURL() : ''; } catch { url = ''; }
    if (!isAllowedSenderUrl(url, urls(), devUrlOf())) {
      onReject('untrusted page url=' + url);
      throw new Error('IPC 拒绝：页面来源不可信');
    }
    return true;
  };
}

module.exports = { makeSenderGuard, isAllowedSenderUrl, normalizeUrl };
