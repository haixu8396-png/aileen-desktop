// ============================================================
// 人设自动生成
//
// 让模型从「一句话灵感」长出一整张角色卡。
//
// 真正麻烦的不是提示词，是**解析**：模型几乎不会老老实实只回一个 JSON ——
// 常见的有：裹在 ```json 围栏里、前面加一段「好的，这是你的角色：」、
// 少给几个字段、把某字段写成数组或数字。所以这里不 JSON.parse 一把梭，
// 而是先剥围栏、再按大括号配平截取第一个对象（字符串里的括号要跳过），
// 然后逐字段类型校验 + 截断。
// ============================================================
import { t, getLang } from './i18n.js';
import { PERSONALITIES, ROLES, GENDERS, RELATIONSHIPS, findArchetype, labelOf, specOf } from './archetypes.js';
import { streamChat } from './llm.js';
import { normalizePersonaV2 } from './persona-v2.js';

export const PERSONA_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];

// 字段长度上限，防止模型灌一篇小作文进角色卡
// personality 现在要求写 500~1000 字的完整提示词，上限必须跟着放宽，
// 否则好不容易写出来的东西会被我们自己的截断毁掉（而这正是「乱写」的另一种形态）。
const MAX_LEN = { name: 40, description: 120, personality: 2500, scenario: 800, first_mes: 800, mes_example: 2000 };

const LANG_NAME = { en: 'English', ja: '日本語', zh: '简体中文' };

