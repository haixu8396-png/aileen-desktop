// ============================================================
// Persona v2：结构化人格（数据源）+ Prompt 编译器（运行时结果）
//
// 为什么要有这一层（任务书 4.3）：
//   「结构化字段是人格数据源，System Prompt 是运行时编译结果，不应只存一段 Prompt。」
// 所以卡片里存的是**字段**，发给模型的是**编译出来的文字**；
// 编译是纯函数，能单测、能预览、能版本化，也不会在运行中偷偷变。
//
// 这一层还要保证三件不许破的事：
//   1) 人格永远只是 system 的第 0 段（编译结果由 characters.js 拼进人格段）；
//   2) 口头禅可以被「建议」，但不能生硬拼接，更不能插进代码/命令/JSON 输出里；
//   3) 旧卡（v1 的 personality/description/scenario）必须无损迁移。
// ============================================================

export const PERSONA_VERSION = 2;

/** 场景标签（任务书 4.2 的预设场景） */
export const SCENES = ['normal', 'happy', 'angry', 'clingy', 'shy', 'surprised', 'sad', 'comfort', 'encourage', 'farewell'];

/** 情绪 → Live2D 表情名的默认关键词（没有映射时按它挑模型自带的表情） */
export const EMOTION_EXPRESSIONS = {
  happy: ['happy', 'smile', 'joy'],
  angry: ['angry', 'mad'],
  sad: ['sad', 'cry'],
  surprised: ['surprise', 'shock'],
  shy: ['shy', 'blush'],
  calm: ['normal', 'calm'],
  think: ['think', 'serious'],
};

const LIMITS = {
  text: 2000,
  short: 200,
  list: 12,
  listItem: 120,
  phrases: 30,
  phraseText: 120,
  emotions: 20,
  habits: 20,
};

export function emptyPersonaV2() {
  return {
    version: PERSONA_VERSION,
    identity: { work: '', role: '', world: '' },
    personality: { traits: [], strengths: [], flaws: [], values: [], temperament: '', humor: '' },
    language: { tone: '', sentenceStyle: '', vocabulary: '', formality: 'neutral', length: 'medium' },
    address: { selfName: '', userTerm: '', rule: '' },
    catchphrases: [],
    emotions: [],
    backstory: { story: '', timeline: '' },
    relationships: { stage: '', boundaries: '', sharedHistory: '' },
    habits: [],
    interaction: { initiative: 'normal', style: '', boundaries: '' },
    promptVersion: 1,
  };
}

function text(v, max = LIMITS.text) {
  return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
}

function list(v, maxItems = LIMITS.list) {
  if (typeof v === 'string') v = v.split(/[,，\n]/);
  if (!Array.isArray(v)) return [];
  return v.map((x) => text(x, LIMITS.listItem)).filter(Boolean).slice(0, maxItems);
}

function oneOf(v, allowed, dflt) {
  const s = String(v || '').toLowerCase();
  return allowed.includes(s) ? s : dflt;
}

/**
 * 归一化结构化人格。**不认识的字段一律丢掉**，长度/条数全部收敛 ——
 * 免得模型或导入的文件把一张卡撑成一本书。
 */
