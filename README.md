<h1 align="center">✦ AILEEN</h1>

<p align="center">
  <b>A desktop AI assistant and agent that keeps your data on your machine.</b><br/>
  Live2D character · multi-provider LLM chat · long-term memory ·<br/>
  tool calling and computer control.
</p>

<p align="center">
  AILEEN can also draft the character card for you — <b>name a character and it writes their personality, history and voice into a card you can use right away</b>.<br/>
  Or start from one line of inspiration and create an original character.
</p>

<p align="center">
  Inspired by <a href="https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA">Neuro-sama</a>,
  a tribute to <a href="https://github.com/moeru-ai/airi">moeru-ai/Airi</a>.
</p>

<p align="center">
  [<a href="./README.md">English</a>]
  [<a href="./README.ja.md">日本語</a>]
  [<a href="./README.zh-CN.md">简体中文</a>]
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-ff7eb3.svg"></a>
  <a href="../../releases"><img src="https://img.shields.io/github/downloads/haixu8396-png/aileen-desktop/total?color=38b0de"></a>
  <a href="#getting-started"><img src="https://img.shields.io/badge/platform-Windows-9aa0b4.svg"></a>
  <a href="#interface-and-languages"><img src="https://img.shields.io/badge/languages-English%20%C2%B7%20日本語%20%C2%B7%20简体中文-a78bfa.svg"></a>
</p>

<p align="center">
  <a href="../../releases/latest"><b>⬇️ Download for Windows</b></a>
  · <a href="https://github.com/haixu8396-png/aileen-desktop/releases">All releases</a>
  · <a href="./CHANGELOG.md">Changelog</a>
</p>

---

## Overview

AILEEN is a Windows desktop application that brings AI conversation, a character system, long-term memory, tool calling, computer control and a visual character into a single interactive environment. It runs as an Electron application: the interface is plain JavaScript, requests that involve API keys are made in the main process, and user data stays on the local machine.

There is no account and no hosted backend. AILEEN communicates only with the model, speech and embedding providers you configure yourself.

The project currently focuses on:

- **AI conversation and character system** — character cards (personality, scenario, greeting, example dialogue), persona prompt assembly, TTS/STT, and multi-provider LLM support (DeepSeek, OpenAI, Moonshot, SiliconFlow, Groq, Zhipu, Qwen, Xiaomi, OpenRouter, Ollama, or any compatible endpoint).
- **Long-term memory and context management** — conversation memories, a local knowledge base, and a shared context engine that assembles system prompt, character card, history, memory, knowledge and tool output into one budgeted request.
- **Agent and tool calling** — a single-agent tool loop with a tool registry, three risk levels and an explicit approval flow.
- **File and computer operation** — file read/write, whitelisted command execution, git inspection and desktop input (mouse, keyboard, window switching), bounded by a workspace rule and per-action approval.
- **Desktop environment interaction** — a frameless, click-through overlay stage, plus Minecraft and chess as interactive environments for the same character.
- **Visual character** — Live2D models whose motions and expressions are driven by the conversation.
- **Image and vision** — screen capture passed to vision-capable models.
- **Extensibility** — the agent core is host-agnostic and the tool registry is data-driven; MCP, browser tools and further environments are the intended direction rather than shipped features.

AILEEN is under active development. The goal is an integrated desktop environment for AI interaction, memory, agent execution and computer control, rather than a single-purpose chat client.

> [!NOTE]
> Everything stays on your machine: API keys, conversations, character cards and models are never uploaded, and no account is required.

## Features

### AI conversation and character system

Bring the model you already use — DeepSeek, OpenAI, Moonshot, SiliconFlow, Groq, Zhipu, Alibaba Bailian, Xiaomi MiMo, OpenRouter — or run the whole stack offline with a local Ollama.

Every character is defined by a card carrying its own name, portrait, personality, scenario, greeting and example dialogue. Two cards pointed at the same model produce two distinct characters. The prompt is built from the card in full: a custom system prompt, if present, takes precedence.

**Character card generation.** Name an existing character, or supply a single line of inspiration, and AILEEN drafts the card fields for you. The result is an editable draft, not an opaque preset.

### Speech input and output

Press the microphone and speak: the reply is spoken aloud and listening continues, so a conversation can run back and forth rather than requiring push-to-talk. One-shot voice input is also available when you would rather type.

Four speech engines cover the credentials you may already hold: the system voice (offline and free), any OpenAI-compatible endpoint, Fish Audio for voice cloning, and Xiaomi MiMo. Chinese, English, Japanese and Spanish are supported throughout.

### Long-term memory and knowledge base

