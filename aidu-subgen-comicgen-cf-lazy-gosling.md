# aidulc —— 本地整本书英语精读 / 跟读工作站

> **可调整的草案**。Phase 0 的实测数字回来后要回头改第五、六节。
> 本文档按用户全局工程原则的五个维度组织第三部分（配置/集成/依赖交付/状态/错误反馈），
> 这五项是验收方案成熟度的卡尺，不是可选章节。

---

# 0. 交接说明（接手者先读这一节）

## 0.1 这份文档是什么

**已实现的系统**（2026-08-03 起）。`F:\my_ai\aidulc` 从空目录变成了可运行的本地精读工作站：
Python 侧车（备料）+ Rust 外壳（Tauri 阅读器/状态层/备料台）+ 前端（从 aidu 剥离适配）。
Phase 1-8 全部落地并通过各自 DoD，见 §5.3 实施完成记录。

## 0.1a 快速上手

```powershell
# 备料: 丢一本书 → 书包
F:\my_ai\aidulc\prep\.venv\Scripts\python.exe -m aidulc_prep.cli --job <job_request.json> --out <书包目录>
# 例见 .spikes\job_phase3.json (Alice 样本, 10 句 77s 跑完)

# 阅读: 起 Tauri (开发期)
$env:AIDULC_LIBRARY = "F:\my_ai\aidulc\.spikes\out\phase8_clean"
$env:AIDULC_PREP = "F:\my_ai\aidulc\prep\build\stage7\aidulc-prep\aidulc-prep.exe"
F:\my_ai\aidulc\src-tauri\target\debug\aidulc.exe

# 测试
F:\my_ai\aidulc\prep\.venv\Scripts\python.exe -m pytest F:\my_ai\aidulc\prep\tests   # 64 个
F:\my_ai\aidulc\src-tauri\target\debug\deps\aidulc-*.exe                             # Rust 28 个
```

**关键路径**：`contracts/`（跨语言契约，唯一真相源）→ `prep/aidulc_prep/`（侧车）→
`src-tauri/src/`（Rust）→ `reader/`（前端）。改跨端字段先改 contracts 三份 schema，
三端 conformance 测试会同时变红。

## 0.2 ⚠️ 可信度分级（最重要的一节，不要跳过）

文档里的陈述**可信度不同**，混用会出事：

| 级别 | 含义 | 在文中的位置 | 使用方式 |
|---|---|---|---|
| **✅ 实测事实** | 本机真实跑过命令核实的 | 第五节全表、3.3 的模型池表 | 可直接依赖 |
| **📐 估算** | 基于公开参数推算，**未在本机验证** | 第六节吞吐表、首次下载体积 | **必须在 Phase 0 用真实 spike 替换**，不要当事实引用 |
| **❓ 待验证假设** | 我认为可行但没验证过 | R1（GBNF 约束解码）、R11（Job Object 孙进程继承）、2.5 路线 1（TTS 吐音素时长） | **动手前必须先验证**，不通过就走文中写的兜底路线 |
| **🎯 设计决策** | 已和用户确认的取舍 | Context 的三个关键决策、第八节"不做什么" | 不要擅自推翻；要改先问用户 |

**具体地说**：第六节"40–60 分钟/本"是 📐 估算，不是实测。TTS 的倍速、llama-server 的
`-np 8` 吞吐、讲解覆盖率 30% 这三个数都还没量过，它们乘起来的结论误差可能很大。

## 0.3 必读的参考代码（本文大量引用，不读会看不懂）

| 项目 | 路径 | 为什么要读 | 建议顺序 |
|---|---|---|---|
| **aidu** | `F:\my_ai\aidu` | 数据契约来源、前端要复用的源码、CF Worker | 1 |
| **comic-gen** | `F:\my_ai\comic-gen` | Python pipeline 骨架的模板（5437 行，全部可参考） | 2 |
| **subgen** | `F:\my_ai\subgen` | 子进程治理、批量对齐重试、首次下载、Job Object | 3 |

**aidu 必读三份**（读完再动手，本文的契约全从这里来）：
- `F:\my_ai\aidu\CLAUDE.md` —— 强制规约（存储所有权表、数据契约、CSS Modules 纪律）
- `F:\my_ai\aidu\doc\ARCHITECTURE.md` —— 架构权威描述
- `F:\my_ai\aidu\src\utils\schema_constants.js` —— `SENTENCE_SCHEMA` / `VOCAB_ENTRY_SCHEMA`，
  aidulc 的书包字段名必须与之字字相同

**其余高频引用的具体文件**：
```
aidu/src/sidepanel/features/reader/components/atomic_block.js   前端要搬的核心（252 行）
aidu/src/sidepanel/features/reader/reader_audio.js              要被推翻的音频层（165 行）
aidu/src/background/llm/prompt_templates.js                     现有 prompt，理解 2.4 为何要改
aidu/worker/index.js                                            CF 后端（139 行，零改动复用）
aidu/src/sidepanel/styles/main.css                              MD3 令牌来源
comic-gen/AGENTS.md                                             pipeline 设计决策与踩坑记录
comic-gen/comic_gen/core/manifest.py                            模型清册模板
subgen/README.md                                                「已知的技术事实」一节全是实测结论
subgen/src/translate/segment.rs                                 批量编号对齐 + 拆分重试算法
subgen/src/job_guard.rs                                         Job Object 用法与测法
```

## 0.4 接手后的第一步

**不要直接进 Phase 2 写代码。** 第九节的 Phase 0 是两条并行 spike，产出是"数字和原型"，
它的结论会修改本文第六节，也可能推翻 2.5 的路线选择。跳过 Phase 0 等于把三个未验证假设
（0.2 表里的 ❓）直接建进架构。

Phase 0 结束时应该产出一张实测数字表，替换掉第六节所有 📐 格子。

## 0.5 本文档遵循的工作方式

来自用户的全局工程原则（`C:\Users\yoyos\.claude\CLAUDE.md`），接手者必须同样遵守：

- **先实测再下结论**：涉及外部工具/库/格式的具体行为，能验证的不要凭记忆或文档假设。
  写"已确认"前确认真的拿运行结果核对过。发现假设与实测矛盾，如实记录"最初以为 A，实测是 B"。
- **测试纪律**：核心逻辑拆成能独立测试的纯函数，配自包含测试数据。
- **范围控制**：不为"以后可能需要"过度设计；明确列出"这次不做什么"（第八节）。
- **文档习惯**：记"为什么"和"踩过什么坑"，不复述代码逻辑；已知但暂不处理的问题显式列出。

三个参考项目的 memory 里都反复记着同一条教训：**读过代码/文档 ≠ 验证过运行时行为**。

## 0.6 未决问题

1. TTS 具体选型未定（候选与判据见 2.5 和 Phase 0-A ③）
2. 讲解模型是 Qwen3-4B 还是 8B 未定（R2，取决于 Phase 0-A ② 的人工评估）
3. 词级时间轴走哪条路未定（2.5 的路线 1 vs 2，取决于 Phase 0-A ③）
4. aidu reader 剥离 `chrome.*` 的适配工作量未量化（R9）

---

## Context

现有 AIDU 是 Chrome 扩展：贴一段文本 → 云端 LLM → 生词本 → CF Worker → 移动端复习。三个短板：
依赖云端 API；输入粒度是"一段"不是"一本书"；**音频是 `window.speechSynthesis` 实时合成**
（`aidu/src/sidepanel/features/reader/reader_audio.js`），音质靠系统、给不出词级时间戳、
句间靠 `onend` 递归 + `setTimeout(50)` 衔接所以听感是断的。

aidulc（`F:\my_ai\aidulc`，当前空目录）：丢一本 EPUB/PDF/TXT 进去 → 全自动跑完 →
得到一个**自带载体的精读包**：原文 + 译文 + 分档讲解 + 高质量朗读 + 逐词时间轴，
生词写回同一套 `vocab_<profile>` 契约、经现有 CF Worker 同步，扩展端/移动端 PWA 直接复习。

**与 subgen / comic-gen 的根本差异**：字幕和漫画翻译"翻完就完了"，播放/观看由别的载体完成；
**aidulc 的交互载体必须是自己，所以交互必须完备**。`aidu` 仓库不改（只读它的代码和令牌）。

