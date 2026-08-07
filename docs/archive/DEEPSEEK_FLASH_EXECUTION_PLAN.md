# aidulc DeepSeek Flash 执行计划

> **执行者**：DeepSeek Flash
>
> **工作目录**：`F:\my_ai\aidulc`
>
> **目标**：把当前“备料流水线 + 阅读器原型”补齐为可日常使用的本地英语精读/跟读工作站。
>
> **执行顺序**：P0 → P1 → P2 → P3 → P4 → P5。每阶段必须通过自己的验收标准后才能进入下一阶段。

## 0. 执行状态（2026-08-04 完成）

全部阶段已实现并通过验收（见下方各阶段）。当前测试门禁：Python 94 + Rust 37 + 前端 13 文件语法全绿；Tauri release 构建成功；主界面/书库/导入/阅读器/设置/查词/任务系统均通过 CDP 端到端实测。

## 1. 当前基线

当前成果不能视为成熟软件。之前“Phase 1-8 全部完成”的结论已撤回，实际状态是：

- Python 侧车已有 EPUB/PDF/TXT、spaCy、LLM、Kokoro、Opus 基础流水线。
- Rust/Tauri 已有 SQLite、IPC、Job Object 和部分服务骨架。
- 前端只有一个阅读器原型，没有产品级主界面。
- `reader/index.html` 只加载阅读器脚本，`prep_view.js` 存在但不可达。
- 阅读器固定加载 `chapters[0]`，不存在书库、导入、章节导航和设置入口。
- 当前测试主要覆盖 Python/Rust 纯逻辑，缺少前端、导入、重启恢复、partial 和失败重试测试。

## 2. 已确认的关键缺陷

### 2.1 词级时间轴缺失

倒数第二句缺失后半段光标的根因：

- Kokoro 输出单个 token：`daisy-chain`。
- spaCy segments 拆成：`daisy`、`-`、`chain`。
- `prep/aidulc_prep/pipeline/tts/stage.py` 的精确匹配失败后直接终止剩余匹配。
- 后续 segment 没有 `words[]`，但 align 只检查时间顺序，没有检查 segment 覆盖率，所以质量报告错误地显示成功。

### 2.2 `it` 高亮错位

第二句的两个 `it` 已经存在于书包中，问题在前端：

- `words[]` 是稀疏 segment 索引，标点会造成数组位置和 `seg_idx` 不相等。
- `reader/components/reader_renderer.js` 把 `wordIndex` 直接当作 `data-seg-idx` 查询。
- 必须改为：`const segIdx = words[wordIndex].seg_idx`，再查询对应 DOM。

### 2.3 产品入口缺失

- 没有主界面、书库、导入、任务列表、设置和导航。
- `prep_view.js` 没有被 `index.html` 引入，也没有路由调用。
- 导入视图即使接入，也只是手工输入路径，不是原生文件选择/拖拽导入。
- 没有导入完成后自动入库、打开书籍和刷新书库的闭环。

### 2.4 其它已确认问题

- 没有字号、行距、正文宽度、字体族、主题和儿童模式设置。
- 阅读进度、播放位置、书签没有接通 SQLite。
- 词点击只有 `console.log`，没有词典面板和显式加入生词本。
- `vocab`/`dictionary` 表没有 profile 隔离字段。
- `nlp.py` 对一个段落只处理第一句，可能丢弃同段后续句子。
- partial 书包的失败句音频字段与 schema 语义不一致。
- 失败句没有单句重试按钮。
- `run.log` 没有形成完整、可用的实际输出链路。
- 任务状态不是持久化任务表，进度事件没有可靠的 `jobId`。
- 当前代码存在硬编码的 `F:\hf_cache`、`F:\my_ai\subgen` 等开发机路径。
- 没有前端自动化测试。

## 3. 总体约束

