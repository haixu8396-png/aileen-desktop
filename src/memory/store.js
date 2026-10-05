// ============================================================
// Store：本地优先的记忆存储（JSON 文件 + 注入的文件系统）
//
// 为什么是 JSON 文件而不是 SQLite：
//   · SQLite 是**原生依赖**（better-sqlite3 要编译），项目规矩是零新增原生模块；
//   · 记忆条的规模是「几百到几千」，一次性载入内存后纯 JS 排序完全够用，
//     没有需要索引才能扛住的查询。
// 代价：全量读写。所以写入必须**原子**（写临时文件再 rename），
// 否则断电/崩溃时留下半个 JSON，下次启动就把整个记忆库读崩了。
//
// 另外两条硬要求：
//   1) **文件系统注入** —— 单测用内存实现，绝不碰磁盘；真机接 node:fs。
//   2) **损坏不许炸** —— 读到坏文件时返回空库 + 记下原因（lastError），
//      应用照常启动，用户还能继续聊（这也符合「数据私有、不因为一个文件毁掉整个应用」）。
// ============================================================
import fsp from 'node:fs/promises';
import { normalizeRecord, contentFingerprint } from './types.js';

/** 存储文件格式版本：将来改结构时用来做迁移判据 */
export const STORE_VERSION = 1;

/** JSON 文件名（放在 AILEEN_DATA_DIR 下） */
export const MEMORY_FILE_NAME = 'memory.json';

/** 写盘用的临时后缀：rename 是原子操作，崩在写临时文件这一步不影响正本 */
export const TEMP_SUFFIX = '.tmp';

/** 过滤条件规范化：拿不准的输入不要变成「什么都匹配」或「什么都过滤掉」 */
function normalizeFilterOptions(options = {}) {
  const statuses = options.statuses
    ? (Array.isArray(options.statuses) ? options.statuses : [options.statuses])
    : null;
  const types = options.types
    ? (Array.isArray(options.types) ? options.types : [options.types])
    : null;
  return {
    statuses: statuses ? statuses.map((s) => String(s)) : null,
    types: types ? types.map((s) => String(s)) : null,
    since: Number.isFinite(options.since) ? options.since : null,
    until: Number.isFinite(options.until) ? options.until : null,
  };
}

/** 按条件过滤记录（纯函数，store 与 retriever 共用同一口径） */
export function filterRecords(records, options = {}) {
  const f = normalizeFilterOptions(options);
  return (Array.isArray(records) ? records : []).filter((rec) => {
    if (!rec) return false;
    if (f.statuses && !f.statuses.includes(rec.status)) return false;
    if (f.types && !f.types.includes(rec.type)) return false;
    if (f.since != null && rec.updated_at < f.since) return false;
    if (f.until != null && rec.updated_at > f.until) return false;
    return true;
  });
}

/**
 * 内存文件系统（单测用；也是「注入 fs」这件事的参考实现）。
 * 只实现 store 真正会用到的那几个方法，接口小到不可能实现错。
 */
export function createMemoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  const log = [];
  return {
    files,
    log,
    async readFile(path) {
      log.push({ op: 'readFile', path });
      if (!files.has(path)) {
        const err = new Error('ENOENT: ' + path);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(path);
    },
    async writeFile(path, data) {
      log.push({ op: 'writeFile', path });
      files.set(path, String(data));
    },
    async mkdir(path) {
      log.push({ op: 'mkdir', path });
      dirs.add(path);
    },
    async rename(from, to) {
      log.push({ op: 'rename', from, to });
      if (!files.has(from)) {
        const err = new Error('ENOENT: ' + from);
        err.code = 'ENOENT';
        throw err;
      }
      files.set(to, files.get(from));
      files.delete(from);
    },
    async exists(path) {
      return files.has(path) || dirs.has(path);
    },
    dirs,
  };
}

/** store 需要的最小 fs 接口（方法名与 node:fs/promises 一致，便于直接传） */
const FS_METHODS = ['readFile', 'writeFile', 'mkdir', 'rename', 'exists'];

/**
 * 建一个 store。
 *
 * @param {object} opts
 *   fs        注入的文件系统（必须实现 FS_METHODS）
 *   filePath  记忆文件路径（也可在 load/save 时给）
 * @returns {object} store
 */