### 已定的三个关键决策

| 决策 | 选择 | 直接后果 |
|---|---|---|
| 技术栈 | **Rust 外壳 + Python 侧车** | Rust 管交互/存储/子进程，Python 管离线批处理 |
| 渲染层 | **WebView（Tauri）复用 aidu 前端** | 1908 行 reader + MD3 令牌可直接用；音频交给 HTML5 `<audio>`，Rust 不写音频代码 |
| 讲解粒度 | **profile 驱动的单一策略函数** | "按需"和"分级"是同一函数的不同返回档；每个 profile 对应独立 CF KV 键 |

---

# 一、用户交互视角

## 1.1 两个身份，两条路径

**A. 备料台（偶尔用，一次约一小时）** —— 拖书 → 选 profile → 开始 → 去干别的。
形态照抄 subgen 批处理队列：任务行 + 阶段条（解析→分析→讲解→合成→打包）+ 移除/重跑/打开文件夹/预览。
中断、崩溃、取消都不丢进度。**这个形态 subgen 已验证，不花设计预算。**

**B. 阅读器（天天用，必须秒开）** —— 打开书包就读。设计预算全部投这里。

## 1.2 阅读器交互语法

**原样继承 aidu**（读过代码确认值得保留）：

| 交互 | 出处 | 保留理由 |
|---|---|---|
| 一句 = 原文/译文/讲解三行的原子块 | `atomic_block.js` | 视线不跳转 |
| 译文/讲解默认模糊，**点单行揭示** | `atomic_block.js:244` | "先自己理解再看答案" |
| 逐词可点，点词查词、沉淀个人词典 | `atomic_block.js:155` | 生词积累入口 |
| **短语连体**：hover 整组亮，点击按整个短语查词 | `atomic_block.js:168` | `break ... up` 不该拆开查 |
| 单击选中 / 双击书签 / 播放键单独放左侧 spine | `atomic_block.js:38-69` | 点文本不触发播放，误触率低 |
| 已加入生词本的词有独立视觉态 | `saved-bubble` | 复习闭环可见性 |

**必须新做**（aidulc 的核心价值）：

- **音频从"实时合成"翻成"预渲染 + 时间轴"**。整章一条 Opus 流，播放器只做 seek 和高亮。
- **跟读模式**：单句重复 N 次 / A-B 循环 / 变速不变调 / 句末留白 / 空格键重复本句。
- **高亮粒度可切换**：句级（整句底色）↔ 词级（卡拉OK逐词）。用户实测反馈"**逐词对小朋友的
  专注力引导帮助很大**"，所以词级是 v1 范围。开关放顶栏——自己精读用句级，陪小孩读用词级。
- **失败态可见**（见 3.5）：翻译失败/TTS 异常/对齐低置信的句子必须在阅读器里有明确标记，
  不能显示成空白让用户以为"这句本来就没讲解"。

## 1.3 Profile 是贯穿一切的主线

| profile 决定 | 例：`kid` | 例：`self` |
|---|---|---|
| 讲解策略 `(句子, profile) → {不讲｜简讲｜深讲}` | 生词多就讲，讲得啰嗦 | 只讲真难的，两句点破 |
| 讲解人设 | 小学老师，打比方 | 简洁，直接说语法术语 |
| 生词判定基准 | `vocab_kid` + 低词频阈值 | `vocab_self` + 高阈值 |
| TTS 音色 / 语速 | 慢速、清晰 | 常速 |
| 默认高亮粒度 | 词级 | 句级 |
| CF KV 键 | `?profile=kid` | `?profile=self` |

**"按需 vs 分级"是同一件事**：按需 = 覆盖率，分级 = 深度，输入都是同一个 profile 的词汇量和水平，
是一条策略函数的两个返回档，"不讲"只是其中一档。不需要两套机制，只需要两套 prompt 模板。

**同一本书可按两个 profile 各跑一遍，产出两个独立书包。**

## 1.4 生词闭环

点词 → 本地词典命中直接显示，没有才调本地 LLM 补全 → 沉淀 `dictionary_<profile>` →
**用户点"加入"才进 `vocab_<profile>`**（沿用 aidu 纪律：AI 补全词典但不自动进复习队列）
→ 推 CF → 扩展端和移动端 PWA 看到同一批词 → 手机上复习。

**aidulc 不做复习。** 只产 `stage='new'` 的新词，SRS 全留扩展/移动端（R3）。

---

# 二、软件技术架构视角

## 2.1 进程与职责切分

```
┌─ Rust 外壳（Tauri）─────────────────────────────────────────┐
│  窗口 / 原生文件对话框 / SQLite（唯一真相源）/ CF 推拉（管密钥）│
│  子进程治理：Job Object 绑定 Python 侧车及其孙进程            │
│  ├─ WebView2 渲染层 ───────────────────────────────────┐   │
│  │   阅读器（复用 aidu 前端）：原子块 / 逐词命中 / 高亮   │   │
│  │   <audio> 播 Opus + rAF 轮询 currentTime 驱动高亮     │   │
│  │   备料台：任务队列 UI                                 │   │
│  │   ★ 无状态：所有读写走 invoke，禁止本地缓存写回        │   │
│  └───────────────────────────────────────────────────┘   │
└───────────────┬─────────────────────────────────────────────┘
                │ ①spawn + NDJSON 进度       ②只读文件契约
                ▼                             ▲
┌─ Python / aidulc-prep.exe（一本书跑一次）────┴──────────────┐
│  loader → nlp(spaCy) → llm(llama-server) → tts → align → pack│
└─────────────────────────────────────────────────────────────┘
                          ▼ 产出
                 📦 书包 = 唯一跨语言契约
```

**关键性质：读书包不需要 Python。** PyInstaller 的慢启动只在"处理新书"时付一次代价
（相对一小时批处理可忽略），日常阅读是 Tauri 冷启动（Win11 预装 WebView2，~200-400ms）。

**WebView 决策消掉的工作量**：egui 富文本排版/逐词命中/MD3 手工映射不需要；Rust 不写音频代码。
**Rust 职责收缩到：窗口、子进程、SQLite、CF、文件读取。**

## 2.2 书包格式（唯一跨语言契约，Phase 1 冻结）

```
<书名>_<profile>/
├── manifest.json      ★ schemaVersion / 标题 / 章节表 / profile 快照 /
│                        生成参数 / prep 版本 / 各模型解析到的绝对路径 / 各阶段耗时
├── quality.json       ★ 质量报告：失败句索引 + 失败原因分类 + 各阶段成功率
├── sentences.json     每句：original_text / translation / explanation /
│                      segments[[word,POS,lemma]] / phrasal_verbs[{text,indices,lemma,translation}]
│                      / audio{chapter,start_ms,end_ms} / words[{seg_idx,start_ms,end_ms}]
│                      / status ∈ {ok, partial, failed} + failedStages[]
├── audio/ch_001.opus  整章一条流
└── run.log            带时间戳的叶子模块日志
```

- **`schemaVersion` 从第一天就有。** aidu 为缺这个踩过迁移坑（`DraftProcessor.migrateAllDrafts`）。
  阅读器遇到高于自己支持的版本必须明确拒绝并提示，不能尽力解析出半吊子结果。
- 字段名**严格沿用 aidu 的 `SENTENCE_SCHEMA`**，新增只有 `audio` / `words` / `status`。
- `words[].seg_idx` 指向 `segments` 下标——词级高亮和点词查词共用同一套下标，
  杜绝"高亮的词和能点的词对不上"。
- `manifest.json` 对标 comic-gen 的 `job.json`：**记录当时用的是什么配置**，
  否则事后无法定位"这本书为什么讲解质量差"。

## 2.3 Python pipeline（照抄 comic-gen 骨架）

comic-gen 是比 subgen 更贴近的模板：`pages.json` 之于 comic-gen = `sentences.json` 之于 aidulc。