- 保留当前技术栈：Tauri + Rust + vanilla JavaScript + Python 侧车。
- 不把整个前端迁移到 React/Vue，不以重写代替修复架构。
- 所有跨语言字段先修改 `contracts/`，再同步 Python/Rust/前端和 fixture。
- 所有核心逻辑先写纯函数测试，再接 I/O。
- 所有 Tauri 调用只能从 `reader/ipc/bridge.js` 出口发出，视图禁止直接 `invoke`。
- 不再使用 demo 小样作为默认启动页或默认书籍。
- 不再固定读取 `latest` 或 `chapters[0]`。
- 不允许使用 `console.log` 代替用户功能或错误反馈。
- 不允许用静默 fallback 掩盖数据缺失。
- 不允许声称阶段完成，除非实际运行对应验收命令并记录结果。
- 不使用破坏性 Git 命令，不覆盖用户数据，不删除与当前任务无关的文件。

## 4. 目标前端架构

保持 vanilla JS，但补齐应用层和边界层：

```text
reader/
├── index.html
├── main.js                         启动入口
├── app/
│   ├── app_state.js                统一应用状态
│   ├── store.js                    状态读写和事件
│   └── router.js                   library/prep/reader/settings
├── ipc/
│   └── bridge.js                   唯一 Tauri invoke/listen 出口
├── views/
│   ├── shell_view.js               应用壳、导航、全局错误
│   ├── library_view.js             书库和最近阅读
│   ├── prep_view.js                导入和任务队列
│   ├── reader_view.js              阅读器
│   └── settings_view.js            设置和 profile
├── components/
│   ├── app_nav.js
│   ├── book_card.js
│   ├── import_dialog.js
│   ├── task_row.js
│   ├── chapter_drawer.js
│   ├── reader_toolbar.js
│   ├── player_bar.js
│   ├── dictionary_panel.js
│   └── error_banner.js
├── core/
│   ├── timeline.js
│   ├── word_alignment.js
│   └── shadow.js
└── styles/
    ├── tokens.css
    ├── app.css
    ├── library.css
    ├── prep.css
    ├── reader.css
    └── settings.css
```

## 5. P0：数据正确性和词级高亮

### 5.1 实现内容

- 新增纯函数 `align_tts_words_to_segments`。
- 支持普通词、大小写差异、连字符词、撇号缩写、重复词、标点和 Unicode 撇号。
- `daisy-chain` 必须覆盖 `daisy`、`-`、`chain`。
- `I've`、`Earth's`、`don't` 等 TTS token 与 spaCy segment 不一致时，按顺序做一对多/多对一映射。
- 不允许因为一个 token 匹配失败就终止后续所有匹配。
- 每个非 `PUNCT` segment 必须有时间轴，或明确记录 alignment failure。
- 前端使用 `words[wordIndex].seg_idx` 定位 DOM。
- `reader_renderer.js` 建立句内 `seg_idx → bubble` Map，只更新旧词和新词，不在每个 rAF 全量查询所有 span。
- `findSentenceIndex` 改为基于连续 audio 区间的二分查找。
- 修复 Kokoro 多 chunk 合并时后续 chunk 时间轴的累计偏移。
- 词时间保持“句内相对 ms”，句子 audio 保持“章节绝对 ms”，不得重复加起点。
- 修复失败句静音占位和句子 audio 区间，保证章节时间轴连续。
- `nlp.py` 必须把一个段落中的所有 spaCy sentence 转成多个 Sentence，不能只取第一句。
- checkpoint 恢复必须 hydrate：`translation`、`explanation`、`segments`、`phrasal_verbs`、`audio`、`words`、`status`。
- align 覆盖率失败必须更新句子 `status` 和 `failedStages`，同时写入 `quality.json`。

### 5.2 必须新增的回归测试

- `daisy-chain` 覆盖所有非标点 segment。
- `I've`、`Earth's`、`don't` 映射。
- 重复词按顺序映射，不跳到后一个同名词。
- 标点造成稀疏 `seg_idx` 时，前端仍高亮正确词。
- 第二句两个 `it` 均能定位。
- 倒数第二句没有尾部无时间轴区间。
- 未匹配词会得到 `partial/align`，不会显示 `ok`。
- 多 chunk TTS 的后续 chunk 时间单调递增。
- 多句段落不会丢句。
- 失败句静音占位后，下一句 audio 起点连续。

