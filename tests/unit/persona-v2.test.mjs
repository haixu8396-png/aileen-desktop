// ============================================================
// Persona v2 单测：schema / 迁移 / 编译器 / 口头禅选择 / 结构化输出抑制
//
// 这一层是「人格数据源 → Prompt」的唯一通路，写错就会让人格变味，
// 所以每条规则都钉一个断言。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  PERSONA_VERSION, SCENES, emptyPersonaV2, normalizePersonaV2, isPersonaEmpty,
  migrateCardToV2, compilePersonaPrompt, pickCatchphrase, isStructuredOutput,
  personaCatchphraseHint, EMOTION_EXPRESSIONS,
} from '../../src/lib/persona-v2.js';

const NOW = 1_800_000_000_000;

function sample() {
  return normalizePersonaV2({
    identity: { work: '东方 Project', role: '巫女', world: '幻想乡' },
    personality: { traits: ['嘴硬', '心软'], flaws: ['不肯认错'], values: ['秩序'] },
    language: { tone: '冷淡', formality: 'formal', length: 'short' },
    address: { selfName: '本座', userTerm: '你' },
    catchphrases: [
      { id: 'cp-1', text: '别误会。', scenes: ['angry'], weight: 3, cooldownTurns: 2 },
      { id: 'cp-2', text: '随你。', scenes: ['normal'], weight: 1, cooldownTurns: 0 },
    ],
    emotions: [{ emotion: 'angry', triggers: '被叫错名字', expression: 'Angry' }],
    backstory: { story: '独自守着神社' },
    relationships: { stage: '刚认识', boundaries: '不谈过去' },
    habits: ['夜里喝茶'],
    interaction: { initiative: 'low', style: '先观察再说话' },
  });
}

describe('schema', () => {
  it('空人格是空的，且带版本号', () => {
    const p = emptyPersonaV2();
    expect(p.version).toBe(PERSONA_VERSION);
    expect(isPersonaEmpty(p)).toBe(true);
  });

  it('归一化收敛长度与条数（不会变成一本书）', () => {
    const p = normalizePersonaV2({
      personality: { traits: new Array(50).fill('x'.repeat(300)) },
      catchphrases: new Array(50).fill({ text: 'y'.repeat(300), weight: 99, cooldownTurns: -5 }),
      habits: new Array(50).fill('h'),
    });
    expect(p.personality.traits.length).toBeLessThanOrEqual(12);
    expect(p.personality.traits[0].length).toBeLessThanOrEqual(120);
    expect(p.catchphrases.length).toBeLessThanOrEqual(30);
    expect(p.catchphrases[0].text.length).toBeLessThanOrEqual(120);
    expect(p.catchphrases[0].weight).toBe(10);
    expect(p.catchphrases[0].cooldownTurns).toBe(0);
    expect(p.habits.length).toBeLessThanOrEqual(20);
  });

  it('枚举字段只接受白名单值', () => {
    const p = normalizePersonaV2({ language: { formality: '黑客话', length: '一亿字' }, interaction: { initiative: '超主动' } });
    expect(p.language.formality).toBe('neutral');
    expect(p.language.length).toBe('medium');
    expect(p.interaction.initiative).toBe('normal');
  });

  it('口头禅：空文本丢掉、非法场景丢掉、id 自动补', () => {
    const p = normalizePersonaV2({
      catchphrases: [
        { text: '', scenes: ['happy'] },
        { text: '嗯。', scenes: ['happy', '不存在的场景'] },
      ],
    });
    expect(p.catchphrases).toHaveLength(1);
    expect(p.catchphrases[0].id).toBe('cp-2');
    expect(p.catchphrases[0].scenes).toEqual(['happy']);
    expect(p.catchphrases[0].enabled).toBe(true);
  });
});