export function normalizePersonaV2(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const base = emptyPersonaV2();
  const id = (r.identity && typeof r.identity === 'object') ? r.identity : {};
  const pf = (r.personality && typeof r.personality === 'object') ? r.personality : {};
  const lg = (r.language && typeof r.language === 'object') ? r.language : {};
  const ad = (r.address && typeof r.address === 'object') ? r.address : {};
  const bs = (r.backstory && typeof r.backstory === 'object') ? r.backstory : {};
  const rl = (r.relationships && typeof r.relationships === 'object') ? r.relationships : {};
  const ia = (r.interaction && typeof r.interaction === 'object') ? r.interaction : {};

  const phrases = Array.isArray(r.catchphrases) ? r.catchphrases : [];
  const emotions = Array.isArray(r.emotions) ? r.emotions : [];

  return {
    version: PERSONA_VERSION,
    identity: {
      work: text(id.work, LIMITS.short),
      role: text(id.role, LIMITS.short),
      world: text(id.world),
    },
    personality: {
      traits: list(pf.traits),
      strengths: list(pf.strengths),
      flaws: list(pf.flaws),
      values: list(pf.values),
      temperament: text(pf.temperament, LIMITS.short),
      humor: text(pf.humor, LIMITS.short),
    },
    language: {
      tone: text(lg.tone, LIMITS.short),
      sentenceStyle: text(lg.sentenceStyle, LIMITS.short),
      vocabulary: text(lg.vocabulary, LIMITS.short),
      formality: oneOf(lg.formality, ['casual', 'neutral', 'formal'], base.language.formality),
      length: oneOf(lg.length, ['short', 'medium', 'long'], base.language.length),
    },
    address: {
      selfName: text(ad.selfName, LIMITS.short),
      userTerm: text(ad.userTerm, LIMITS.short),
      rule: text(ad.rule, LIMITS.short),
    },
    catchphrases: phrases.slice(0, LIMITS.phrases).map((p, i) => {
      const x = (p && typeof p === 'object') ? p : {};
      return {
        id: text(x.id, 40) || 'cp-' + (i + 1),
        text: text(x.text, LIMITS.phraseText),
        scenes: list(x.scenes, SCENES.length).map((s) => String(s).toLowerCase()).filter((s) => SCENES.includes(s)),
        emotions: list(x.emotions, 8).map((s) => String(s).toLowerCase()),
        weight: Math.max(1, Math.min(10, Math.round(Number(x.weight) || 1))),
        cooldownTurns: Math.max(0, Math.min(100, Math.round(Number(x.cooldownTurns) || 0))),
        cooldownSeconds: Math.max(0, Math.min(86400, Math.round(Number(x.cooldownSeconds) || 0))),
        enabled: x.enabled !== false,
        priority: Math.max(0, Math.min(10, Math.round(Number(x.priority) || 0))),
      };
    }).filter((p) => p.text),
    emotions: emotions.slice(0, LIMITS.emotions).map((e) => {
      const x = (e && typeof e === 'object') ? e : {};
      return {
        emotion: text(x.emotion, 40).toLowerCase(),
        triggers: text(x.triggers, LIMITS.short),
        expression: text(x.expression, 40),
      };
    }).filter((e) => e.emotion),
    backstory: {
      story: text(bs.story),
      timeline: text(bs.timeline, LIMITS.short),
    },
    relationships: {
      stage: text(rl.stage, LIMITS.short),
      boundaries: text(rl.boundaries, LIMITS.short),
      sharedHistory: text(rl.sharedHistory),
    },
    habits: list(r.habits, LIMITS.habits),
    interaction: {
      initiative: oneOf(ia.initiative, ['low', 'normal', 'high'], base.interaction.initiative),
      style: text(ia.style, LIMITS.short),
      boundaries: text(ia.boundaries, LIMITS.short),
    },
    promptVersion: Math.max(1, Math.round(Number(r.promptVersion) || 1)),
  };
}

/** 结构化人格是不是「空的」（全空就不编译，退回旧字段） */
export function isPersonaEmpty(p) {
  const x = normalizePersonaV2(p);
  return !(x.identity.work || x.identity.role || x.identity.world
    || x.personality.traits.length || x.personality.strengths.length || x.personality.flaws.length
    || x.personality.values.length || x.personality.temperament || x.personality.humor
    || x.language.tone || x.language.sentenceStyle || x.language.vocabulary
    || x.address.selfName || x.address.userTerm || x.address.rule
    || x.catchphrases.length || x.emotions.length
    || x.backstory.story || x.backstory.timeline
    || x.relationships.stage || x.relationships.boundaries || x.relationships.sharedHistory
    || x.habits.length || x.interaction.style || x.interaction.boundaries);
}

/** v1 卡（只有 description/personality/scenario/mes_example）→ v2 结构化字段 */
export function migrateCardToV2(card) {
  const c = (card && typeof card === 'object') ? card : {};
  if (c.persona && typeof c.persona === 'object' && !isPersonaEmpty(c.persona)) {
    return Object.assign({}, c, { persona: normalizePersonaV2(c.persona), spec: 'aileen-card-v2' });
  }
  const persona = emptyPersonaV2();
  // 旧卡的 personality 是一整段自由文本：原样留在 card.personality 里，
  // 同时把「能结构化的那部分」抄一份进来（不丢原文字，也不假装理解它）。
  persona.identity.work = text(c.scenario, LIMITS.short);
  persona.personality.temperament = text(c.description, LIMITS.short);
  return Object.assign({}, c, {
    spec: 'aileen-card-v2',
    migratedFrom: c.spec || 'aileen-card-v1',
    migratedAt: Date.now(),
    persona,
  });
}