Conversations are distilled into memories that are stored locally and recalled when they are relevant, instead of replaying the entire transcript.

**Knowledge base.** Text, Markdown, HTML, JSON and PDF files can be added. They are chunked and stored locally, and the passages matching the current conversation are included in the request. PDF parsing is implemented in this repository — no additional dependency was added to read documents.

Both use a small **embedding model** configured in **Settings → 🧠 Memory & Knowledge** (OpenAI, SiliconFlow, Alibaba Bailian, Zhipu, a local Ollama, or any compatible endpoint), so retrieval works by meaning rather than by keyword. Without an embedding model, retrieval falls back to keyword matching and remains fully offline.

Memory and knowledge data live in the application data folder, and only the two folders belonging to them are writable.

> [!NOTE]
> The embedding key is handled like every other key in the application: the interface never sees it. Requests are issued by the main process, and the renderer only receives a boolean indicating that a key is configured.

### Agent and tool calling

Enable **🖥 Computer control** in the sidebar. The normal chat box remains the entry point: you keep talking as before, and the agent decides when a tool is required, executes it and reports the result.

Permissions are enforced in three risk levels. Reading is unrestricted; any operation that touches the machine asks for approval every time, and that requirement deliberately cannot be disabled in settings.

> [!IMPORTANT]
> While a task is running, the right-hand stage becomes the **Agent Control Dashboard**: the task, the current step, a timestamped operation log, every tool call, the captured screen and the approval buttons. Tool logs are never inserted into chat bubbles.

> [!NOTE]
> The character's persona is preserved. The first segment of the system prompt is always the character card, whether the character is chatting, playing chess or operating the desktop; a hard check aborts the run if the persona is missing.

### Computer interaction

The available tools read and edit files, run whitelisted commands, inspect git state, capture the screen, move the mouse, type, launch applications and switch windows. When a task finishes, the result is reported back in the character's own voice rather than as a generic completion message.

Everything the agent touches is bounded by a workspace rule (paths outside it are rejected) and by the approval step described above.

### Visual character

Any Live2D model — Cubism 2, 3 or 4 — can be used as the character: idle animation, breathing, motions, expressions and mouth movement while speaking. Import a model folder, or paste the URL of a `model3.json` file.

> [!TIP]
> Adding a model takes two clicks: **Settings → 🎀 Live2D Model Settings → 📁 Import from folder**. The stage panel exposes the same buttons.

### Floating stage

The floating stage places the character on the desktop in a frameless, transparent, always-on-top window. It is **click-through by default**, so windows underneath keep every click; the handle appears only while the pointer is near it.

> [!TIP]
> `Ctrl+Shift+S` (or **Stage → Show / Hide Borderless Stage** in the menu) toggles it. It can be dragged, resized with the `−` / `＋` buttons, or reset to the corner from the menu; position and size are remembered.

### Vision

A screenshot of any window or monitor can be attached together with a question — commonly for reading stack traces or checking charts. Vision requires a multimodal model: `qwen-vl-plus`, `gpt-4o`, `glm-4v` and `MiMo-VL` work; a text-only model will ignore the image.

### Interactive environments

**Minecraft.** The character joins a Java Edition server as a bot: it follows you, accepts manual steering, talks in the server chat, and — with auto-reply enabled — answers other players in its own voice and personality.

**Chess.** Five difficulty levels, either colour, undo, board flip, and character commentary on the position while you think.

## Architecture / Design

### Design notes

- **The card is the single source of the prompt.** Name, portrait, personality, scenario, greeting and example dialogue all come from one card, and a custom system prompt takes precedence over the generated persona.
- **The same persona is used everywhere.** Minecraft and chess reuse the character's personality rather than introducing separate, throwaway prompts.
- **The floating stage is click-through by default**, and that behaviour is among the first things the self-test checks.
- **The source stays readable.** No minified vendor bundle and no hidden service: any behaviour can be traced through this repository.
- **API keys never reach the renderer.** Requests to model, speech and embedding providers are issued from the main process; the interface receives redacted settings only.

### Project layout

