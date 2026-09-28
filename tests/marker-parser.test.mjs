import { describe, it, expect } from 'vitest';
import { createMarkerParser, stripMarkers, collectMarkers } from '../src/lib/marker-parser.js';

/** 跑一段分片输入，返回 { text, markers } */
function run(chunks) {
  let text = '';
  const markers = [];
  const p = createMarkerParser({ onText: (s) => { text += s; }, onMarker: (m) => markers.push(m) });
  for (const c of chunks) p.push(c);
  p.end();
  return { text, markers };
}

describe('marker-parser', () => {
  it('纯文本原样通过', () => {
    const r = run(['你好呀', '，今天过得怎么样？']);
    expect(r.text).toBe('你好呀，今天过得怎么样？');
    expect(r.markers).toHaveLength(0);
  });

  it('规范写法 <|kind:value|>：摘掉标记，正文不受影响', () => {
    const r = run(['好的<|motion:Tap|>，这就来']);
    expect(r.text).toBe('好的，这就来');
    expect(r.markers[0]).toMatchObject({ kind: 'motion', value: 'Tap' });
  });

  it('线上写法 <{\'|\'}kind:value{\'|\'}>：同样识别', () => {
    const r = run(["好的<{'|'}motion:Tap{'|'}>，这就来"]);
    expect(r.text).toBe('好的，这就来');
    expect(r.text).not.toContain("{'|'}");
    expect(r.markers[0]).toMatchObject({ kind: 'motion', value: 'Tap' });
  });

  it('两种写法混用也没问题', () => {
    const r = run(["A<|motion:Wave|>B<{'|'}expr:Happy{'|'}>C"]);
    expect(r.text).toBe('ABC');
    expect(r.markers.map((m) => m.kind + ':' + m.value)).toEqual(['motion:Wave', 'expr:Happy']);
  });

  it('标记被切在两个 chunk 中间也能正确解析（关键回归）', () => {
    const r = run(['好的<|mo', 'tion:Tap|>，走起']);
    expect(r.text).toBe('好的，走起');
    expect(r.text).not.toContain('<|');
    expect(r.markers).toHaveLength(1);
    expect(r.markers[0]).toMatchObject({ kind: 'motion', value: 'Tap' });
  });

  it('线上写法被切开也要能解析（含切在 {\'|\'} 中间）', () => {
    expect(run(["好的<{'|", "'}motion:Tap{'|'}>", '，走起']).text).toBe('好的，走起');
    expect(run(["<{'|'}expr:Happy{", "'|'}>好"]).markers[0]).toMatchObject({ kind: 'expr', value: 'Happy' });
  });

  it('逐字符喂进去也不能漏', () => {
    const src = "A<|expr:Happy|>B<{'|'}motion:Wave{'|'}>C";
    const r = run(src.split(''));
    expect(r.text).toBe('ABC');
    expect(r.markers.map((m) => m.kind + ':' + m.value)).toEqual(['expr:Happy', 'motion:Wave']);
  });

  it('标记用空格分隔也认（kind value）', () => {
    expect(run(['嗯<|act happy|>好']).markers[0]).toMatchObject({ kind: 'act', value: 'happy' });
  });

  it('标记在开头 / 结尾', () => {
    expect(run(["<{'|'}expr:Angry{'|'}>哼"]).text).toBe('哼');
    expect(run(["哼<{'|'}expr:Angry{'|'}>"]).text).toBe('哼');
  });

  it('不闭合的标记当正文吐出来，不能吞字', () => {
    expect(run(['你看这个 <|motion']).text).toBe('你看这个 <|motion');
    expect(run(["你看这个 <{'|'}motion"]).text).toBe("你看这个 <{'|'}motion");
    expect(run(['你看这个 <|motion']).markers).toHaveLength(0);
  });

  it('普通的小于号不会被误判成标记', () => {
    expect(run(['a < b', ' and c']).text).toBe('a < b and c');
    expect(run(['1 < 2 > 0']).text).toBe('1 < 2 > 0');
    expect(run(['if (a < b) return']).markers).toHaveLength(0);
  });

  it('stripMarkers 两种写法都能清干净', () => {
    expect(stripMarkers('好看<|expr:Smile|>！')).toBe('好看！');
    expect(stripMarkers("好看<{'|'}expr:Smile{'|'}>！")).toBe('好看！');
  });

  it('collectMarkers 拿到全部标记', () => {
    const m = collectMarkers("a<|motion:Tap|>b<{'|'}expr:Happy{'|'}>c");
    expect(m.map((x) => x.kind)).toEqual(['motion', 'expr']);
  });

  it('空输入不炸', () => {
    expect(run(['', '', null, undefined]).text).toBe('');
  });
});