/** 灵感留空时，从当前语言的候选里随机挑一个，保证每次生成的东西不重样 */
export function randomHint() {
  const raw = String(t('persona.hints') || '');
  const list = raw.split('|').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return 'an original character';
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 把「原型 + 锁定」写成给模型的约束块。
 *
 * 锁定的原型走硬约束口径（每一句台词都要能验证，偏离算失败），
 * 没锁的走参考口径（可以借鉴也可以另走一路）—— 两句话术完全不同，
 * 不是同一个模板换个词。
 */
function constraintBlock(opts, lang) {
  const p = findArchetype(PERSONALITIES, opts.personalityId);
  const r = findArchetype(ROLES, opts.roleId);
  const hard = [];
  const soft = [];

  // 「已有角色」模式：不是自由创作，而是回忆 + 整理。要求忠实，并且**允许它说不认识** ——
  // 不认识却说认识，出来的一定是一张套着名字的通用卡，那比失败更糟。
  if (opts.mode === 'known') {
    const charName = String(opts.charName || '').trim();
    const work = String(opts.work || '').trim();
    const strict = opts.fidelity !== 'loose';
    if (charName) hard.push(t('persona.knownChar', { v: charName }));
    if (work) hard.push(t('persona.knownWork', { v: work }));
    hard.push(t('persona.knownFidelity', { v: strict ? t('persona.knownStrict') : t('persona.knownLoose') }));
    hard.push(t('persona.knownRule'));
    hard.push(t('persona.knownUnknown'));
    const parts0 = t('persona.knownHeader') + '\n' + hard.join('\n');
    const relLines0 = relationshipLines(opts, lang);
    return relLines0.length
      ? parts0 + '\n\n' + t('persona.relHeader') + '\n' + relLines0.join('\n')
      : parts0;
  }

  if (p) {
    const line = t('persona.linePersonality', { v: labelOf(p, lang) + ' —— ' + specOf(p, lang) });
    (opts.lockPersonality === false ? soft : hard).push(line);
  }
  if (r) {
    const line = t('persona.lineRole', { v: labelOf(r, lang) + ' —— ' + specOf(r, lang) });
    (opts.lockRole === false ? soft : hard).push(line);
  }
  const parts = [];
  if (hard.length) parts.push(t('persona.lockHeader') + '\n' + hard.join('\n') + '\n' + t('persona.lockRule'));
  if (soft.length) parts.push(t('persona.softHeader') + '\n' + soft.join('\n') + '\n' + t('persona.softRule'));
  // 对话者的身份是硬约束：同一句台词，「恋人」和「刚认识的人」说出来的样子完全不同
  const relLines = relationshipLines(opts, lang);
  if (relLines.length) parts.push(t('persona.relHeader') + '\n' + relLines.join('\n') + '\n' + t('persona.relRule'));
  return parts.join('\n\n');
}

/** 对话者（用户）在这段关系里是谁 */
function relationshipLines(opts, lang) {
  const out = [];
  const rel = findArchetype(RELATIONSHIPS, opts.relationId);
  if (rel && rel.id !== 'any') out.push(t('persona.relLine', { v: labelOf(rel, lang) + ' —— ' + specOf(rel, lang) }));
  const who = String(opts.userName || '').trim();
  if (who) out.push(t('persona.relName', { v: who }));
  return out;
}

/** 名字/性别/年龄/其它要求 —— 用户明确写了的，就必须照做 */
function requirementLines(opts, lang) {
  const out = [];
  const name = String(opts.name || '').trim();
  if (name) out.push(t('persona.reqName', { v: name }));
  const g = findArchetype(GENDERS, opts.genderId);
  if (g && g.id !== 'any') out.push(t('persona.reqGender', { v: labelOf(g, lang) }));
  const age = String(opts.age || '').trim();
  if (age) out.push(t('persona.reqAge', { v: age }));
  const extra = String(opts.extra || '').trim();
  if (extra) out.push(t('persona.reqExtra', { v: extra }));
  return out;
}

/**
 * 发给模型的消息。
 * 可以只传一句灵感（字符串，老用法），也可以传完整的 { seed, personalityId, roleId, lock*, name, genderId, age, extra }。
 * seed 为空则随机挑一个灵感。
 */
export function buildPersonaMessages(input) {
  const opts = typeof input === 'string' ? { seed: input } : (input || {});
  const lang = getLang();
  const langName = LANG_NAME[lang] || 'English';

  const known = opts.mode === 'known';
  // 关键：两种模式的「底稿」必须不同。共用一份「创造一个角色」的提示词时，
  // 模型会照字面执行 —— 于是你输入「凉宫春日」，它给你编一个潜水员出来。
  const blocks = [known ? t('persona.systemKnown', { lang: langName }) : t('persona.system', { lang: langName })];
  const c = constraintBlock(opts, lang);
  if (c) blocks.push(c);

  const lines = [];
  if (known) {
    const nm = String(opts.charName || '').trim();
    const wk = String(opts.work || '').trim();
    if (nm) lines.push(t('persona.knownAsk', { v: nm }));
    if (wk) lines.push(t('persona.knownAskWork', { v: wk }));
    const kReqs = requirementLines(opts, lang);
    if (kReqs.length) lines.push(t('persona.reqHeader'), ...kReqs.map((x) => '- ' + x));
    // 已有角色模式绝不能给「随机灵感」：那等于让模型改去编一个新角色
    lines.push(t('persona.knownGo'));
    return [
      { role: 'system', content: blocks.join('\n\n') },
      { role: 'user', content: lines.join('\n') },
    ];
  }

  const seed = String(opts.seed || '').trim();
  const reqs = requirementLines(opts, lang);
  if (reqs.length) lines.push(t('persona.reqHeader'), ...reqs.map((x) => '- ' + x));
  lines.push(seed ? t('persona.hintLine', { seed }) : t('persona.hintNone') + ' ' + t('persona.hintRandom', { v: randomHint() }));
  lines.push(t('persona.userGo'));

  return [
    { role: 'system', content: blocks.join('\n\n') },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** 老接口：只要种子 */
export function buildSeedMessages(seed) {
  return buildPersonaMessages(seed);
}

// 生成一张卡要花的额度（思考很占）。起步额度必须给够，否则模型把预算花在思考上。
export const PERSONA_MIN_TOKENS = 4096;
// 只有起步额度不高时才翻倍重试；用户自己设得很大时不再翻倍（避免一次生成要两倍巨额）。
export const PERSONA_RETRY_CEILING = 16384;

/**
 * 额度阶梯：**跟随用户设置，不设上限**。
 *   · 用户设得比 4096 小 → 按 4096 起步（一张卡光正文就 1000+ 字）
 *   · 用户设得很大 → 直接用用户的值，不再翻倍
 * 只在「思考把额度吃光、一个字正文都没写出来」或「JSON 被截断」时才用到第二级。
 */
export function personaBudgets(userMax) {
  const base = Math.max(Number(userMax) || 0, PERSONA_MIN_TOKENS);
  if (base >= PERSONA_RETRY_CEILING) return [base];
  return [base, base * 2];
}

// 值得「加大额度重来一次」的两种失败：
//   EMPTY_REPLY      —— 思考把预算吃光，一个字正文都没写出来
//   TRUNCATED_REPLY  —— 正文写了，但 JSON 被截断（括号没闭合），解析必然失败
const RETRYABLE = { EMPTY_REPLY: true, TRUNCATED_REPLY: true };

/**
 * 按额度阶梯跑生成。run(budget, attempt) 抛出的错误 code 属于上面两种，就翻倍再试一次；
 * 别的错误（没配 key、401、网络断了）照常往上抛，绝不重试。
 */
export async function withPersonaBudget(userMax, run) {
  const budgets = personaBudgets(userMax);
  for (let i = 0; i < budgets.length; i += 1) {
    try {
      return await run(budgets[i], i);
    } catch (err) {
      if (!err || !RETRYABLE[err.code] || i === budgets.length - 1) throw err;
    }
  }
  return null;
}

/**
 * 解析结果分三种，而不只是「成功 / 失败」：
 *   card    —— 拿到可用角色卡
 *   unknown —— 模型明确表示它不认识这个角色（我们已经要求它这么说，而不是硬编）
 *   bad     —— 输出根本没法用
 * 区分 unknown 的意义在于提示词完全不同：前者要告诉用户「换个写法」，后者才是「再试一次」。
 */
export function parsePersonaOutcome(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return { kind: 'bad' };
  if (/"unknown"\s*:\s*true/i.test(text)) return { kind: 'unknown' };
  const card = parsePersonaResponse(text);
  return card ? { kind: 'card', card } : { kind: 'bad' };
}

/**
 * 生成一张角色卡（两个入口共用：角色编辑器里的快捷键、设置里的人设生成室）。
 *
 * 这里把两种「其实只是额度不够」的失败自己扛掉，不让用户看到「再试一次吧」：
 *   思考吃光预算 → 加额度重来；JSON 被截断 → 加额度重来。
 * 额度上限跟随用户在设置里的「最大输出 Token」（不设上限）。
 */
export async function generatePersonaCard(settings, options) {
  const messages = buildPersonaMessages(options);
  return withPersonaBudget(settings.llm.maxTokens, async (budget) => {
    let out = '';
    let truncated = false;
    await streamChat({
      messages,
      settings: { ...settings, llm: { ...settings.llm, maxTokens: budget } },
      onDelta: (d) => { out += d; },
      onFinish: (info) => { truncated = !!(info && info.finishReason === 'length'); },
    });
    const r = parsePersonaOutcome(out);
    if (r.kind === 'card') return r.card;
    if (r.kind === 'unknown') {
      // 不认识就是不认识：绝不重试、绝不硬编一张卡出来（重试只会烧钱，还可能逼出幻觉）
      const e = new Error(t('studio.unknownChar'));
      e.code = 'UNKNOWN_CHARACTER';
      throw e;
    }
    const err = new Error(t('char.genFail'));
    err.code = truncated ? 'TRUNCATED_REPLY' : 'UNPARSABLE';
    throw err;
  });
}

/**
 * 从模型回复里抠出第一个完整 JSON 对象（剥围栏 + 大括号配平）。
 * 0.7.9 抽出来给「Draft 生成」复用，解析规则只留一份。
 */
export function extractJsonObject(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const fence = text.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj;
  } catch (err) {
    return null;
  }
}

/**
 * 从模型回复里把角色卡抠出来。
 * 返回 { name?, description?, personality?, scenario?, first_mes?, mes_example? }，
 * 一个字段都救不回来时返回 null。
 */
export function parsePersonaResponse(raw) {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  let got = 0;
  const out = {};
  for (const key of PERSONA_FIELDS) {
    let v = obj[key];
    if (Array.isArray(v)) v = v.filter((x) => typeof x === 'string').join('\n');
    if (typeof v !== 'string') continue;
    const s = v.replace(/\r\n/g, '\n').trim();
    if (!s) continue;
    out[key] = s.slice(0, MAX_LEN[key] || 1000);
    got += 1;
  }
  return got ? out : null;
}

// ============================================================
// 0.7.9：结构化人设草稿（Draft）
//
// 和上面那张「6 字段卡」的区别：
//   · 生成的是**结构化人格 + 事实分级 + 来源**，不是一张成品卡；
//   · 先给用户看草稿，确认后才写进编辑器（persona-studio 那边控制）；
//   · 有资料时只写资料支持的结论，不确定的进 inference / unknowns ——
//     任务书 5.2 明确「不得为了填满字段而编造」。
// ============================================================

/** 草稿里允许出现的字段（白名单，防止模型塞一坨别的东西进卡里） */
export const DRAFT_FIELDS = [
  'name', 'work', 'identity', 'personality', 'language', 'address',
  'catchphrases', 'emotions', 'backstory', 'relationships', 'habits', 'interaction',
  'legacy', 'confidence',
];

const MAX_DRAFT_LEGACY = { description: 120, scenario: 800, first_mes: 800, mes_example: 2000 };

function clampStr(v, n) {
  return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, n);
}

/** 资料块：把来源写成模型能引用的编号列表（只给标题/类型/摘要，不塞整页 HTML） */
export function formatSourcesForPrompt(sources) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) return '';
  const rows = list.slice(0, 8).map((s, i) => {
    const x = (s && typeof s === 'object') ? s : { title: String(s) };
    return '[' + (i + 1) + '] ' + clampStr(x.title, 160)
      + '（' + clampStr(x.type || 'secondary', 20) + '）'
      + (x.url ? ' ' + clampStr(x.url, 300) : '')
      + (x.snippet ? '\n    摘要：' + clampStr(x.snippet, 400) : '');
  });
  return '【已知资料】\n' + rows.join('\n');
}