| 阶段 | 做什么 | 关键决策 |
|---|---|---|
| `loader` | EPUB(OPF spine)/PDF(PyMuPDF)/TXT → 章节纯文本 | 搬 comic-gen `pipeline/loader.py` |
| `nlp` | spaCy 分句 + `segments` + 短语候选 | **见 2.4，可行性的关键** |
| `llm` | llama-server + GBNF 约束 + 批量编号对齐 | 移植 subgen `translate/segment.rs` 对半拆分重试 |
| `tts` | 逐句合成 + 记录时长 | 逐句合成让故障半径 = 一句 |
| `align` | 词级时间轴 | 见 2.5 |
| `pack` | ffmpeg 合并编码 + 写书包 | 11h WAV=1.9GB → Opus 32k ≈ 160MB，**必须编码** |

状态机 `pending → parsed → translated → explained → synthed → aligned`，**逐句 try + 每句落盘**，
单句失败不毁整阶段（comic-gen 核心教训，原样继承）。

## 2.4 把 segments 从 LLM 手里拿走（可行性的关键）

aidu 现有 prompt 要求 LLM 同时产出五个字段，其中 `segments`（每词 `[word,POS,lemma]`，标点独立占位）
和 `phrasal_verbs.indices`（必须指向 segments 物理下标）**正是 4B 级模型最易错、传统 NLP 100% 正确
的部分** —— aidu 自己为此写了 `JsonCleaner`（截断修复/括号配平）+ `ResponseValidator` 兜底。

| 字段 | aidu 现在 | aidulc |
|---|---|---|
| `segments` | LLM 生成（易错） | **spaCy `en_core_web_sm`** → 映射 aidu 的 13 类 POS |
| `phrasal_verbs.indices` | LLM 数下标（最易错） | **spaCy 依存树** `prt`/`prep` 直出下标，零对齐错误 |
| `translation` / `explanation` | LLM | LLM（批量+编号对齐） |
| 短语 `lemma`/`translation` | LLM | LLM（只翻译，不数下标） |

LLM 输出用 llama.cpp 的 **JSON-Schema 约束解码（GBNF）**，从语法层保证结构合法。

## 2.5 词级时间轴：先试免费的路

文本已知，不需要重新识别。两条路**按顺序试**：

1. **TTS 自吐时长**（免费）：Kokoro 这类模型经 G2P 得音素序列，推理时本就有每个音素 duration，
   聚合到词即可 → 零额外算力。**若可行是最优解。**
2. **强制对齐**（兜底）：ctc-forced-aligner（文本已知所以快）；或已在盘的
   `whisper-cli --output-json-full`（large-v3 对 11 小时约 1.4 小时，太贵，要用就换 base.en）。

## 2.6 前端两个技术细节（现在写下来，别到实现才发现）

- **高亮同步不能用 `timeupdate`**：多数引擎只有 ~4Hz，词级会明显滞后。
  必须 `requestAnimationFrame` 轮询 `audio.currentTime`（60Hz）再对 `words[]` 二分查找。
- **aidu reader 是 CSS Modules + 扩展环境**，搬进 Tauri 要剥掉 `chrome.*`，换成 `invoke` 调 Rust。
  这是**适配**不是重写，但要预留工作量（R9 要在 Phase 0 量出来）。

## 2.7 模块化结构

仓库是三个代码库 + **一个不属于任何语言的顶级契约目录**。契约目录是防 R3（跨三语言的契约漂移）
的结构性手段——不是靠纪律，是靠"三端各自对同一份 schema 写 conformance 测试"。

```
aidulc/
├── contracts/          ★ 顶级，不属于任何语言。三端共同的真相源
│   ├── bookpack.schema.json      书包 JSON Schema（含 schemaVersion）
│   ├── job_request.schema.json   Rust → Python 的任务快照
│   ├── progress.schema.json      Python → Rust 的 NDJSON 进度行
│   └── fixtures/
│       ├── vocab_golden.json     从 aidu JS 侧导出，Python/Rust 各写 conformance 测试
│       └── sample_bookpack/      最小书包，三端都拿它做测试
├── prep/               Python 侧车（离线批处理）
├── src-tauri/          Rust 外壳
├── reader/             WebView 前端
└── scripts/            素材生成 / 打包 / fixture 导出
```

### Python 侧（`prep/aidulc_prep/`）

依赖方向单向向内：`cli → runner → pipeline → infra → core`，**`core` 不 import 任何上层**。
没有 `ui/`——UI 全在 Rust，这是相对 comic-gen 的净简化。

```
aidulc_prep/
├── core/           无 I/O 的领域层，全部可纯函数单测
│   ├── models.py       Book/Chapter/Sentence/Segment/PhrasalVerb/WordTiming + 状态机
│   ├── schema.py       书包结构定义 + schemaVersion + 对 contracts/ 的校验
│   ├── job.py          JobRequest（Rust 传入的不可变快照）/ JobReport
│   ├── quality.py      QualityReport 累积器（失败句 / 原因分类 / 各阶段成功率）
│   ├── errors.py       AidulcError 层次 + format_job_failure（人话摘要与技术细节分离）
│   ├── contracts.py    Loader/Translator/Tts/Aligner 的 Protocol 类型契约
│   └── pos_map.py      spaCy POS/tag → aidu 13 类标签（纯函数，表驱动单测）
├── infra/          横切能力，依赖 core
│   ├── logging.py      叶子模块 → run.log ＋ NDJSON 进度（stdout，给 Rust 解析）
│   ├── process.py      子进程封装：CREATE_NO_WINDOW / 超时 / 日志捕获
│   ├── modelpool.py    ★ 模型池定位：两种布局 + 四态判定（见 3.3）
│   └── checkpoint.py   中间产物读写 + 断点判定（靠文件存在性，不另存状态文件）
├── pipeline/       各阶段，依赖 core + infra
│   ├── loader/         epub.py / pdf.py / txt.py / __init__.py（按扩展名分发）
│   ├── nlp.py          spaCy 分句 + segments + 短语候选
│   ├── llm/
│   │   ├── server.py     llama-server 生命周期（动态端口 / 常驻 / 按需重启）
│   │   ├── batch.py      批量编号对齐 + 对半拆分重试（移植 subgen segment.rs）
│   │   ├── prompt.py     profile 分档模板（不讲 / 简讲 / 深讲）
│   │   └── guard.py      echo 检测 + 整段错位检测（见 3.5）
│   ├── tts/            engine.py / registry.py（引擎切换走注册表，不硬编码 if/elif）
│   ├── align.py        音素时长聚合 或 强制对齐兜底
│   ├── pack.py         ffmpeg 编码 + 写书包 + 写 quality.json
│   └── runner.py       编排 + 逐句 try + 每句落盘 + 协作式取消
└── cli.py          唯一入口：读 job_request.json → 跑 → 写书包 → 退出码
```

### Rust 侧（`src-tauri/src/`）

依赖方向：`main → ipc → services/jobs → store → domain`。

```
src/
├── domain/         无 I/O，可纯函数单测
│   ├── vocab.rs        VocabEntry + normalize（对 aidu 契约，跑 golden fixture）
│   ├── dict.rs         DictEntry + sense 级合并
│   ├── bookpack.rs     书包 struct + schemaVersion 校验（高版本明确拒绝）
│   └── sync.rs         envelope 合并策略（新者胜 / 双方独有保留）
├── store/          SQLite —— 唯一真相源
│   ├── mod.rs          连接池 + WAL + busy_timeout
│   ├── migrations/     顺序迁移 + 版本表
│   ├── vocab_repo.rs   ★ 生词唯一写者
│   ├── dict_repo.rs    ★ 个人词典唯一写者
│   ├── profile_repo.rs ★ profile 唯一写者
│   └── reading_repo.rs ★ 阅读进度/书签/播放位置唯一写者
├── services/
│   ├── config.rs       config.toml 便携配置
│   ├── secrets.rs      Windows Credential Manager（CF token）
│   ├── modelbind.rs    模型绑定 + 每次任务的不可变快照组装
│   ├── sync.rs         CF 推拉 + 体积告警 + 离线降级
│   └── library.rs      书库扫描 + 书包读取校验
├── jobs/
│   ├── job_guard.rs    ★ Job Object（含 R11 的孙进程真拉真杀集成测试）
│   ├── spawn.rs        起 prep 侧车 + 写 job_request.json
│   └── progress.rs     NDJSON 解析 → Tauri event 广播
├── ipc/
│   └── commands.rs     ★ 唯一暴露给 WebView 的边界，全部 #[tauri::command] 集中在此
│                          —— 集中是为了 allowlist 可一眼审计（3.7）
└── main.rs         组合根：只接线，不含业务决策
```