export function createStore(opts = {}) {
  const fs = opts.fs;
  if (!fs || typeof fs !== 'object') throw new Error('createStore 需要注入 fs 接口');
  for (const m of FS_METHODS) {
    if (typeof fs[m] !== 'function') throw new Error('fs 接口缺少方法：' + m);
  }

  let filePath = opts.filePath || null;
  let records = [];
  let loaded = false;
  let lastError = null;

  /** 目录从文件路径推：store 只关心「路径的父目录」 */
  function dirOf(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : '';
  }

  const store = {
    /** 当前文件路径（engine 可能延后设置） */
    get filePath() { return filePath; },
    setFilePath(p) { filePath = p; return store; },

    /**
     * 载入。**不抛错**：坏文件 → 空库 + lastError。
     * @returns {{ records:Array, corrupted:boolean, created:boolean, error:string|null }}
     */
    async load(path) {
      if (path) filePath = path;
      if (!filePath) throw new Error('load 需要 filePath');
      lastError = null;
      loaded = true;

      let text = null;
      try {
        text = await fs.readFile(filePath, 'utf8');
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          // 首次运行：没有文件是**正常**的，不是错误
          records = [];
          return { records: [], corrupted: false, created: false, error: null };
        }
        lastError = '读取记忆文件失败：' + String((err && err.message) || err);
        records = [];
        return { records: [], corrupted: true, created: false, error: lastError };
      }

      const raw = String(text == null ? '' : text).trim();
      if (!raw) {
        records = [];
        return { records: [], corrupted: false, created: false, error: null };
      }

      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        lastError = '记忆文件不是合法 JSON，已按空库启动（原文件保留）：' + String((err && err.message) || err);
        records = [];
        return { records: [], corrupted: true, created: false, error: lastError };
      }

      const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.records) ? parsed.records : null);
      if (!list) {
        lastError = '记忆文件结构不对（既不是数组也没有 records 字段），已按空库启动';
        records = [];
        return { records: [], corrupted: true, created: false, error: lastError };
      }

      const now = Date.now();
      const out = [];
      let dropped = 0;
      for (const item of list) {
        const rec = normalizeRecord(item || {}, now);
        if (!rec.id || !rec.content) { dropped += 1; continue; }
        out.push(rec);
      }
      if (dropped) lastError = '有 ' + dropped + ' 条记忆缺 id/content，已跳过';
      records = out;
      return { records: out, corrupted: false, created: false, error: lastError };
    },

    /** 原子写：临时文件 → rename。失败时不改变内存里的 records，也不留半个文件。 */
    async save(path) {
      if (path) filePath = path;
      if (!filePath) throw new Error('save 需要 filePath');
      const dir = dirOf(filePath);
      if (dir && typeof fs.mkdir === 'function') await fs.mkdir(dir, { recursive: true });
      const payload = JSON.stringify({
        version: STORE_VERSION,
        updated_at: Date.now(),
        count: records.length,
        records,
      }, null, 2);
      const tmp = filePath + TEMP_SUFFIX;
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, filePath);
      return { path: filePath, count: records.length, bytes: payload.length };
    },

    /**
     * 写入/更新一条记录。
     * 判据顺序：**id 命中** → 覆盖；否则 **内容指纹相同** → 覆盖（同一句话重复写不产生第二条）。
     */
    upsert(record) {
      const rec = normalizeRecord(record, Date.now());
      if (!rec.id) throw new Error('upsert 需要 id');
      const idx = records.findIndex((r) => r.id === rec.id);
      if (idx >= 0) {
        // 保留原 created_at：这条记忆「什么时候第一次出现」不该被覆盖写改掉
        rec.created_at = records[idx].created_at;
        records[idx] = rec;
        return { record: rec, inserted: false };
      }
      const fp = contentFingerprint(rec.content);
      const same = records.findIndex((r) => contentFingerprint(r.content) === fp && r.status !== 'deleted');
      if (same >= 0 && fp) {
        rec.id = records[same].id;
        rec.created_at = records[same].created_at;
        records[same] = rec;
        return { record: rec, inserted: false };
      }
      records.push(rec);
      return { record: rec, inserted: true };
    },

    /** 批量写入（load 之后的整体替换/补充） */
    upsertMany(list) {
      const out = [];
      for (const item of list || []) out.push(store.upsert(item));
      return out;
    },

    getById(id) {
      return records.find((r) => r.id === String(id)) || null;
    },

    /** 全部记录（默认给副本，避免调用方直接改内部数组） */
    all(options = {}) {
      const hasFilter = !!(options && (options.statuses || options.types || options.since != null || options.until != null));
      return hasFilter ? filterRecords(records, options) : records.slice();
    },

    /** 真正的内部数组（engine 内部用；外部请用 all()） */
    raw() { return records; },

    byType(type) { return filterRecords(records, { types: [type] }); },
    byStatus(status) { return filterRecords(records, { statuses: [status] }); },

    /** 直接替换记录（consolidation 改状态时用；替换后由调用方决定何时 save） */
    replace(id, next) {
      const idx = records.findIndex((r) => r.id === String(id));
      if (idx < 0) return null;
      const rec = normalizeRecord(Object.assign({}, records[idx], next), Date.now());
      rec.created_at = records[idx].created_at;
      records[idx] = rec;
      return rec;
    },

    remove(id) {
      const idx = records.findIndex((r) => r.id === String(id));
      if (idx < 0) return false;
      records.splice(idx, 1);
      return true;
    },

    size() { return records.length; },
    isLoaded() { return loaded; },
    lastError() { return lastError; },
    /** 计数：给 stats() 用，按状态/类型分组 */
    counts() {
      const byStatus = {};
      const byType = {};
      for (const rec of records) {
        byStatus[rec.status] = (byStatus[rec.status] || 0) + 1;
        byType[rec.type] = (byType[rec.type] || 0) + 1;
      }
      return { total: records.length, byStatus, byType };
    },
  };

  return store;
}

/**
 * 真机用的 node:fs 适配器。
 *
 * 静态 import `node:fs/promises` 而不是 createRequire：渲染层里 Vite 会把它换成
 * 一个空 stub（只在这个函数被调用时才炸），加载期完全安全；而这一层本来就该由
 * `memory-host` 注入桥接实现，真机直接跑 Node 时才轮到它。
 */
export function createNodeFs() {
  return {
    readFile: (p, enc) => fsp.readFile(p, enc || 'utf8'),
    writeFile: (p, data, enc) => fsp.writeFile(p, data, enc || 'utf8'),
    mkdir: (p, o) => fsp.mkdir(p, o || { recursive: true }),
    rename: (a, b) => fsp.rename(a, b),
    async exists(p) {
      try { await fsp.access(p); return true; } catch { return false; }
    },
  };
}