/**
 * 草稿生成的提示词。
 * 结构：底稿（原创 / 已有角色）+ 原型约束 + 资料 + 输出格式 + 硬规矩。
 */
export function buildDraftMessages(input, { sources = [] } = {}) {
  const opts = typeof input === 'string' ? { seed: input } : (input || {});
  const lang = getLang();
  const langName = LANG_NAME[lang] || 'English';
  const known = opts.mode === 'known';
  const blocks = [known ? t('persona.systemKnown', { lang: langName }) : t('persona.system', { lang: langName })];
  const c = constraintBlock(opts, lang);
  if (c) blocks.push(c);
  const src = formatSourcesForPrompt(sources);
  if (src) blocks.push(src);

  blocks.push([
    '输出格式（只输出一个 JSON 对象，不要解释、不要代码围栏）：',
    '{',
    '  "name": "角色名",',
    '  "work": "出自哪部作品（原创就写 original）",',
    '  "identity": { "work": "", "role": "", "world": "" },',
    '  "personality": { "traits": [], "strengths": [], "flaws": [], "values": [], "temperament": "", "humor": "" },',
    '  "language": { "tone": "", "sentenceStyle": "", "vocabulary": "", "formality": "casual|neutral|formal", "length": "short|medium|long" },',
    '  "address": { "selfName": "", "userTerm": "", "rule": "" },',
    '  "catchphrases": [ { "text": "不超过 40 字", "scenes": ["normal|happy|angry|clingy|shy|surprised|sad|comfort|encourage|farewell"] } ],',
    '  "emotions": [ { "emotion": "happy", "triggers": "什么会触发", "expression": "Live2D 表情名，可留空" } ],',
    '  "backstory": { "story": "", "timeline": "" },',
    '  "relationships": { "stage": "", "boundaries": "", "sharedHistory": "" },',
    '  "habits": [],',
    '  "interaction": { "initiative": "low|normal|high", "style": "", "boundaries": "" },',
    '  "legacy": { "description": "一句话简介", "scenario": "场景", "first_mes": "开场白", "mes_example": "两行示例" },',
    '  "confidence": { "confirmedFacts": [], "secondaryClaims": [], "inferences": [], "unknowns": [] }',
    '}',
  ].join('\n'));

  blocks.push([
    '硬规矩：',
    '1. 有【已知资料】时，只把资料里明确写了的东西放进 confirmedFacts；二手说法进 secondaryClaims；你自己的推断进 inferences；不知道的进 unknowns。',
    '2. 资料不足就让它空着或在 unknowns 里写清楚 —— **不要为了填满字段而编造**。',
    '3. 同名角色、不同作品版本/时间线/译名有歧义时，在 unknowns 里说明，不要猜。',
    '4. 不得复述原作台词、歌词、剧本段落；口头禅要概括或原创化，每条不超过 40 字。',
    '5. 不得声称这是官方设定或官方授权内容。',
    '6. 全部用 ' + langName + ' 写。',
  ].join('\n'));

  const userLines = [];
  const nm = clampStr(opts.charName, 80);
  const wk = clampStr(opts.work, 120);
  if (known && nm) userLines.push(t('persona.knownAsk', { v: nm }));
  if (known && wk) userLines.push(t('persona.knownAskWork', { v: wk }));
  if (known && opts.version) userLines.push('版本 / 时间线：' + clampStr(opts.version, 120));
  if (!known) {
    const seed = clampStr(opts.seed, 300);
    userLines.push(seed ? '灵感：' + seed : '灵感：（无，请自行想一个不落俗套的）');
  }
  const reqs = requirementLines(opts, lang);
  if (reqs.length) userLines.push('用户要求：\n- ' + reqs.join('\n- '));

  return [
    { role: 'system', content: blocks.join('\n\n') },
    { role: 'user', content: userLines.join('\n') },
  ];
}

