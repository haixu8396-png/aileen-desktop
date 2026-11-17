// ============================================================
// 电脑控制输入层单测：SendKeys 转义
//
// 真机踩过的 bug：让 Agent 往记事本里「敲」一段 HTML 代码，
// 代码里的 `{` `}` 被 SendKeys 当成按键组语法，敲到一半就炸了。
// 这一组把「元字符必须转义」「长文本/代码走剪贴板」两条钉住。
// ============================================================
import { describe, it, expect } from 'vitest';
import { escapeSendKeys, typeScript } from '../../shared/desktop-input.cjs';

describe('SendKeys 转义', () => {
  it('普通文字原样输出', () => {
    expect(escapeSendKeys('hello world')).toBe('hello world');
    expect(escapeSendKeys('你好')).toBe('你好');
  });

  it('花括号被转义，不会被当成按键组', () => {
    expect(escapeSendKeys('function() {}')).toBe('function{(}{)} {{}{}}');
    expect(escapeSendKeys('{')).toBe('{{}');
    expect(escapeSendKeys('}')).toBe('{}}');
  });

  it('修饰键字符（^ % + ~）也被转义', () => {
    expect(escapeSendKeys('a^b')).toBe('a{^}b');
    expect(escapeSendKeys('100%')).toBe('100{%}');
    expect(escapeSendKeys('1+1')).toBe('1{+}1');
    expect(escapeSendKeys('~')).toBe('{~}');
  });

  it('方括号也转义（SendKeys 里同样是特殊字符）', () => {
    expect(escapeSendKeys('[x]')).toBe('{[}x{]}');
  });

  it('换行变成 {ENTER}，回车符丢掉', () => {
    expect(escapeSendKeys('a\nb')).toBe('a{ENTER}b');
    expect(escapeSendKeys('a\r\nb')).toBe('a{ENTER}b');
    expect(escapeSendKeys('a\tb')).toBe('a{TAB}b');
  });
});

describe('typeScript 走哪条路', () => {
  it('代码（含花括号/换行）走剪贴板粘贴，不用 SendKeys 逐字敲', () => {
    const script = typeScript('<html>\n<script>if (a) { b() }</script>\n</html>');
    expect(script).toContain('Set-Clipboard');
    expect(script).toContain("SendWait('^v')");
    expect(script).not.toContain('SendWait($t)');
  });

  it('长文本也走剪贴板（SendKeys 逐字发太慢也更容易出错）', () => {
    expect(typeScript('x'.repeat(200))).toContain('Set-Clipboard');
  });

  it('短的单行纯文本仍然走 SendKeys，不碰剪贴板', () => {
    const script = typeScript('hello');
    expect(script).toContain('[System.Windows.Forms.SendKeys]::SendWait($e)');
    expect(script).not.toContain('Set-Clipboard');
  });

  it('原文不会出现在脚本里（引号 / 中文 / 元字符都不进 PowerShell）', () => {
    const text = '他说："你好" & 再见';
    const script = typeScript(text);
    expect(script).not.toContain(text);
    expect(script).toContain(Buffer.from(text, 'utf8').toString('base64'));
  });

  it('文字仍然用 base64 传，避免引号与中文被 PowerShell 吃掉', () => {
    const script = typeScript('他说"早上好"');
    expect(script).toContain('[Convert]::FromBase64String');
  });
});
