<h1 align="center">✦ AILEEN</h1>

<p align="center">
  <b>数据完全保存在本机的桌面 AI 助手 / AI Agent。</b><br/>
  Live2D 角色 · 多服务商 LLM 对话 · 长期记忆 ·<br/>
  工具调用与电脑控制。
</p>

<p align="center">
  AILEEN 也可以替你写角色卡 ——<b>说出角色名字，它就整理出可直接使用的性格、经历与说话方式</b>；<br/>
  或从一句灵感开始，生成一个原创角色。
</p>

<p align="center">
  灵感来自 <a href="https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA">Neuro-sama</a>，
  致敬 <a href="https://github.com/moeru-ai/airi">moeru-ai/Airi</a>。
</p>

<p align="center">
  [<a href="./README.md">English</a>]
  [<a href="./README.ja.md">日本語</a>]
  [<a href="./README.zh-CN.md">简体中文</a>]
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-ff7eb3.svg"></a>
  <a href="../../releases"><img src="https://img.shields.io/github/downloads/haixu8396-png/aileen-desktop/total?color=38b0de"></a>
  <a href="#安装"><img src="https://img.shields.io/badge/platform-Windows-9aa0b4.svg"></a>
  <a href="#界面与语言"><img src="https://img.shields.io/badge/languages-English%20%C2%B7%20日本語%20%C2%B7%20简体中文-a78bfa.svg"></a>
</p>

<p align="center">
  <a href="../../releases/latest"><b>⬇️ 下载 Windows 版</b></a>
  · <a href="https://github.com/haixu8396-png/aileen-desktop/releases">全部版本</a>
  · <a href="./CHANGELOG.md">更新日志</a>
</p>

---

## 概览

AILEEN 是一个面向 Windows 桌面环境的 AI Assistant / AI Agent 项目，把 AI 对话、角色系统、长期记忆、工具调用、电脑控制与可视化角色整合到同一个交互环境中。它以 Electron 应用的形式运行：界面使用原生 JavaScript，涉及 API Key 的请求全部在主进程中完成，用户数据只保存在本机。

项目不设账号，也没有自建后端：AILEEN 只与你自行配置的模型、语音与嵌入服务商通信。

当前重点方向：

- **AI 对话与角色系统** —— 角色卡（性格、场景、开场白、示例对话）、人格提示词装配、TTS/STT，以及多服务商 LLM 支持（DeepSeek、OpenAI、Moonshot、SiliconFlow、Groq、智谱、通义千问、小米、OpenRouter、Ollama 或任何兼容接口）。
- **长期记忆与上下文管理** —— 对话记忆、本地知识库，以及统一的上下文引擎：把系统提示词、角色卡、历史、记忆、知识与工具输出装配成一份带 token 预算的请求。
- **Agent 与工具调用** —— 单 Agent 工具循环，包含工具注册表、三档风险等级与显式审批流程。
- **文件与电脑操作** —— 读写文件、执行白名单命令、查看 git 状态，以及桌面输入（鼠标、键盘、窗口切换）；全部受工作区边界约束，并按操作逐次授权。
- **桌面环境交互** —— 无边框、默认鼠标穿透的悬浮展台，以及 Minecraft 与国际象棋两个可交互环境。
- **可视化角色** —— Live2D 模型，动作与表情由对话内容驱动。
- **图像与视觉** —— 屏幕截图交由支持视觉的模型处理。
- **可扩展性** —— Agent 核心与宿主无关，工具注册表由数据驱动；MCP、浏览器工具与更多环境是后续方向，目前尚未实现。

AILEEN 仍在持续开发中。目标是为 AI 对话、记忆、Agent 执行与电脑控制提供一个统一的桌面环境，而不只是一个单一用途的聊天客户端。

> [!NOTE]
> 所有数据都留在本机：API Key、聊天记录、角色卡与模型都不会上传，也不需要注册账号。

## 为什么这么做

