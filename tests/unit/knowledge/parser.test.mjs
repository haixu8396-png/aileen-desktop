// ============================================================
// parser：txt / md / html / json / pdf 五种格式的提取与容错
//
// PDF 样本全部**现场用 Node 造**（zlib.deflateSync 压一个带文本的流），
// 不引第三方库、不读外部文件。
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  parse, parseTxt, parseMarkdown, parseHtml, parseJson, parsePdf,
  stripHtml, decodeEntities, cleanText, decodeBytes, formatWarnings, PDF_WARNING,
} from '../../../src/knowledge/parser.js';
import { buildSimplePdf, PDF_CONTENT, utf8AsLatin1 } from './helpers.mjs';

describe('parser / txt', () => {
  it('读纯文本，第一行当标题', () => {
    const r = parseTxt('安装说明\n\n第一步：解压。\n第二步：运行。');
    expect(r.format).toBe('txt');
    expect(r.title).toBe('安装说明');
    expect(r.text).toContain('第二步：运行。');
    expect(r.blocks).toEqual([]);
  });

  it('CRLF 与多余空行被规范化', () => {
    const r = parseTxt('a\r\n\r\n\r\n\r\nb');
    expect(r.text).toBe('a\n\nb');
  });

  it('带 BOM 的 UTF-8 能正确解码（BOM 不进正文）', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('标题\n正文', 'utf8')]);
    const r = parseTxt(buf);
    expect(r.text.startsWith('标题')).toBe(true);
    expect(r.metadata.encoding).toBe('utf8-bom');
  });

  it('parse 按扩展名派发', () => {
    expect(parse('# 标题\n正文', { filename: 'a.md' }).format).toBe('md');
    expect(parse('<p>x</p>', { filename: 'a.html' }).format).toBe('html');
    expect(parse('{"a":1}', { filename: 'a.json' }).format).toBe('json');
    expect(parse('纯文本', { filename: 'a.txt' }).format).toBe('txt');
  });
});

describe('parser / markdown', () => {
  const md = [
    '# 手册',
    '',
    '开头段落。',
    '',
    '## 安装',
    '',
    '第一步。',
    '',
    '```js',
    'const a = 1;',
    '',
    'const b = 2;',
    '```',
    '',
    '## 使用',
    '',
    '第二步。',
  ].join('\n');

  it('取第一个 # 作为文档标题，章节各自带标题', () => {
    const r = parseMarkdown(md);
    expect(r.title).toBe('手册');
    expect(r.blocks.map((b) => b.title)).toEqual(['手册', '安装', '使用']);
    expect(r.blocks[0].text).toContain('开头段落。');
    expect(r.metadata.heading_count).toBe(3);
  });

  it('代码围栏内部原样保留（空格与空行不被折叠）', () => {
    const r = parseMarkdown(md);
    const section = r.blocks.find((b) => b.title === '安装' && b.text.includes('const a'));
    expect(section).toBeTruthy();
    expect(section.text).toContain('const a = 1;\n\nconst b = 2;');
    expect(section.text).toContain('```js');
    expect(section.text.trim().endsWith('```')).toBe(true);
  });

  it('front matter 进元数据、不进正文', () => {
    const r = parseMarkdown('---\ntitle: 我的笔记\ntags: 学习\n---\n\n# 正文标题\n内容');
    expect(r.metadata.front_matter.title).toBe('我的笔记');
    expect(r.text).not.toContain('title: 我的笔记');
  });

  it('未闭合的围栏给 warning 而不是抛错', () => {
    const r = parseMarkdown('# t\n\n```\ncode without end');
    expect(r.warnings.some((w) => w.code === 'markdown-unclosed-fence')).toBe(true);
  });
});

describe('parser / html（自己写的标签剥离器）', () => {
  it('script/style 整段剔除', () => {
    const html = '<html><head><style>p{color:red}</style></head><body><script>var x = "<p>假的</p>";</script><p>真的正文</p></body></html>';
    const r = parseHtml(html);
    expect(r.text).not.toContain('假的');
    expect(r.text).not.toContain('color:red');
    expect(r.text).toContain('真的正文');
  });

  it('实体解码：命名 / 十进制 / 十六进制', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#20013;&#x6587;&nbsp;end')).toBe('a & b <c> 中文 end');
    // 不认识的实体原样保留（猜错比不猜更糟）
    expect(decodeEntities('&unknownent; &amp')).toBe('&unknownent; &amp');
    const r = parseHtml('<p>5 &lt; 6 &amp;&amp; 7 &gt; 6</p>');
    expect(r.text).toBe('5 < 6 && 7 > 6');
  });

  it('属性里的 > 不会让标签提前结束', () => {
    const r = parseHtml('<a href="/x" title="a > b" data-x="1 > 2">链接</a>');
    expect(r.text).toBe('链接');
    expect(r.text).not.toContain('title');
  });

  it('注释、CDATA、自闭合标签、块级标签转换行', () => {
    const html = '<div>第一段<!-- 注释里有 <p> 标签 --><br/>第二段</div><div><![CDATA[原始 <text>]]></div>';
    const r = parseHtml(html);
    expect(r.text).toContain('第一段');
    expect(r.text).not.toContain('注释里有');
    expect(r.text).toContain('原始 <text>');
    expect(r.text.split('\n').length).toBeGreaterThan(1);
  });

  it('取 <title> 作为标题', () => {
    const r = parseHtml('<html><head><title>知识库 &gt; 首页</title></head><body><p>x</p></body></html>');
    expect(r.title).toBe('知识库 > 首页');
  });

  it('pre 变成```围栏（切块器据此保护代码）', () => {
    const r = parseHtml('<pre>line1\n  line2</pre>');
    expect(r.text).toContain('```');
    expect(r.text).toContain('line1');
  });

  it('stripHtml 对畸形输入不抛错', () => {
    expect(() => stripHtml('<p>未闭合 <a href="x')).not.toThrow();
  });
});