const HEAD = {
  zh: {
    identity: '身份与世界观',
    personality: '性格',
    language: '说话方式',
    address: '称呼规则',
    catchphrase: '口头禅库（自然地带一句，最多每轮 1 条；代码/命令/路径/JSON 里绝对不要插）',
    emotions: '情绪与表现（需要时用 <{\'|\'}expr:表情名{\'|\'}> 标记，让立绘跟上）',
    backstory: '背景',
    relationships: '与用户的关系',
    habits: '习惯与偏好',
    interaction: '互动方式',
    work: '作品 / 出处',
    role: '身份',
    world: '世界观',
    traits: '性格特质',
    strengths: '优点',
    flaws: '缺点 / 短板',
    values: '在意的东西',
    temperament: '脾气',
    humor: '幽默感',
    tone: '语气',
    style: '句式',
    words: '常用词 / 口癖',
    formality: '正式程度',
    length: '一次回复的长度',
    selfName: '自称',
    userTerm: '怎么称呼用户',
    addrRule: '称呼变化规则',
    story: '背景故事',
    timeline: '时间线 / 重要经历',
    stage: '关系阶段',
    boundaries: '边界',
    shared: '共同经历',
    initiative: '主动程度',
    initLow: '偏被动',
    initNormal: '正常',
    initHigh: '很主动',
    formal: { casual: '随意', neutral: '自然', formal: '正式' },
    len: { short: '短（1~3 句）', medium: '中等', long: '长（会展开说）' },
  },
  en: {
    identity: 'Identity & setting',
    personality: 'Personality',
    language: 'How they speak',
    address: 'How to address people',
    catchphrase: 'Catchphrases (drop at most one per reply, only when it fits; never inside code, commands, paths or JSON)',
    emotions: 'Emotions & expression (you may emit <{\'|\'}expr:Name{\'|\'}> so the avatar follows)',
    backstory: 'Backstory',
    relationships: 'Relationship with the user',
    habits: 'Habits & preferences',
    interaction: 'Interaction style',
    work: 'Work',
    role: 'Role',
    world: 'World',
    traits: 'Traits',
    strengths: 'Strengths',
    flaws: 'Flaws',
    values: 'What they care about',
    temperament: 'Temperament',
    humor: 'Humour',
    tone: 'Tone',
    style: 'Sentence style',
    words: 'Favourite words',
    formality: 'Formality',
    length: 'Reply length',
    selfName: 'Self-reference',
    userTerm: 'Calls the user',
    addrRule: 'Addressing rules',
    story: 'Backstory',
    timeline: 'Timeline',
    stage: 'Relationship stage',
    boundaries: 'Boundaries',
    shared: 'Shared history',
    initiative: 'Initiative',
    initLow: 'reactive',
    initNormal: 'normal',
    initHigh: 'proactive',
    formal: { casual: 'casual', neutral: 'neutral', formal: 'formal' },
    len: { short: 'short (1-3 sentences)', medium: 'medium', long: 'long' },
  },
  ja: {
    identity: 'identity',
    personality: 'personality',
    language: 'language',
    address: 'address',
    catchphrase: 'catchphrases',
    emotions: 'emotions',
    backstory: 'backstory',
    relationships: 'relationship',
    habits: 'habits',
    interaction: 'interaction',
    work: 'work',
    role: 'role',
    world: 'world',
    traits: 'traits',
    strengths: 'strengths',
    flaws: 'flaws',
    values: 'values',
    temperament: 'temperament',
    humor: 'humour',
    tone: 'tone',
    style: 'style',
    words: 'words',
    formality: 'formality',
    length: 'length',
    selfName: 'self',
    userTerm: 'user',
    addrRule: 'rules',
    story: 'story',
    timeline: 'timeline',
    stage: 'stage',
    boundaries: 'boundaries',
    shared: 'history',
    initiative: 'initiative',
    initLow: 'low',
    initNormal: 'normal',
    initHigh: 'high',
    formal: { casual: 'casual', neutral: 'neutral', formal: 'formal' },
    len: { short: 'short', medium: 'medium', long: 'long' },
  },
};

function bullets(label, items) {
  const rows = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!rows.length) return '';
  return label + '：' + rows.join('、');
}

/**
 * 把结构化人格编译成「人格段正文」。
 * 注意：这里**不含** intro/outro 与描述/场景/示例 —— 那些仍由 characters.js 拼，
 * 这样编译结果可以单独预览、单独版本化。
 */
