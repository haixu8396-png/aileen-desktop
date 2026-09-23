# 贡献指南

感谢你想为 AILEEN 出一份力！无论提 Issue、改 Bug、加功能还是写文档，都非常欢迎。

## 本地开发

```bash
npm install          # 安装依赖
npm start            # 构建并启动
```

- 主进程逻辑在 `main.js`，渲染层在 `src/`（Vite 构建）。
- 功能模块在 `src/lib/`：`llm.js`（对话）、`tts.js`、`stt.js`、`characters.js`（角色卡）、`settings.js`、`markdown.js`。

## 提交规范

- 一个 PR 只做一件事，描述清楚改动与动机。
- 新功能请同步更新 `README.md`。
- 提交信息建议用 Conventional Commits 风格（`feat:` / `fix:` / `docs:` …）。

## 联系方式

- 💬 微信（维护联系）：`Am112211HGHE`
- 🐧 QQ 讨论群：`815615686`
