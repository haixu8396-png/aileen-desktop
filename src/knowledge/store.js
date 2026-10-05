// ============================================================
// Knowledge Base：本地存储（Local-first，JSON 文件 + 注入 fs）
//
// 为什么不用 SQLite：项目规矩是零新依赖、不许原生模块。
// 知识库规模是「个人文档」，JSON 文件完全够用，而且用户能直接看懂、
// 直接备份（和项目里其它数据一样放在 AILEEN_DATA_DIR 下）。
//
// 三条硬要求：
//   1) **原子写** —— 先写 .tmp 再 rename，断电/崩溃不会留下半个 JSON，
//      否则下次启动就是"库打不开"。
//   2) **损坏不崩** —— 任何一份文件解析失败都只记 errors 并当作空库，
//      绝不让整个知识库打不开（丢一份文档总好过应用起不来）。
//   3) **注入 fs** —— 单测塞一个内存实现就能跑，不必碰磁盘，
//      所以这一层的测试可以待在 tests/unit 里（项目约定 unit 不碰磁盘）。
//
// 注入的 fs 只需要这几个方法（都是 async）：
//   readText(p) / readBytes(p) / writeText(p, text) / exists(p) / mkdirp(p)
//   / rename(from, to) / remove(p) / list(dir)
// ============================================================

import fsp from 'node:fs/promises';

/** 存储版本：将来格式变了靠它做迁移 */
export const STORE_VERSION = 1;

export const STORE_FILE = { DOCUMENTS: 'documents.json', CHUNKS_DIR: 'chunks' };

/** Node 环境下真正落盘的 fs 适配器 */
export function createNodeFs() {
  return {
    async readText(p) {
      return await fsp.readFile(p, 'utf8');
    },
    async readBytes(p) {
      return await fsp.readFile(p);
    },
    async writeText(p, text) {
      await fsp.writeFile(p, text, 'utf8');
    },
    async exists(p) {
      try {
        await fsp.access(p);
        return true;
      } catch {
        return false;
      }
    },
    async mkdirp(p) {
      await fsp.mkdir(p, { recursive: true });
    },
    async rename(from, to) {
      await fsp.rename(from, to);
    },
    async remove(p) {
      await fsp.rm(p, { force: true, recursive: true });
    },
    async list(p) {
      try {
        return await fsp.readdir(p);
      } catch {
        return [];
      }
    },
  };
}

/** 路径拼接：不引 node:path，只处理 '/' 与反斜杠，够这个模块用 */
function join(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p, i) => (i === 0 ? String(p).replace(/[\\/]+$/, '') : String(p).replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('/');
}

export function createStore(options = {}) {
  const fs = options.fs || createNodeFs();
  const dir = String(options.dir || 'knowledge');
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const paths = {
    dir,
    documents: join(dir, STORE_FILE.DOCUMENTS),
    chunksDir: join(dir, STORE_FILE.CHUNKS_DIR),
    chunks: (id) => join(dir, STORE_FILE.CHUNKS_DIR, encodeURIComponent(String(id)) + '.json'),
  };

  /** @type {Map<string, object>} 文档索引（元数据，不含 chunk） */
  let docs = new Map();
  const errors = [];
  let initialized = false;

  function recordError(path, code, err) {
    errors.push({ path, code, message: String((err && err.message) || err || '未知错误'), at: now() });
  }

  /** 读 JSON：不存在算正常（返回 fallback），坏了记错误并返回 fallback */
  async function readJson(path, fallback) {
    if (!(await fs.exists(path))) return fallback;
    try {
      const text = await fs.readText(path);
      if (!text || !text.trim()) return fallback;
      const data = JSON.parse(text);
      return data === null || data === undefined ? fallback : data;
    } catch (err) {
      recordError(path, 'corrupt-json', err);
      return fallback;
    }
  }

  /** 原子写：先写临时文件再 rename，中途崩了也不会留半个 JSON */
  async function writeJsonAtomic(path, value) {
    const tmp = path + '.tmp';
    await fs.mkdirp(dir);
    await fs.writeText(tmp, JSON.stringify(value, null, 2));
    await fs.rename(tmp, path);
  }

  async function persistDocuments() {
    await writeJsonAtomic(paths.documents, {
      version: STORE_VERSION,
      updated_at: now(),
      documents: Object.fromEntries(docs),
    });
  }

  /** 读某个文档的 chunks；文件缺失/损坏 → 空数组 + errors */
  async function readChunksOf(id) {
    const content = await readJson(paths.chunks(String(id)), null);
    if (!content) return [];
    if (!Array.isArray(content.chunks)) {
      recordError(paths.chunks(String(id)), 'corrupt-chunks', new Error('chunks 字段不是数组'));
      return [];
    }
    return content.chunks.filter((c) => c && typeof c === 'object' && c.id);
  }

  return {
    paths,
    fs,
    dir,

    /** 初始化：建目录 + 读索引。损坏的索引 → 空库 + errors，不抛错 */
    async init() {
      if (initialized) return { documents: docs.size, errors: errors.slice() };
      await fs.mkdirp(paths.chunksDir);
      const raw = await readJson(paths.documents, { documents: {} });
      const list = raw && typeof raw.documents === 'object' && raw.documents ? raw.documents : {};
      if (raw && raw.version && raw.version > STORE_VERSION) {
        recordError(paths.documents, 'newer-version', new Error('存储版本 ' + raw.version + ' 高于当前支持的 ' + STORE_VERSION));
      }
      docs = new Map(Object.entries(list).filter(([, v]) => v && typeof v === 'object' && v.id));
      initialized = true;
      return { documents: docs.size, errors: errors.slice() };
    },

    documents() {
      return [...docs.values()];
    },

    getDocument(id) {
      const doc = docs.get(String(id));
      return doc ? Object.assign({}, doc) : null;
    },

    async upsertDocument(doc) {
      if (!doc || !doc.id) throw new Error('upsertDocument 需要带 id 的文档对象');
      docs.set(String(doc.id), Object.assign({}, doc));
      await persistDocuments();
      return Object.assign({}, docs.get(String(doc.id)));
    },

    /** 删文档：索引 + 它的 chunk 文件一起删（孤儿 chunk 是很多 bug 的源头） */
    async deleteDocument(id) {
      const key = String(id);
      const existed = docs.delete(key);
      await fs.remove(paths.chunks(key));
      await persistDocuments();
      return existed;
    },

    /** 写文档正文与 chunks（重索引/更新时整体替换，不做增量拼接） */
    async saveContent(id, payload) {
      const key = String(id);
      await fs.mkdirp(paths.chunksDir);
      await writeJsonAtomic(paths.chunks(key), Object.assign({ version: STORE_VERSION, updated_at: now() }, payload, { document_id: key }));
    },

    async readContent(id) {
      return await readJson(paths.chunks(String(id)), null);
    },

    async removeContent(id) {
      await fs.remove(paths.chunks(String(id)));
    },

    /** 读某个文档的 chunks；文件缺失/损坏 → 空数组 + errors */
    async readChunks(id) {
      return await readChunksOf(id);
    },

    /** 遍历全部 chunk（检索用；engine 会自己缓存一份） */
    async iterChunks() {
      const out = [];
      for (const doc of docs.values()) {
        const chunks = await readChunksOf(doc.id);
        for (const c of chunks) out.push(c);
      }
      return out;
    },

    status() {
      return {
        dir,
        documents: docs.size,
        errors: errors.slice(),
      };
    },

    errors() {
      return errors.slice();
    },

    clearErrors() {
      errors.length = 0;
    },
  };
}