export function compilePersonaPrompt(persona, { lang = 'zh' } = {}) {
  const p = normalizePersonaV2(persona);
  const L = HEAD[lang] || HEAD.zh;
  if (isPersonaEmpty(p)) return '';
  const out = [];

  const identity = [];
  if (p.identity.work) identity.push(L.work + '：' + p.identity.work);
  if (p.identity.role) identity.push(L.role + '：' + p.identity.role);
  if (p.identity.world) identity.push(L.world + '：' + p.identity.world);
  if (identity.length) out.push('【' + L.identity + '】\n' + identity.join('\n'));

  const personality = [];
  const b = (k, v) => bullets(L[k], v);
  for (const line of [b('traits', p.personality.traits), b('strengths', p.personality.strengths),
    b('flaws', p.personality.flaws), b('values', p.personality.values)]) {
    if (line) personality.push(line);
  }
  if (p.personality.temperament) personality.push(L.temperament + '：' + p.personality.temperament);
  if (p.personality.humor) personality.push(L.humor + '：' + p.personality.humor);
  if (personality.length) out.push('【' + L.personality + '】\n' + personality.join('\n'));

  const language = [];
  if (p.language.tone) language.push(L.tone + '：' + p.language.tone);
  if (p.language.sentenceStyle) language.push(L.style + '：' + p.language.sentenceStyle);
  if (p.language.vocabulary) language.push(L.words + '：' + p.language.vocabulary);
  language.push(L.formality + '：' + (L.formal[p.language.formality] || p.language.formality));
  language.push(L.length + '：' + (L.len[p.language.length] || p.language.length));
  out.push('【' + L.language + '】\n' + language.join('\n'));

  const address = [];
  if (p.address.selfName) address.push(L.selfName + '：' + p.address.selfName);
  if (p.address.userTerm) address.push(L.userTerm + '：' + p.address.userTerm);
  if (p.address.rule) address.push(L.addrRule + '：' + p.address.rule);
  if (address.length) out.push('【' + L.address + '】\n' + address.join('\n'));

  if (p.catchphrases.length) {
    const rows = p.catchphrases.filter((x) => x.enabled).map((x) => {
      const tags = (x.scenes.length ? x.scenes.join('/') : 'any')
        + (x.emotions.length ? '·' + x.emotions.join('/') : '');
      return '· 「' + x.text + '」（' + tags + '）';
    });
    if (rows.length) out.push('【' + L.catchphrase + '】\n' + rows.join('\n'));
  }

  if (p.emotions.length) {
    const rows = p.emotions.map((e) => '· ' + e.emotion
      + (e.triggers ? '（触发：' + e.triggers + '）' : '')
      + (e.expression ? ' → expr:' + e.expression : ''));
    out.push('【' + L.emotions + '】\n' + rows.join('\n'));
  }

  const back = [];
  if (p.backstory.story) back.push(p.backstory.story);
  if (p.backstory.timeline) back.push(L.timeline + '：' + p.backstory.timeline);
  if (back.length) out.push('【' + L.backstory + '】\n' + back.join('\n'));

  const rel = [];
  if (p.relationships.stage) rel.push(L.stage + '：' + p.relationships.stage);
  if (p.relationships.boundaries) rel.push(L.boundaries + '：' + p.relationships.boundaries);
  if (p.relationships.sharedHistory) rel.push(L.shared + '：' + p.relationships.sharedHistory);
  if (rel.length) out.push('【' + L.relationships + '】\n' + rel.join('\n'));

  if (p.habits.length) out.push('【' + L.habits + '】\n' + bullets(L.habits, p.habits));

  const ia = [];
  const initLabel = { low: L.initLow, normal: L.initNormal, high: L.initHigh }[p.interaction.initiative];
  ia.push(L.initiative + '：' + initLabel);
  if (p.interaction.style) ia.push(p.interaction.style);
  if (p.interaction.boundaries) ia.push(L.boundaries + '：' + p.interaction.boundaries);
  out.push('【' + L.interaction + '】\n' + ia.join('\n'));

  return out.join('\n\n');
}

/** 结构化输出（代码/命令/路径/JSON）—— 这类回复里不许插口头禅 */
export function isStructuredOutput(textValue) {
  const s = String(textValue || '');
  if (!s.trim()) return false;
  if (/```/.test(s)) return true;
  if (/^\s*[{[]/.test(s) && /[}\]]\s*$/.test(s)) return true;
  if (/^\s*(npm|npx|pnpm|yarn|git|node|python|pip|cargo|go|dotnet|java|cd|mkdir|rm|del|copy|move)\b/m.test(s)) return true;
  const backtick = (s.match(/`/g) || []).length;
  if (backtick >= 4) return true;
  if (/^[A-Za-z]:\\|^\/(usr|home|etc|var)\//m.test(s)) return true;
  return false;
}