### Web 侧（`reader/`）

依赖方向：`main → views → components → core`，`ipc/bridge.js` 是唯一出口叶子。

```
reader/
├── core/           无 DOM，可纯函数单测
│   ├── timeline.js     words[] 二分查找定位当前词
│   ├── shadow.js       跟读状态机（循环 / 重复 N 次 / 句末留白）
│   └── selectors.js    从书包派生视图数据
├── ipc/
│   └── bridge.js       ★ 唯一 invoke 封装；其它模块禁止直接 invoke
├── components/     从 aidu 搬（剥 chrome.*）
│   ├── atomic_block.js   原子块三行结构
│   ├── word_span.js      逐词 bubble + 短语连体
│   └── ...
├── views/
│   ├── reader_view.js
│   ├── shadow_bar.js     跟读控制条（新设计）
│   └── prep_view.js      备料台
├── styles/
│   ├── tokens.css        ★ 从 aidu main.css 搬的 MD3 令牌，唯一颜色/间距/圆角来源
│   └── ...
└── main.js
```

### 三条强制的结构纪律

1. **`core/` `domain/` 层不做 I/O**——这是"核心逻辑拆成能独立测试的纯函数"落到目录上的形式。
   违反了测试就必须起模型/起网络，然后测试就会像 comic-gen 那样写了不跑（R12）。
2. **每个存储键只有一个 repo 能写**（3.4 的所有权表），其它模块一律走服务方法。
3. **跨语言边界只有三个**：`contracts/` 里的三份 schema。新增任何跨端字段必须先改 schema，
   三端各自的 conformance 测试会同时变红——这是让漂移**当场暴露**而不是半年后在用户那里暴露。

---

# 三、按工程原则五维度的设计（这一节是成熟度的主体）

## 3.1 配置管理

**三层配置，各有唯一归属，禁止跨层直写：**

| 层 | 内容 | 存储 | 唯一写者 | 生效方式 |
|---|---|---|---|---|
| **应用配置** | 窗口尺寸、书库目录、模型池目录、日志级别 | `config.toml`（exe 同目录，便携） | Rust `ConfigService` | 启动读，改后立即写盘 |
| **密钥** | CF Worker URL + AUTH_TOKEN | **Windows Credential Manager** | Rust `SecretStore` | 永不落明文，永不进 WebView |
| **Profile** | 讲解策略/人设/词频阈值/TTS 音色语速/默认高亮粒度/CF profile 键 | SQLite `profiles` 表 | Rust `ProfileService` | 变更只影响**下一次**备料任务 |
| **模型绑定** | 各模型 key → 绝对路径 | SQLite `model_bindings` 表 | Rust `ModelService` | 每次任务取**不可变快照**传给 Python |

**关键纪律（照抄 comic-gen 第 7 条，它踩过坑）**：
模型路径是**每次任务的不可变快照，不是进程级全局表**——任务运行中改设置不影响正在跑的任务。
Rust 组装快照 → 写进临时 `job_request.json` → Python 只读这一份，Python 侧**不做任何配置发现**。

**解析顺序**：显式绑定 → 本地缓存搜索（含 `HF_HOME` 根目录本身，见 3.3）→ 报错。
**绑定失效或大小不对直接报错，绝不静默回落去联网下载新的顶替**（comic-gen 明确写的规约）。

## 3.2 外部系统集成

| 集成对象 | 启动/连接 | 异常处理 | 资源回收 |
|---|---|---|---|
| **Python 侧车** | Rust spawn，`CREATE_NO_WINDOW` | 非零退出码 → 读 `quality.json` 判断是 partial 还是彻底失败 | Job Object |
| **llama-server**（孙进程） | Python spawn | 启动超时 60s → 报错；端口从 **动态分配**（bind :0 取端口）避免冲突 | ★见下 |
| **ffmpeg** | Python spawn，`CREATE_NO_WINDOW` | 非零退出 → 该章标记失败，不毁整本 | Job Object |
| **SQLite** | Rust，**WAL 模式** | busy_timeout 5s；schema 版本表 + 顺序迁移 | 连接池，进程退出自动关 |
| **CF Worker** | reqwest，超时 15s | 网络错误重试 3 次指数退避；**离线 = 本地照常用，同步标记 pending，不阻塞阅读** | — |

**★ 孙进程绑定（我上一版含糊过去的洞）**：Job Object 由 **Rust 侧创建**，Python 侧车 spawn 时绑入。
Windows Job Object 默认子进程继承，所以 Python 拉起的 llama-server/ffmpeg 会自动进同一个 Job。
**但必须显式验证**：Python 侧绝不能自建 Job（会脱离父 Job 或冲突），且要写一个
"真拉起孙进程再杀父进程"的集成测试——subgen 的 `job_guard::tests::dropping_the_job_kills_bound_child_process`
就是这么测的，照抄它的测法，**不能只读文档就认为继承生效**。

**中断语义（对齐 subgen 的既有设计）**：点"取消"和意外中断**效果完全相同**——
已完成的中间产物保留，下次重跑同一本书同一 profile 自动续上，不重跑已完成的句子。
断点续跑**靠中间产物是否存在且完整来判定，不额外维护状态文件**（subgen 的实测结论）。

## 3.3 依赖与交付

**两类依赖必须分开管**（用户框架里点名最容易被忽视的一类）：

