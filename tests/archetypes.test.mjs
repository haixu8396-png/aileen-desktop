import { describe, it, expect } from 'vitest';
import { PERSONALITIES, ROLES, GENDERS, findArchetype, labelOf, specOf } from '../src/lib/archetypes.js';

// 原型库是「精准锁定」的地基：缺一种语言的标签、或者少了「怎么演」那句约束，
// 锁出来的角色就会退化成通用模板 —— 那正是「乱写」的来源。
const LANGS = ['en', 'ja', 'zh'];
const groups = [['性格原型', PERSONALITIES], ['身份原型', ROLES]];

describe('原型库', () => {
  for (const [name, list] of groups) {
    it(name + '：id 唯一、有图标', () => {
      const ids = list.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const x of list) expect(x.icon).toBeTruthy();
    });

    for (const lang of LANGS) {
      it(name + '：' + lang + ' 的标签与约束都不缺、不含占位符', () => {
        for (const x of list) {
          const label = labelOf(x, lang);
          const spec = specOf(x, lang);
          expect(label && label.length).toBeGreaterThan(1);
          expect(spec && spec.length).toBeGreaterThan(10);
          expect(spec).not.toMatch(/\{[a-z]+\}/);
        }
      });
    }

    it(name + '：三种语言各自成篇，不是照抄英文', () => {
      for (const x of list) {
        expect(x.spec.ja).not.toBe(x.spec.en);
        expect(x.spec.zh).not.toBe(x.spec.en);
        expect(x.label.zh).not.toBe(x.label.en);
      }
    });
  }

  it('数量够用（至少要能覆盖常见的性格与身份）', () => {
    expect(PERSONALITIES.length).toBeGreaterThanOrEqual(10);
    expect(ROLES.length).toBeGreaterThanOrEqual(10);
  });

  it('findArchetype：找得到、找不到给 null、空 id 给 null', () => {
    expect(findArchetype(PERSONALITIES, 'tsundere').id).toBe('tsundere');
    expect(findArchetype(PERSONALITIES, 'nope')).toBe(null);
    expect(findArchetype(PERSONALITIES, '')).toBe(null);
  });

  it('性别选项第一项是「不限」', () => {
    expect(GENDERS[0].id).toBe('any');
    for (const g of GENDERS) for (const l of LANGS) expect(labelOf(g, l)).toBeTruthy();
  });
});
