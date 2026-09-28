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

AILEEN は、ひとつのしつこい疑問から始まりました。**なぜデスクトップにいるキャラクターは、チャットウィンドウの形をしていないといけないのか。**

欲しかったのは、そうではなくて。ただ**そこに居る**子です。作業している横で呼吸していて、こちらが目をやるとまばたきして、話しかければこちらを向いて、あなたが選んだ声で答えてくれる。開いて閉じる道具ではなく、ずっと置いておきたくなる誰か。

そういう子がいると、次は「どこかへ連れて行きたい」と思うようになります。だからこの子は Minecraft のサーバーに付いてきて、必死に追いかけながら見事に道に迷います。チェスの盤を挟んで向かいに座ります。そしてアプリの外に出て、**自分しか入っていないウィンドウ**としてデスクトップに浮かびます。

> [!NOTE]
> すべてはあなたの PC の中で完結します。API キーも会話もキャラクターカードもモデルも、どこにもアップロードされませんし、アカウント登録もありません。AILEEN が通信するのは、あなたが指定した LLM プロバイダだけです。

## なぜこう作ったのか

**キャラクターはプリセットではなく「人」だから。** カードには名前・アイコン・性格・場面・第一声・会話例がそれぞれ入ります。同じモデルを2枚のカードに向ければ、脳みそを共有しているだけの別人格が2人できます。プロンプトは**あなたのカード**から組み立てます — しかも全部です。カスタムのシステムプロンプトを書いたなら、それが最優先されます。

**チャット欄の外でも、その子のままでいてほしいから。** Minecraft とチェスに専用の使い捨てプロンプトを渡すのは簡単でした。でもそうはしませんでした。まったく同じ人格をそのまま使います。チャットであなたをからかう子は、ゲームの中でも同じようにからかってきます。

**クリックを奪うデスクトップペットは、居ないほうがマシだから。** フローティングステージは既定でマウスを透過します。これは最初にテストする項目であり、いちばん何度も壊して直してきた項目でもあります。

**ソースを読みたかったから。** 難読化された塊も、隠れたサービスもありません。おかしな動きをしたら、そのまま開ける数千行があります。

## からだを与える

Live2D モデル（Cubism 2 / 3 / 4）を読み込めば、それが相棒の顔になります。待機モーションで呼吸し、まばたきし、表情を変え、**話している間は口が動きます**。

フォルダから読み込むことも、`model3.json` の URL を貼ってそのまま置いておくこともできます。

> [!TIP]
> Live2D モデルの追加は2クリックです：**設定 → 🎀 Live2D モデル設定 → 📁 フォルダから読み込む**。ダイアログを開きたくない場合は、ステージパネルにも同じボタンがあります。

## こえを与える

マイクを押して話しかけてください。声に出して答えて、そのまま聞き続けます。放置しておけば、押しっぱなしのトランシーバーではなく、本当のキャッチボールになります。タイピング中心のときは単発の音声入力もどうぞ。

音声エンジンは4種類。すでにキーを持っているものを選べます：システム音声（オフライン・無料）、OpenAI 互換なら何でも、声をクローンしたいなら Fish Audio、それから Xiaomi MiMo。中国語・英語・日本語・スペイン語に対応。

## あたまを与える

すでに契約しているモデルをそのまま持ち込めます — DeepSeek / OpenAI / Moonshot / SiliconFlow / Groq / Zhipu / Alibaba Bailian / Xiaomi MiMo / OpenRouter。完全オフラインにしたければローカルの Ollama でどうぞ。

AILEEN のアカウントも AILEEN のサーバーもありません。キーはあなたの PC からプロバイダへ直接飛びます。

## めを与える

任意のウィンドウやモニターのスクリーンショットを渡して、感想を聞けます。エラーログを読ませたり、グラフを眺めさせたり、そして予定よりずっと頻繁に、ボス戦の愚痴を聞いてもらったりしています。

> [!IMPORTANT]
> 画面を見るにはマルチモーダルモデルが必要です。`qwen-vl-plus` / `gpt-4o` / `glm-4v` / `MiMo-VL` は動作します。テキスト専用モデルは、行儀よく画像を無視します。

## チャット欄の外へ

**Minecraft。** キャラクターはボットとして Java 版サーバーに入ります。あなたを追いかけ、自分で操作したいときは手動操作を受け付け、チャットで話し、自動返信を ON にすれば**他のプレイヤーにもその子の口調で**返事をします。坂を登ろうとして盛大に失敗する姿は、面白いと認めるしかありません。

**チェス。** 難易度5段階、白番・黒番の選択、待った、盤面反転。あなたが考える間、キャラクターに局面を実況させられます。相棒に「意見を持つ何か」を与える最短の方法です。

