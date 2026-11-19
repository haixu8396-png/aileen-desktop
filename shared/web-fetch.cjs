'use strict';
// ============================================================
// 网页抓取（主进程，唯一出口）
//
// 为什么需要它：R6 要求「模型原生联网」，但**没有原生能力时也不能伪造**。
// 能做的最起码一件真事是：用户/模型给一个 URL，我们真的去读它，并把
// 标题、正文摘录、抓取时间一起带回对话 —— 让「查了没有」有据可查。
//
// 三条安全边界（网页内容永远是**不可信数据**）：
//   1) 只允许 http/https；端口只允许默认端口或 80/443
//   2) DNS 解析后拒绝私网/回环/链路本地/保留地址（防 SSRF），重定向逐跳再查
//   3) 大小、超时、内容类型都设上限；正文里的 <script>/<style> 一律剥掉
// ============================================================

const MAX_BYTES = 300 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

/** 内网/回环/保留地址判断（IPv4 + IPv6 常见段） */
function isPrivateAddress(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return true;
  if (s === '::1' || s === '::' || s === '0.0.0.0') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;          // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true;         // fe80::/10 链路本地
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;                                   // 非 IPv4 字面量：交给 dns 层判断
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;                // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT
  if (a >= 224) return true;                              // 组播/保留
  return false;
}

function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error('不是合法的 URL：' + String(raw || '').slice(0, 120));
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只允许 http/https 链接');
  if (u.username || u.password) throw new Error('链接里不允许带用户名/密码');
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (![80, 443].includes(port)) throw new Error('只允许 80/443 端口（收到 ' + port + '）');
  u.hash = '';
  return u;
}

/** 从 HTML 里抽标题与可读正文（零依赖，够用于「读一眼」） */
function extractReadable(html, contentType) {
  const raw = String(html || '');
  if (/json/.test(String(contentType || ''))) {
    return { title: '', text: raw.slice(0, 20000) };
  }
  if (!/html|xml/.test(String(contentType || '')) && raw.indexOf('<') < 0) {
    return { title: '', text: raw.replace(/\s+/g, ' ').trim().slice(0, 20000) };
  }
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  const body = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|hr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 20000);
  return { title, text };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * 抓一个 URL。
 * @param {object} p { url, timeoutMs, maxBytes, fetchImpl, lookup }
 * @returns {Promise<{url,finalUrl,status,title,text,contentType,bytes,fetchedAt}>}
 */
async function fetchUrl(p = {}) {
  const fetchImpl = typeof p.fetchImpl === 'function' ? p.fetchImpl : fetch;
  const lookup = typeof p.lookup === 'function' ? p.lookup : null;
  const timeoutMs = Math.max(1000, Math.min(60000, Number(p.timeoutMs) || TIMEOUT_MS));
  const maxBytes = Math.max(1024, Math.min(MAX_BYTES, Number(p.maxBytes) || MAX_BYTES));

  let target = normalizeUrl(p.url);
  let hops = 0;
  let res = null;
  for (;;) {
    // 每一跳都重新做 DNS 检查（防「公网域名 → 私网 IP」与重定向绕过）
    if (typeof lookup === 'function') {
      const host = target.hostname.replace(/^\[|\]$/g, '');
      const addr = await lookup(host);
      const list = Array.isArray(addr) ? addr : (addr && addr.address ? [addr.address] : []);
      if (!list.length) throw new Error('域名解析失败：' + host);
      for (const a of list) {
        if (isPrivateAddress(a)) throw new Error('拒绝访问内网地址（' + host + ' → ' + a + '）');
      }
    } else if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(target.hostname)) {
      throw new Error('拒绝访问内网地址：' + target.hostname);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      res = await fetchImpl(target.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'AILEEN/0.7.9 (+local desktop companion)',
          Accept: 'text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1',
        },
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        throw new Error('抓取超时（' + timeoutMs + 'ms）');
      }
      throw new Error('抓取失败：' + String((err && err.message) || err));
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      hops += 1;
      if (hops > MAX_REDIRECTS) throw new Error('重定向次数过多');
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : '';
      if (!loc) throw new Error('重定向缺少 Location');
      target = normalizeUrl(new URL(loc, target).toString());
      continue;
    }
    break;
  }

  if (!res.ok) {
    throw new Error('HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : ''));
  }
  const contentType = (res.headers && typeof res.headers.get === 'function')
    ? String(res.headers.get('content-type') || '')
    : '';
  if (contentType && !/text|json|xml|html|xhtml|plain/i.test(contentType)) {
    throw new Error('不支持的内容类型：' + contentType.slice(0, 60));
  }

  let body = '';
  let bytes = 0;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      body += decoder.decode(chunk.value, { stream: true });
      if (bytes >= maxBytes) break;
    }
    body += decoder.decode();
  } else {
    body = String(await res.text());
    bytes = Buffer.byteLength(body, 'utf8');
  }
  const truncated = bytes >= maxBytes;
  if (bytes > maxBytes) {
    body = body.slice(0, maxBytes);
    bytes = maxBytes;
  }

  const readable = extractReadable(body, contentType);
  return {
    url: String(p.url),
    finalUrl: target.toString(),
    status: res.status,
    title: readable.title,
    text: readable.text,
    contentType,
    bytes,
    truncated,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  fetchUrl, isPrivateAddress, normalizeUrl, extractReadable, decodeEntities,
  MAX_BYTES, TIMEOUT_MS, MAX_REDIRECTS,
};
