import { describe, it, expect } from 'vitest';
import { EN, setLang, t, applyI18n } from '../../src/lib/i18n.js';
import util from '../../shared/util.cjs';

const { normalizeSettings, UI_LANGS } = util;

// 三语字典必须永远对齐：缺一个 key，切到那种语言时界面就会露出一串原始 key。
// 这个测试是硬门槛 —— 加文案时三个文件一起加，否则这里红。
const ja = (await import('../../src/lib/i18n.ja.json')).default;
const zh = (await import('../../src/lib/i18n.zh.json')).default;
const DICTS = { en: EN, ja, zh };

describe('i18n 字典对齐', () => {
  it('en / ja / zh 的 key 数量一致', () => {
    const n = Object.keys(EN).length;
    expect(Object.keys(ja).length).toBe(n);
    expect(Object.keys(zh).length).toBe(n);
  });

  for (const [lang, dict] of Object.entries(DICTS)) {
    it(`${lang} 不缺 en 里的任何 key`, () => {
      const missing = Object.keys(EN).filter((k) => !(k in dict));
      expect(missing).toEqual([]);
    });
    it(`${lang} 没有多余的孤儿 key`, () => {
      const extra = Object.keys(dict).filter((k) => !(k in EN));
      expect(extra).toEqual([]);
    });
    it(`${lang} 没有空值`, () => {
      const blank = Object.keys(dict).filter((k) => !String(dict[k]).trim());
      expect(blank).toEqual([]);
    });
  }

  it('每种语言的占位符集合一致（{v} / {name} 这类不能漏）', () => {
    const holders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const k of Object.keys(EN)) {
      const want = holders(EN[k]);
      expect({ k, h: holders(ja[k]) }).toEqual({ k, h: want });
      expect({ k, h: holders(zh[k]) }).toEqual({ k, h: want });
    }
  });
});

describe('语言切换', () => {
  it('UI_LANGS 里的每种语言都能切且取到真文案', () => {
    for (const lang of UI_LANGS) {
      setLang(lang);
      expect(t('char.genBtn')).toBeTruthy();
      expect(t('char.genBtn')).not.toBe('char.genBtn');
      expect(t('char.genBtn')).toBe(DICTS[lang]['char.genBtn']);
    }
    setLang('en');
  });

  it('未知语言回落到 en，不会抛异常', () => {
    setLang('kl');
    expect(t('char.genBtn')).toBe(EN['char.genBtn']);
    setLang('en');
  });

  it('persona.system 是三语各自成篇，不是照抄英文', () => {
    expect(ja['persona.system']).not.toBe(EN['persona.system']);
    expect(zh['persona.system']).not.toBe(EN['persona.system']);
    expect(zh['persona.system']).toContain('{lang}');
  });

  it('applyI18n 在没有 document 时安全返回（服务端/测试环境）', () => {
    expect(typeof document).toBe('undefined');
    expect(() => applyI18n()).not.toThrow();
  });

  it('持久化设置里的语言会被 normalizeSettings 保留', () => {
    for (const lang of UI_LANGS) {
      expect(normalizeSettings({ language: lang }).language).toBe(lang);
    }
  });
});