| 类别 | 内容 | 策略 |
|---|---|---|
| 包管理器依赖 | Rust crates / Python 包 | `Cargo.lock` + `requirements-lock.txt`（照抄 comic-gen：直接依赖固定精确版本 + 递归闭包快照，**不是裸 `pip freeze`**） |
| **运行时外部二进制** | llama-server、ffmpeg、（可选）whisper-cli | **aidulc 自带一份，不借用 `subgen\dist\`** |
| **模型权重** | Qwen3 GGUF、TTS、spaCy en | **共享 `F:\hf_cache` 模型池**，递归查找 |

**★ 上一版被含糊过去的假设**：方案早期表格里"llama-server 存在 → 直接复用"指的是
`F:\my_ai\subgen\dist\translator\llama-server.exe`。**开发期可以借用省下载，但发版不能依赖
用户装过 subgen**。所以：
- **二进制**（小，llama.cpp ~240MB + ffmpeg ~100MB）：aidulc 自己下一份到自己的 `engine/`，
  首次运行下载，断点续传 + 官方源失败自动切镜像（照抄 subgen `setup/download.rs` 的策略）。
- **模型**（大）：加入已有的共享池，**已有的直接复用不重复下载**。

### 共享模型池（已实测核实，aidulc 是第三家）

| 证据 | 值 |
|---|---|
| `HKCU\Environment` 的 `HF_HOME` | `F:\hf_cache` |
| subgen `dist/config.toml` | `models_dir_override = 'F:\hf_cache'` |
| comic-gen `dist/comicgen/settings.json` | `model_dir = "F:\hf_cache"` |
| comic-gen 的 `model_files.llm` | `F:\hf_cache\Qwen3-4B-Instruct-2507-Q4_K_M.gguf` |
| subgen 用的通用翻译模型 | **同一个平铺文件** |

→ **两个项目已经在共用同一份 2.497GB 的 GGUF，不是各存一份。aidulc 接进来即可，LLM 零下载。**

**但两个项目读写不对称（comic-gen memory 明确记的坑，必须继承）**：

| | 写 | 读 |
|---|---|---|
| subgen（Rust） | 平铺到 `F:\hf_cache` 根 | 按文件名递归搜，不认目录结构 |
| comic-gen（Python） | `huggingface_hub` 写 `hub/models--*/snapshots/` | 修复后两种都认 |

→ **`infra/modelpool.py` 必须同时认两种布局，且搜索根包含 `F:\hf_cache` 根目录本身而不只是 `hub/`。**

**进不了池的依赖**（要单独处理，别想当然）：
- **spaCy `en_core_web_sm` 是 pip 包**，装进 site-packages，不是 HF 缓存条目 → 走侧车打包依赖
- TTS 若选 HF 上的模型（如 Kokoro）则自然进池；若是别的分发方式要单列
- 参照：comic-gen 也有两个模型不在池里（LaMa 在 torch hub 缓存、EasyOCR 在 `~/.EasyOCR`）

**模型清册**（对标 comic-gen `core/manifest.py`）：每个模型记 repo / 文件名 / **精确字节数** /
magic 前 4 字节，用于四态判定 `ready / missing / path_broken / size_mismatch`。

**改清册里 GGUF 的 repo/filename 前，先对一遍 subgen 的 `src/translate/mod.rs` 和 comic-gen 的
`core/manifest.py`，三边文件名必须字字相同**，否则各下一份浪费几个 GB。

**首次运行真实成本**（诚实版）：二进制 ~340MB + TTS 模型 ~0.3–1.5GB + spaCy ~50MB
+ LLM 0（复用已有 Qwen3-4B）≈ **0.7–1.9GB**。

**交付形态**：`aidulc.exe`（Tauri）+ 同级 `prep/`（PyInstaller onedir 侧车）+ `engine/` + `config.toml`。
打包沿用 comic-gen `build_exe.ps1` 的"**就地换件，不碰 `settings`/日志/用户模型**"模式。

## 3.4 状态管理（★ 上一版最大的洞）

### 存储所有权表（强制，对标 aidu CLAUDE.md 的同名表）

aidu 的历史 bug 主因是多写者，为此立了这张表。aidulc 的情况更复杂——同一份生词数据
同时存在于 **WebView(JS) / Rust(SQLite) / CF(KV)** 三处，必须先定死谁是真相源。

| 数据 | 唯一真相源 | 唯一写者 | 其他层怎么访问 |
|---|---|---|---|
| 生词 `vocab_<profile>` | **SQLite** | Rust `VocabService` | WebView 一律 `invoke('vocab_add'/'vocab_list')`，**禁止在 JS 侧缓存后写回** |
| 个人词典 `dictionary_<profile>` | **SQLite** | Rust `DictService` | 同上 |
| 阅读进度 / 书签 / 播放位置 | **SQLite** `reading_state` 表 | Rust `ReadingStateService` | WebView 节流上报（3s），**不在 localStorage 存一份** |
| 跟读设置 / 高亮粒度 | SQLite `profiles` 表 | Rust `ProfileService` | invoke |
| 书包内容 | **磁盘文件，只读** | Python（生成时） | Rust 读 → 传给 WebView；**运行时任何一层都不得改写书包** |
| CF 远端 | KV | Rust `SyncService` | 只有它能推拉 |

**CF 是镜像不是真相源**：冲突时以 SQLite 的 `updatedAt` 逐条新者胜（沿用 aidu 的合并策略），
远端只是跨设备通道。

### 状态变更如何被感知

WebView 不轮询。Rust 侧状态变更通过 **Tauri event** 广播（`vocab-changed` / `sync-status` /
`job-progress`），前端订阅后局部更新。**禁止"改完数据再全量重渲染整章"**——一章 3000+ span，
全量重渲染会掉帧。

## 3.5 错误处理与反馈（★ 上一版空白，且这是本项目最危险的一维）

用户框架原话："**后台失败但用户以为成功**是要优先排除的最差情况"。
本项目的具体形态：**跑了 50 分钟，30 句翻译失败，用户不知道，读到那里才发现是空的。**

### partial 语义（三个参考项目都有，必须继承）

| 层 | 语义 |
|---|---|
| 单句 | `status ∈ {ok, partial, failed}` + `failedStages[]`。翻译失败 ≠ TTS 失败 ≠ 对齐失败，分别记 |
| 单章 | 有任何非 ok 句 → 章级标记 partial |
| 整本 | 全部阶段全失败才是 `error`；**有部分成功就是 `partial`，不是失败** |
| 备料台 UI | 显示"N 句失败"，**"重试失败句"只重跑失败的**，已完成结果保留（aidu `failedChunks` 的同款语义） |
| 阅读器 | 失败句有明确视觉标记 + 单句重试按钮，**绝不显示成空白** |

### 错误分层（对标 comic-gen `core/errors.py`）

`AidulcError` 层次：`ModelError`（权重缺失/大小不符/加载失败）/ `InputError`（书解析失败/加密 EPUB）/
`EngineError`（llama-server 起不来/端口占用）/ `OutputError`（磁盘满/路径被占）/ `SyncError`。
每类同时携带**人话摘要**（给用户）和**技术细节**（进 run.log），
`format_job_failure` 供 Rust UI 和 Python CLI 共用一份措辞，避免两处各写一版。

### 静默失败的具体防线

| 可能的静默失败 | 防线 |
|---|---|
| LLM 返回了格式合法但内容是提示词回显 | 照抄 comic-gen `_ECHO_MARKERS` 检测（它在 493 页真实运行中抓到 162 个），判失败记 quality.json |
| 翻译"成功"但整段错位（编号对齐骗过校验） | subgen 已定位过这个根因；批次内做原文/译文长度比值异常检测 |
| TTS 读崩/漏读 | 每句校验 `时长 / 字符数` 比值，超出区间单独重试并记 run.log |
| GPU 静默回落 CPU | 解析 llama-server / TTS 启动日志确认后端，没用上 GPU 在界面醒目提示（subgen 实测过 whisper 会静默回落） |
| 同步"成功"但 payload 超限 | 推送前测体积，>15MB 界面告警（见 R4） |

## 3.6 可观测性

- **`manifest.json`**：本次任务完整配置快照 + 各模型实际解析到的绝对路径 + 各阶段耗时。
  没有它，事后无法回答"这本书为什么讲解质量差"。
- **`quality.json`**：失败句索引 + 原因分类 + 各阶段成功率。这是"备料台重试"和"阅读器标记"共同的数据源。
- **`run.log`**：叶子模块（nlp/llm/tts/align）经统一 logging 桥记的带时间戳警告，
  同时桥接到备料台 UI 面板（comic-gen `infra/logging.py` 的做法）。
- **PowerShell 控制台 GBK 显示中文日志乱码是显示问题，日志本身 UTF-8 正常，不要为此改代码**
  （comic-gen 明确记过的规约，避免重复浪费时间）。

## 3.7 安全边界（Tauri 特有，不能不定）

- **Tauri allowlist 最小化**：只暴露必要的 `invoke` 命令，不开 `fs`/`shell`/`http` 全量 API。
  书包路径由 Rust 校验后才读，不接受 WebView 传任意路径。
- **CSP**：WebView 只加载本地资源，禁 remote script/style；书包内容是数据，
  渲染时**一律 `textContent` 不用 `innerHTML`**（aidu 已有 `lint:safe-dom` 检查，同款纪律）。
- **CF token 永不进 WebView**：同步全在 Rust 侧完成，前端只看到状态枚举。

---

# 四、设计工作流与节奏把控

## 4.1 为什么"先做 pipeline 再设计"是错的

界面需要什么数据，决定 pipeline 产出什么。书包格式是唯一跨语言契约、一旦冻结要动三个语言才能改，
所以**必须让界面原型先说话**。同时模型侧能拿到什么数据又约束界面能做什么。

→ **两条腿并行，在"冻结书包格式"这一点汇合。**

```
Phase 0-A（Python/模型侧）        Phase 0-B（前端/设计侧）
拿得到什么数据、成本多少     ↘   ↙   界面需要什么数据
                        Phase 1
                    冻结书包格式（契约）
                            ↓
                   Phase 2+ 两边各自实现
