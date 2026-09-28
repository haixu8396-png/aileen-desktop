# ✦ AILEEN

**English** · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md)

[![License](https://img.shields.io/badge/license-MIT-ff7eb3.svg)](./LICENSE)
[![Downloads](https://img.shields.io/github/downloads/haixu8396-png/aileen-desktop/total?color=38b0de)](../../releases)
[![Platform](https://img.shields.io/badge/platform-Windows-9aa0b4.svg)](#install)
[![Languages](https://img.shields.io/badge/languages-English%20%C2%B7%20日本語%20%C2%B7%20简体中文-a78bfa.svg)](#interface)

### A desktop companion you actually own.

AILEEN puts a character on your desktop. Not a chat window — a presence. A Live2D figure that breathes, blinks, looks at you, and speaks out loud in a voice you chose. You decide who it is; it decides how to say things.

And when you're done talking, it will follow you into Minecraft, or sit down across the board for a game of chess.

No account. No cloud. Your conversations, your API keys and your character cards never leave your computer.

---

## Give it a body

Drop in any Live2D model — Cubism 2, 3 or 4 — and it becomes the face of your companion. It idles, breathes, plays motions, changes expressions, and moves its mouth while it talks. Import from a folder or load one straight from a URL.

## Give it a voice

Press the mic and speak; it answers out loud and keeps listening. Leave it running for a real back-and-forth conversation, or use one-shot voice input when you would rather type. Four speech engines — your system voice, anything OpenAI-compatible, Fish Audio with voice cloning, or Xiaomi MiMo — across Chinese, English, Japanese and Spanish.

## Give it a mind

Bring the model you already pay for: DeepSeek, OpenAI, Moonshot, SiliconFlow, Groq, Zhipu, Alibaba Bailian, Xiaomi MiMo or OpenRouter. Or keep it entirely offline with a local Ollama.

Every character card carries its own name, portrait, personality, scenario, greeting and example dialogue. Two cards can share the same model brain and still feel like two completely different people — and Minecraft and chess use the same personality, so the character who teases you in chat is the character who teases you in-game.

## Give it eyes

Hand it a screenshot of any window or monitor and ask what it thinks. Useful for debugging, reading a chart, or complaining about a boss fight together.

## Then let it out of the chat box

**Minecraft.** Your character joins a Java server as a bot: it follows you around, takes manual steering, chats in the server chat, and — with auto-reply on — answers other players in its own voice and personality. Perched on a hill watching it try to pathfind after you is genuinely funny.

**Chess.** Five difficulty levels, play as white or black, undo, flip the board, and let your character comment on the position as you go.

## And let it off the leash of the window

The **floating stage** lifts your character out of the app and onto your desktop: a frameless, transparent, always-on-top window with nothing in it but your character.

It is **click-through by default**, so it never steals a click from whatever is underneath. The little handle only appears when you reach for it, and fades again when you stop. Drag it where you like, resize it, or lock it in place — it remembers.

---

## Install

Grab the newest build from **[Releases](../../releases)**.

| | |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **Installer** — adds desktop and Start-menu shortcuts. Recommended. |
| `AILEEN x.x.x.exe` | **Portable** — double-click and go. Nothing is installed. |

Windows 10 / 11, 64-bit.

## Interface

The app speaks **English, 日本語 and 简体中文** — completely, not half-translated. It starts in English.

Switch any time from **Settings → 🌐 Language**, or straight from the native menu (`Alt`). The application menu itself is localised too.

> Want to add a fourth language? Everything lives in `src/lib/i18n.js` plus a JSON file per language — pull requests are very welcome.

## Run from source

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start
```

Node.js 18 or newer. The first run downloads Electron — if that is slow where you are, set `ELECTRON_MIRROR` to a mirror first. On Windows you can also just double-click `install.bat`.

## Build your own installer

```bash
npm run dist      # installer + portable exe, into release/
npm test          # unit tests
```

On Windows, `build-installer.bat` does the same thing.

## Under the hood

```
main.js               Electron main process — windows, IPC, settings, local model server
preload.js            the contextBridge API surface
mc-bot.cjs            Minecraft bot
shared/               helpers shared by the main process and the tests
src/                  the interface
  main.js             entry point and event wiring
  overlay.*           the floating stage window
  lib/                state, dom, stage, chat, characters, modals, voice,
                      minecraft, chess, i18n
  lib/i18n.ja.json    Japanese strings
  lib/i18n.zh.json    Simplified Chinese strings
tests/                unit tests
```

Nothing is fetched at runtime and nothing phones home. Models and avatars are served from a tiny local HTTP server so that Live2D's WebAssembly and texture loading work under `file://` — that server never listens outside your machine.

## Credits

AILEEN stands on other people's generous work. Bundled with thanks:

- [mineflayer](https://github.com/PrismarineJS/mineflayer) and [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — MIT
- [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) — BSD-3-Clause
- [js-chess-engine](https://github.com/josefjadrny/js-chess-engine) — MIT
- [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d) — MIT
- [DOMPurify](https://github.com/cure53/DOMPurify) — Apache-2.0 or MIT

The Live2D Cubism Core runtime is covered by Live2D's own licence, and any Live2D model you add carries its own terms — please respect the artist's.

Inspired by [moeru-ai/Airi](https://github.com/moeru-ai/airi) and the AI streamer [Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA).

## License

MIT — see [LICENSE](./LICENSE).