**因为角色是「人」，不是预设。** 每张卡都有自己的名字、头像、性格、场景、开场白和示例对话。同一个模型，两张卡就是两个人。提示词完全由**你的卡**拼出来 —— 而且是全部：如果你写了自定义系统提示词，那就以它为准。

**因为角色走出聊天框，也该还是它自己。** 给 Minecraft 和象棋各塞一段一次性的提示词，是最省事的做法。我们没这么干，而是让它们复用**完全相同的人格**。在聊天里爱损你的那个它，进了游戏还是那个它。

**因为一个抢你鼠标的桌宠，还不如没有。** 悬浮展台默认整窗鼠标穿透。这是我们最先测的一项，也是被我们搞坏又修好次数最多的一项。

**因为我们也想能读源码。** 没有压缩过的黑盒，没有藏起来的服务。哪里行为不对，就是几千行可以自己打开看的代码。

## 给它一副身体

放进任意一个 Live2D 模型（Cubism 2 / 3 / 4），它就成了你伙伴的脸。会待机呼吸、会眨眼、会做动作、会换表情，**说话的时候嘴巴跟着动**。

你可以导入模型文件夹，也可以直接贴一个 `model3.json` 的网址，让它就待在那儿。

> [!TIP]
> 加模型只要两下：**设置 → 🎀 Live2D 模型设置 → 📁 从文件夹导入**。不想开弹窗的话，舞台面板上也有同样的按钮。

## 给它一副嗓子

按下麦克风直接说话。它出声回答，然后接着听 —— 挂着不管，你得到的是一场真正的来回对话，而不是对讲机。想打字的时候，也有单次语音输入。

四种语音引擎，用你手头已经有 Key 的那个就行：系统语音（离线免费）、任何 OpenAI 兼容接口、想克隆音色就上 Fish Audio、以及小米 MiMo。中文、英语、日语、西班牙语全程支持。

## 给它一个脑子

你已经在付费用的模型，直接拿来用 —— DeepSeek / OpenAI / Moonshot / 硅基流动 / Groq / 智谱 / 阿里百炼 / 小米 MiMo / OpenRouter。想彻底离线，接本地 Ollama。

没有 AILEEN 账号，也没有 AILEEN 服务器。你的 Key 从你的电脑直连你的服务商。

## 给它一双眼睛

把任意窗口或显示器的截图丢给它，问问它怎么看。我们拿它读报错堆栈、扫一眼图表，以及——比原计划频繁得多地——一起吐槽某场 BOSS 战。

> [!IMPORTANT]
> 看屏幕需要多模态模型。`qwen-vl-plus` / `gpt-4o` / `glm-4v` / `MiMo-VL` 都可以；纯文本模型会很有礼貌地无视那张图。

## 然后，让它走出聊天框

**Minecraft。** 角色会以机器人身份进 Java 版服务器。它跟着你走，你想自己开的时候它也接受手动操控，会在服务器聊天栏说话；打开自动回复后，**它还会用自己的语气去回别的玩家**。看它想爬个坡却摔得七荤八素，是真的好笑，这个我们不装。

**国际象棋。** 五档难度、执白或执黑、悔棋、翻转棋盘，还能在你思考的时候让角色点评局面。这是给一个伙伴「塞点可以有意见的东西」最便宜的办法。

## 而且它记得住

角色会记住你们之间发生过的事 —— 不是把整段聊天记录无限重播，而是记住那些真正重要的，等需要的时候自己想起来。说过一次的事，不用再说第二次。

**知识库。** 把你自己的文件丢进去 —— 文本、Markdown、HTML、JSON、PDF —— 它们会被切块、存在本地，相关的那几段在需要时自动进到对话里。PDF 解析是自己写的，为了读你的文档没有多装任何东西。

这两样都跑在你自己选的**嵌入模型**上（设置 → 🧠 记忆与知识库：OpenAI / 硅基流动 / 阿里云百炼 / 智谱 / 本地 Ollama，或任何兼容接口），所以检索是**按意思**找，不只是对关键词。没配嵌入模型也照样能用 —— 检索退化成关键词匹配，全程离线。

