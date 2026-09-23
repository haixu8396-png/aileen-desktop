# ✦ AILEEN — Open-source desktop AI companion

<div align="center">

**English** · [日本語](#-日本語) · [简体中文](#-简体中文)

[![License: MIT](https://img.shields.io/badge/License-MIT-ff7eb3.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-38b0de.svg)](#-install)
[![Electron](https://img.shields.io/badge/Electron-44-9aa0b4.svg)](https://www.electronjs.org/)
[![i18n](https://img.shields.io/badge/i18n-EN%20%7C%20JA%20%7C%20ZH-a78bfa.svg)](#-languages)

[⬇️ Download](../../releases/latest) · [📋 Changelog](./CHANGELOG.md) · [🤝 Contributing](./CONTRIBUTING.md) · [🔒 Security](./SECURITY.md)

</div>

---

## 📖 What is AILEEN

AILEEN brings a **character that talks, moves and sees your screen** onto your desktop. Everything runs locally — your API keys, chat logs, character cards and models never leave your machine.

- 💬 **Multi-provider chat** — DeepSeek, OpenAI, Moonshot, SiliconFlow, Groq, Zhipu, Alibaba Bailian, Xiaomi MiMo, OpenRouter and local Ollama, with streaming replies.
- 🎀 **Live2D avatar** — Cubism 2/3/4 runtime included. Your character reacts, plays motions and changes expressions while speaking.
- 🎙 **Live voice mode** — speak → transcribe → reply → read aloud → keep listening, in one continuous loop.
- 🔊 **TTS** — system voice / OpenAI-compatible / Fish Audio / Xiaomi MiMo, in Chinese, English, Japanese and Spanish.
- 🎤 **STT** — Whisper-compatible / Xiaomi MiMo ASR / browser recognition.
- 📷 **Screen vision** — send a screenshot to the character so it can actually look at your screen.
- 🗂 **Character cards** — create, edit, duplicate, import and export; bind a model and a voice to each card.
- 🪟 **Borderless floating stage** — float the character in a frameless, transparent, always-on-top window. It is **click-through by default**, so it never blocks what is underneath. The handle appears only while you use it and fades away when idle; drag, resize, toggle clickability and the position is remembered.
- 🎮 **Minecraft companion** — built on the MIT-licensed [mineflayer](https://github.com/PrismarineJS/mineflayer). Your character joins a Java server as a bot, follows you around, takes manual controls, chats, and — with auto-reply on — answers other players in its own persona using *your* LLM.
- ♟ **Chess** — play against the MIT-licensed [js-chess-engine](https://github.com/josefjadrny/js-chess-engine), with 5 difficulty levels and optional commentary from your character.
- 🎨 **Theming** — six presets plus custom accent colours.
- 🔒 **Private by design** — no telemetry, no accounts, no third-party servers.

> Inspired by [moeru-ai/Airi](https://github.com/moeru-ai/airi) and the AI streamer [Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA).

## 🌐 Languages

The interface ships in three languages and **defaults to English**:

| Language | Status |
| --- | --- |
| English | default, complete (303 strings) |
| 日本語 | complete (303 strings) |
| 简体中文 | complete (303 strings) |

Switch at any time from **⚙ Settings → 🌐 Language**, or from the native menu (`Alt`). The native application menu is localised too.

## 📦 Install

Download the latest from [Releases](../../releases):

| File | Description |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | Installer (recommended) — creates desktop and Start-menu shortcuts |
| `AILEEN x.x.x.exe` | Portable — just double-click, no install |

> Windows 10/11, 64-bit.

## 🔧 Run from source

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start
```

Requires Node.js ≥ 18. On first run Electron is downloaded (use a mirror if that is slow for you).
Windows users can also just double-click `install.bat`.

## 📦 Build your own installer

```bash
npm run dist      # NSIS installer + portable exe into release/
npm test          # 33 unit tests
```

Windows users can double-click `build-installer.bat`.

## 🗂 Project structure

```
main.js              Electron main process (windows, IPC, settings, local model server)
preload.js           contextBridge API surface
mc-bot.cjs           Minecraft bot (mineflayer)
shared/              pure helpers shared by main process and tests
  util.cjs           settings whitelist / validation
  menu-i18n.cjs      native menu translations
src/                 renderer (vanilla JS + Vite)
  main.js            renderer entry / event wiring
  overlay.html|js|css  borderless floating stage window
  lib/               controllers: state, dom, stage, chat, characters-ui, modals, voice, minecraft, chess, i18n
  lib/i18n.*.json    Japanese and Simplified Chinese dictionaries
tests/               vitest unit tests
```

## ✅ Quality gates

Every push to `v*` runs CI that must pass before a release is published:

1. 33 unit tests
2. dev smoke test — no runtime errors, every settings modal opens, menu returns to the parent menu after closing a sub-page, theme preview rolls back on cancel, Minecraft IPC alive, chess board renders 64 squares, i18n has **zero** untranslated strings, language switching actually works, `#typing` is hidden
3. packaged-app smoke test — the same checks on the built `.exe`, plus the floating stage must be **click-through by default** with its handle clear of the window resize border, and `mineflayer` / `mineflayer-pathfinder` must load from the asar

## 📄 License

MIT — see [LICENSE](./LICENSE).

Bundled third-party work: [mineflayer](https://github.com/PrismarineJS/mineflayer) (MIT), [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) (MIT), [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) (BSD-3-Clause), [js-chess-engine](https://github.com/josefjadrny/js-chess-engine) (MIT), [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d) (MIT), [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0/MIT). The Live2D Cubism Core runtime carries Live2D's own licence.

---
## 🇯🇵 日本語

AILEEN は、**話して、動いて、画面まで見てくれるキャラクター**をデスクトップに連れてくるオープンソースの AI コンパニオンです。API キー・会話ログ・キャラクターカード・モデルはすべて手元の PC に保存され、外部には送信されません。

### 主な機能

- 💬 **マルチプロバイダー会話** — DeepSeek / OpenAI / Moonshot / SiliconFlow / Groq / Zhipu / Alibaba Bailian / Xiaomi MiMo / OpenRouter / ローカル Ollama。ストリーミング対応。
- 🎀 **Live2D アバター** — Cubism 2/3/4 ランタイム同梱。読み上げに合わせて動き、表情を変えます。
- 🎙 **リアルタイム音声会話** — 話す → 認識 → 返答 → 読み上げ → また聞く、を連続で。
- 🔊 **TTS** — システム音声 / OpenAI 互換 / Fish Audio / Xiaomi MiMo。中国語・英語・日本語・スペイン語。
- 🎤 **STT** — Whisper 互換 / Xiaomi MiMo ASR / ブラウザー認識。
- 📷 **画面を見る** — スクリーンショットをキャラクターに送って、画面の内容について話せます。
- 🗂 **キャラクターカード** — 作成・編集・複製・読み込み・書き出し。モデルと音声を紐付けられます。
- 🪟 **枠なしフローティングステージ** — 透過・枠なし・常に最前面のウィンドウにキャラクターを浮かべます。**既定でマウスを透過**するので、下にあるウィンドウの操作を邪魔しません。ハンドルは使うときだけ現れ、放置すると自動で消えます。移動・サイズ変更・クリック可否の切り替えができ、位置は記憶されます。
- 🎮 **Minecraft コンパニオン** — MIT ライセンスの [mineflayer](https://github.com/PrismarineJS/mineflayer) を利用。Java 版サーバーにボットとして参加し、追従・手動操作・チャットができます。自動返信を ON にすると、**あなたの LLM** とキャラクター設定で他のプレイヤーに返事をします。
- ♟ **チェス** — MIT ライセンスの [js-chess-engine](https://github.com/josefjadrny/js-chess-engine) と対局。難易度 5 段階、キャラクターの実況も可能。
- 🎨 **テーマ** — 6 種類のプリセットと自由な配色。

### インターフェース言語

**英語（既定）/ 日本語 / 简体中文** の 3 言語に対応しています（各 303 文字列、未翻訳ゼロ）。
**⚙ 設定 → 🌐 言語**、またはネイティブメニュー（`Alt`）からいつでも切り替えられます。ネイティブメニューも翻訳されます。

### インストール

[Releases](../../releases) から最新版をダウンロードしてください。

| ファイル | 説明 |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | インストーラー（推奨）。デスクトップとスタートメニューにショートカットを作成します |
| `AILEEN x.x.x.exe` | ポータブル版。ダブルクリックだけで起動します |

> Windows 10/11 64bit 対応。

### ソースから実行

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start
```

Node.js 18 以上が必要です。初回は Electron のダウンロードが走ります。
Windows なら `install.bat` をダブルクリックするだけでも構いません。

### インストーラーのビルド

```bash
npm run dist      # NSIS インストーラー + ポータブル版を release/ に出力
npm test          # ユニットテスト 33 件
```

### ライセンス

MIT — [LICENSE](./LICENSE) を参照してください。

---
## 🇨🇳 简体中文

AILEEN 把「**会说话、会动、还能看屏幕的二次元角色**」带到你的桌面上。全部本地运行 —— API Key、聊天记录、角色卡与模型都只存在你自己电脑里，不上传任何第三方。

### 功能

- 💬 **多模型对话** — DeepSeek / OpenAI / Moonshot / 硅基流动 / Groq / 智谱 / 阿里百炼 / 小米 MiMo / OpenRouter / 本地 Ollama，流式输出。
- 🎀 **Live2D 看板娘** — 内置 Cubism 2/3/4 运行时，朗读时自动做动作、换表情。
- 🎙 **实时语音对话** — 说话 → 识别 → 回复 → 朗读 → 继续听，连贯进行。
- 🔊 **TTS** — 系统语音 / OpenAI 兼容 / Fish Audio / 小米 MiMo，支持中文、英语、日语、西班牙语。
- 🎤 **STT** — Whisper 兼容 / 小米 MiMo ASR / 浏览器识别。
- 📷 **屏幕视觉** — 一键截图发给角色，让它真的「看」你的屏幕。
- 🗂 **角色卡** — 新建 / 编辑 / 复制 / 导入 / 导出，可绑定专属模型与音色。
- 🪟 **无边框悬浮展台** — 把角色放进一个透明、无边框、始终置顶的独立窗口。**默认整窗鼠标穿透**，绝不挡住底下的操作；工具条用的时候才浮现、静止 2.6 秒自动隐藏，可拖动、缩放、切换是否可点击，位置自动记忆。
- 🎮 **Minecraft 伙伴** — 基于 MIT 许可的 [mineflayer](https://github.com/PrismarineJS/mineflayer)。角色以机器人身份进入 Java 版服务器，能跟着你走、手动操控、聊天栏说话；开启自动回复后，会用**你自己的 LLM** 和当前角色的人设回应其他玩家。
- ♟ **国际象棋** — 对手是 MIT 许可的 [js-chess-engine](https://github.com/josefjadrny/js-chess-engine)，5 档难度，还能让角色点评棋局。
- 🎨 **外观调色** — 6 套预设 + 自定义主辅色。

### 界面语言

支持 **英文（默认）/ 日文 / 简体中文** 三种语言，各 303 条文案、零漏翻。
随时在 **⚙ 设置 → 🌐 Language** 或原生菜单（按 `Alt`）里切换，原生菜单本身也已翻译。

### 安装

到 [Releases](../../releases) 下载最新版：

| 文件 | 说明 |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | 安装版（推荐），自动创建桌面与开始菜单快捷方式 |
| `AILEEN x.x.x.exe` | 免安装便携版，双击即用 |

> 支持 Windows 10/11 64 位。

### 从源码运行

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start
```

需要 Node.js ≥ 18，首次安装会下载 Electron。
Windows 用户也可以直接双击 `install.bat`。

### 自行打包安装包

```bash
npm run dist      # 生成 NSIS 安装包 + 便携版到 release/
npm test          # 33 项单元测试
```

Windows 用户也可双击 `build-installer.bat`。

### 许可证

MIT — 见 [LICENSE](./LICENSE)。