'use strict';
// ============================================================
// 本地静态文件服务（Live2D 模型 / 头像）
//
// 为什么需要它（不是想炫技）：
//   Live2D 的 WebAssembly 与贴图在 file:// 页面下读不了，
//   而渲染层是 file://，所以模型/头像必须经由一个本地 HTTP 服务提供。
//
// 安全边界（写在这里，改动时对照着看）：
//   · 只 bind 127.0.0.1 —— 外部网络访问不到；
//   · 只服务 models/ 与 avatars/ 两个目录，且做路径越界校验；
//   · 只允许 GET / HEAD，不设 Cookie，不开 Allow-Credentials；
//   · 非法百分号编码回 400（以前会抛 URIError 把请求挂住）。
//
// CORS 为什么是通配符：渲染层是 file://，它的 Origin 是字面量 "null"，
// 浏览器不把它当成可匹配来源，所以要让页面 fetch 到本机文件只能放开。
// 实际影响面 = 本机上任意页面可以读取你自己的模型与头像。
// **若将来渲染层改为非 file:// 来源，这里应改为来源白名单。**
// ============================================================
const fs = require('fs');
const path = require('path');
const http = require('http');

const MIME = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.moc3': 'application/octet-stream',
  '.mtn': 'application/octet-stream',
  '.tga': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/**
 * 起服务并返回 baseUrl（形如 http://127.0.0.1:34567）。
 * 端口用 0 = 让系统分配，避免与别的程序撞端口。
 *
 * @param {object} opts
 *   modelsDir   模型根目录（绝对路径）
 *   avatarsDir  头像根目录（绝对路径）
 *   log         可选日志
 * @returns {Promise<{ baseUrl: string, close: () => void, server: object }>}
 */
function startStaticServer(opts) {
  const modelsDir = path.resolve(opts.modelsDir);
  const avatarsDir = path.resolve(opts.avatarsDir);
  const log = opts.log || (() => {});

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('method not allowed');
        return;
      }

      // 非法百分号编码（例如 /models/%E0%A4%A）会让 decodeURIComponent 抛 URIError。
      // 以前这个异常直接冒到 server 层：请求挂住 + 控制台刷未捕获异常。现在明确回 400。
      let urlPath;
      try {
        urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('bad request');
        return;
      }

      let filePath = null;
      if (urlPath.startsWith('/models/')) {
        filePath = path.join(modelsDir, urlPath.slice('/models/'.length));
      } else if (urlPath.startsWith('/avatars/')) {
        filePath = path.join(avatarsDir, urlPath.slice('/avatars/'.length));
      }
      if (!filePath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }

      // 路径越界校验：normalize 之后必须真的落在那两个目录里
      const resolved = path.normalize(filePath);
      const inside = (dir) => resolved === dir || resolved.startsWith(dir + path.sep);
      if (!inside(modelsDir) && !inside(avatarsDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
        return;
      }

      fs.stat(resolved, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(resolved).pipe(res);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const baseUrl = 'http://127.0.0.1:' + server.address().port;
      log('本地静态服务已启动：' + baseUrl);
      resolve({
        baseUrl,
        server,
        close: () => { try { server.close(); } catch { /* 已关闭 */ } },
      });
    });
  });
}

module.exports = { startStaticServer, MIME };
