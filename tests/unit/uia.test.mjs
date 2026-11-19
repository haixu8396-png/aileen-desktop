// ============================================================
// UIA 桥（shared/uia.cjs）单测
//
// 这些脚本只能在 Windows 上真机跑，所以这里钉三件事：
//   · 脚本用的是 .NET 自带 UIAutomationClient（零新依赖）
//   · 输入（标题/文本/选择器）走 base64 或 JSON，不拼进 PowerShell 字符串
//   · 输出是**一行 JSON**，Node 侧只解析 JSON
// ============================================================
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const uia = require('../../shared/uia.cjs');

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

describe('控件树', () => {
  it('用系统自带 UIAutomationClient，不引入新依赖', () => {
    const s = uia.treeScript({});
    expect(s).toContain('Add-Type -AssemblyName UIAutomationClient');
    expect(s).toContain('Add-Type -AssemblyName UIAutomationTypes');
    expect(s).toContain('$AE::RootElement');
  });

  it('有深度和节点数上限（UIA 树可以上万节点）', () => {
    expect(uia.treeScript({ depth: 2 })).toContain('if ($level -ge 2)');
    expect(uia.treeScript({ maxNodes: 50 })).toContain('$script:count -ge 50');
  });

  it('深度和节点数被收敛到安全范围', () => {
    expect(uia.treeScript({ depth: 99 })).toContain('if ($level -ge 6)');
    expect(uia.treeScript({ maxNodes: 99999 })).toContain('$script:count -ge 400');
    expect(uia.treeScript({ depth: 0 })).toContain('if ($level -ge 1)');
  });

  it('窗口标题走 base64（中文/引号不会被 PowerShell 吃掉）', () => {
    const act = uia.actScript({ selector: { name: '他说"你好"' }, action: 'invoke' });
    expect(act).toContain(b64('他说"你好"'));
  });

  it('输出 JSON，并且空树也给 []', () => {
    const s = uia.treeScript({});
    expect(s).toContain('ConvertTo-Json -Compress');
    expect(s).toContain('Write-Output "[]"');
  });
});

describe('控件动作', () => {
  it('支持 5 种语义 Pattern + 点击回退', () => {
    const s = uia.actScript({ selector: { name: 'OK' }, action: 'invoke' });
    for (const p of ['InvokePattern', 'ValuePattern', 'SelectionItemPattern', 'TogglePattern', 'ExpandCollapsePattern']) {
      expect(s).toContain(p);
    }
    expect(s).toContain('fallback = "click"');
  });

  it('setValue 的文本走 base64', () => {
    const s = uia.actScript({ selector: { automationId: 'edit' }, action: 'setValue', value: 'a{b}"c' });
    expect(s).toContain(b64('a{b}"c'));
  });

  it('找不到控件时输出 not-found（Node 侧据此报错，不假装成功）', () => {
    expect(uia.actScript({ selector: { name: 'x' } })).toContain('not-found');
  });

  it('选择器支持 name / nameContains / automationId / role / index', () => {
    const f = uia.selectorFilter({ name: 'n', nameContains: 'c', automationId: 'a', role: 'Button', index: 2 });
    expect(f.filter).toContain('$_.name -eq $selName');
    expect(f.filter).toContain('$_.name -like "*$selNameLike*"');
    expect(f.filter).toContain('$_.automationId -eq $selAid');
    expect(f.filter).toContain('$_.role -eq $selRole');
    expect(f.index).toBe(2);
  });

  it('空选择器 = 第一个控件（$true），不会拼出非法表达式', () => {
    expect(uia.selectorFilter({}).filter).toBe('$true');
    expect(uia.selectorFilter({}).index).toBe(0);
  });
});

describe('窗口控制与前台窗口', () => {
  it('minimize/maximize/restore 用 ShowWindow 的对应常量', () => {
    expect(uia.windowControlScript({ op: 'minimize', title: 'x' })).toContain('ShowWindow($hwnd, 6)');
    expect(uia.windowControlScript({ op: 'maximize', title: 'x' })).toContain('ShowWindow($hwnd, 3)');
    expect(uia.windowControlScript({ op: 'restore', title: 'x' })).toContain('ShowWindow($hwnd, 9)');
  });

  it('close 是发 WM_CLOSE（让应用自己弹保存提示），不是强杀', () => {
    const s = uia.windowControlScript({ op: 'close', title: 'x' });
    expect(s).toContain('0x0010');
    expect(s).not.toContain('kill');
    expect(s).not.toContain('Stop-Process');
  });

  it('未知窗口操作直接抛错', () => {
    expect(() => uia.windowControlScript({ op: 'explode', title: 'x' })).toThrow(/未知的窗口操作/);
  });

  it('前台窗口信息带 id/标题/进程/矩形', () => {
    const s = uia.activeWindowScript();
    expect(s).toContain('GetForegroundWindow');
    expect(s).toContain('process = $proc');
    expect(s).toContain('ConvertTo-Json -Compress');
  });
});
