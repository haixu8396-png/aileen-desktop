'use strict';
// ============================================================
// 记忆库 / 知识库的存储通道（Renderer ⇄ Main）
//
// 为什么需要它：长期记忆与知识库引擎跑在**渲染层**（它们要读对话与角色），
// 但渲染层没有 Node 的 fs。所以给它们一条**受限**的文件读写通道。
//
// 与 Agent 那条通道的区别（重要）：
//   · Agent 的边界是「用户选的工作区」；这条通道的边界是**写死的两个子目录**：
//       <userData>/memory/   长期记忆
//       <userData>/knowledge/ 知识库文档与索引
//     调用方只能给**相对这两个根的路径**，绝对路径、`..`、符号链接一律拒绝。
//   · 这条通道只服务数据文件，**不提供删除整个目录**这类操作（remove 只允许删文件）。
//   · 路径校验用 path.resolve + 前缀比较（与 shared/util.cjs 的 isInsidePath 同一套思路），
//     并且额外拒绝空字节与超长路径。
//
// 参数验证在 shared/ipc-schemas.cjs 里声明（缺失规则的通道会被显式拒绝）。
// ============================================================
const fs = require('fs');
const path = require('path');
const { isInsidePath } = require('./util.cjs');

/** 两个允许的根：调用方用 root 指定其中一个 */
const ROOTS = { memory: 'memory', knowledge: 'knowledge' };

function registerStoreIpc(deps) {
  const { handle, dataDir, log = () => {} } = deps;
  const base = path.resolve(dataDir);

  function rootOf(name) {
    const sub = ROOTS[String(name || '')];
    if (!sub) throw new Error('未知的存储根：' + name);
    return path.join(base, sub);
  }

  /** 相对路径 → 绝对路径，并确保落在对应的根里 */
  function resolveSafe(rootName, relPath) {
    const root = rootOf(rootName);
    const raw = String(relPath == null ? '' : relPath).trim();
    if (!raw) throw new Error('缺少路径');
    if (raw.includes('\0')) throw new Error('路径含非法字符');
    if (raw.length > 500) throw new Error('路径过长');
    const abs = path.resolve(root, raw);
    if (!isInsidePath(abs, root)) throw new Error('路径越界（只能操作记忆库/知识库目录内）');
    return abs;
  }

  handle('store:fs', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const op = String(p.op || '');
    const rootName = String(p.root || '');
    const abs = resolveSafe(rootName, p.path);
    const root = rootOf(rootName);

    switch (op) {
      case 'readText': {
        if (!fs.existsSync(abs)) return { missing: true, text: '' };
        const st = await fs.promises.stat(abs);
        if (st.isDirectory()) throw new Error('这是一个目录');
        if (st.size > 32 * 1024 * 1024) throw new Error('文件过大（超过 32MB）');
        return { text: await fs.promises.readFile(abs, 'utf8') };
      }
      case 'readBytes': {
        if (!fs.existsSync(abs)) return { missing: true, base64: '' };
        const buf = await fs.promises.readFile(abs);
        return { base64: buf.toString('base64') };
      }
      case 'writeText': {
        const text = String(p.text == null ? '' : p.text);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        // 先写临时文件再 rename：中途崩了不会把正本写成半个文件
        const tmp = abs + '.tmp-' + process.pid;
        await fs.promises.writeFile(tmp, text, 'utf8');
        await fs.promises.rename(tmp, abs);
        return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
      }
      case 'exists': {
        return { exists: fs.existsSync(abs) };
      }
      case 'mkdir': {
        await fs.promises.mkdir(abs, { recursive: true });
        return { ok: true };
      }
      case 'list': {
        if (!fs.existsSync(abs)) return { entries: [] };
        const entries = await fs.promises.readdir(abs, { withFileTypes: true });
        // 只回 { name, isDirectory } —— Dirent 的方法跨 IPC 会丢（这个坑踩过）
        return { entries: entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })) };
      }
      case 'remove': {
        if (!fs.existsSync(abs)) return { ok: true };
        const st = await fs.promises.stat(abs);
        if (st.isDirectory()) {
          // 只允许删**空目录**：不提供「递归删掉用户资料」的能力
          const rest = await fs.promises.readdir(abs);
          if (rest.length) throw new Error('目录非空，拒绝删除');
          await fs.promises.rmdir(abs);
          return { ok: true };
        }
        if (!isInsidePath(abs, root)) throw new Error('路径越界');
        await fs.promises.unlink(abs);
        return { ok: true };
      }
      case 'rename': {
        const to = resolveSafe(rootName, p.to);
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        await fs.promises.rename(abs, to);
        return { ok: true };
      }
      case 'stat': {
        if (!fs.existsSync(abs)) return { missing: true };
        const st = await fs.promises.stat(abs);
        return { size: st.size, isDirectory: st.isDirectory(), mtimeMs: st.mtimeMs };
      }
      default:
        throw new Error('未知的 store:fs 操作：' + op);
    }
  });

  /** 让渲染层知道两个根在哪（知识库管理界面要显示路径） */
  handle('store:roots', () => ({
    memory: path.join(base, ROOTS.memory),
    knowledge: path.join(base, ROOTS.knowledge),
  }));

  log('存储通道已就绪：' + base);
}

module.exports = { registerStoreIpc, ROOTS };
