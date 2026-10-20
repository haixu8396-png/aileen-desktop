// ============================================================
// Agent 检查点存储（主进程侧，落盘）
//
// 为什么放在主进程：渲染层没有 Node fs；而且检查点里可能有工作区路径之类的本机信息，
// 统一写在 `<userData>/agent/checkpoint.json` 一个文件里更好管（也方便用户手动删）。
//
// 三条要求：
//   1) **只有一个「最近一次」**：每存一次覆盖旧的。断点续跑只续最近一次，不做任务队列。
//   2) **原子写**：先写 .tmp 再 rename，断电不会留下半个 JSON。
//   3) **坏了不炸**：解析失败就当没有检查点（返回 null）并留下原因，应用照常启动。
// ============================================================
const fsDefault = require('node:fs');
const pathDefault = require('node:path');

const MAX_BYTES = 256 * 1024;

function createCheckpointStore(opts = {}) {
  const fs = opts.fs || fsDefault;
  const file = opts.file;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!file) throw new Error('checkpoint store 需要 file 路径');

  function tmpFile() { return file + '.tmp'; }

  /** 保存（覆盖）。数据太大/不是对象就拒绝，绝不写坏文件。 */
  function save(data) {
    if (!data || typeof data !== 'object') return { ok: false, error: '不是对象' };
    let text;
    try {
      text = JSON.stringify(data, null, 2);
    } catch (err) {
      return { ok: false, error: '序列化失败：' + String((err && err.message) || err) };
    }
    if (text.length > MAX_BYTES) return { ok: false, error: '检查点太大（' + text.length + ' 字节）' };
    try {
      const dir = pathDefault.dirname(file);
      if (typeof fs.mkdirSync === 'function') fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpFile(), text, 'utf8');
      fs.renameSync(tmpFile(), file);
      return { ok: true };
    } catch (err) {
      const message = String((err && err.message) || err);
      log('检查点写入失败：' + message);
      try { fs.unlinkSync(tmpFile()); } catch (e) { /* 清理失败也无所谓 */ }
      return { ok: false, error: message };
    }
  }

  /** 读取。没有文件返回 null；文件坏了返回 null + 原因（不抛）。 */
  function load() {
    try {
      if (!fs.existsSync(file)) return null;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw || !String(raw).trim()) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (err) {
      log('检查点读取失败（当作没有）：' + String((err && err.message) || err));
      return null;
    }
  }

  function clear() {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return true;
    } catch (err) {
      log('检查点删除失败：' + String((err && err.message) || err));
      return false;
    }
  }

  return { file, save, load, clear, maxBytes: MAX_BYTES };
}

module.exports = { createCheckpointStore, MAX_BYTES };
