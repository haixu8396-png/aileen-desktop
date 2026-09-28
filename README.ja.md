<h1 align="center">✦ AILEEN</h1>

<p align="center">
  <b>あなたのデスクトップに、あなたの相棒を。</b><br/>
  声に出して話し、画面を見て、<br/>
  Minecraft に付いてきて、チェスの盤を挟んで向かいに座る Live2D のキャラクター。
</p>

<p align="center">
  <a href="https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA">Neuro-sama</a> へのオマージュ。
  <a href="https://github.com/moeru-ai/airi">moeru-ai/Airi</a> にインスパイアされて。
</p>

<p align="center">
  [<a href="./README.md">English</a>]
  [<a href="./README.ja.md">日本語</a>]
  [<a href="./README.zh-CN.md">简体中文</a>]
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff7eb3.svg"></a>
  <a href="../../releases"><img src="https://img.shields.io/github/downloads/haixu8396-png/aileen-desktop/total?color=38b0de"></a>
  <a href="#インストール"><img src="https://img.shields.io/badge/platform-Windows-9aa0b4.svg"></a>
  <a href="#インターフェースと言語"><img src="https://img.shields.io/badge/languages-English%20%C2%B7%20日本語%20%C2%B7%20简体中文-a78bfa.svg"></a>
</p>

<p align="center">
  <a href="../../releases/latest"><b>⬇️ Windows 版をダウンロード</b></a>
  · <a href="https://github.com/haixu8396-png/aileen-desktop/releases">すべてのリリース</a>
  · <a href="./CHANGELOG.md">変更履歴</a>
</p>

---

## AILEEN とは

AILEEN はデスクトップに「キャラクター」を住まわせるアプリです。チャットウィンドウではなく、そこに居る何か。呼吸して、まばたきして、こちらを見て、あなたが選んだ声で話し出す Live2D の姿です。

どんな子にするかはあなたが決め、どう喋るかはその子が決めます。話し終えたら、そのまま Minecraft に付いてきてくれます。チェスの盤を挟んで向かいに座ることもできます。

アカウント登録は不要、クラウドも使いません。会話も API キーもキャラクターカードも、あなたの PC から出ることはありません。

## 何が違うのか

- **「何か」ではなく「誰か」であること。** キャラクターカードには名前・アイコン・性格・場面・第一声・会話例がそれぞれ入ります。同じモデルを使っていても、2枚のカードはまったく別人になります。
- **チャット欄の外でも、その子のままであること。** Minecraft もチェスも**同じ人格**を使います。チャットであなたをからかう子は、ゲームの中でも同じようにからかってきます。
- **ウィンドウの外に出られること。** フローティングステージは、キャラクターをアプリからデスクトップへ連れ出します。枠なし・透過・常に最前面で、クリックを決して奪いません。
- **本当にあなたのものであること。** 実行時に外部から何も取りに行かず、どこにも送信しません。アカウントもテレメトリーもありません。

## からだを与える

Live2D モデル（Cubism 2 / 3 / 4）を読み込めば、それが相棒の顔になります。待機モーションで呼吸し、まばたきし、表情を変え、**話している間は口が動きます**。フォルダからでも、URL から直接でも読み込めます。

## こえを与える

マイクを押して話しかければ、声に出して答えて、また聞き耳を立てます。ずっと続く本物の音声会話にも、タイピング中心のときの単発音声入力にも使えます。

音声エンジンは4種類 —— システム音声、OpenAI 互換、音色クローンができる Fish Audio、Xiaomi MiMo。中国語・英語・日本語・スペイン語に対応します。

## あたまを与える

すでに契約しているモデルをそのまま持ち込めます：DeepSeek / OpenAI / Moonshot / SiliconFlow / Groq / Zhipu / Alibaba Bailian / Xiaomi MiMo / OpenRouter。完全オフラインにしたければローカルの Ollama でも構いません。

## めを与える

任意のウィンドウやモニターのスクリーンショットを渡して、感想を聞けます。デバッグの相談にも、グラフの読み取りにも、ボス戦の愚痴にも。

## チャット欄の外へ

