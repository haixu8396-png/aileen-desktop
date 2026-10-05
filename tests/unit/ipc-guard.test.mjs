import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeSenderGuard, isAllowedSenderUrl, normalizeUrl } = require('../../shared/ipc-guard.cjs');

const MAIN = 'file:///D:/app/dist/index.html';
const OVERLAY = 'file:///D:/app/dist/overlay.html';
const allowedUrls = () => [MAIN, OVERLAY];

describe('isAllowedSenderUrl', () => {
  it('允许我们自己的页面（含 query/hash）', () => {
    expect(isAllowedSenderUrl(MAIN, [MAIN, OVERLAY])).toBe(true);
    expect(isAllowedSenderUrl(MAIN + '?x=1#y', [MAIN, OVERLAY])).toBe(true);
    expect(isAllowedSenderUrl(OVERLAY, [MAIN, OVERLAY])).toBe(true);
  });

  it('拒绝别的页面 / 空 / about:blank', () => {
    expect(isAllowedSenderUrl('file:///D:/app/dist/evil.html', [MAIN, OVERLAY])).toBe(false);
    expect(isAllowedSenderUrl('https://example.com/', [MAIN, OVERLAY])).toBe(false);
    expect(isAllowedSenderUrl('data:text/html,<h1>x</h1>', [MAIN, OVERLAY])).toBe(false);
    expect(isAllowedSenderUrl('about:blank', [MAIN, OVERLAY])).toBe(false);
    expect(isAllowedSenderUrl('', [MAIN, OVERLAY])).toBe(false);
  });

  it('开发服务器按前缀放行，但不会顺带放行别的站点', () => {
    expect(isAllowedSenderUrl('http://127.0.0.1:5173/index.html', [], 'http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedSenderUrl('http://127.0.0.1:5173.evil.com/', [], 'http://127.0.0.1:5173')).toBe(false);
  });

  it('normalizeUrl 去掉 query/hash，非法 URL 返回空串', () => {
    expect(normalizeUrl('file:///a/b.html?x=1#h')).toBe('file:///a/b.html');
    expect(normalizeUrl('not a url')).toBe('');
  });
});

describe('makeSenderGuard', () => {
  const guardFor = (ids, urls) => makeSenderGuard({
    allowedWebContentsIds: () => ids,
    allowedUrls: () => urls,
    onReject: () => {},
  });
  const evt = (id, url, destroyed) => ({ sender: { id, getURL: () => url, isDestroyed: () => !!destroyed } });

  it('白名单内的窗口 + 自己的页面 → 放行', () => {
    expect(guardFor([1, 2], [MAIN])(evt(1, MAIN))).toBe(true);
  });

  it('未知 webContents → 拒绝', () => {
    expect(() => guardFor([1], [MAIN])(evt(9, MAIN))).toThrow(/未知的发送方/);
  });

  it('已知窗口但页面不对（被导航/注入）→ 拒绝', () => {
    expect(() => guardFor([1], [MAIN])(evt(1, 'https://evil.example/'))).toThrow(/页面来源不可信/);
  });

  it('窗口已销毁、没有窗口、发送方缺失 → 拒绝', () => {
    expect(() => guardFor([], [MAIN])(evt(1, MAIN))).toThrow(/未知的发送方/);
    expect(() => guardFor([1], [MAIN])(evt(1, MAIN, true))).toThrow(/发送方不可用/);
    expect(() => guardFor([1], [MAIN])(null)).toThrow(/发送方不可用/);
  });
});