/**
 * 版权检查：整段引用超过阈值就提示（任务书 5.2「不得复制大段原作台词」）。
 * 不做法学判断，只拦「明显越界」：长引号段 / 引用总量过大。
 */
export function copyrightWarning(text) {
  const s = String(text || '');
  const spans = [];
  const re = /[「“"『]([^」”"』]{1,600})[」”"』]/g;
  let m;
  while ((m = re.exec(s)) !== null) spans.push(m[1]);
  const long = spans.filter((x) => x.length >= 80);
  const total = spans.reduce((n, x) => n + x.length, 0);
  const reasons = [];
  if (long.length) reasons.push('有 ' + long.length + ' 段引用超过 80 字');
  if (spans.length >= 3 && total >= 200) reasons.push('引用总量偏大（' + total + ' 字）');
  return { ok: reasons.length === 0, reasons, spans: spans.length, total };
}

/** 把模型输出解析成草稿；解析不出来返回 { kind:'bad' } */
export function parsePersonaDraft(raw, { sources = [] } = {}) {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return { kind: 'bad' };
  if (/"unknown"\s*:\s*true/i.test(text)) return { kind: 'unknown' };
  const obj = extractJsonObject(text);
  if (!obj) return { kind: 'bad' };

  const legacyRaw = (obj.legacy && typeof obj.legacy === 'object') ? obj.legacy : obj;
  const legacy = {};
  for (const key of Object.keys(MAX_DRAFT_LEGACY)) {
    const v = legacyRaw[key];
    if (typeof v === 'string' && v.trim()) legacy[key] = clampStr(v, MAX_DRAFT_LEGACY[key]);
  }

  const persona = normalizePersonaV2({
    identity: obj.identity,
    personality: obj.personality,
    language: obj.language,
    address: obj.address,
    catchphrases: obj.catchphrases,
    emotions: obj.emotions,
    backstory: obj.backstory,
    relationships: obj.relationships,
    habits: obj.habits,
    interaction: obj.interaction,
  });

  const conf = (obj.confidence && typeof obj.confidence === 'object') ? obj.confidence : {};
  const listOf = (v) => (Array.isArray(v)
    ? v.map((x) => clampStr(typeof x === 'string' ? x : JSON.stringify(x), 300)).filter(Boolean).slice(0, 20)
    : []);

  const srcList = (Array.isArray(sources) ? sources : []).slice(0, 8).map((s) => {
    const x = (s && typeof s === 'object') ? s : { title: String(s) };
    return {
      title: clampStr(x.title, 200),
      url: clampStr(x.url, 500),
      type: clampStr(x.type || 'secondary', 20),
      retrievedAt: clampStr(x.retrievedAt || new Date().toISOString(), 40),
    };
  });

  const draft = {
    draftId: 'draft-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    status: 'draft',
    sourceCharacter: {
      name: clampStr(obj.name || legacyRaw.name, 80),
      work: clampStr(obj.work || (obj.identity && obj.identity.work), 160),
      version: clampStr((obj.identity && obj.identity.version) || '', 120),
      sources: srcList,
    },
    confidence: {
      confirmedFacts: listOf(conf.confirmedFacts),
      secondaryClaims: listOf(conf.secondaryClaims),
      inferences: listOf(conf.inferences),
      unknowns: listOf(conf.unknowns),
    },
    persona,
    legacy,
    copyright: { checked: false, reasons: [] },
  };

  const joined = [legacy.first_mes, legacy.mes_example, legacy.description, legacy.scenario,
    persona.backstory.story, persona.catchphrases.map((x) => x.text).join('\n')].filter(Boolean).join('\n');
  const warn = copyrightWarning(joined);
  draft.copyright = { checked: true, ok: warn.ok, reasons: warn.reasons };

  const empty = !Object.keys(legacy).length && !draft.sourceCharacter.name
    && !persona.identity.work && !persona.personality.traits.length && !persona.catchphrases.length;
  return empty ? { kind: 'bad' } : { kind: 'draft', draft };
}