describe('迁移 v1 → v2', () => {
  const v1 = {
    spec: 'aileen-card-v1',
    name: '爱丽丝',
    description: '安静的书店店员',
    personality: '她话很少，但记得每个客人买过的书。',
    scenario: '城南旧书店',
    first_mes: '欢迎光临。',
    mes_example: '爱丽丝: 这本书你上次也看过。',
  };

  it('旧的自由文本一个字都不丢', () => {
    const card = migrateCardToV2(v1);
    expect(card.spec).toBe('aileen-card-v2');
    expect(card.personality).toBe(v1.personality);
    expect(card.description).toBe(v1.description);
    expect(card.scenario).toBe(v1.scenario);
    expect(card.migratedFrom).toBe('aileen-card-v1');
    expect(card.migratedAt).toBeGreaterThan(0);
  });

  it('能结构化的部分抄进新字段（但不是假装理解了全文）', () => {
    const card = migrateCardToV2(v1);
    expect(card.persona.identity.work).toBe(v1.scenario.slice(0, 200));
    expect(card.persona.personality.temperament).toBe(v1.description);
  });

  it('幂等：再迁一次不会改动已迁移的卡', () => {
    const once = migrateCardToV2(v1);
    const twice = migrateCardToV2(once);
    expect(twice.persona).toEqual(once.persona);
    expect(twice.migratedAt).toBe(once.migratedAt);
  });

  it('已有结构化人格的卡不会被覆盖', () => {
    const card = migrateCardToV2({ spec: 'aileen-card-v2', name: 'x', persona: sample() });
    expect(card.persona.identity.work).toBe('东方 Project');
  });
});

describe('Prompt 编译', () => {
  it('把结构化字段编成中文段落，标题齐全', () => {
    const text = compilePersonaPrompt(sample(), { lang: 'zh' });
    expect(text).toContain('【身份与世界观】');
    expect(text).toContain('作品 / 出处：东方 Project');
    expect(text).toContain('【性格】');
    expect(text).toContain('嘴硬、心软');
    expect(text).toContain('【说话方式】');
    expect(text).toContain('正式');
    expect(text).toContain('【称呼规则】');
    expect(text).toContain('本座');
    expect(text).toContain('【口头禅库');
    expect(text).toContain('别误会。');
    expect(text).toContain('【情绪与表现');
    expect(text).toContain('expr:Angry');
    expect(text).toContain('【背景】');
    expect(text).toContain('【与用户的关系】');
    expect(text).toContain('【互动方式】');
  });

  it('口头禅的「不许插进代码」那条规矩必须在提示词里', () => {
    const text = compilePersonaPrompt(sample(), { lang: 'zh' });
    expect(text).toContain('代码');
    expect(text).toContain('JSON');
  });

  it('空人格编译成空串（调用方会退回旧字段）', () => {
    expect(compilePersonaPrompt(emptyPersonaV2(), { lang: 'zh' })).toBe('');
  });

  it('语言可切换（en 用英文标题）', () => {
    const text = compilePersonaPrompt(sample(), { lang: 'en' });
    expect(text).toContain('【Personality】');
    expect(text).toContain('【How they speak】');
    expect(text).toContain('【Catchphrases');
  });

  it('被禁用的口头禅不会出现在提示词里', () => {
    const p = sample();
    p.catchphrases[0].enabled = false;
    const text = compilePersonaPrompt(p, { lang: 'zh' });
    expect(text).not.toContain('别误会。');
    expect(text).toContain('随你。');
  });
});