```
main.js               Electron main process — app lifecycle and wiring
preload.js            the contextBridge API surface
mc-bot.cjs            Minecraft bot
shared/               code shared by the main process, the renderer and the tests
  ipc-guard.cjs       who is allowed to call IPC
  ipc-validate.cjs    what they are allowed to pass
  ipc-schemas.cjs     one validation rule per channel
  llm.cjs             streaming chat core (API keys never leave the main process)
  agent-ipc.cjs       what the agent's tools are allowed to do to your machine
  embeddings.cjs      embedding math plus the offline fallback
  store-ipc.cjs       the two folders the memory and knowledge base may write to
src/
  main/               main-process modules
    self-test.cjs     diagnostics — runs only when AILEEN_SELFTEST=1
    server/           the local static server for models and avatars
    storage/          settings and API key storage
  agent/              the agent core: runtime, planner, tools, permissions, executor
  context/            the shared context engine (prompt layers and token budget)
  memory/             long-term memory: extraction, storage, retrieval, consolidation
  knowledge/          local knowledge base: parsing, chunking, retrieval
  lib/                the interface — state, dom, stage, chat, characters, modals,
                      voice, minecraft, chess, agent-dashboard, agent-ui, i18n
  overlay.*           the floating stage window
tests/                unit / integration / e2e (see tests/README.md)
```

### Why models are served over HTTP

Models and avatars are served by a small local HTTP server instead of `file://`. This is not a stylistic choice: Live2D's WebAssembly and texture loading do not work from `file://`, and this was the least invasive fix available. The server binds to localhost only and never listens outside your machine.

## Getting Started

Grab the newest build from **[Releases](../../releases)**.

| | |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **Installer** — desktop and Start-menu shortcuts. This is the one most people want. |
| `AILEEN x.x.x.exe` | **Portable** — double-click and go. Nothing is written to the registry. |

Windows 10 / 11, 64-bit.

### Interface and languages

The app ships in **English, 日本語 and 简体中文** — fully translated, not partially. It starts in English and can be switched in one click.

Change it at any time from **Settings → 🌐 Language**, or from the native menu (`Alt`). The application menu itself is localised as well.

> [!TIP]
> To add a fourth language: every string lives in `src/lib/i18n.js` with one JSON file per language, and the whole interface reads from it. Add a file, add a row to `LANGS`, and the new language is available. Pull requests are welcome.

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
npm run lint     # syntax and project-specific boundary rules
```

On Windows, `build-installer.bat` does the same as `npm run dist`.

## Acknowledgements

### Standing on

A tribute to **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** — AILEEN would not exist without it. It is the project that made "an open-source AI companion" sound like a real thing rather than a wish, and this repository follows it openly: its README structure, its habits, and its conviction that a virtual character can be worth building carefully. If you have not seen Airi yet, it has earned its stars many times over.

And the idea started with **[Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA)** — the AI VTuber who showed that a character with a voice, a memory and a personality can make you forget you are watching software. That is the bar. AILEEN is a much smaller attempt in that direction, and it is not close yet.

### Built with

- [mineflayer](https://github.com/PrismarineJS/mineflayer) and [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder): how a character with no hands can follow you around a Minecraft world — and get stuck on fences like everyone else. PrismarineJS has maintained the JavaScript Minecraft ecosystem for years.
- [js-chess-engine](https://github.com/josefjadrny/js-chess-engine): a real search-based chess engine with zero dependencies. We keep being suspicious of how small it is, and it keeps winning.
- [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d): Live2D on a page without a build-system argument. Our `Cubism 2/3/4` support comes from it.
- [DOMPurify](https://github.com/cure53/DOMPurify): the reason model output can be rendered as Markdown safely.
- [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) — BSD-3-Clause. Speaks the Minecraft wire protocol so we do not have to.

The Live2D Cubism Core runtime is covered by Live2D's own licence. Every Live2D model you add carries its own terms too — please respect the artist's, especially if you plan to stream with it.

## Similar projects

- **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** — self-hosted, browser + desktop + mobile, and considerably more ambitious in scope.
- **[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)** — local LLM plus Live2D, offline-first, and a good starting point if that is the configuration you want.
- **[BongoCat](https://github.com/ayangweb/BongoCat)** — a desktop pet with a strong focus on polish.

## License

AILEEN is distributed under the **PolyForm Noncommercial License 1.0.0**. The licence text in [LICENSE](./LICENSE) is the binding version.

The default licence does not grant rights for commercial use. Noncommercial purposes — personal use, study, hobby projects, schools, charities and other noncommercial organizations — are permitted; selling the software, or building a commercial product on it, is not.

For commercial use, commercial distribution, or any other commercial licensing, prior written permission from the AILEEN developers is required. Please contact us through the channels listed in [SECURITY.md](./SECURITY.md).

Licence history: 0.7.0 changed the project licence from MIT to PolyForm Noncommercial 1.0.0. Copies obtained while the project was MIT-licensed retain their MIT rights for that copy — licences are not retroactive.

## Contact

- **Bug reports and feature requests** — [GitHub Issues](../../issues)
- **Code, documentation and translation contributions** — [pull requests](../../pulls)
- **Security reports and other contact channels** — [SECURITY.md](./SECURITY.md)
- **Commercial licensing** — see [License](#license)
