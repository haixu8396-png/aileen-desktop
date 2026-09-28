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

AILEEN started from one stubborn question: why does the character on your desktop have to be a chat window?

We wanted the other thing. The character who is simply *there* — breathing in the corner of your screen while you work, blinking when you look over, turning to face you when you say something, and answering out loud in a voice you picked for them. Not a tool you open and close. Someone you keep around.

And once a character is that present, you start wanting to take them places. So they will follow you into a Minecraft server and get hopelessly lost trying to keep up. They will sit down across the board and play you at chess. They will come out of the app entirely and float on your desktop as a window containing nothing but themselves.

> [!NOTE]
> Everything happens on your machine. Your API keys, your conversations, your character cards, your models — none of it is uploaded anywhere, and there is no account to make. AILEEN talks to your LLM provider and to nothing else.

## Why we did it this way

**Because a character is a person, not a preset.** Every card carries its own name, portrait, personality, scenario, greeting and example dialogue. Point two cards at the same model and you get two people who happen to share a brain. The prompt is built from *your* card — and we mean all of it: if you wrote a custom system prompt, that wins outright.

**Because the character should not stop being themselves outside the chat box.** It would have been easy to give Minecraft and chess their own throwaway prompts. We made them reuse the exact same personality instead, so the character who teases you in chat is the character who teases you in-game.

**Because a desktop pet that eats your clicks is worse than no desktop pet.** The floating stage is click-through by default. It is the first thing we test, and it is the thing we have broken and re-fixed the most times.

**Because we wanted to read the source too.** No minified vendor blob, no hidden service. If something behaves strangely, the whole thing is a few thousand lines you can actually open.

## Give it a body

Drop in any Live2D model — Cubism 2, 3 or 4 — and it becomes the face of your companion. It idles, breathes, plays motions, changes expressions, and moves its mouth while it talks.

You can import a model folder, or just paste a URL to a `model3.json` and let it live there.

> [!TIP]
> Adding a Live2D model is a two-click affair: **Settings → 🎀 Live2D Model Settings → 📁 Import from folder**. The stage panel has the same buttons if you would rather not open a dialog.

## Give it a voice

Press the mic and speak. It answers out loud, then keeps listening — leave it running and you get a real back-and-forth conversation, not a push-to-talk walkie-talkie. If you would rather type, one-shot voice input is there too.

Four speech engines, so you can pick whatever you already have keys for: your system voice (offline and free), anything OpenAI-compatible, Fish Audio if you want to clone a voice, or Xiaomi MiMo. Chinese, English, Japanese and Spanish throughout.

## Give it a mind

Bring the model you already pay for — DeepSeek, OpenAI, Moonshot, SiliconFlow, Groq, Zhipu, Alibaba Bailian, Xiaomi MiMo, OpenRouter. Or keep the whole thing offline with a local Ollama.

There is no AILEEN account and no AILEEN server. Your key goes straight from your machine to your provider.

## Give it eyes

Hand it a screenshot of any window or monitor and ask what it thinks. We use it for reading stack traces, for glancing at charts, and — more often than we planned — for complaining about a boss fight together.

> [!IMPORTANT]
> Screen vision needs a multimodal model. `qwen-vl-plus`, `gpt-4o`, `glm-4v` and `MiMo-VL` all work; a text-only model will politely ignore the picture.

## Then let it out of the chat box

**Minecraft.** Your character joins a Java server as a bot. It follows you around, takes manual steering when you want to drive, chats in the server chat, and — with auto-reply on — answers other players in its own voice and personality. Watching it try to pathfind up a hill after you is unreasonably funny, and we are not going to pretend otherwise.

**Chess.** Five difficulty levels, play as white or black, undo, flip the board, and let your character comment on the position while you think. It is the cheapest way to give a companion something to have opinions about.

## And off the leash of the window

The floating stage lifts your character out of the app and onto your desktop: a frameless, transparent, always-on-top window containing nothing but them.

It is **click-through by default**. Whatever is underneath keeps every click. The little handle only appears when you reach for it and fades again when you stop, so there is nothing on your screen you did not ask for.

> [!TIP]
> `Ctrl+Shift+S` (or **Stage → Show / Hide Borderless Stage** in the menu) toggles it from anywhere. Drag it, resize it, resize it smaller with the `−` button, or reset it to the corner from the menu — positions and size are remembered.

## Install

Grab the newest build from **[Releases](../../releases)**.

| | |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **Installer** — desktop and Start-menu shortcuts. This is the one most people want. |
| `AILEEN x.x.x.exe` | **Portable** — double-click and go. Nothing is written to the registry. |

Windows 10 / 11, 64-bit.

## Interface & languages

The app speaks **English, 日本語 and 简体中文** — translated properly, not partially. It starts in English, and you can change that in a click.

Switch any time from **Settings → 🌐 Language**, or straight from the native menu (`Alt`). The application menu is localised too, which is the part everyone forgets.

> [!TIP]
> Want a fourth language? Every string lives in `src/lib/i18n.js` with one JSON file per language, and the whole UI reads from it. Add a file, add a row to `LANGS`, and you are done. Pull requests are genuinely welcome.

## Development

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start        # build the interface and launch
```

Node.js 18 or newer. The first run downloads Electron; if that is slow where you are, point `ELECTRON_MIRROR` at a mirror first. On Windows you can also just double-click `install.bat`.

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

### One thing that surprises people

Models and avatars are served over a tiny local HTTP server instead of `file://`. That is not us being fancy — Live2D's WebAssembly and texture loading simply do not work from `file://`, and this was the least invasive fix we found. The server binds to localhost only and never listens outside your machine.

## Acknowledgements

### Standing on

AILEEN would not exist without **[moeru-ai/Airi](https://github.com/moeru-ai/airi)**. It is the project that made "an open-source AI companion" sound like a real thing rather than a wish, and this repository follows it openly — its README structure, its habits, and its conviction that a virtual character can be worth building carefully. If you are reading this and you have not seen Airi yet, close this tab and go look. It has earned its stars many times over.

And **[Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA)** — the AI VTuber who proved that a character with a voice, a memory and a personality can make you forget you are watching software. That is the bar. AILEEN is a small hand reaching for it, and we are nowhere near it yet.

### Built with

- [mineflayer](https://github.com/PrismarineJS/mineflayer) and [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder): the reason a character with no hands can still follow you around a Minecraft world and get stuck on fences like everyone else. PrismarineJS has been quietly maintaining the entire JavaScript Minecraft ecosystem for years — it is worth an afternoon of browsing.
- [js-chess-engine](https://github.com/josefjadrny/js-chess-engine): a real search-based chess engine with zero dependencies. We keep being suspicious of how small it is, and it keeps winning.
- [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d): put Live2D on a page without a build system argument. Also where our whole `Cubism 2/3/4` support comes from.
- [DOMPurify](https://github.com/cure53/DOMPurify): the reason we can render model output as Markdown without lying awake about it.
- [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) — BSD-3-Clause. Speaks the Minecraft wire protocol so we do not have to.

The Live2D Cubism Core runtime is covered by Live2D's own licence. Every Live2D model you add carries its own terms too — please respect the artist's, especially if you plan to stream with it.

## Similar projects

- **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** — the one to beat. Self-hosted, browser + desktop + mobile, far more ambitious than this.
- **[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)** — local LLM plus Live2D, offline-first, and a very good place to start if that is what you want.
- **[BongoCat](https://github.com/ayangweb/BongoCat)** — a desktop pet done with real charm. If a cat is all you need, honestly, go get the cat.

## License

MIT — see [LICENSE](./LICENSE). Take it, change it, ship it.