describe('口头禅选择', () => {
  const p = sample();

  it('按场景命中', () => {
    const picked = pickCatchphrase(p.catchphrases, { scene: 'angry', turn: 1, now: NOW });
    expect(picked && picked.text).toBe('别误会。');
  });

  it('场景不匹配就不硬塞', () => {
    expect(pickCatchphrase(p.catchphrases, { scene: 'farewell', turn: 1, now: NOW })).toBeNull();
  });

  it('冷却轮数内不会重复同一句', () => {
    const lastUsed = new Map([['cp-1', { turn: 5, at: NOW }]]);
    const picked = pickCatchphrase(p.catchphrases, { scene: 'angry', turn: 6, now: NOW, lastUsed });
    expect(picked).toBeNull();
    const ok = pickCatchphrase(p.catchphrases, { scene: 'angry', turn: 9, now: NOW, lastUsed });
    expect(ok && ok.text).toBe('别误会。');
  });

  it('冷却秒数也生效', () => {
    const lastUsed = new Map([['cp-2', { turn: 0, at: NOW }]]);
    const list = normalizePersonaV2({ catchphrases: [{ id: 'cp-2', text: '随你。', scenes: ['normal'], cooldownSeconds: 60 }] }).catchphrases;
    expect(pickCatchphrase(list, { scene: 'normal', turn: 10, now: NOW + 10000, lastUsed })).toBeNull();
    expect(pickCatchphrase(list, { scene: 'normal', turn: 10, now: NOW + 61000, lastUsed })).not.toBeNull();
  });

  it('禁用的不参与', () => {
    const list = p.catchphrases.map((x) => ({ ...x, enabled: false }));
    expect(pickCatchphrase(list, { scene: 'angry', turn: 1, now: NOW })).toBeNull();
  });

  it('权重高的优先（重复抽多次）', () => {
    const list = normalizePersonaV2({
      catchphrases: [
        { id: 'a', text: 'A', scenes: ['normal'], weight: 1, priority: 0 },
        { id: 'b', text: 'B', scenes: ['normal'], weight: 9, priority: 0 },
      ],
    }).catchphrases;
    let b = 0;
    for (let i = 0; i < 200; i += 1) {
      const picked = pickCatchphrase(list, { scene: 'normal', turn: i, now: NOW });
      if (picked && picked.text === 'B') b += 1;
    }
    expect(b).toBeGreaterThan(150);
  });

  it('提示里会说明「每轮最多一条」和「不许插进代码」', () => {
    const hint = personaCatchphraseHint(p, { lang: 'zh', scene: 'angry', turn: 1, now: NOW });
    expect(hint).toContain('最多用 1 条');
    expect(hint).toContain('JSON');
  });

  it('onPick 回调能拿到被选中的那条（用于记冷却）', () => {
    let picked = null;
    personaCatchphraseHint(p, { lang: 'zh', scene: 'angry', turn: 1, now: NOW, onPick: (x) => { picked = x; } });
    expect(picked && picked.id).toBe('cp-1');
  });
});

describe('结构化输出抑制', () => {
  it('代码块 / JSON / 命令 / 路径都算结构化输出', () => {
    expect(isStructuredOutput('```js\nconsole.log(1)\n```')).toBe(true);
    expect(isStructuredOutput('{"a":1}')).toBe(true);
    expect(isStructuredOutput('npm test')).toBe(true);
    expect(isStructuredOutput('D:\\projects\\a.txt')).toBe(true);
    expect(isStructuredOutput('这是一段普通对话。')).toBe(false);
  });

  it('四个反引号（行内代码较多）也算结构化', () => {
    expect(isStructuredOutput('用 `a` 和 `b` 还有 `c` 和 `d`')).toBe(true);
  });
});

describe('情绪映射表', () => {
  it('每种情绪都有可用的表情关键词', () => {
    for (const k of Object.keys(EMOTION_EXPRESSIONS)) {
      expect(Array.isArray(EMOTION_EXPRESSIONS[k])).toBe(true);
      expect(EMOTION_EXPRESSIONS[k].length).toBeGreaterThan(0);
    }
  });

  it('场景常量齐全（任务书预设的 10 个）', () => {
    expect(SCENES).toEqual(['normal', 'happy', 'angry', 'clingy', 'shy', 'surprised', 'sad', 'comfort', 'encourage', 'farewell']);
  });
});