记下来的东西只留在你自己机器上，和别的数据放在同一个目录里，而且只有属于它的那两个文件夹可写。

> [!NOTE]
> 嵌入模型的 Key 和这个应用里其它 Key 一个待遇：页面永远看不到它。请求由主进程发出，渲染层只拿到一个「已配置」的布尔值。

## 然后，让它真的去动手

前面那些都发生在应用里。这一段是它走出去、真的用你的电脑。

侧栏打开 **🖥 电脑控制**，**普通聊天框就是入口** —— 你还是像平常那样跟角色说话。区别在于，它现在会去做，而不是只告诉你怎么做：

> **你**：帮我打开浏览器搜一下 AILEEN
>
> **AILEEN**：好，我去看看。
>
> *右侧展台变成控制仪表板，它开始干活*

它能读写文件、跑命令、看 git、读屏幕、动鼠标、敲键盘、开程序、切窗口。干完之后，**用它自己的语气**回来跟你汇报 —— 还是那个人，还是那种说话方式，不是一句「任务已完成」。

**没有你的同意，它什么都不会做。** 看东西是自由的；凡是会碰到电脑的操作 —— 动鼠标、敲键盘、跑命令、开程序 —— 每一次都会先停下来问你。这个「必须问」是**刻意做成设置里也关不掉的**。

> [!IMPORTANT]
> 它干活的时候，右侧展台会变成 **Agent 控制仪表板**：任务、当前步骤、带时间戳的操作日志、每一次工具调用、它截到的屏幕、以及批准按钮。聊天区还是聊天区 —— 工具日志**不会**被塞进聊天气泡里。

> [!NOTE]
> 角色有人格，Agent 就必须带着这个人格。系统提示词的第一段**永远是角色卡**，不管它是在聊天、下棋，还是在操作你的桌面。它不会在拿到工具之后悄悄变成一个通用的编程助手 —— 有人格丢失的硬性检查，一旦发现就直接中止。

## 再让它走出窗口

**无边框悬浮展台**把角色从应用里拎出来放到桌面上：一个无边框、透明、始终置顶的窗口，里面除了它什么都没有。

它**默认整窗鼠标穿透**。底下的窗口一个点击都不会丢。那个小手柄只在你伸手去够的时候浮现，手一停就淡出 —— 屏幕上不会多出你没要的东西。

> [!TIP]
> `Ctrl+Shift+S`（或菜单里的 **展台 → 显示 / 隐藏无边框展台**）随时开关。拖动、用 `−` 按钮缩小、或用菜单把它复位回角落；位置和大小都会记住。

## 安装

到 **[Releases](../../releases)** 下载最新版。

| | |
| --- | --- |
| `AILEEN Setup x.x.x.exe` | **安装版** —— 自动创建桌面与开始菜单快捷方式。绝大多数人要的是这个。 |
| `AILEEN x.x.x.exe` | **免安装便携版** —— 双击即用，注册表里什么都不写。 |

支持 Windows 10 / 11（64 位）。

## 界面与语言

完整支持 **English / 日本語 / 简体中文**，是全部翻完，不是翻一半。启动默认英文，一下就能换。

随时在 **设置 → 🌐 Language** 或原生菜单（按 `Alt`）里切换。**应用菜单本身也翻了** —— 这一点很多项目都会忘。

> [!TIP]
> 想加第四种语言？所有文案都在 `src/lib/i18n.js`，每种语言一个 JSON 文件，整个界面都从那儿读。加一个文件、在 `LANGS` 里加一行，就完事了。非常欢迎提 PR。

## 开发

```bash
git clone https://github.com/haixu8396-png/aileen-desktop.git
cd aileen-desktop
npm install
npm start        # 构建界面并启动
```

需要 Node.js 18 或更高。首次运行会下载 Electron；觉得慢可以先把 `ELECTRON_MIRROR` 指向国内镜像。Windows 用户也可以直接双击 `install.bat`。