```

**Phase 0 两条腿互不阻塞，谁先跑完谁等；Phase 1 是同步点。**

## 4.2 设计任务分三类，预算差一个数量级

| 类别 | 内容 | 怎么做 | 预算 |
|---|---|---|---|
| **A 继承** | MD3 令牌（22 color role / 6 radius / elevation / state layer）、原子块、短语连体、点击揭示 | 直接搬 `aidu` 的 `main.css` + `reader_layout.module.css` | ~0 |
| **B 抄现成** | 备料台队列、阶段条、任务行按钮组 | 照抄 subgen 形态 | 低 |
| **C 真设计** | 跟读控制条、词级高亮视觉层次、句级/词级切换、profile 切换、**失败态呈现** | claude.ai/design 组件库 + 真实规模原型 | 全部预算 |

## 4.3 claude.ai/design 接入（已验证可用）

`DesignSync` 授权已通，**当前 0 个 design-system 项目**，从零建。因为渲染层是 WebView，
**设计产出物就是生产代码，不是效果图**——没有"设计稿转实现"的损耗。

1. 本地在 `aidulc/reader/` 写真 HTML/CSS 组件（aidu 的 MD3 令牌 + 假 `sentences.json`）
2. `DesignSync` 推到 claude.ai/design，每组件带预览卡
3. 网页上看、批注、指定要改哪个
4. 改完的组件**直接是 Tauri 里跑的那份代码**

## 4.4 设计 brief（可独立使用的提示词）

> **项目**：本地英语精读跟读阅读器，Tauri + WebView2，Win11 桌面，单人使用（成人自读 + 陪小孩读两档）。
>
> **必须继承的既有体系**：Material Design 3 令牌集（`--md-sys-color-*` 22 个 role、
> `--md-sys-radius-xs/sm/md/lg/xl/pill`、`--md-sys-elevation-*`、`--md-sys-state-hover/focus`、
> `--md-sys-font-sans/serif`）。既有结构：一句一个"原子块"，三行——原文（逐词可点的 bubble）、
> 译文、讲解；译文和讲解默认高斯模糊，点击单行揭示；短语动词的多个词 hover 联动高亮、
> 点击按整个短语查词；已加入生词本的词有独立视觉态。
>
> **要设计的新东西**：
> 1. **跟读控制条**：播放/暂停、单句重复 N 次、A-B 区间循环、变速（不变调）、句末留白时长、
>    句级↔词级切换。常驻底部又不抢阅读注意力。
> 2. **词级高亮**：卡拉OK逐词推进。核心约束——高亮的词和"可点击查词的词"是同一批 span，
>    三种状态（正在读 / 可点击 / 已在生词本）会叠加，需要一套不打架的视觉层次。
> 3. **句级↔词级切换**在同一套排版下无缝，**不能重排**。
> 4. **profile 切换**：两档默认语速、高亮粒度、讲解详略都不同，入口要轻但不能误触。
> 5. **失败态**：某句翻译/朗读/对齐失败时的标记 + 单句重试入口。要让人一眼看出"这是失败"
>    而不是"这句本来就没内容"，同时不能打断正常阅读的视觉节奏。
>
> **硬约束**：
> - 长文阅读，一章可能 3000+ span，**样式不能依赖昂贵选择器或大量 DOM 动画**
> - 高亮更新 60Hz（rAF 驱动），高亮态样式变更必须 GPU 友好（transform/opacity/背景色）
> - 儿童场景需要更大字号和更高对比度，但**不能是两套独立 CSS**，必须是同一套令牌的不同取值
> - 深浅色都要
>
> **产出**：可运行的 HTML/CSS 组件（不是图），每组件一个预览页，用假数据驱动。

---

# 五、已实测确认的环境事实（不是估算）

| 事实 | 值 | 意义 |
|---|---|---|
| GPU | RTX 3060 12GB | 4B/8B GGUF + TTS 够用，不能同驻 |
| F: 可用空间 | 450 GB | 音频/模型不构成约束 |
| `HF_HOME`（进程 + `HKCU\Environment`） | `F:\hf_cache` | 共享模型池已存在 |
| `F:\hf_cache\Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | **2.497 GB，已在盘** | 翻译/讲解零下载起步 |
| subgen `config.toml` / comic-gen `settings.json` | 都指向 `F:\hf_cache`，`llm` 指同一个平铺文件 | **两项目已共用一份权重，aidulc 是第三家**（3.3） |
| `subgen\dist\translator\llama-server.exe` | 存在 | **开发期可借用；发版 aidulc 自带一份**（3.3） |
| `subgen\dist\engine\Release\whisper-cli.exe` | 存在 | 强制对齐兜底 |
| `subgen\dist\ffmpeg\...\ffmpeg.exe` | 8.1.2 | 音频编码 |
| `aidu\worker\index.js` | 139 行，schema 无关 | **CF 后端零改动** |
| `aidu` MD3 令牌 | 22 color role + 6 radius + elevation + state | 设计体系现成 |
| `aidu/src/sidepanel/features/reader/` | 1908 行 | WebView 决策后成为可复用源码 |
| comic-gen 全部 Python | 5437 行 | pipeline 骨架可整体照搬 |
| Python | 3.13.14（comic-gen venv 已跑通） | 侧车环境现成 |
| claude.ai/design | 授权通，0 个项目 | 从零建组件库 |

## 5.1 Phase 0-A 实测数字表（2026-08-03，替换上表未覆盖的估算）

