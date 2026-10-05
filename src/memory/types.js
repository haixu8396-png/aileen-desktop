// ============================================================
// Memory 数据模型：常量 + schema + 校验/规范化
//
// 与 Chat History 的分工（这是整个模块的立意，不能混）：
//   · History 回答「发生过什么」—— 全量、只追加、会压缩、可以丢。
//   · Memory  回答「什么值得长期记住」—— 稀疏、会被改写/合并/作废、
//     但**不能悄悄消失**（冲突要把旧记录置 superseded，而不是删掉）。
//
// 这一层只做「形状」的事：字段有哪些、取值域是什么、缺字段怎么补、
// 非法值怎么收敛。任何带业务判断的逻辑都不放在这里。
// ============================================================

/** 记忆类型：事实 / 偏好 / 经历 / 关系 / 知识 */
export const MEMORY_TYPES = ['user_fact', 'preference', 'experience', 'relationship', 'knowledge'];

/** 记忆状态：生效 / 被取代 / 归档 / 已删除（全部是软状态，行永远留在库里） */
export const MEMORY_STATUS = ['active', 'superseded', 'archived', 'deleted'];

/**
 * 一条记忆的字段清单。
 * 前 11 个是需求规定的最小 schema，后面几个是「可追溯性」需要的：
 * 没有它们，冲突/合并之后就说不清「这条记忆是哪来的、被谁取代了」。
 */
export const MEMORY_FIELDS = [
  'id', 'content', 'type', 'importance', 'confidence',
  'created_at', 'updated_at', 'last_retrieved_at',
  'source', 'status', 'embedding',
  // —— 以下为可追溯字段（合并/冲突用）
  'supersedes', 'supersededBy', 'mergedFrom', 'relations',
];

/** 缺省值：只在这里写一次，避免各处各写一份 */
export const MEMORY_DEFAULTS = {
  type: 'user_fact',
  importance: 0.5,
  confidence: 0.6,
  status: 'active',
  source: 'conversation',
  embedding: [],
  supersedes: null,
  supersededBy: null,
  mergedFrom: [],
  relations: [],
};

/** 内容长度上限：记忆是摘要不是原文，太长说明提取器串了段 */
export const MAX_CONTENT_CHARS = 1000;

/**
 * 稳定可读的 id：`mem-<时间戳36进制>-<序号36进制>-<随机>`。
 * 为什么不用 uuid：出问题时肉眼就能看出「大概是哪个时间点、第几条写的」，
 * 而且不引入任何依赖（Node 内置 crypto 也不必）。
 */
let idSeq = 0;
export function createMemoryId(now = Date.now()) {
  idSeq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return 'mem-' + now.toString(36) + '-' + idSeq.toString(36) + '-' + rand;
}

