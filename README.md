# ✦ AILEEN

**An open-source desktop AI companion — a character that talks, moves, sees your screen, and plays games with you. Runs entirely on your own machine.**

**English** | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md)

[![License](https://img.shields.io/badge/license-MIT-ff7eb3.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-38b0de.svg)](#install)
[![Electron](https://img.shields.io/badge/electron-44-9aa0b4.svg)](https://www.electronjs.org/)
[![Tests](https://img.shields.io/badge/tests-33%20passing-4ecdc4.svg)](./tests)
[![Languages](https://img.shields.io/badge/languages-EN%20%7C%20JA%20%7C%20ZH-a78bfa.svg)](#interface-languages)

[Download](../../releases/latest) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

---

AILEEN puts a **Live2D character on your desktop** and gives it a brain, a voice, eyes and hands. It is not a chatbot in a browser tab — it is a small companion that lives next to your windows, remembers your conversations, and can join you in Minecraft or a game of chess.

Everything stays local: API keys, chat logs, character cards and models never leave your machine. No account, no telemetry, no third-party server in the middle.

> Inspired by [moeru-ai/Airi](https://github.com/moeru-ai/airi) and the AI streamer [Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA).

## Highlights

| | |
| --- | --- |
| 🎀 **Live2D avatar** | Cubism 2/3/4 runtime included. Your character blinks, breathes, plays motions and changes expressions — and moves its mouth while speaking. |
| 💬 **Bring your own model** | DeepSeek, OpenAI, Moonshot, SiliconFlow, Groq, Zhipu, Alibaba Bailian, Xiaomi MiMo, OpenRouter, or a local Ollama. Streaming replies, per-character prompts. |
| 🎙 **Real voice conversation** | Speak → transcribe → the character answers → read aloud → keep listening. One continuous loop, no push-to-talk. |
| 📷 **It can see your screen** | Pick any window or monitor and send it as an image, so the character can comment on what you are actually looking at. |
| 🪟 **Borderless floating stage** | Float the character in a frameless, transparent, always-on-top window. **Click-through by default** — it never blocks the window underneath. The handle appears when you reach for it and fades when you stop. |
| 🎮 **Minecraft companion** | Your character joins a Java server as a bot, follows you around, takes manual controls, chats — and answers other players in its own persona using your LLM. |
| ♟ **Chess** | Five difficulty levels, play as white or black, undo, flip the board — and let your character comment on the position. |
| 🗂 **Character cards** | Create, edit, duplicate, import and export. Bind a model and a voice to each card. |
| 🎨 **Theming** | Six presets plus custom accent colours. |

## Interface languages

The app ships in three languages and **starts in English**:

| Language | Coverage |
| --- | --- |
| English | default — complete (303 strings) |
| 日本語 | complete (303 strings) |
| 简体中文 | complete (303 strings) |

Switch any time from **Settings → 🌐 Language**, or from the native menu (`Alt`). The native application menu is localised too.

## Install

Grab the newest build from [Releases](../../releases):

| File | What it is |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **Installer (recommended)** — adds desktop and Start-menu shortcuts |
| `AILEEN x.x.x.exe` | **Portable** — just double-click, nothing gets installed |

Windows 10 / 11, 64-bit.

## Run from source

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start
```

Node.js 18 or newer. The first run downloads Electron; if that is slow where you are, point `ELECTRON_MIRROR` at a mirror first.
On Windows you can also just double-click `install.bat`.

## Build your own installer

```bash
npm run dist      # NSIS installer + portable exe into release/
npm test          # 33 unit tests
```

On Windows, `build-installer.bat` does the same thing.

## How it is put together

```
main.js                 Electron main process — windows, IPC, settings, local model server
preload.js              contextBridge API surface
mc-bot.cjs              Minecraft bot (mineflayer)
shared/                 helpers shared by the main process and the tests
  util.cjs              settings whitelist and validation
  menu-i18n.cjs         native menu translations
src/                    renderer (vanilla JS + Vite)
  main.js               renderer entry, event wiring
  overlay.html|js|css   the borderless floating stage window
  lib/                  controllers — state, dom, stage, chat, characters-ui,
                        modals, voice, minecraft, chess, i18n
  lib/i18n.ja.json      Japanese dictionary
  lib/i18n.zh.json      Simplified Chinese dictionary
tests/                  vitest unit tests
```

## Quality gates

Nothing gets released until CI passes. Every tag runs:

1. **33 unit tests.**
2. **Dev smoke test** — no runtime errors; every settings modal opens; closing a sub-page returns to the parent menu; cancelling the theme editor rolls the preview back; Minecraft IPC answers; the chess board renders 64 squares; **zero untranslated strings**; switching language actually changes the UI; the “thinking” indicator is hidden.
3. **Packaged-app smoke test** — all of the above against the built `.exe`, plus: the floating stage must be **click-through by default**, its handle must sit clear of the window resize border, and `mineflayer` / `mineflayer-pathfinder` must load from inside the asar.

## License

MIT — see [LICENSE](./LICENSE).

Bundled third-party work: [mineflayer](https://github.com/PrismarineJS/mineflayer) and [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) (MIT), [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) (BSD-3-Clause), [js-chess-engine](https://github.com/josefjadrny/js-chess-engine) (MIT), [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d) (MIT), [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0 or MIT). The Live2D Cubism Core runtime carries Live2D's own licence.
