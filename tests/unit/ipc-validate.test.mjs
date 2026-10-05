import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const v = require('../../shared/ipc-validate.cjs');
const { CHANNELS, makeValidatedHandle } = require('../../shared/ipc-schemas.cjs');

// ---------------------------------------------------------------------------
// IPC 参数验证：渲染层是网页环境，**不信任它的输入**。
// 这些用例就是「哪些东西进不来」的清单。
// ---------------------------------------------------------------------------

const clip = (spec, value, field = 'x') => () => spec.parse(value, field);

describe('基础原语', () => {
  it('str：类型/长度/空值', () => {
    expect(v.str({ max: 10 }).parse('abc', 'x')).toBe('abc');
    expect(clip(v.str({ max: 3 }), 'abcd')).toThrow(/太长/);
    expect(clip(v.str({ allowEmpty: false }), '')).toThrow(/不能为空/);
    expect(clip(v.str(), 123)).toThrow(/应为字符串/);
    expect(clip(v.str(), null)).toThrow(/应为字符串/);
  });
  it('bool / int / num：不给默认值时缺省即报错', () => {
    expect(v.bool().parse(true, 'x')).toBe(true);
    expect(clip(v.bool(), 'true')).toThrow(/应为布尔值/);
    expect(v.num({ min: 0, max: 10 }).parse(5, 'x')).toBe(5);
    expect(v.num({ min: 0, max: 10 }).parse('7', 'x')).toBe(7);
    expect(clip(v.num({ min: 0, max: 10 }), 11)).toThrow(/超出范围/);
    expect(clip(v.int(), 1.5)).toThrow(/应为整数/);
    expect(clip(v.num(), NaN)).toThrow(/应为数字/);
  });
  it('bool/int/num 支持默认值（缺省不报错）', () => {
    expect(v.bool({ dflt: false }).parse(undefined, 'x')).toBe(false);
    expect(v.int({ dflt: 3 }).parse(undefined, 'x')).toBe(3);
  });
  it('oneOf 枚举', () => {
    expect(v.oneOf(['a', 'b']).parse('a', 'x')).toBe('a');
    expect(clip(v.oneOf(['a', 'b']), 'c')).toThrow(/只能是/);
  });
  it('arr：类型与长度上限，逐元素校验且报出下标', () => {
    expect(v.arr(v.str({ max: 5 })).parse(['a', 'b'], 'x')).toEqual(['a', 'b']);
    expect(v.arr(undefined).parse(undefined, 'x')).toEqual([]);
    expect(clip(v.arr(undefined, { max: 2 }), [1, 2, 3])).toThrow(/元素太多/);
    expect(clip(v.arr(v.str({ max: 5 })), ['a', 1])).toThrow(/x\[1\]/);
  });
  it('object：字段级校验、未知字段丢弃', () => {
    const spec = v.object({ a: v.str({ max: 5 }), b: v.int({ dflt: 1 }) });
    expect(spec.parse({ a: 'x', evil: 1 }, 'o')).toEqual({ a: 'x', b: 1 });
    expect(() => spec.parse({ a: 'xxxxxx' }, 'o')).toThrow(/o\.a/);
    // 必填字段缺失：应该报错而不是静默给 undefined
    const req = v.object({ a: v.str({ max: 5, allowEmpty: false }) });
    expect(() => req.parse({}, 'o')).toThrow(/o\.a/);
  });
  it('optional：缺省不触发子校验', () => {
    const spec = v.object({ a: v.optional(v.url()) });
    expect(spec.parse({}, 'o')).toEqual({ a: undefined });
    expect(clip(spec, { a: 'not-a-url' }, 'o')).toThrow(/URL/);
  });
  it('any：挡掉不可序列化的类型', () => {
    expect(v.any().parse({ x: 1 }, 'a')).toEqual({ x: 1 });
    expect(clip(v.any(), () => {})).toThrow(/不可序列化/);
  });
});

describe('语义原语：文件名 / URL / 路径 / 命令名', () => {
  it('fileName 挡掉一切路径穿越写法', () => {
    const spec = v.fileName({ max: 64 });
    expect(spec.parse('星野空', 'f')).toBe('星野空');
    for (const bad of ['../secret', '..\\secret', 'a/b', 'a\\b', '..', 'a\0b', 'a:b', 'a|b', 'a?b', 'a*b']) {
      expect(clip(spec, bad), bad).toThrow(v.ValidationError);
    }
  });
  it('fileName 可要求扩展名', () => {
    expect(v.fileName({ ext: '.json' }).parse('a.json', 'f')).toBe('a.json');
    expect(clip(v.fileName({ ext: '.json' }), 'a.txt')).toThrow(/必须以/);
  });
  it('url 只放行 http/https', () => {
    expect(v.url().parse('https://a.com/x', 'u')).toBe('https://a.com/x');
    expect(clip(v.url(), 'javascript:alert(1)')).toThrow(/只允许 http\/https/);
    expect(clip(v.url(), 'file:///etc/passwd')).toThrow(/只允许 http\/https/);
    expect(clip(v.url(), 'not a url')).toThrow(/不是合法 URL/);
    expect(clip(v.url(), '')).toThrow(/不能为空/);
  });
  it('absPath 要求绝对路径且无空字符', () => {
    expect(v.absPath().parse('D:/a/b', 'p')).toBe('D:/a/b');
    expect(v.absPath().parse('/usr/local', 'p')).toBe('/usr/local');
    expect(v.absPath().parse('\\\\server\\share', 'p')).toBe('\\\\server\\share');
    expect(clip(v.absPath(), 'relative/path')).toThrow(/必须是绝对路径/);
    expect(clip(v.absPath(), 'D:/a\0b')).toThrow(/空字符/);
  });
  it('commandName 挡掉路径与 shell 元字符', () => {
    expect(v.commandName().parse('npm', 'c')).toBe('npm');
    expect(v.commandName().parse('node.exe', 'c')).toBe('node.exe');
    for (const bad of ['C:/evil.exe', '../../x', 'a;b', 'a&b', 'a|b', 'a`b', 'a$b', 'a>b', 'a\nb', 'a b']) {
      expect(clip(v.commandName(), bad), bad).toThrow(v.ValidationError);
    }
  });
  it('message：role 必须合法', () => {
    expect(v.message().parse({ role: 'user', content: 'hi' }, 'm')).toMatchObject({ role: 'user' });
    expect(clip(v.message(), { role: 'root', content: 'x' })).toThrow(/只能是/);
  });
});