/** 0~1 收敛；非数字给 fallback。布尔不当作数字（true 会变成 1，那是假的精度） */
export function clamp01(value, fallback = 0) {
  if (typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** 合法类型否则回落到 user_fact —— 宁可记成泛泛的事实，也不要写进一个不存在的类型 */
export function normalizeType(type) {
  const s = String(type == null ? '' : type).trim();
  return MEMORY_TYPES.includes(s) ? s : MEMORY_DEFAULTS.type;
}

/** 非法状态一律按 deleted 处理：宁可搜不到，也不要让脏数据混进检索 */
export function normalizeStatus(status) {
  const s = String(status == null ? '' : status).trim();
  return MEMORY_STATUS.includes(s) ? s : 'deleted';
}

/** 时间戳：数字就用，能被 Date 解析的字符串转成数字，否则用 fallback */
export function normalizeTime(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const n = value.getTime();
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Date.parse(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** 向量规范化：只收有限数字，NaN/Infinity 一律变 0（否则 cosine 会整条变 NaN） */
export function normalizeEmbedding(embedding) {
  if (!Array.isArray(embedding)) return [];
  const out = [];
  for (const n of embedding) {
    const v = Number(n);
    out.push(Number.isFinite(v) ? v : 0);
  }
  return out;
}

/** 纯文本归一：用于指纹比较（大小写/空白/全半角标点差异不算不同） */
export function normalizeContent(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。！？、；：""''（）【】,.!?;:()[\]{}"'`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 内容指纹：同一句话重复写入时不产生第二条记忆的判据之一。
 * 用归一化后的文本本身（不哈希），因为指纹要在测试输出里肉眼可比。
 */
export function contentFingerprint(text) {
  return normalizeContent(text);
}

/**
 * 规范化一条记忆：补齐缺省字段 + 收敛非法值。
 * **不生成 id**（id 由写入方给，便于测试固定 id）。
 */
export function normalizeRecord(raw = {}, now = Date.now()) {
  const created = normalizeTime(raw.created_at, now);
  const content = String(raw.content == null ? '' : raw.content).trim().slice(0, MAX_CONTENT_CHARS);
  return {
    id: String(raw.id == null ? '' : raw.id),
    content,
    type: normalizeType(raw.type),
    importance: clamp01(raw.importance, MEMORY_DEFAULTS.importance),
    confidence: clamp01(raw.confidence, MEMORY_DEFAULTS.confidence),
    created_at: created,
    updated_at: normalizeTime(raw.updated_at, created),
    last_retrieved_at: raw.last_retrieved_at == null ? null : normalizeTime(raw.last_retrieved_at, created),
    source: String(raw.source == null ? MEMORY_DEFAULTS.source : raw.source).slice(0, 200),
    status: normalizeStatus(raw.status),
    embedding: normalizeEmbedding(raw.embedding),
    supersedes: raw.supersedes ? String(raw.supersedes) : null,
    supersededBy: raw.supersededBy ? String(raw.supersededBy) : null,
    mergedFrom: Array.isArray(raw.mergedFrom) ? raw.mergedFrom.map((x) => String(x)) : [],
    relations: Array.isArray(raw.relations) ? Array.from(new Set(raw.relations.map((x) => String(x)))) : [],
  };
}

/** 校验：给出问题清单而不是抛错 —— 入库时我们更想「修好并记录」而不是炸掉对话 */
export function validateRecord(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['记录不是对象'] };
  if (!String(raw.id || '').trim()) errors.push('缺少 id');
  if (!String(raw.content || '').trim()) errors.push('缺少 content');
  if (!MEMORY_TYPES.includes(raw.type)) errors.push('非法 type：' + raw.type);
  if (!MEMORY_STATUS.includes(raw.status)) errors.push('非法 status：' + raw.status);
  if (!Number.isFinite(Number(raw.importance))) errors.push('importance 不是数字');
  if (!Number.isFinite(Number(raw.confidence))) errors.push('confidence 不是数字');
  if (!Array.isArray(raw.embedding)) errors.push('embedding 不是数组');
  return { ok: errors.length === 0, errors };
}

/** 新建一条记忆对象（候选 → 记录）；embedding 由 engine 填 */
export function makeRecord(input = {}, now = Date.now()) {
  return normalizeRecord({
    id: input.id || createMemoryId(now),
    content: input.content,
    type: input.type,
    importance: input.importance,
    confidence: input.confidence,
    created_at: now,
    updated_at: now,
    last_retrieved_at: null,
    source: input.source,
    status: 'active',
    embedding: input.embedding || [],
    relations: input.relations || [],
  }, now);
}

/** 脱敏用的轻量裁剪：给界面/日志看的摘要，不带 embedding（那玩意几百个数） */
export function toSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    content: record.content,
    type: record.type,
    status: record.status,
    importance: record.importance,
    confidence: record.confidence,
    created_at: record.created_at,
    updated_at: record.updated_at,
    last_retrieved_at: record.last_retrieved_at,
    source: record.source,
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
    mergedFrom: record.mergedFrom,
    relations: record.relations,
  };
}
