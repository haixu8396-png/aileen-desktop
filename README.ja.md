# ✦ AILEEN

**オープンソースのデスクトップ AI コンパニオン —— 話して、動いて、画面を見て、一緒に遊んでくれる相棒。すべて手元の PC で動きます。**

[English](./README.md) | **日本語** | [简体中文](./README.zh-CN.md)

[![License](https://img.shields.io/badge/license-MIT-ff7eb3.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-38b0de.svg)](#インストール)
[![Electron](https://img.shields.io/badge/electron-44-9aa0b4.svg)](https://www.electronjs.org/)
[![Tests](https://img.shields.io/badge/tests-33%20passing-4ecdc4.svg)](./tests)
[![Languages](https://img.shields.io/badge/languages-EN%20%7C%20JA%20%7C%20ZH-a78bfa.svg)](#インターフェース言語)

[ダウンロード](../../releases/latest) · [変更履歴](./CHANGELOG.md) · [コントリビュート](./CONTRIBUTING.md) · [セキュリティ](./SECURITY.md)

---

AILEEN は、**Live2D のキャラクターをデスクトップに住まわせる**アプリです。そのキャラクターには頭脳があり、声があり、目と手があります。ブラウザーのタブの中のチャットボットではなく、ウィンドウの隣に居ついて、会話を覚えていて、Minecraft やチェスにも付き合ってくれる小さな相棒です。

データはすべてローカルに留まります。API キー・会話ログ・キャラクターカード・モデルが外部へ送られることはありません。アカウント登録もテレメトリーも、間に挟まる第三者サーバーもありません。

> [moeru-ai/Airi](https://github.com/moeru-ai/airi) と AI ストリーマー [Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA) にインスパイアされました。

## できること

| | |
| --- | --- |
| 🎀 **Live2D アバター** | Cubism 2/3/4 ランタイム同梱。まばたきし、呼吸し、モーションを再生し、表情を変え、**読み上げに合わせて口が動きます**。 |
| 💬 **好きなモデルを持ち込める** | DeepSeek / OpenAI / Moonshot / SiliconFlow / Groq / Zhipu / Alibaba Bailian / Xiaomi MiMo / OpenRouter / ローカル Ollama。ストリーミング対応、キャラクターごとのプロンプト設定。 |
| 🎙 **本物の音声会話** | 話す → 認識 → キャラクターが答える → 読み上げ → また聞く。ボタンを押しっぱなしにしなくても、これが延々と続きます。 |
| 📷 **画面を見られる** | ウィンドウやモニターを選んで画像として送ると、キャラクターが実際に映っているものについて感想を言います。 |
| 🪟 **枠なしフローティングステージ** | 透過・枠なし・常に最前面のウィンドウにキャラクターを浮かべます。**既定でマウスを透過**するので、下のウィンドウの操作を絶対に邪魔しません。ハンドルは手を伸ばしたときだけ現れ、離すと消えます。 |
| 🎮 **Minecraft コンパニオン** | Java 版サーバーにボットとして参加し、追いかけ、手動操作を受け付け、チャットします。自動返信を ON にすれば、**あなたの LLM** を使ってそのキャラクターらしい口調で他のプレイヤーに返事をします。 |
| ♟ **チェス** | 難易度 5 段階、白番／黒番の選択、待った、盤面反転。キャラクターに局面を実況させることもできます。 |
| 🗂 **キャラクターカード** | 作成・編集・複製・読み込み・書き出し。カードごとにモデルと音声を紐付けられます。 |
| 🎨 **テーマ** | 6 種類のプリセットと自由な配色。 |

## インターフェース言語

3 言語に対応し、**初期状態は英語**です。

| 言語 | 収録状況 |
| --- | --- |
| English | 既定 — 全 303 文字列 |
| 日本語 | 全 303 文字列 |
| 简体中文 | 全 303 文字列 |

**設定 → 🌐 Language**、またはネイティブメニュー（`Alt`）からいつでも切り替えられます。ネイティブメニュー自体も翻訳されています。

## インストール

[Releases](../../releases) から最新版を取得してください。

| ファイル | 内容 |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **インストーラー（推奨）** — デスクトップとスタートメニューにショートカットを作成します |
| `AILEEN x.x.x.exe` | **ポータブル版** — ダブルクリックだけで起動し、何もインストールされません |

Windows 10 / 11（64bit）に対応しています。

## ソースから実行

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start
```

Node.js 18 以上が必要です。初回起動時に Electron をダウンロードします。回線が遅い場合は先に `ELECTRON_MIRROR` をミラーに向けてください。
Windows なら `install.bat` をダブルクリックするだけでも構いません。

## インストーラーを自分でビルドする

```bash
npm run dist      # NSIS インストーラー + ポータブル版を release/ に出力
npm test          # ユニットテスト 33 件
```

Windows では `build-installer.bat` でも同じことができます。

## 構成

```
main.js                 Electron メインプロセス — ウィンドウ、IPC、設定、ローカルモデルサーバー
preload.js              contextBridge で公開する API
mc-bot.cjs              Minecraft ボット（mineflayer）
shared/                 メインプロセスとテストで共有するヘルパー
  util.cjs              設定のホワイトリストと検証
  menu-i18n.cjs         ネイティブメニューの翻訳
src/                    レンダラー（バニラ JS + Vite）
  main.js               レンダラーの入口とイベント配線
  overlay.html|js|css   枠なしフローティングステージのウィンドウ
  lib/                  コントローラー — state, dom, stage, chat, characters-ui,
                        modals, voice, minecraft, chess, i18n
  lib/i18n.ja.json      日本語辞書
  lib/i18n.zh.json      簡体字中国語辞書
tests/                  vitest によるユニットテスト
```

## 品質ゲート

CI が通るまでリリースされません。タグを打つたびに以下を実行します。

1. **ユニットテスト 33 件。**
2. **開発版スモークテスト** — 実行時エラーなし／すべての設定モーダルが開く／サブページを閉じると親メニューに戻る／テーマ編集をキャンセルするとプレビューが元に戻る／Minecraft の IPC が応答する／チェス盤が 64 マス描画される／**未翻訳の文字列がゼロ**／言語切替が実際に UI を変える／「考え中」インジケーターが非表示になる。
3. **パッケージ版スモークテスト** — 上記すべてをビルド済み `.exe` に対して実行。さらに、フローティングステージが**既定でマウス透過**であること、ハンドルがウィンドウのリサイズ境界から離れていること、`mineflayer` / `mineflayer-pathfinder` が asar 内から読み込めることを確認します。

## ライセンス

MIT — [LICENSE](./LICENSE) を参照してください。

同梱しているサードパーティ製ソフトウェア: [mineflayer](https://github.com/PrismarineJS/mineflayer) / [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)（MIT）、[minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol)（BSD-3-Clause）、[js-chess-engine](https://github.com/josefjadrny/js-chess-engine)（MIT）、[oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d)（MIT）、[DOMPurify](https://github.com/cure53/DOMPurify)（Apache-2.0 または MIT）。Live2D Cubism Core ランタイムには Live2D 社独自のライセンスが適用されます。