## ウィンドウの外へ

**フローティングステージ**は、キャラクターをアプリからデスクトップへ連れ出します。枠なし・透過・常に最前面で、中身はその子だけのウィンドウです。

**既定でマウスを透過**します。下にあるウィンドウはクリックを1つも失いません。小さなハンドルは手を伸ばしたときだけ現れ、離せば消えます。頼んでいないものが画面に増えることはありません。

> [!TIP]
> `Ctrl+Shift+S`（またはメニューの **ステージ → 枠なしステージの表示／非表示**）でどこからでも切り替えられます。移動・サイズ変更は `−` ボタンで縮小、メニューからすみへの復帰も可能。位置とサイズは記憶されます。

## インストール

最新版は **[Releases](../../releases)** から。

| | |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **インストーラー** —— デスクトップとスタートメニューにショートカットを作ります。ほとんどの方はこちら。 |
| `AILEEN x.x.x.exe` | **ポータブル版** —— ダブルクリックだけで起動。レジストリにも何も書きません。 |

Windows 10 / 11（64bit）。

## インターフェースと言語

**English / 日本語 / 简体中文** に対応しています。中途半端な部分翻訳ではなく、ちゃんと全部です。初期状態は英語で、クリック一つで変えられます。

**設定 → 🌐 Language**、またはネイティブメニュー（`Alt`）からいつでも。アプリケーションメニュー自体も翻訳済みです —— ここを忘れるプロジェクトが多いのですが。

> [!TIP]
> 4つ目の言語を足したい方へ。文言は `src/lib/i18n.js` と言語ごとの JSON ファイルにまとまっており、UI はすべてそこから読んでいます。ファイルを1つ足して `LANGS` に1行追加すれば完了です。プルリクエスト、本当に歓迎します。

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

### 地味に驚かれる話

モデルとアイコンは `file://` ではなく、小さなローカル HTTP サーバー経由で配信しています。おしゃれをしているわけではなく、Live2D の WebAssembly とテクスチャが `file://` では読めないためで、これが一番お行儀のいい回避策でした。このサーバーは localhost にしか bind せず、あなたの PC の外に出ることはありません。

## 謝辞

### その肩の上に

AILEEN は **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** なしには存在しませんでした。「オープンソースの AI コンパニオン」を願望ではなく現実のものとして見せてくれたプロジェクトであり、このリポジトリは堂々と Airi に倣っています —— README の構成も、習慣も、バーチャルキャラクターを丁寧に作る価値があるという確信も。もし Airi をまだ見ていないなら、このタブを閉じてあちらを開いてください。あのスターの数は伊達ではありません。

そして **[Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA)** へ。声と記憶と人格を持ったキャラクターが、ソフトを見ていることを忘れさせる――それを証明してみせた AI VTuber です。それが基準です。AILEEN はそこへ手を伸ばした小さな試みで、まだ遠く及びません。

### 使わせてもらっているもの

- [mineflayer](https://github.com/PrismarineJS/mineflayer) / [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)：手のないキャラクターが Minecraft の世界であなたを追いかけ、みんなと同じようにフェンスに引っかかれるのは、この子たちのおかげです。PrismarineJS は JavaScript の Minecraft エコシステム全体を長年静かに支え続けていて、眺めているだけで一日潰れます。
- [js-chess-engine](https://github.com/josefjadrny/js-chess-engine)：依存ゼロなのに本物の探索をするチェスエンジン。小さすぎて今も疑っていますが、そのたびに負かされています。
- [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d)：ビルドシステムと格闘せずに Live2D をページに載せられます。Cubism 2/3/4 対応の根っこもここです。
- [DOMPurify](https://github.com/cure53/DOMPurify)：モデルの出力を Markdown として描画しながら、夜も眠れなくて済むのはこのおかげです。
- [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) — BSD-3-Clause。Minecraft のワイヤプロトコルを話してくれます。

Live2D Cubism Core ランタイムには Live2D 社のライセンスが適用されます。追加する Live2D モデルにもそれぞれの規約がありますので、作者の方の意向を尊重してください —— 特に配信で使う予定がある場合は。

## 似たプロジェクト

- **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** —— 超えるべき本命。セルフホスト型で、ブラウザ・デスクトップ・モバイルに対応。比較にならないほど野心的です。
- **[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)** —— ローカル LLM + Live2D の VTuber。オフライン重視で、まさにそれを求める方の出発点に最適です。
- **[BongoCat](https://github.com/ayangweb/BongoCat)** —— 本気で可愛いデスクトップペット。猫で足りるなら、素直に猫を飼いましょう。

## ライセンス

MIT —— [LICENSE](./LICENSE) を参照してください。持っていって、変えて、配ってください。