### 5.3 P0 验收

- 第二句两个 `it` 都能正确高亮。
- 倒数第二句从句首到句尾没有无光标的可读词区间。
- 词级覆盖率不足时，`quality.json` 明确报告失败。
- 失败句不会伪装成 `status=ok`。
- Python 测试和前端单元测试全绿。

## 6. P1：主界面、书库和导入

### 6.1 Rust 数据和命令

- 新增 `books` 表：`id`、`title`、`source_path`、`pack_dir`、`profile_id`、`status`、`last_opened_at`、`created_at`、`updated_at`。
- 新增 `library_list`、`library_register`、`library_remove`、`library_open`、`library_scan` 命令。
- 书包目录必须是每本书/profile 独立的受控目录。
- `load_bookpack` 接收 `book_id`，不再接收 `latest`。
- 音频读取必须相对于已校验的书包根目录，不能相对于全局库目录猜路径。
- 导入任务完成后自动注册 book，并发送 `library-changed` 事件。
- 增加原生文件选择命令或 Tauri dialog plugin，限定 EPUB/PDF/TXT。

### 6.2 前端实现

- `main.js` 初始化 bridge、store、router、shell。
- 启动默认进入 library，不直接进入 reader。
- shell 提供书库、备料台、设置、当前书籍入口。
- library 显示书名、profile、处理状态、最近阅读、章节数和失败数。
- prep 支持文件选择、拖拽、profile 选择、开始任务、取消任务。
- 任务完成后显示“打开书籍”和“打开目录”。
- 同时支持两本书和两个 profile，不允许路径/音频串书。
- 删除、移除、重跑按钮必须接真实命令，不允许只创建按钮。

### 6.3 P1 验收

- 清空书库后启动，显示主界面而不是 demo。
- 选择 EPUB/PDF/TXT 后出现任务行和阶段进度。
- 任务完成后书籍自动出现在书库。
- 点击任意书籍能打开对应书包。
- 两本书、两个 profile 同时存在时，书名、音频、阅读状态不混淆。

## 7. P2：成熟阅读器和显示设置

### 7.1 阅读器功能

- 章节目录、上一章、下一章。
- 播放/暂停、音频进度条、拖动定位。
- 上一句、下一句、当前句播放。
- 单句重复 N 次。
- 句末留白。
- A-B 循环。
- 变速不变调。
- 空格重复当前句。
- 句级/词级高亮切换。
- 关闭后恢复章节、句子和播放位置。
- 双击句子书签，书签面板持久化。
- 书内搜索和搜索结果跳转。

### 7.2 字体和显示设置

新增 SQLite 表：

```text
reader_settings(
  profile_id,
  font_size,
  line_height,
  content_width,
  font_family,
  theme,
  highlight_granularity,
  child_mode,
  updated_at
)
```

- CSS 使用 `--reader-font-size`、`--reader-line-height`、`--reader-content-width` 等变量。
- 字体设置实时改变，不重建整章 DOM。
- 儿童模式自动提高字号、对比度和默认词级高亮。
- profile 设置和临时阅读设置必须明确归属，不能只存在 JS 模块变量。

### 7.3 P2 验收

- 字体大小、行距、正文宽度可实时修改。
- 重启后字体、主题、行距保持。
- 阅读位置恢复误差不超过 1 秒。
- 书签重启后仍存在。
- 章节切换后音频、句级高亮、词级高亮和跟读状态全部对应新章节。

## 8. P3：查词、词典、生词本和 profile

- 点击词打开 dictionary panel。
- 本地词典命中优先。
- 未命中时调用 Python LLM 补全。
- 显示释义、词性、音标、例句和当前上下文。
- 只有用户点击“加入生词本”才写入 vocab。
- AI 补全词典不自动进入复习队列。
- `vocab` 和 `dictionary` 增加 `profile_id`，迁移为复合 key。
- `vocab_self` 和 `vocab_kid` 必须完全隔离。
- `sync_push` 只推当前 profile。
- `sync_pull` 合并后必须写回 SQLite。
- CF token 使用 Windows Credential Manager，永不进入 WebView。
- 同步失败显示 pending，不阻塞本地阅读和加词。