**Minecraft。** キャラクターはボットとして Java 版サーバーに入ります。あなたを追いかけ、手動操作を受け付け、チャットで話し、自動返信を ON にすれば**他のプレイヤーにもその子の口調で**返事をします。必死に追いかけてくる姿を眺めるのは、地味に面白いです。

**チェス。** 難易度5段階、白番・黒番の選択、待った、盤面反転。そして勝負の途中でキャラクターに局面を実況させられます。

## ウィンドウの外へ

**フローティングステージ**は、中身がキャラクターだけの、枠なし・透過・常に最前面の独立したウィンドウです。

**既定でマウスを透過**するので、下にあるウィンドウのクリックを決して奪いません。小さなハンドルは手を伸ばしたときだけ現れ、離せばまた消えます。好きな場所へ動かし、大きさを変え、位置はそのまま覚えてくれます。

## インストール

最新版は **[Releases](../../releases)** から。

| | |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **インストーラー** —— デスクトップとスタートメニューにショートカットを作ります。おすすめ。 |
| `AILEEN x.x.x.exe` | **ポータブル版** —— ダブルクリックだけで起動。何もインストールされません。 |

Windows 10 / 11（64bit）。

## インターフェースと言語

**English / 日本語 / 简体中文** の3言語に、手抜きなしで完全対応しています。初期状態は英語です。

**設定 → 🌐 Language**、またはネイティブメニュー（`Alt`）からいつでも切り替えられます。アプリケーションメニュー自体も翻訳済みです。

> 4つ目の言語を足したい方へ：文言は `src/lib/i18n.js` と言語ごとの JSON ファイルにまとまっています。プルリクエスト歓迎です。

## 開発

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start        # 画面をビルドして起動
```

Node.js 18 以上が必要です。初回は Electron をダウンロードします。回線が遅い場合は先に `ELECTRON_MIRROR` をミラーへ。Windows なら `install.bat` をダブルクリックでも構いません。

```bash
npm run dist     # インストーラー + ポータブル版を release/ に出力
npm test         # ユニットテスト
```

Windows では `build-installer.bat` でも同じです。

### ディレクトリ構成

```
main.js               Electron メインプロセス（ウィンドウ / IPC / 設定 / ローカルモデルサーバー）
preload.js            contextBridge で公開する API
mc-bot.cjs            Minecraft ボット
shared/               メインプロセスとテストで共有するコード
src/                  画面まわり
  main.js             入口とイベント配線
  overlay.*           フローティングステージのウィンドウ
  lib/                state, dom, stage, chat, characters, modals, voice,
                      minecraft, chess, i18n
  lib/i18n.ja.json    日本語の文言
  lib/i18n.zh.json    簡体字中国語の文言
tests/                ユニットテスト
```

## 謝辞

### その肩の上に

AILEEN は **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** なしには存在しませんでした。オープンソースの AI コンパニオンがどこまで行けるかを示してくれたプロジェクトであり、この README の構成も、プロジェクトの在り方も、堂々と Airi に倣っています。こういうものが好きな方なら、ぜひ Airi にスターを。あの数のスターは伊達ではありません。

そして **[Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA)** へ。声と人格を持ったキャラクターが「人」のように感じられることを証明してみせた AI VTuber です。それが基準です。このプロジェクトは、そこへ手を伸ばす小さな試みです。

### 使用しているもの

- [mineflayer](https://github.com/PrismarineJS/mineflayer) / [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — MIT
- [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) — BSD-3-Clause
- [js-chess-engine](https://github.com/josefjadrny/js-chess-engine) — MIT
- [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d) — MIT
- [DOMPurify](https://github.com/cure53/DOMPurify) — Apache-2.0 または MIT

Live2D Cubism Core ランタイムには Live2D 社のライセンスが適用されます。追加する Live2D モデルにもそれぞれの規約がありますので、作者の方の意向を尊重してください。

## 似たプロジェクト

- **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** —— 本命。セルフホスト型 AI コンパニオンで、ブラウザ・デスクトップ・モバイルに対応。比較にならないほど野心的です。
- **[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)** —— ローカル LLM + Live2D の VTuber。オフライン重視。
- **[BongoCat](https://github.com/ayangweb/BongoCat)** —— 猫で十分なら、これが最高に可愛いです。

## ライセンス

MIT —— [LICENSE](./LICENSE) を参照してください。
