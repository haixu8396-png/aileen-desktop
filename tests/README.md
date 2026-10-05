# tests 目录结构

按「测什么」分类，而不是按文件大小。

| 目录 | 放什么 | 判据 |
| --- | --- | --- |
| `unit/` | 纯逻辑单测 | **不碰磁盘、不起进程、不打网络** |
| `unit/agent/` | Agent 的纯逻辑（解析、权限、上下文拼装） | 同上 |
| `integration/` | 需要真实环境才能验的 | 会读写临时目录 / 起子进程 / 打本地 HTTP |
| `e2e/` | 打包产物、真实 Electron 行为 | 目前由 `AILEEN_SELFTEST=1` 的**真机自检**承担（见下） |
| `fixtures/` | 测试数据 | 供上面几类共用 |
| `self-test/` | 真机自检的产物与说明 | 不是 vitest 用例 |

## 关于 e2e

这个项目的 e2e 不是假浏览器，而是 **真的把 Electron 跑起来**：主进程挂上
`src/main/self-test.cjs`，加载界面、操作 DOM、截图、收集几十项断言，把结果写成
`shot.json` / `overlay.json`，然后 CI 逐条核对（见 `.github/workflows/build.yml`）。

跑法：

```powershell
$env:AILEEN_SELFTEST='1'; $env:AILEEN_SELFTEST_DIR='D:\AileenData\shot'
& node_modules\.bin\electron.cmd .
# 产物：shot.png / shot.json / console.log /（可选）overlay.png / overlay.json
```

为什么这么设计：渲染层的排版、鼠标穿透、动画这些**只有真跑起来才看得出来**，
jsdom 里测不出「弹窗盖住了按钮」这类问题（以前真踩过）。

## 加新测试时

- 纯函数 → `unit/`
- 需要临时目录/子进程 → `integration/`
- 只有真机才看得出的（布局、交互、穿透）→ 加进 `src/main/self-test.cjs` 的断言，并在 CI 里加一条核对
