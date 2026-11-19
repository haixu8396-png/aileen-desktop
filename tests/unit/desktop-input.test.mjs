// ============================================================
// 电脑控制输入层单测：SendKeys 转义
//
// 真机踩过的 bug：让 Agent 往记事本里「敲」一段 HTML 代码，
// 代码里的 `{` `}` 被 SendKeys 当成按键组语法，敲到一半就炸了。
// 这一组把「元字符必须转义」「长文本/代码走剪贴板」两条钉住。
// ============================================================
import { describe, it, expect } from 'vitest';
import { escapeSendKeys, typeScript, clickScript, mouseScript, listWindowsJsonScript } from '../../shared/desktop-input.cjs';

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

describe('鼠标点击脚本', () => {
  it('单击是一对 down/up', () => {
    const s = clickScript({ button: 'left' });
    expect(s.match(/mouse_event\(0x0002/g)).toHaveLength(1);
    expect(s.match(/mouse_event\(0x0004/g)).toHaveLength(1);
  });

  it('双击发两对 down/up，中间隔一下', () => {
    const s = clickScript({ button: 'left', double: true });
    expect(s.match(/mouse_event\(0x0002/g)).toHaveLength(2);
    expect(s.match(/mouse_event\(0x0004/g)).toHaveLength(2);
    expect(s).toContain('Start-Sleep -Milliseconds 90');
  });

  it('带坐标时先 SetCursorPos，再一次调用里完成移动 + 点击', () => {
    const s = clickScript({ button: 'right', x: 640, y: 360 });
    const move = s.indexOf('SetCursorPos(640, 360)');
    const down = s.indexOf('mouse_event(0x0008');
    expect(move).toBeGreaterThan(-1);
    expect(down).toBeGreaterThan(move);
  });

  it('坐标会取整，不接受非法鼠标键', () => {
    expect(clickScript({ button: 'middle', x: 1.6, y: 2.4 })).toContain('SetCursorPos(2, 2)');
    expect(() => clickScript({ button: 'side' })).toThrow(/未知的鼠标键/);
  });

  it('老的 mouseScript 仍然可用（没坐标的单动作）', () => {
    expect(mouseScript('move', 10, 20)).toContain('SetCursorPos(10, 20)');
    expect(mouseScript('left', 0, 0)).toContain('mouse_event(0x0002');
  });
});

describe('窗口列表脚本', () => {
  it('输出 JSON（带句柄、进程名与矩形），不再是裸标题', () => {
    const s = listWindowsJsonScript();
    expect(s).toContain('ConvertTo-Json');
    expect(s).toContain('MainWindowHandle');
    expect(s).toContain('GetWindowRect');
    expect(s).toContain('process =');
    // 没有窗口时也必须输出合法 JSON，调用方好解析
    expect(s).toContain('Write-Output "[]"');
  });
});