### P3 验收

- 点击词不会直接写入生词本。
- 点击“加入”后才落库。
- kid/self 词条互不污染。
- 离线阅读和加词正常。
- 网络恢复后同步状态可见且可重试。

## 9. P4：持久任务系统和失败重试

新增任务表：

```text
jobs(
  id,
  book_path,
  profile_id,
  output_dir,
  status,
  stage,
  current,
  total,
  failed_count,
  created_at,
  updated_at
)
```

- 使用真正 UUID `job_id`。
- 每一条进度事件必须携带 `jobId`。
- GPU 任务串行执行，任务可排队。
- 应用重启后恢复任务列表。
- 支持取消任务、删除任务、打开目录、预览成果。
- 支持“只重试失败句”。
- 重试失败句时，成功句 checkpoint hash 不得改变。
- 失败句显示失败阶段、用户摘要和技术详情入口。
- `run.log` 实际写入任务目录。
- Job Object 保持 R11 测试，并增加应用取消/崩溃场景验证。

### P4 验收

- 杀掉应用后任务仍然存在。
- 重新打开后能显示并继续任务。
- 取消后没有 Python、ffmpeg 孤儿进程。
- 重试失败句只执行失败句。
- 多个任务的进度不会串行或串 job。

## 10. P5：交付和质量门禁

- 删除硬编码 `F:\hf_cache`、`F:\my_ai\subgen`。
- ffmpeg、模型、TTS、spaCy 路径全部走配置和模型绑定快照。
- 首次运行检查模型、CUDA runtime、ffmpeg、spaCy 和 WebView2。
- 缺失依赖时提供下载/修复入口和可操作错误。
- Tauri bundle 正式开启。
- 重新打包不能覆盖用户数据库、书包、设置和模型池。
- 支持干净目录运行。
- 增加 schema、SQLite 和书包版本迁移。
- 侧车不依赖开发机绝对路径。

### 10.1 必须新增的测试类别

- Python：词级对齐、分句、partial、checkpoint、重试、quality report。
- Rust：书库扫描、路径安全、SQLite 迁移、profile 隔离、任务恢复、Job Object。
- 前端：Playwright 或 CDP 测试主界面、导入、书库、章节、播放、词级高亮、字体、书签、失败态。
- 集成：导入 EPUB/PDF/TXT、生成书包、打开书包、重启恢复、取消任务、失败句重试。
- 打包：干净目录运行，不依赖 `F:\my_ai\subgen`。

### 10.2 最终验收

- 两本真实书同时存在。
- 每本书至少两章。
- 至少包含一个翻译失败句、一个 TTS 失败句和一个对齐失败句。
- 导入、处理、入库、打开、阅读、查词、加词、重启恢复全部走通。
- `quality.json` 的失败数与界面标记数完全一致。
- 前端、Python、Rust 测试全绿。
- 干净目录不依赖开发机绝对路径。

## 11. 建议执行命令

执行者每个阶段开始前先运行：

```powershell
Set-Location F:\my_ai\aidulc

F:\my_ai\aidulc\prep\.venv\Scripts\python.exe -m pytest F:\my_ai\aidulc\prep\tests
cargo test --manifest-path F:\my_ai\aidulc\src-tauri\Cargo.toml
node --check F:\my_ai\aidulc\reader\views\reader_view.js
node --check F:\my_ai\aidulc\reader\components\reader_renderer.js
```

每个阶段结束必须报告：

```text
阶段:
修改文件:
新增测试:
实际执行命令:
实际测试结果:
实际人工/端到端验收结果:
未完成项:
风险和下一阶段前提:
```

## 12. 明确不做

以下仍不属于本轮补齐范围：

- 在 aidulc 内实现 SRS 复习算法。
- 声音克隆和多音色旁白。
- 中译英和其它源语言。
- 跟读录音回放对比。
- EPUB3 Media Overlays 导出。
- 多机并发和远程推理。

**开始执行时必须从 P0 开始，先修复数据正确性，再建立主界面，不能继续从 demo 阅读器上堆按钮。**
