import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { xiaomiAsrLang } = require('../../shared/ai-langs.cjs');

describe('xiaomiAsrLang', () => {
  it('zh / en / ja / es / auto 各归各位（不是「非 zh 就 en」）', () => {
    expect(xiaomiAsrLang('zh')).toBe('zh');
    expect(xiaomiAsrLang('en')).toBe('en');
    expect(xiaomiAsrLang('ja')).toBe('ja');
    expect(xiaomiAsrLang('es')).toBe('es');
    expect(xiaomiAsrLang('auto')).toBe('auto');
  });

  it('日语/西语绝不能被当成英语（这正是修复前的 bug）', () => {
    expect(xiaomiAsrLang('ja')).not.toBe('en');
    expect(xiaomiAsrLang('es')).not.toBe('en');
  });

  it('大小写与空值：归一化后处理，未知取值退回 auto 而不是 en', () => {
    expect(xiaomiAsrLang('JA')).toBe('ja');
    expect(xiaomiAsrLang('')).toBe('auto');
    expect(xiaomiAsrLang(null)).toBe('auto');
    expect(xiaomiAsrLang(undefined)).toBe('auto');
    expect(xiaomiAsrLang('fr')).toBe('auto');
    expect(xiaomiAsrLang('fr')).not.toBe('en');
  });
});