| 实测项 | 值 | 结论 / 影响 |
|---|---|---|
| subgen `llama-server.exe` 后端 | **CPU build**（日志无 CUDA，n_ctx_slot 平分） | 17 t/s 单流、`-np 8` 并发无增益（15.5–17）→ **发版绝不能带 CPU build** |
| comic-gen venv `llama_cpp_python` 0.3.34 | **CUDA build**（ggml-cuda.dll 902MB，需 `os.add_dll_directory(torch/lib)` 才能加载） | GPU 实测 **68–80 t/s** 单流；LLM 引擎改用 llama_cpp_python 而非 llama-server 子进程 |
| `response_format: json_schema`（0.3.34） | **被静默忽略**（源码无处理路径） | 必须显式 `json_schema_to_gbnf` → `LlamaGrammar` → 传 `grammar=` |
| GBNF 约束解码速度（Qwen3-4B） | **8.1 t/s**（890 tok / 109s，合法 JSON 10/10） | 自由解码 68.4 t/s → 约束慢 8 倍 → **R1 结论：放弃约束解码，走 JsonCleaner+重试兜底** |
| 自由解码输出形态 | 20/20 合法 JSON（外层 ```json 围栏，JsonCleaner 剥掉即好） | JsonCleaner 兜底路线实测可行 |
| 翻译+讲解吞吐 | 20 句真书句 **25s**（47 句/分，单流，输出 max_tokens=250） | 7000 句 ≈ 2.5h；讲解只讲 30% → 1.5–2h，压线 |
| 讲解质量（Qwen3-4B） | 20/20 全部产出可用讲解，语法点准确（so...that / either...or / make out / wonder if / think nothing of） | 盘上**无 8B**（sakura-7b 是日文翻译模型，不能比）→ R2 变更为"4B 单独人工评估，过关即用" |
| Kokoro TTS（PyTorch 版） | GPU realtime **x18.1**（8.55s 音频 0.47s）；CPU kokoro-onnx 仅 x2.8 | TTS 用 PyTorch Kokoro 跑 GPU；11h 音频 ≈ **37 分钟**（原估 15–25 分，偏慢但可接受） |
| Kokoro 词级时间轴 | **内置**：`KModel.forward(return_output=True)` 返回 `pred_dur`，`KPipeline.join_timestamps` 直接给每词 start/end 秒 | **2.5 路线 1 确认可行，对齐成本=0，兜底路（whisper/ctc）不需要** |
| Kokoro 依赖链 | 需 spacy+en_core_web_sm+spacy-curated-transformers+num2words+espeak(espeakng-loader 自带 dll+data) | 首次装依赖记录在案；`KModel(config, model)` 不下载 config 需手传 HF 缓存路径 |
| spaCy POS | 13 类映射可行（`en_core_web_sm` 3.8.0）；AUX/PART 需映射（AUX→VERB、PART 保留） | 2.4 的"segments 从 LLM 拿走"确认 |
| spaCy 短语动词 | `prt` 依赖 5/5 全对（broke up / put off / gave up / took off / put up） | phrasal_verbs.indices 零对齐错误确认 |
| CF 免费版限额（官方文档 2026-07-28） | KV 值 25 MiB、写 1000/天、读 100k/天；Workers 请求 100k/天 | R4 的 25MB 假设正确；"只推点过的词 + >15MB 告警"策略不变 |
| 首次运行体积（修正） | Kokoro .pth 328MB + voices 26.9MB + 二进制 ~340MB + spaCy ~50MB + LLM 0（复用）≈ **750MB** | 比原估 0.7–1.9GB 的下限更接近实情 |

**Phase 0-A 对架构的实际修正**（已超出"更新数字"范畴，Phase 1 必须落实）：
1. LLM 引擎从"llama-server 子进程 + GBNF"改为 **llama_cpp_python 进程内库（CUDA）+ JsonCleaner 兜底**——孙进程治理简化（R11 风险降低），但 R11 仍要保留（TTS/ffmpeg 子进程还是孙进程）
2. `2.4` 表格中"GBNF 约束解码"一行改为"JsonCleaner + 校验重试（aidu 老路）"，不再依赖约束解码
3. TTS 引擎定为 **Kokoro PyTorch**（不是 kokoro-onnx），路线 1 时间轴直接可用
4. 讲解覆盖 30% 是达到 ≤2h 验收线的**必要条件**（全讲 2.5h 超线）

## 5.2 Phase 0-B 实测记录（R9/R10，2026-08-03）

| 项 | 结果 |
|---|---|
| aidu 原子块 `chrome.*` 依赖 | **零直接依赖**（grep 整个 reader 目录仅 `reader_view.js:93,246` 两处 `chrome.storage.onChanged`，且那是 view 层非组件层） |
| 实际剥离点 | 只有 3 处适配：`t()` 国际化（2 个 key）、CSS Modules→全局类名、`DebugModal`（78 行调试工具，剥掉） |
| R9 结论 | 剥离成本 ≈ **低**：252 行 `atomic_block.js` 原样搬入，handler 接口（onPlay/onSelect/onBubbleClick/onBookmark）不变，将来换 `invoke` 只动 view 层 |
| Tauri 空壳 | `cargo init` + tauri 2.11.5，`cargo build` 41s 冷编译，`aidulc.exe` 正常起窗（WebView2 预装） |
| 前端真跑通验证 | 加 `boot_ping` invoke 探针：前端加载完调 Rust 写临时文件 → **`boot_ping: spans=3001` 收到**，证明 JS 无报错、invoke 链路通 |
| 3001 spans 渲染 | 假数据生成器（确定性 PRNG，句长/词时长参照 Alice 实测分布）→ 渲染无报错 |
| `timeline.js` 二分查找 | 边界用例全过（t=0→0 / 边界切换→1 / 超尾→-1 / 句边界→正确切换），纯函数可单测 |
| R10 提示 | 60Hz fps 数字必须在 WebView2 devtools 里量（Phase 5 验收），代码侧已按"先定位句再句内二分"实现，避免全量扫 3001 词 |

**已知暂不处理**：`tokens.css` 只搬了 22 个 color role + radius + elevation 精简集（够原型跑），Phase 5 对齐全集；字体（ri-* 图标）未搬，播放键用文本 `▶` 占位。

## 5.3 实施完成记录（2026-08-03，Phase 1-8 全部落地）

> 本文档从"尚未开工的方案"变成"已实现的系统"了。下面是各 Phase 的实际结果与踩坑，
> 与本文档 0.2 的可信度分级对应——这些现在都是 ✅ 实测事实。

### Phase 1-4（Python 侧车，`prep/`，64 个 pytest 全绿）

| Phase | 结果 | 关键实测结论 / 坑 |
|---|---|---|
| 1 契约冻结 | `contracts/*.schema.json` 三份 + `vocab_golden.json` + `sample_bookpack` + `alice_sample.epub`（自打公版素材） | 自研轻量 JSON-Schema 校验器（draft-07 子集：required/type/const/enum/items/$ref/allOf/if-then），32 测试 |
| 2 loader+nlp | EPUB(PyMuPDF 可选)/TXT 解析 + spaCy 分句/segments/prt 短语 | `<head>` 不剥会泄漏 `<title>` 文本当正文；`away` 这类副词 spaCy 标 ADV 不触发 prt，v1 接受 |
| 3 llm | llama_cpp_python 进程内（CUDA）+ 批量编号对齐 + 对半重试 + echo/错位防线 + checkpoint 断点续跑 | 20 句真书 25s（47 句/分）；**断点续跑必须合并写 checkpoint，覆盖写会清掉已完成字段**（端到端实测踩过） |
| 4 tts+align+pack | Kokoro PyTorch GPU（realtime x18）+ 词级时间轴（路线 1 零成本）+ ffmpeg Opus | 词时间轴是**句内相对 ms**，align 校验要用句长而非绝对起点（踩过）；整章 26s 音频 Opus 仅 96KB |

### Phase 5-8（阅读器 + Rust + 打包）

| Phase | 结果 | 关键实测结论 / 坑 |
|---|---|---|
| 5 阅读器 | Tauri + WebView2，真书包可读可听可跟读（CDP 实测：播放推进/空格重复/A-B 循环/词级卡拉OK 60Hz 全过） | WebView2 自定义 scheme 对 media 有 URL safety check → 音频走 `read_audio` invoke + Blob URL（`blob:` 已在 CSP）；`withGlobalTauri` 暴露 `window.__TAURI__.core` |
| 6 Rust 状态层 | SQLite 5 表（WAL/迁移/所有权表）+ vocab/dict/profile/reading repos + CF 推拉 + 22 测试全绿 | **std Mutex 不可重入**：repo 持锁内调 self.get() 死锁（实测挂起）；ON CONFLICT 必须保留 SRS 字段（只有 SRS 算法能改） |
| 7 备料台 | start_prep_job/cancel_prep_job + NDJSON→event 广播 + Job Object（R11 真拉真杀测试通过） | `creation_flags` 需要 `std::os::windows::process::CommandExt` |
| 8 打包 | PyInstaller onedir 侧车（6.27GB，含 CUDA runtime 830MB）+ Tauri exe，干净目录端到端 77s | spaCy 模型/language_tags/espeakng/llama_cpp 都要 `collect_all`；ggml-cuda.dll 需 `_internal/cuda_runtime`（CUDA 12.4 DLL）；pack 书包根必须 = out_dir（踩过写到父目录） |

**已知但暂不处理**：
- 侧车 6.27GB 偏大（torch 全量被带进来；ggml-cuda 902MB + CUDA runtime 830MB 是硬需求）——后续可试 torch 瘦身/换 kokoro-onnx 或 onnxruntime-gpu 路线
- CF 同步闭环（aidulc 加词 → CF → 扩展可见）未做真实端到端（需真实 Worker + aidu 扩展环境），本地侧 SQLite 写入已实测
- 8B 讲解模型始终没有（sakura-7b 是日文翻译模型），4B 质量样本在 `.spikes/out/quality_sample_v2.json` 供人工读
- 60Hz fps 数字需 WebView2 devtools 量（代码路径已按"先定位句再句内二分"实现）

# 六、吞吐评估（估算，Phase 0 校准）

> **Phase 0 实测后更新（2026-08-03，见 §5.1 实测数字表）**：> 下面原表格的"单流 50 tok/s / -np 8 ~300 tok/s"**已被实测推翻**：
> - subgen 自带的 `llama-server.exe` 是 **CPU build**（实测 17 t/s 单流、并发无增益，日志无 CUDA）
> - comic-gen venv 的 llama_cpp_python 是 **CUDA build**（实测 68–80 t/s 单流）
> - GBNF 约束解码在 llama_cpp_python 0.3.34 实测仅 **8.1 t/s**（且 0.3.34 的 `response_format` json_schema 被静默忽略，必须显式传 grammar）→ **R1 结论：放弃约束解码，走 JsonCleaner+校验重试兜底路线**
> - 全本实测节奏：翻译+讲解 47 句/分（单流 GPU）→ 7000 句 ≈ **2.5 小时**；讲解只讲 30% 时 ≈ **1.5–2 小时**，压线可接受，但比原估算慢
> - Kokoro PyTorch 版（GPU realtime x18.1）自带词级时间戳 → 2.5 路线 1 确认可行，对齐成本为 0

10 万词英文小说（≈7000 句）：

| 阶段 | 计算 | 估算 |
|---|---|---|
| 解析 + spaCy | ~10k 词/s（CPU） | **~15 秒** |
| 翻译 | 7000 句 × ~25 token = 175k | 单流 50 tok/s → 58 分；`-np 8` ~300 tok/s → **~10 分** |
| 讲解 | 按 profile 只讲 30% ≈ 2100 句 × 60 token = 126k | **~7 分**（全讲 ~25 分） |
| TTS | 10 万词 ≈ **11 小时音频** | GPU 估 30–50× 实时 → **15–25 分** |
| 对齐 | 走 2.5 路线 1 则为 0 | **0**（兜底另计 20 分） |
| 编码 | ffmpeg → Opus | ~5 分 |

**结论：GPU 全开约 40–60 分钟/本，"丢进去自己跑"成立。**
12GB 装不下 LLM+TTS 同驻，所以**按阶段串行**（LLM 跑完 → 停 llama-server → 再 TTS），
照搬 subgen"批次内常驻、按需重启"策略。

**验收线（超过就是不合格，要回头优化而不是接受）**：单本 ≤ 2 小时；
若 Phase 0 实测显示 >3 小时，砍讲解覆盖率或降 TTS 采样率，不接受"跑一夜"作为常态。

真正的成本大头不是速度，是**讲解质量**——4B 写中文语法讲解够不够格，只能读了才知道（R2）。

# 七、风险登记

| | 风险 | 对策 |
|---|---|---|
| **R1** | GBNF/json_schema 在当前 build 上的行为与速度代价 | **已实测解决（见 5.1）**：约束解码 8.1 t/s 慢 8 倍且 0.3.34 静默忽略 response_format → **走 JsonCleaner+校验重试兜底路线**，不依赖约束解码 |
| **R2** | 4B 中文讲解质量可能不够（最大不确定性，不是速度） | **已实测初判**：盘上无 8B，20/20 句 4B 讲解质量合格（见 `.spikes/out/quality_sample_v2.json`）→ 人工再读一遍样本确认即关闭；模型走清册可配置 |
| **R3** | **契约漂移**——aidu 历史 bug 主因，现跨 JS/Python/Rust 三语言 | ① v1 **不移植 SRS**，只产 `stage='new'`；② JS 侧导出 golden fixture，Python/Rust 各写 conformance 测试；③ 书包字段名照抄 `SENTENCE_SCHEMA` |
| **R4** | KV 单值 25MB（1 万条词典 ≈ 10MB） | 只推用户点过的词；推前测 payload，>15MB 界面告警而非静默失败 |
| **R5** | 12GB 显存装不下 LLM+TTS 同驻 | 阶段串行 + 显式 stop（subgen 已验证） |
| **R6** | 长文本 TTS 读崩/漏读 | 逐句合成限故障半径；时长/字符数比值校验；异常句重试记 run.log |
| **R7** | 两种语言两套构建，发版复杂度 = subgen + comic-gen 之和 | Tauri exe + `prep/` onedir 侧车；沿用 `build_exe.ps1` 就地换件模式 |
| **R8** | ~~egui 富文本~~ | **已被 WebView 决策消除** |
| **R9** | aidu reader 剥离 `chrome.*` 的适配量未评估 | Phase 0-B 先真搬一个原子块进 Tauri 跑起来量一下 |
| **R10** | 3000 span + 60Hz 高亮的前端性能 | Phase 0-B 原型用**真实规模假数据**压测，不用 10 句玩具数据 |
| **R11** | Job Object 对**孙进程**（Python 拉起的 llama-server）是否真生效未验证 | 照抄 subgen 的测法写集成测试真拉真杀，**不接受"文档说会继承"** |
| **R12** | 测试基建写了不跑（comic-gen 真实教训：venv 里根本没装 pytest） | Phase 1 就把 CI 命令跑通并看到全绿输出，之后每 Phase 的 DoD 都含"测试真跑过" |

# 八、v1 明确不做

- ❌ 在 aidulc 里实现 SRS 复习（留扩展/移动端）
- ❌ 声音克隆 / 多音色旁白（profile 只选预置音色）
- ❌ 中译英、其它源语言（只做英→中）
- ❌ 改 aidu 仓库任何运行时代码（最多加一个导出 fixture 的脚本）
- ❌ 跟读录音回放对比（跟读只做播放侧：循环/变速/留白）
- ❌ EPUB3 Media Overlays 导出
- ❌ 备料台的精细设计（照抄 subgen）
- ❌ 多机并发/远程推理（单机单用户）

# 九、实施阶段（每阶段带完成判据 DoD）

**Phase 0 —— 两条腿并行，产出是"数据和原型"不是功能**

*0-A 模型侧* ①llama-server + Qwen3-4B 实测 GBNF 可用性 + 单流/`-np 8` 真实 tok/s
②真实书本 20 句 4B vs 8B 讲解质量人工对比 ③TTS 候选 A/B 试听 + 实测倍速 + 长文本稳定性
+ **能否直接吐音素时长**（决定 2.5 走哪条路）④spaCy 对 3 段真实文本的 POS/短语目视核对
⑤核实 CF 免费版当期官方限额（查文档，不凭印象）
> **DoD**：一张实测数字表，第六节的每个估算格子都被真实数字替换或确认。

*0-B 前端/设计侧（不等 0-A）* ⑥搬一个原子块进 Tauri 空壳跑起来，量剥离 `chrome.*` 成本（R9）
⑦**3000+ span 真实规模假数据**做词级高亮 + rAF 同步，压测 60Hz（R10）
⑧按 4.4 brief 建 claude.ai/design 组件库
> **DoD**：3000 span 下 60Hz 不掉帧的可运行原型 + 组件库上线 + R9 工作量有数字。

**Phase 1 同步点** —— 两边结论汇总，**冻结书包格式（2.2）+ 立起测试基建**
> **DoD**：`schemaVersion=1` 的书包 JSON Schema 文档化；自测素材生成脚本（最小 EPUB + 已知答案文本，
> **用公版素材如 Project Gutenberg，不用有版权的书**）；`cargo test` 和 `pytest` **都真跑过看到全绿**（R12）。

**Phase 2** loader + nlp：EPUB/PDF/TXT → 章 → 句 → segments
> **DoD**：纯函数单测覆盖章节切分 + POS 映射；对自测素材输出与 golden 一致。

**Phase 3** llm：llama-server 生命周期 + 批量编号对齐 + 断点续跑 + profile 讲解策略
> **DoD**：跑通一章；**故意 kill llama-server 后重跑能续上**；echo 检测与错位检测有单测。

**Phase 4** tts + align + pack：逐句合成 + 时间轴 + Opus 编码
> **DoD**：一章出完整书包（含 `quality.json`）；音频总时长 = 各句时长之和；20 句人耳核对词级偏移 <150ms。

**Phase 5** 阅读器：Phase 0-B 组件接真书包，句级/词级切换 + 跟读循环 + 失败态呈现
> **DoD**：真书包在 Tauri 里可读可听可跟读；失败句有标记和重试入口。

**Phase 6** Rust 状态层：SQLite（含迁移）+ 存储所有权表落实 + CF 推拉 + conformance 测试
> **DoD**：`normalizeVocabEntry` conformance 对 aidu golden fixture 全绿；
> **同步闭环实测**：aidulc 加词 → CF → Chrome 扩展可见 → 移动 PWA 可复习；离线时阅读不受影响。

**Phase 7** 备料台：任务队列 + NDJSON 进度 + Job Object + partial 重试
> **DoD**：R11 的孙进程集成测试通过（真拉真杀）；"重试失败句"只重跑失败的。

**Phase 8** 打包：Tauri exe + Python 侧车 onedir + 首次运行下载
> **DoD**：干净机器（或干净目录）上从零跑通一本书；重新打包不碰用户数据。

# 十、验证方式

- **纯函数单测**（无模型无网络，可 CI）：章节切分、spaCy POS→aidu 13 类映射、批量编号对齐与拆分重试、
  echo/错位检测、envelope 合并、`normalizeVocabEntry` conformance
- **集成测试**：Job Object 真拉孙进程真杀（R11）；SQLite 迁移正反向
- **端到端真跑**：一本真实 EPUB 全量跑完，核对 ①无缺句 ②音频总时长 = 各句时长之和
  ③中断后重跑复用中间产物 ④取消不留孤儿进程 ⑤`quality.json` 里的失败数与阅读器标记数一致
- **时间轴精度**：随机 20 句人耳核对，偏移 >150ms 不合格
- **前端性能**：3000 span 章节 60Hz 高亮不掉帧（WebView2 devtools 量）
- **同步闭环**：aidulc 加词 → CF → 扩展可见 → 移动 PWA 可复习
- **绝不把"读过代码/文档"当验证**（aidu / subgen / comic-gen 三个项目的 memory 里都记着这条教训）
