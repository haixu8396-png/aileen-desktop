# ✦ AILEEN

[English](./README.md) · [日本語](./README.ja.md) · **简体中文**

[![License](https://img.shields.io/badge/license-MIT-ff7eb3.svg)](./LICENSE)
[![Downloads](https://img.shields.io/github/downloads/haixu8396-png/aileen-desktop/total?color=38b0de)](../../releases)
[![Platform](https://img.shields.io/badge/platform-Windows-9aa0b4.svg)](#安装)
[![Languages](https://img.shields.io/badge/languages-English%20%C2%B7%20日本語%20%C2%B7%20简体中文-a78bfa.svg)](#界面语言)

### 一个真正属于你的桌面伙伴。

AILEEN 做的事很简单：把「一个角色」放到你的桌面上。不是聊天窗口，而是一个**存在**——一个会呼吸、会眨眼、会看向你、会用你挑的声音开口说话的 Live2D 形象。它是什么样的人由你写，话怎么说由它定。

聊完了，它会跟着你进 Minecraft；也可以坐到棋盘对面，陪你下一局。

不用注册账号，不经过云端。聊天记录、API Key、角色卡，全都不会离开你的电脑。

---

## 给它一副身体

放进任意一个 Live2D 模型（Cubism 2 / 3 / 4），它就成了你伙伴的脸。会待机呼吸、会眨眼、会做动作、会换表情，**说话的时候嘴巴跟着动**。可以从文件夹导入，也可以直接填个网址加载。

## 给它一副嗓子

按下麦克风直接说话，它出声回答，然后继续听——一段可以一直持续下去的真正语音对话；想打字的时候，也可以只用单次语音输入。四种语音引擎：系统语音、任何 OpenAI 兼容接口、能克隆音色的 Fish Audio、小米 MiMo，覆盖中文、英语、日语、西班牙语。

## 给它一个脑子

你已经在付费用的模型，直接拿来用：DeepSeek / OpenAI / Moonshot / 硅基流动 / Groq / 智谱 / 阿里百炼 / 小米 MiMo / OpenRouter。想彻底离线，接本地 Ollama 也行。

每张角色卡都有自己的名字、头像、性格、场景、开场白和示例对话。同一个模型，两张卡就能是**完全不同的两个人**。而且 **Minecraft 和象棋用的是同一份人格**——在聊天里爱损你的那个它，进了游戏还是那个它。

## 给它一双眼睛

把任意窗口或显示器的截图丢给它，问问它怎么看。调 bug 的时候有用，读图表的时候有用，一起吐槽 BOSS 战的时候也有用。

## 然后，让它走出聊天框

**Minecraft。** 角色会以机器人身份进入 Java 版服务器：跟着你走、接受手动操控、在服务器聊天栏说话；打开自动回复后，**它还会用自己的语气去回别的玩家**。站在山坡上看它手忙脚乱地追你，是真的好笑。

**国际象棋。** 五档难度、执白或执黑、悔棋、翻转棋盘，还能让它在你落子时实时点评局面。

## 再让它走出窗口

**无边框悬浮展台**把角色从应用里拎出来，放到桌面上：一个无边框、透明、始终置顶的窗口，里面除了你的角色什么都没有。

它**默认整窗鼠标穿透**，绝不抢走底下窗口的点击。那个小小的手柄只在你伸手去够的时候浮现，手一停就淡出。位置、大小随你摆弄，它都记得。

---

## 安装

到 **[Releases](../../releases)** 下载最新版。

| | |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **安装版** —— 自动创建桌面与开始菜单快捷方式，推荐。 |
| `AILEEN x.x.x.exe` | **免安装便携版** —— 双击即用，不写注册表。 |

支持 Windows 10 / 11（64 位）。

## 界面语言

完整支持 **English / 日本語 / 简体中文** 三种语言——是全部翻完，不是翻一半。启动默认英文。

随时在 **设置 → 🌐 Language** 或原生菜单（按 `Alt`）里切换。应用菜单本身也已翻译。

> 想加第四种语言？所有文案都在 `src/lib/i18n.js` 和每种语言一个 JSON 文件里，欢迎提 PR。

## 从源码运行

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start
```

需要 Node.js 18 或更高。首次运行会下载 Electron；觉得慢可以先把 `ELECTRON_MIRROR` 指向国内镜像。Windows 用户也可以直接双击 `install.bat`。

## 自己打包安装包

```bash
npm run dist      # 生成安装包 + 便携版到 release/
npm test          # 单元测试
```

Windows 上双击 `build-installer.bat` 效果相同。

## 里面是怎么搭的

```
main.js               Electron 主进程（窗口 / IPC / 设置 / 本地模型服务器）
preload.js            contextBridge 暴露的 API
mc-bot.cjs            Minecraft 机器人
shared/               主进程与测试共用的代码
src/                  界面部分
  main.js             入口与事件装配
  overlay.*           无边框悬浮展台窗口
  lib/                state, dom, stage, chat, characters, modals, voice,
                      minecraft, chess, i18n
  lib/i18n.ja.json    日文文案
  lib/i18n.zh.json    简体中文文案
tests/                单元测试
```

运行时不从外部拉取任何东西，也不向任何地方上报。模型和头像由一个很小的本地 HTTP 服务提供（因为 Live2D 的 WebAssembly 和贴图在 `file://` 下读不了），这个服务永远不会监听你电脑以外的地址。

## 致谢

AILEEN 站在很多人的成果之上，在此一并致谢：

- [mineflayer](https://github.com/PrismarineJS/mineflayer) 与 [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) —— MIT
- [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) —— BSD-3-Clause
- [js-chess-engine](https://github.com/josefjadrny/js-chess-engine) —— MIT
- [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d) —— MIT
- [DOMPurify](https://github.com/cure53/DOMPurify) —— Apache-2.0 或 MIT

Live2D Cubism Core 运行时适用 Live2D 公司自己的许可条款；你添加的每个 Live2D 模型也各有各的规约，请尊重原作者的意愿。

灵感来自 [moeru-ai/Airi](https://github.com/moeru-ai/airi) 与 AI 主播 [Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA)。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