```bash
npm run dist     # 生成安装包 + 便携版到 release/
npm test         # 单元测试
```

Windows 上双击 `build-installer.bat` 效果相同。

### 目录结构

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

### 一件会让人意外的小事

模型和头像是用一个很小的本地 HTTP 服务提供的，而不是 `file://`。不是我们想炫技 —— Live2D 的 WebAssembly 和贴图在 `file://` 下就是读不了，而这是我们找到的最不打扰人的办法。这个服务只绑 localhost，永远不会监听你电脑以外的地址。

## 致谢

### 站在谁的肩膀上

致敬 **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** —— 没有它，就不会有 AILEEN。是它让「开源的 AI 伴侣」听上去像一件真事而不是一个愿望。这个仓库大大方方地照着 Airi 学 —— 说明的写法、做事的习惯，以及那份「虚拟角色值得被认真做」的笃定。如果你还没看过 Airi，先把这页关掉去看它。那么多 star 不是白来的。

而这一切的起点是 **[Neuro-sama](https://www.youtube.com/channel/UCLHmLrj4pHHg3-iBJn_CqxA)** —— 这位 AI 主播证明了：一个有声线、有记忆、有性格的角色，真的能让你忘记自己在看软件。那就是标杆。AILEEN 只是朝它伸了伸手，而且离得还远。

### 用到的开源项目

- [mineflayer](https://github.com/PrismarineJS/mineflayer) 与 [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)：一个没有手的角色能在 Minecraft 里追着你跑、并且和大家一样卡在栅栏上，全靠它们。PrismarineJS 这些年一直安安静静地撑着整个 JavaScript 版 Minecraft 生态，光翻一翻就够消磨一个下午。
- [js-chess-engine](https://github.com/josefjadrny/js-chess-engine)：零依赖，却是真有搜索的棋力引擎。我们到现在还怀疑它怎么这么小，而它每次都在赢。
- [oh-my-live2d](https://github.com/oh-my-live2d/oh-my-live2d)：不用跟构建系统打架就能把 Live2D 放进页面。我们整套 Cubism 2/3/4 支持也是从这儿来的。
- [DOMPurify](https://github.com/cure53/DOMPurify)：能把模型输出当 Markdown 渲染、晚上还睡得着觉，全靠它。
- [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) —— BSD-3-Clause。替我们讲 Minecraft 的网络协议。

Live2D Cubism Core 运行时适用 Live2D 公司自己的许可条款。你添加的每个 Live2D 模型也各有各的规约，请尊重原作者的意愿 —— 尤其是打算拿它开直播的话。

## 类似的项目

- **[moeru-ai/Airi](https://github.com/moeru-ai/airi)** —— 需要超越的那个。自托管，浏览器 / 桌面 / 手机三端，野心比这个项目大得多。
- **[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)** —— 本地 LLM + Live2D 的 VTuber，主打离线。如果你要的正是这个，它会是很棒的起点。
- **[BongoCat](https://github.com/ayangweb/BongoCat)** —— 一只做得真心可爱的桌宠。如果你要的只是一只猫，那就诚实地去养那只猫。

## 许可证

AILEEN 采用 **PolyForm Noncommercial License 1.0.0** 发布，具有约束力的是 [LICENSE](./LICENSE) 中的协议原文。

默认许可证不授予商业使用权：个人使用、学习、爱好项目、学校以及公益组织等非商业用途均可使用；但不允许将本软件出售，也不允许在其之上构建商业产品。

如需商业使用、商业发行或其他形式的商业授权，必须事先取得 AILEEN 开发者的书面许可，可通过 [SECURITY.md](./SECURITY.md) 中列出的方式联系我们。

许可变更说明：0.7.0 起，本项目许可证由 MIT 变更为 PolyForm Noncommercial 1.0.0。在 MIT 期间已获得副本的用户，就该副本仍享有 MIT 授予的权利 —— 许可证不追溯。