/**
 * 生成结构化草稿。额度阶梯与「思考吃光预算」的处理和旧路径共用一套。
 * @param {object} settings
 * @param {object} options  { mode, seed, charName, work, version, ... }
 * @param {object} extra    { sources: [{title,url,type,snippet}] }
 */
export async function generatePersonaDraft(settings, options, extra = {}) {
  const sources = Array.isArray(extra.sources) ? extra.sources : [];
  const messages = buildDraftMessages(options, { sources });
  return withPersonaBudget(settings.llm.maxTokens, async (budget) => {
    let out = '';
    let truncated = false;
    await streamChat({
      messages,
      settings: { ...settings, llm: { ...settings.llm, maxTokens: budget } },
      onDelta: (d) => { out += d; },
      onFinish: (info) => { truncated = !!(info && info.finishReason === 'length'); },
    });
    const r = parsePersonaDraft(out, { sources });
    if (r.kind === 'draft') return r.draft;
    if (r.kind === 'unknown') {
      const e = new Error(t('studio.unknownChar'));
      e.code = 'UNKNOWN_CHARACTER';
      throw e;
    }
    const err = new Error(t('char.genFail'));
    err.code = truncated ? 'TRUNCATED_REPLY' : 'UNPARSABLE';
    throw err;
  });
}

