# ✦ AILEEN

**开源桌面 AI 伴侣 —— 一个会说话、会动、能看见你的屏幕、还能陪你打游戏的二次元角色。全部在你自己电脑上运行。**

[English](./README.md) | [日本語](./README.ja.md) | **简体中文**

[![License](https://img.shields.io/badge/license-MIT-ff7eb3.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-38b0de.svg)](#安装)
[![Electron](https://img.shields.io/badge/electron-44-9aa0b4.svg)](https://www.electronjs.org/)
[![Tests](https://img.shields.io/badge/tests-39%20passing-4ecdc4.svg)](./tests)
[![Languages](https://img.shields.io/badge/languages-EN%20%7C%20JA%20%7C%20ZH-a78bfa.svg)](#界面语言)

[下载最新版](../../releases/latest) · [更新日志](./CHANGELOG.md) · [参与贡献](./CONTRIBUTING.md) · [安全策略](./SECURITY.md)

---

AILEEN 把**一个 Live2D 角色请进你的桌面**，并给了它脑子、声音、眼睛和手脚。它不是浏览器标签页里的聊天机器人 —— 它是住在你窗口旁边的小小伴侣：记得你们聊过什么，能陪你进 Minecraft，也能陪你下一盘棋。

所有数据都留在本地：API Key、聊天记录、角色卡、模型，一律不出你的电脑。不需要注册账号，没有遥测，中间也没有第三方服务器。

> 灵感来自 [moeru-ai/Airi](https://github.com/moeru-ai/airi) 与 AI 主播 [Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA)。

## 能做什么

| | |
| --- | --- |
| 🎀 **Live2D 看板娘** | 内置 Cubism 2/3/4 运行时。会眨眼、会呼吸、会做动作、会换表情，**朗读时嘴巴跟着动**。 |
| 💬 **用你自己的模型** | DeepSeek / OpenAI / Moonshot / 硅基流动 / Groq / 智谱 / 阿里百炼 / 小米 MiMo / OpenRouter / 本地 Ollama。流式输出，每个角色可单独写人设。 |
| 🎙 **真正的语音对话** | 说话 → 识别 → 角色回答 → 朗读 → 继续听。不用一直按着按钮，可以一直聊下去。 |
| 📷 **它能看见你的屏幕** | 选择任意窗口或显示器，作为图片发给角色，它就能对你正在看的东西发表意见。 |
| 🪟 **无边框悬浮展台** | 把角色放进一个透明、无边框、始终置顶的独立窗口。**默认整窗鼠标穿透**，绝不挡住下面的窗口。工具条在你伸手去用时才浮现，停手就淡出。 |
| 🎮 **Minecraft 伙伴** | 角色以机器人身份进入 Java 版服务器：跟着你走、接受手动操控、在聊天栏说话；开启自动回复后，会用**你自己的 LLM** 和当前角色的人设回应其他玩家。 |
| ♟ **国际象棋** | 五档难度、执白或执黑、悔棋、翻转棋盘，还能让角色实时点评棋局。 |
| 🗂 **角色卡** | 新建 / 编辑 / 复制 / 导入 / 导出，每张卡可绑定专属模型与音色。 |
| 🎨 **外观调色** | 六套预设，也可自定义主辅色。 |

## 界面语言

内置三种语言，**启动默认英文**：

| 语言 | 完成度 |
| --- | --- |
| English | 默认 —— 303 条文案全部翻译 |
| 日本語 | 303 条文案全部翻译 |
| 简体中文 | 303 条文案全部翻译 |

随时在 **设置 → 🌐 Language** 或原生菜单（按 `Alt`）里切换。**原生应用菜单本身也已翻译**。

## 安装

到 [Releases](../../releases) 下载最新版：

| 文件 | 说明 |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **安装版（推荐）** —— 自动创建桌面与开始菜单快捷方式 |
| `AILEEN x.x.x.exe` | **免安装便携版** —— 双击即用，不写注册表 |

支持 Windows 10 / 11（64 位）。

## 从源码运行

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start
```

需要 Node.js 18 或更高版本。首次运行会下载 Electron；如果太慢，可以先把 `ELECTRON_MIRROR` 指向国内镜像。
Windows 用户也可以直接双击 `install.bat`。

## 自己打包安装包

```bash
npm run dist      # 生成 NSIS 安装包 + 便携版到 release/
npm test          # 39 项单元测试
```

Windows 上双击 `build-installer.bat` 效果相同。

## 项目结构

```
main.js                 Electron 主进程 —— 窗口、IPC、设置、本地模型服务器
preload.js              contextBridge 暴露的 API
mc-bot.cjs              Minecraft 机器人（mineflayer）
shared/                 主进程与测试共用的纯函数
  util.cjs              设置的字段白名单与校验
  menu-i18n.cjs         原生菜单的翻译
src/                    渲染层（原生 JS + Vite）
  main.js               渲染层入口与事件装配
  overlay.html|js|css   无边框悬浮展台窗口
  lib/                  控制器 —— state, dom, stage, chat, characters-ui,
                        modals, voice, minecraft, chess, i18n
  lib/i18n.ja.json      日文词典
  lib/i18n.zh.json      简体中文词典
tests/                  vitest 单元测试
```

## 质量门禁

CI 不过就不发版。每次打 tag 都会跑：

1. **39 项单元测试** —— 其中包含人格提示词回归测试：验证 Minecraft 与象棋用的是**你的角色卡**而不是软件自带人格，并且提示词跟随界面语言。
2. **开发版自检** —— 无运行时错误；所有设置弹窗都能打开；关闭子页面会退回上级菜单；外观调色点取消会还原预览；Minecraft IPC 有响应；棋盘渲染出 64 格；**零漏翻**；切换语言确实改变了界面；「正在思考」指示器处于隐藏状态。
3. **打包产物自检** —— 对着构建好的 `.exe` 重跑以上全部检查，另外还要求：悬浮展台**默认鼠标穿透**、交互手柄避开窗口的缩放边界、`mineflayer` / `mineflayer-pathfinder` 能从 asar 内成功加载。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。

随包分发的第三方作品：[mineflayer](https://github.com/PrismarineJS/mineflayer) 与 [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)（MIT）、[minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol)（BSD-3-Clause）、[js-chess-engine](https://github.com/josefjadrny/js-chess-engine)（MIT）、[oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d)（MIT）、[DOMPurify](https://github.com/cure53/DOMPurify)（Apache-2.0 或 MIT）。Live2D Cubism Core 运行时适用 Live2D 公司自己的许可条款。