describe('parser / json', () => {
  it('展平成可读文本并保留 key 路径', () => {
    const r = parseJson(JSON.stringify({ title: '配置', server: { host: 'localhost', port: 8080 }, tags: ['a', 'b'] }));
    expect(r.metadata.json_keys).toEqual(['title', 'server', 'tags']);
    expect(r.text).toContain('$.server.host: localhost');
    expect(r.text).toContain('$.tags[0]: a');
    expect(r.blocks.map((b) => b.path)).toEqual(['$.title', '$.server', '$.tags']);
    expect(r.title).toBe('配置');
  });

  it('顶层数组：每个元素各成一块', () => {
    const r = parseJson(JSON.stringify([{ q: '问题一', a: '答案一' }, { q: '问题二', a: '答案二' }]));
    expect(r.blocks.length).toBe(2);
    expect(r.blocks[0].path).toBe('$[0]');
    expect(r.blocks[1].text).toContain('答案二');
  });

  it('坏 JSON：给 warning 并降级成纯文本，不抛错', () => {
    const r = parseJson('{ 这不是 json');
    expect(r.warnings.some((w) => w.code === 'json-parse-failed')).toBe(true);
    expect(r.metadata.json_valid).toBe(false);
    expect(r.text).toContain('这不是 json');
  });
});

describe('parser / pdf（自造最小样本）', () => {
  it('FlateDecode 压缩流里的文本能提取出来', () => {
    const pdf = buildSimplePdf({ pages: [PDF_CONTENT.simple] });
    const r = parsePdf(pdf);
    expect(r.text).toContain('Hello Knowledge Base');
    expect(r.blocks.length).toBe(1);
    expect(r.blocks[0].page).toBe(1);
    expect(r.metadata.pages).toBe(1);
  });

  it('未压缩的流也能提取', () => {
    const r = parsePdf(buildSimplePdf({ pages: [PDF_CONTENT.simple], compress: false }));
    expect(r.text).toContain('Hello Knowledge Base');
  });

  it('八进制转义、转义括号、TJ 数组都认', () => {
    const r = parsePdf(buildSimplePdf({ pages: [PDF_CONTENT.escaped, PDF_CONTENT.array] }));
    expect(r.text).toContain('AAB (paren) C');
    expect(r.text).toContain('Alpha');
    expect(r.text).toContain('Beta');
    // TJ 里的大负数按空格处理
    expect(r.text).toMatch(/Alpha\s+Beta/);
  });

  it('多行/多页：页码与顺序正确', () => {
    const r = parsePdf(buildSimplePdf({ pages: [PDF_CONTENT.twoLines, 'BT /F1 12 Tf 72 700 Td (Page two) Tj ET'] }));
    expect(r.blocks.length).toBe(2);
    expect(r.blocks[0].page).toBe(1);
    expect(r.blocks[1].page).toBe(2);
    expect(r.text.indexOf('First line')).toBeLessThan(r.text.indexOf('Second line'));
    expect(r.text).toContain('Page two');
  });

  it('UTF-8 字节存的中文能被启发式还原', () => {
    const r = parsePdf(buildSimplePdf({ pages: [PDF_CONTENT.chinese] }));
    expect(r.text).toContain('你好，知识库系统');
    expect(r.warnings.some((w) => w.code === PDF_WARNING.UTF8_HEURISTIC)).toBe(true);
  });

  it('加密 PDF：返回 warnings + 空文本，绝不抛错', () => {
    const pdf = buildSimplePdf({ pages: [PDF_CONTENT.simple], encrypted: true });
    let r;
    expect(() => { r = parsePdf(pdf); }).not.toThrow();
    expect(r.text).toBe('');
    expect(r.warnings.map((w) => w.code)).toContain(PDF_WARNING.ENCRYPTED);
    expect(formatWarnings(r.warnings)).toContain('加密');
  });

  it('纯图片/无文本层：给 warnings（说明不支持 OCR），文本为空', () => {
    const r = parsePdf(buildSimplePdf({ pages: [PDF_CONTENT.imageOnly], imageOnly: true }));
    expect(r.text).toBe('');
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain(PDF_WARNING.IMAGE_ONLY);
    expect(codes).toContain(PDF_WARNING.NO_TEXT);
  });

  it('不是 PDF 的字节：warning + 空文本，不抛错', () => {
    const r = parsePdf(Buffer.from('这根本不是 PDF 文件', 'utf8'));
    expect(r.text).toBe('');
    expect(r.warnings.map((w) => w.code)).toContain(PDF_WARNING.NOT_PDF);
  });

  it('空 buffer 也不抛错', () => {
    expect(() => parsePdf(Buffer.alloc(0))).not.toThrow();
  });
});

describe('parser / 公共件', () => {
  it('cleanText 清控制字符、折叠空白但保留段落', () => {
    expect(cleanText('a\u0000b\u0007  c\n\n\n\nd')).toBe('ab c\n\nd');
  });

  it('decodeBytes 支持 UTF-16LE BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')]);
    expect(decodeBytes(buf).text).toBe('中文');
  });

  it('未知扩展名不参与派发（由 sources 层负责拒绝）', () => {
    // parse 本身只按 format/filename 走，认不出就当 txt —— 拒绝发生在 sources.js
    expect(parse('x', { filename: 'a.unknownext' }).format).toBe('txt');
  });
});