/**
 * 挑一条口头禅（或 null）。
 *
 * @param {Array} phrases 归一化后的口头禅
 * @param {object} opts { scene, emotion, turn, now, lastUsed: Map<id,{turn,at}>, usedThisReply }
 */
export function pickCatchphrase(phrases, opts = {}) {
  const list = Array.isArray(phrases) ? phrases : [];
  const scene = String(opts.scene || 'normal');
  const emotion = String(opts.emotion || '');
  const turn = Number(opts.turn) || 0;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const lastUsed = opts.lastUsed instanceof Map ? opts.lastUsed : new Map();
  const used = new Set(Array.isArray(opts.usedThisReply) ? opts.usedThisReply : []);

  const usable = list.filter((p) => {
    if (!p || p.enabled === false || !p.text) return false;
    if (used.has(p.id)) return false;
    if (p.scenes && p.scenes.length) {
      const hit = p.scenes.includes(scene);
      // 「安慰」比「普通」优先：场景冲突时按优先级决定，这里先只按标签命中筛
      if (!hit) return false;
    }
    if (emotion && p.emotions && p.emotions.length && !p.emotions.includes(emotion)) {
      // 只带情绪标签、但当前情绪不匹配 → 跳过（不硬塞）
      if (!p.scenes || !p.scenes.length) return false;
    }
    const prev = lastUsed.get(p.id);
    if (prev) {
      if (p.cooldownTurns > 0 && turn - Number(prev.turn || 0) < p.cooldownTurns) return false;
      if (p.cooldownSeconds > 0 && now - Number(prev.at || 0) < p.cooldownSeconds * 1000) return false;
    }
    return true;
  });

  if (!usable.length) return null;
  // 优先级高的先来；同优先级按权重随机（权重越大越容易被挑中）
  usable.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const top = usable.filter((p) => (p.priority || 0) === (usable[0].priority || 0));
  const total = top.reduce((n, p) => n + Math.max(1, p.weight || 1), 0);
  let roll = Math.random() * total;
  for (const p of top) {
    roll -= Math.max(1, p.weight || 1);
    if (roll <= 0) return p;
  }
  return top[top.length - 1];
}

/**
 * 给本轮回复的「口头禅提示」：不是把口头禅拼进回复，而是告诉模型
 * 「这一轮你可能会想这么说」—— 生硬拼接会比没有更糟。
 */
export function personaCatchphraseHint(persona, opts = {}) {
  const p = normalizePersonaV2(persona);
  if (!p.catchphrases.length) return '';
  const picked = pickCatchphrase(p.catchphrases, opts);
  if (picked && typeof opts.onPick === 'function') opts.onPick(picked);
  const lang = opts.lang || 'zh';
  const max = Number.isFinite(opts.maxPerReply) ? Math.max(1, Math.min(3, opts.maxPerReply)) : 1;
  const head = lang === 'en'
    ? 'Phrasing hint for this reply'
    : (lang === 'ja' ? '今回の言い回しのヒント' : '这一轮的措辞提示');
  const lines = [];
  lines.push(head + '：');
  if (picked) {
    lines.push(lang === 'en'
      ? '· You may naturally slip in: 「' + picked.text + '」'
      : '· 可以自然地带上一句：「' + picked.text + '」');
  }
  lines.push(lang === 'en'
    ? '· Use at most ' + max + ' catchphrase(s) per reply, only if it fits the moment.'
    : '· 每轮最多用 ' + max + ' 条，而且只在场景真的合适时用。');
  lines.push(lang === 'en'
    ? '· Never put a catchphrase inside code, commands, file paths or JSON.'
    : '· 代码、命令、路径、JSON 里绝对不要插口头禅。');
  return lines.join('\n');
}

/** 「自我称呼 / 怎么称呼用户」这种小规则单独抽出来，生成器与编译器共用 */
export function addressSummary(persona) {
  const p = normalizePersonaV2(persona);
  const bits = [];
  if (p.address.selfName) bits.push('自称 ' + p.address.selfName);
  if (p.address.userTerm) bits.push('称呼用户为 ' + p.address.userTerm);
  if (p.address.rule) bits.push(p.address.rule);
  return bits.join('；');
}
