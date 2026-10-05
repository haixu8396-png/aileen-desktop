import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const secrets = require('../../shared/secrets.cjs');
const { SECRET_CLEAR, SECRET_PREFIX, redactSecrets, isEncryptedSecret, isPlaintextSecret, resolveSecretPatch } = secrets;

describe('redactSecrets', () => {
  const full = { llm: { apiKey: 'sk-abc', model: 'm' }, tts: { apiKey: '' }, stt: { apiKey: 'sk-x' }, language: 'zh' };

  it('三个密钥都清空，只留 apiKeySet 标记', () => {
    const out = redactSecrets(full);
    expect(out.llm.apiKey).toBe('');
    expect(out.llm.apiKeySet).toBe(true);
    expect(out.tts.apiKeySet).toBe(false);
    expect(out.stt.apiKeySet).toBe(true);
  });

  it('明文一个字节都不留在返回值里，且不改动入参', () => {
    const out = redactSecrets(full);
    expect(JSON.stringify(out)).not.toContain('sk-abc');
    expect(JSON.stringify(out)).not.toContain('sk-x');
    expect(out.llm.model).toBe('m');
    expect(out.language).toBe('zh');
    expect(full.llm.apiKey).toBe('sk-abc');
  });

  it('空设置也安全', () => {
    expect(redactSecrets(null).llm).toBeUndefined();
    expect(() => redactSecrets(undefined)).not.toThrow();
  });
});

describe('resolveSecretPatch', () => {
  const current = { llm: { apiKey: 'stored' }, tts: { apiKey: 'stored-tts' }, stt: { apiKey: '' } };

  it('空字符串 = 保持不变（表单留空不该抹掉密钥）', () => {
    const out = resolveSecretPatch({ llm: { apiKey: '', model: 'x' } }, current);
    expect(out.llm.apiKey).toBe('stored');
    expect(out.llm.model).toBe('x');
  });

  it('缺字段 = 保持不变', () => {
    expect(resolveSecretPatch({ llm: { model: 'x' } }, current).llm.apiKey).toBe('stored');
  });

  it('哨兵 = 清除', () => {
    expect(resolveSecretPatch({ llm: { apiKey: SECRET_CLEAR } }, current).llm.apiKey).toBe('');
  });

  it('新值 = 覆盖', () => {
    const out = resolveSecretPatch({ llm: { apiKey: 'sk-new' }, stt: { apiKey: 'sk-stt' } }, current);
    expect(out.llm.apiKey).toBe('sk-new');
    expect(out.stt.apiKey).toBe('sk-stt');
  });

  it('没提到的分组干脆不进 patch（合并时自然保持原值，不会被写成空）', () => {
    const out = resolveSecretPatch({ llm: { apiKey: 'sk-new' } }, current);
    expect(out.tts).toBeUndefined();
    // 真要合并时用的语义：patch 里没有的键，合并后保留 current 的值
    expect(Object.assign({}, current, out).tts.apiKey).toBe('stored-tts');
  });

  it('只读标记不会被打回文件', () => {
    const out = resolveSecretPatch({ llm: { apiKey: '', apiKeySet: true }, secretsEncrypted: true }, current);
    expect(out.llm.apiKeySet).toBeUndefined();
    expect(out.secretsEncrypted).toBeUndefined();
  });

  it('不改动入参', () => {
    const patch = { llm: { apiKey: '' } };
    resolveSecretPatch(patch, current);
    expect(patch.llm.apiKey).toBe('');
  });
});

describe('密文判定', () => {
  it('safe:v1: 前缀才算密文', () => {
    expect(isEncryptedSecret(SECRET_PREFIX + 'AAAA')).toBe(true);
    expect(isEncryptedSecret('sk-plaintext')).toBe(false);
    expect(isEncryptedSecret('')).toBe(false);
    expect(isEncryptedSecret(null)).toBe(false);
  });

  it('需要迁移的只有非空明文', () => {
    expect(isPlaintextSecret('sk-old')).toBe(true);
    expect(isPlaintextSecret(SECRET_PREFIX + 'AAAA')).toBe(false);
    expect(isPlaintextSecret('')).toBe(false);
    expect(isPlaintextSecret(undefined)).toBe(false);
  });
});
