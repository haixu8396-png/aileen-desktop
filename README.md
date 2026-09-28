<h1 align="center">✦ AILEEN</h1>

<p align="center">
  <b>A desktop companion you actually own.</b><br/>
  A Live2D character that talks out loud, sees your screen,<br/>
  follows you into Minecraft and sits down across the board for chess.
</p>

<p align="center">
  A tribute to <a href="https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA">Neuro-sama</a>,
  inspired by <a href="https://github.com/moeru-ai/airi">moeru-ai/Airi</a>.
</p>

<p align="center">
  [<a href="./README.md">English</a>]
  [<a href="./README.ja.md">日本語</a>]
  [<a href="./README.zh-CN.md">简体中文</a>]
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff7eb3.svg"></a>
  <a href="../../releases"><img src="https://img.shields.io/github/downloads/haixu8396-png/aileen-desktop/total?color=38b0de"></a>
  <a href="#install"><img src="https://img.shields.io/badge/platform-Windows-9aa0b4.svg"></a>
  <a href="#interface--languages"><img src="https://img.shields.io/badge/languages-English%20%C2%B7%20日本語%20%C2%B7%20简体中文-a78bfa.svg"></a>
</p>

<p align="center">
  <a href="../../releases/latest"><b>⬇️ Download for Windows</b></a>
  · <a href="https://github.com/haixu8396-png/aileen-desktop/releases">All releases</a>
  · <a href="./CHANGELOG.md">Changelog</a>
</p>

---

## What is AILEEN?

AILEEN puts a character on your desktop. Not a chat window — a presence. A Live2D figure that breathes, blinks, looks at you, and speaks out loud in a voice you chose.

You decide who it is. It decides how to say things. And when you are done talking, it will follow you into Minecraft, or sit down across the board for a game of chess.

No account. No cloud. Your conversations, your API keys and your character cards never leave your computer.

## What makes it different

- **It is somebody, not something.** Every character card carries its own name, portrait, personality, scenario, greeting and example dialogue. Two cards sharing the same model brain still feel like two different people.
- **It remembers who it is outside the chat box.** Minecraft and chess use the *same* personality — the character who teases you in chat is the character who teases you in-game.
- **It can leave the window.** The floating stage lifts your character out of the app and onto your desktop as a frameless, transparent, always-on-top window that never steals a click.
- **It is actually yours.** Nothing is fetched at runtime, nothing phones home, no account, no telemetry.

## Give it a body

Drop in any Live2D model — Cubism 2, 3 or 4 — and it becomes the face of your companion. It idles, breathes, plays motions, changes expressions, and moves its mouth while it talks. Import from a folder or load one straight from a URL.

## Give it a voice

Press the mic and speak; it answers out loud and keeps listening. Leave it running for a real back-and-forth conversation, or use one-shot voice input when you would rather type.

Four speech engines — your system voice, anything OpenAI-compatible, Fish Audio with voice cloning, or Xiaomi MiMo — across Chinese, English, Japanese and Spanish.

## Give it a mind

Bring the model you already pay for: DeepSeek, OpenAI, Moonshot, SiliconFlow, Groq, Zhipu, Alibaba Bailian, Xiaomi MiMo or OpenRouter. Or keep everything offline with a local Ollama.

## Give it eyes

Hand it a screenshot of any window or monitor and ask what it thinks. Useful for debugging, reading a chart, or complaining about a boss fight together.

## Then let it out of the chat box

**Minecraft.** Your character joins a Java server as a bot: it follows you around, takes manual steering, chats in the server chat, and — with auto-reply on — answers other players in its own voice. Watching it try to pathfind after you is genuinely funny.

**Chess.** Five difficulty levels, play as white or black, undo, flip the board, and let your character comment on the position as you go.

## And off the leash of the window

The **floating stage** is a separate frameless, transparent, always-on-top window containing nothing but your character.

It is **click-through by default**, so it never steals a click from whatever is underneath. The little handle only appears when you reach for it, and fades again when you stop. Drag it where you like, resize it, lock it in place — it remembers.

## Install

Grab the newest build from **[Releases](../../releases)**.

| | |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **Installer** — adds desktop and Start-menu shortcuts. Recommended. |
| `AILEEN x.x.x.exe` | **Portable** — double-click and go. Nothing is installed. |

Windows 10 / 11, 64-bit.

## Interface & languages

The app speaks **English, 日本語 and 简体中文** — completely, not half-translated. It starts in English.

Switch any time from **Settings → 🌐 Language**, or straight from the native menu (`Alt`). The application menu itself is localised too.

> Want to add a fourth language? Every string lives in `src/lib/i18n.js` plus one JSON file per language. Pull requests are very welcome.

## Development

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start        # build the interface and launch
```

Node.js 18 or newer. The first run downloads Electron — if that is slow where you are, set `ELECTRON_MIRROR` to a mirror first. On Windows you can also just double-click `install.bat`.

```bash
npm run dist     # installer + portable exe, into release/
npm test         # unit tests
```

On Windows, `build-installer.bat` does the same thing.

### Project layout

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

## Acknowledgements

### Standing on

AILEEN would not exist without **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** — the project that showed what an open-source AI companion could be, and whose README, structure and spirit this one openly follows. If you are here for this kind of thing, go and give Airi a star; it has earned every one of them.

And to **[Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA)** — the AI VTuber who proved a character with a voice and a personality could feel like a person. That is the bar. This project is a small attempt at reaching for it.

### Built with

- [mineflayer](https://github.com/PrismarineJS/mineflayer) and [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — MIT
- [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) — BSD-3-Clause
- [js-chess-engine](https://github.com/josefjadrny/js-chess-engine) — MIT
- [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d) — MIT
- [DOMPurify](https://github.com/cure53/DOMPurify) — Apache-2.0 or MIT

The Live2D Cubism Core runtime is covered by Live2D's own licence, and any Live2D model you add carries its own terms — please respect the artist's.

## Similar projects

- **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** — the big one. Self-hosted AI companion, browser + desktop + mobile, far more ambitious than this.
- **[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)** — local LLM + Live2D VTuber, offline-first.
- **[BongoCat](https://github.com/ayangweb/BongoCat)** — a delightful little desktop pet, if a cat is all you need.

## License

MIT — see [LICENSE](./LICENSE).