describe('通道规则表本身', () => {
  it('每个规则都是可用的 spec', () => {
    for (const [channel, schema] of Object.entries(CHANNELS)) {
      expect(typeof schema.parse, channel).toBe('function');
    }
  });
  it('关键通道都登记了（漏登记会被 validatedHandle 显式拦下）', () => {
    for (const ch of [
      'settings:get', 'settings:set', 'shell:openPath', 'chat:read', 'chat:write', 'chat:clear',
      'characters:write', 'characters:delete', 'models:delete', 'models:addUrl', 'screen:capture',
      'llm:stream', 'llm:abort', 'tts:fetchAudio', 'stt:transcribe',
      'agent:fs', 'agent:exec', 'agent:input', 'agent:open', 'agent:window',
      'overlay:dragStart', 'mc:connect', 'mc:step',
    ]) {
      expect(CHANNELS[ch], ch).toBeTruthy();
    }
  });
  it('真实攻击样例：这些输入必须进不来', () => {
    const cases = [
      ['chat:read', ['../../../etc/passwd']],
      ['chat:write', [{ file: '../evil', messages: [] }]],
      ['characters:delete', ['..\\..\\Windows\\System32\\config\\SAM']],
      ['shell:openPath', ['relative/not/absolute']],
      ['models:addUrl', [{ url: 'file:///etc/passwd' }]],
      ['llm:stream', [{ requestId: '', messages: [] }]],
      ['llm:stream', [{ requestId: 'r', messages: 'not-an-array' }]],
      ['tts:fetchAudio', [{ text: '' }]],
      ['stt:transcribe', [{ dataBase64: '' }]],
      ['agent:exec', [{ command: 'evil; rm -rf /' }]],
      ['agent:input', [{ op: 'keyboardPress', keys: ['ctrl', 'rm -rf /'] }]],
      ['agent:window', [{ op: 'kill' }]],
      ['agent:fs', [{ op: 'delete', path: 'a' }]],
      ['mc:connect', [{ port: 999999 }]],
      ['mc:step', [{ dir: 'up' }]],
      ['overlay:dragStart', ['unexpected-arg']],
    ];
    for (const [channel, argList] of cases) {
      expect(() => CHANNELS[channel].parse(argList, channel), channel + ' ' + JSON.stringify(argList)).toThrow(v.ValidationError);
    }
  });
});

describe('makeValidatedHandle', () => {
  const mkBase = () => {
    const calls = [];
    const base = (channel, fn) => { calls.push({ channel, fn }); };
    return { calls, base };
  };

  it('校验通过才把清洗后的参数交给业务', () => {
    const { calls, base } = mkBase();
    const h = makeValidatedHandle(base);
    h('chat:read', (_e, file) => file);
    const handler = calls[0].fn;
    expect(handler({ sender: {} }, 'a.json')).toBe('a.json');
  });

  it('校验失败直接抛错，业务函数一行都不执行', () => {
    const { calls, base } = mkBase();
    const h = makeValidatedHandle(base);
    let ran = false;
    h('chat:read', () => { ran = true; });
    expect(() => calls[0].fn({}, '../x')).toThrow(/IPC 参数无效/);
    expect(ran).toBe(false);
  });

  it('未登记的通道必须显式报错（新加 IPC 忘了写校验要当场发现）', () => {
    const { base } = mkBase();
    const h = makeValidatedHandle(base);
    expect(() => h('brand:new', () => {})).toThrow(/未登记参数校验规则/);
  });

  it('校验失败会调日志钩子（便于排查谁在乱调）', () => {
    const { calls, base } = mkBase();
    const seen = [];
    const h = makeValidatedHandle(base, (err, ch) => seen.push([ch, err.field]));
    h('chat:read', () => {});
    expect(() => calls[0].fn({}, '../x')).toThrow();
    expect(seen[0][0]).toBe('chat:read');
    expect(seen[0][1]).toBe('chat:read[0]');
  });

  it('多参数通道逐位校验', () => {
    const { calls, base } = mkBase();
    const h = makeValidatedHandle(base);
    h('mc:step', (_e, payload) => payload);
    expect(calls[0].fn({}, { dir: 'forward', ms: 100 })).toEqual({ dir: 'forward', ms: 100 });
    expect(() => calls[0].fn({}, { dir: 'sideways' })).toThrow(/只能是/);
  });
});