/**
 * 字段级重生成：只让模型重写一个字段（任务书 5.1「字段级编辑、重新生成」）。
 * @returns {string} 新值（列表字段用「、」连起来，交给界面再拆）
 */
export async function regeneratePersonaField(settings, { field, options = {}, current = '' } = {}) {
  const key = String(field || '').trim();
  if (!key) throw new Error('缺少要重生成的字段');
  const messages = buildDraftMessages(options, {});
  messages.push({
    role: 'user',
    content: [
      '只重写这一个字段：' + key,
      '当前值：' + (clampStr(current, 800) || '（空）'),
      '要求：保持其它设定不变；只输出 JSON {"value": ...}；列表字段用数组。',
    ].join('\n'),
  });
  let out = '';
  await streamChat({
    messages,
    settings: { ...settings, llm: { ...settings.llm, maxTokens: Math.min(2048, Math.max(512, Number(settings.llm.maxTokens) || 1024)) } },
    onDelta: (d) => { out += d; },
  });
  const obj = extractJsonObject(out);
  if (!obj || obj.value === undefined) throw new Error(t('char.genFail'));
  const v = obj.value;
  if (Array.isArray(v)) return v.map((x) => clampStr(x, 200)).filter(Boolean).slice(0, 20).join('、');
  return clampStr(v, 2000);
}

