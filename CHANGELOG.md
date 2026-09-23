# 更新日志

本项目所有重要改动都会记录在此，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-16

### 变更
- **项目改名为 AILEEN**（原 Elysia）：
  - 应用名、窗口标题、界面 Logo、安装包名改为 AILEEN
  - 数据目录改为 `D:/AileenData`（环境变量 `AILEEN_DATA_DIR`，兼容旧名 `ELYSIA_DATA_DIR`）
  - 内部标识统一：`__AILEEN_*` 自检钩子、`AILEEN_SELFTEST*` 环境变量、`aileen-card-v1` 角色卡 spec、localStorage 键前缀 `aileen.`
  - **旧数据自动迁移**：首次启动会依次从 `D:/ElysiaData`、`%APPDATA%\Elysia`、原应用目录查找并迁移设置、角色卡与模型，API Key 不会丢失
  - 安装目录、桌面与开始菜单快捷方式名称变为 AILEEN（旧版可手动卸载）

## [0.1.4] - 2026-09-15

### 重构
- **渲染层控制器拆分**：`src/main.js` 从 1325 行降到约 330 行，按职责拆分为 7 个模块：
  - `lib/state.js` 共享状态、TTS/STT 实例、跨模块回调（hooks）
  - `lib/dom.js` DOM 与交互工具
  - `lib/stage.js` Live2D 舞台与模型管理
  - `lib/chat.js` 消息渲染 / 流式对话 / 聊天记录
  - `lib/characters-ui.js` 角色卡列表、菜单、编辑器
  - `lib/modals.js` 设置弹窗 / 主题调色 / 屏幕视觉
  - `lib/voice.js` 实时语音对话
- 模块间通过 `hooks` 注入回调，消除循环依赖。

### 工程
- CI 流水线加入**单元测试**与**自检冒烟测试**双重门禁，任一失败即中止发布。

## [0.1.3] - 2026-09-15

### 安全
- `markdown.js` 输出统一经 **DOMPurify** 消毒（标签/属性白名单），链接仅放行 http(s) 并剔除可逃逸属性的字符。
- `shell:openPath` 收敛为仅允许打开用户数据目录/应用目录内的路径。
- `settings:set` 走白名单规范化：未知字段丢弃、类型与范围校验、非 http(s) 的 baseUrl 清空。

### 修复
- 角色卡同名不再静默覆盖，新建/导入/复制时自动追加 `-2`、`-3`。
- `sanitizeFileName` 支持 Unicode 字母，日文假名（アトリ）等不再被替换成下划线。
- 聊天记录改由主进程按角色存文件（不再 `slice(-60)` 截断、清缓存不丢），并自动迁移旧 localStorage 记录。
- 删除渲染层重复的默认配置，默认值只在主进程维护。
- 数据目录改为探测式解析：`ELYSIA_DATA_DIR` > D 盘（存在时）> 系统默认 userData。

### 新增
- TTS 语速贯通全部引擎（OpenAI `speed` / Fish `prosody.speed` / 系统语音 `rate`），并新增语速滑条。
- 单元测试 21 项（vitest）：deepMerge、sanitizeFileName、normalizeSettings、isInsidePath、SSE 解析、XSS 消毒。

### 其他
- 内部前缀 `AIRI_*` / `__AIRI_*` 统一改为 `ELYSIA_*`。

## [0.1.2] - 2026-09-15

### 新增
- GitHub Actions 自动构建：推送 `v*` 标签后自动打包 NSIS 安装包、便携版与完整源码 zip，并发布 Release。

### 修复
- 打包时禁用 electron-builder 的自动发布，交给 CI 上传 Release 附件（修复 tag 构建失败）。

## [0.1.1] - 2026-09-15

### 新增
- 一键安装：NSIS 安装包 + 免安装便携版。
- Windows 一键脚本：`install.bat`（安装依赖并启动）、`build-installer.bat`（本地打包）。

### 修复
- 用户数据目录固定到 `D:/ElysiaData` 并支持自动迁移。

## [0.1.0] - 2026-09-01

### 新增
- 首个公开版本。
- 多模型 LLM 对话（DeepSeek / OpenAI / Moonshot / 硅基流动 / Groq / 智谱 / 阿里百炼 / 小米 MiMo / OpenRouter / Ollama）。
- Live2D 看板娘：模型导入、动作、表情、朗读联动。
- TTS：系统语音 / OpenAI 兼容 / Fish Audio / 小米 MiMo，多语言（中/英/日/西）。
- STT：Whisper 兼容 / 小米 MiMo ASR / 浏览器识别。
- 实时语音对话、屏幕视觉、角色卡系统、外观调色。
- 数据本地化存储，API Key 与角色卡不出本机。
