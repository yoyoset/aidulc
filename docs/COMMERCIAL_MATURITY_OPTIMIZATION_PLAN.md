# aidulc 商用成熟度优化方案 v2

## 0. 目的和结论

## 0a. 执行成果（2026-08-04 完成 G0–G7）

| 阶段 | 成果 | 验证 |
|---|---|---|
| G0 | Rust f64 编译修复、v3 迁移重复列修复、删除 stale store/mod.rs、迁移测试 3 项 | Rust 42 + Python 94 |
| G1 | profile `default` 统一、vocab/dict 无损 canonical payload、Credential Manager、AIDU Worker 协议、.aidu-data 导入导出 | Rust 47 (含 roundtrip/隐私断言) |
| G2 | Batch/BookJob/StageRun 批量工作流、批次进度、checkpoint 原子写入、失败态不再误判完成 | Rust 51 + Python 101 |
| G3 | 音频分块读取、搜索索引、章节竞态防护、Blob revoke、nlp.pipe 批处理、loader 迭代器 | 端到端通过 |
| G4 | main.rs 763→183 行、commands/jobs+library 模块、前端 services 层 | Rust 55 |
| G5 | 组件健康检查、模型池扫描、组件中心 UI、启动恢复 stale 队列 | 端到端验证 prep/LLM/TTS 状态 |
| G6 | 任务完成"打开书籍"入口、组件中心、首次运行健康检查 | CDP 验证 |
| G7 | 批量 2 本书端到端:1 batch → 2 jobs → 自动入库;全量门禁 | Python 101 + Rust 55 + 前端 16 |

最终门禁：**Python 101 passed / Rust 55 passed / 前端 16 文件语法通过 / 批量工作流端到端通过**。

## 0b. 模型管理·向导·多语言执行成果（H1–H6, 同日完成）

| 阶段 | 成果 | 验证 |
|---|---|---|
| H1 | v5 迁移 (model_registry/wizard_state/books 语言+模型字段);模型注册表 repo;扫描器(平铺+hub 布局已实测) | Rust 61 |
| H2 | model_service (recommend_for/登记/推荐唯一/书级绑定);downloader (断点续传/sha256/原子);hardware (磁盘/显存) | Rust 69 |
| H3 | 向导状态机 (wizard_state 表, 6 步可跳过续走);前端 WizardView 6 步, 首次运行拦截 | Rust 72 |
| H4 | 模型中心 UI (语言分组/推荐/移除/扫描登记);导入页书语言选择;导航入口 | 端到端 |
| H5 | language_registry (en 完整, ja 预留, fallback 不崩溃);runner/TTS 走注册表 | Python 111 (弹性测试 10 项) |
| H6 | 端到端: 新库首启显向导 → 扫描 F:\hf_cache 7 文件 → 登记 Qwen LLM → en 推荐组合;全量门禁 | Rust 72 + Python 111 + 前端 19 |

**H 系列最终门禁：Rust 72 / Python 111 / 前端 19 文件全绿; 新库首启向导、模型扫描复用、登记、推荐全部 CDP 实测通过。**

## 0c. 审查修复成果（同日）

三路并行审查（前端接线 / Rust 参数传递 / Python pipeline）发现 17 个真实 bug,全部修复并加回归测试：

| # | 严重度 | 修复 |
|---|---|---|
| A1 | 崩溃 | pack.py 整章失败写 `.opus` 用 soundfile 崩溃 → 改 ffmpeg 生成真实空 opus |
| B1 | 高 | checkpoint 失败状态粘死 + partial/failed 语义冲突 → tts/explain/align 失败=partial(可恢复), translate/nlp 失败=failed |
| A2 | 高 | tts/stage.py `.index(s)` 重复句取错 checkpoint → 改 enumerate |
| B2 | 高 | TTS 跳过句不推进时间轴导致漂移 → 跳过也推进 0.5s |
| A3 | 中 | runner `languages` 非 dict 崩溃 → isinstance 防护 |
| H5-死链 | 中 | TTS language 从不传入(engine getattr 时序错误)→ 构造参数 + stage/runner 传递 |
| Rust-卡死 | 高 | pump_queue spawn 失败 running_job 卡死队列 → 清理+标记 failed+继续泵 |
| Rust-语言 | 中 | 自动登记书硬编码 en/zh-CN 覆盖真实语言 → 用 job 真实语言 |
| 前端-拖拽 | 高 | `f.path` Tauri 2 无此属性 → tauri://drag-drop 事件 + Rust 原生 pick_files 对话框 |
| 前端-向导 | 高 | 完成页不调 wizardFinish → 下次启动重新拦截 → 修复 |
| 前端-router | 高 | navigate 双重 dispatch → 统一 hashchange;监听器累积 → 注销旧订阅 |
| 前端-open | 中 | prep→reader 三连 open / 切章读取不中止 / 离开后写 null DOM → generation 防护 |
| 前端-other | 低 | __aidulcAudio 全局残留 → cleanup 清除 |

最终门禁：**Python 115 / Rust 72 / 前端 19 全绿**（新增 partial 语义回归测试 4 项 + 原有 111 项）。

这份方案承接：

`F:\my_ai\aidulc\docs\MATURITY_OPTIMIZATION_PLAN.md`

目标不是继续堆功能，而是把 aidulc 变成：

> 一个轻量外壳，负责书库、任务、组件、模型、配置、升级、回滚和数据；
> 重型 prep/LLM/TTS/ffmpeg 按需安装；用户只面对“导入 → 准备 → 入库 → 阅读”的完整产品流程。

用户提出的核心要求被整理为五条产品原则：

1. 单本书和批量书籍都必须通过同一个可观测工作流。
2. 识别、翻译、讲解、语音、对齐、打包每个阶段都可以观察、暂停、取消、恢复和重试。
3. 准备完成的书必须原子入库，随后可以稳定学习和阅读。
4. 生词本和个人词典必须无损兼容 AIDU，并严格隔离私有数据。
5. 前后端按单一职责拆分，单文件不过度膨胀，模块边界由测试和依赖方向强制。

## 1. 当前执行审查

### 1.1 已实测结果

| 项目 | 当前结果 | 判断 |
|---|---|---|
| Python pytest | 94 passed | 基础 Python 测试通过 |
| 前端 JS 语法 | 13 个文件通过 `node --check` | 仅能证明语法，不能证明 UI 行为 |
| `cargo build` | 当前通过 | 仅是开发构建 |
| `cargo test --no-run` | 当前失败 | M1 把 `interval` 改为 f64 后，Rust 测试仍使用整数 literal，测试二进制不能编译 |
| M0 1k benchmark | 约 104.7 句/s，含模型启动开销 | 已有基线但不完整 |
| M0 10k benchmark | 约 278.6 句/s | 可作为 NLP 基线 |
| Tauri 外壳 | 约 11.65 MiB | 适合轻量外壳方向 |
| PyInstaller 侧车 | 约 6.12 GiB | 不能作为默认安装包 |
| AIDU Worker | 当前协议未完成兼容 | 不能发布同步功能 |

### 1.2 当前不能宣称完成的部分

- M1 AIDU 数据迁移没有形成可回滚的正式迁移。
- 当前数据库 v3 迁移存在 `dictionary.payload` 重复添加风险。
- `self`、`default`、`kid` 仍存在混用风险。
- AIDU dictionary 尚未完整进入同步链。
- 当前 Worker adapter 仍有旧 `action/key/envelopes` 语义残留。
- 任务是队列雏形，不是完整的持久批处理系统。
- 失败句重试不能仅凭字段存在判定成功。
- `run.log`、退出码、quality 和任务状态还没有统一状态机。
- 长书仍然存在全量 DOM、全量 bookpack、整章音频 IPC 和 raw WAV 风险。
- Rust `main.rs`、Python Runner、ReaderView 仍承担过多职责。
- 当前包构建产物和运行路径没有形成完整的组件安装/升级/回滚链。

**第一控制结论：在 Rust 测试重新全绿、M1 数据迁移可回滚前，不得进入商用打包和同步发布。**

## 2. 商用产品形态

### 2.1 用户看到的产品

```text
aidulc.exe
├── 书库
├── 准备资料
├── 阅读器
├── 生词本/个人词典
├── 设置和 profile
├── 组件与模型中心
└── 同步中心
```

用户不需要知道：

- Python 环境。
- CUDA runtime。
- ffmpeg 路径。
- GGUF、Kokoro、spaCy 文件路径。
- 临时 checkpoint、WAV 和 Job Object。

### 2.2 两条主工作流

#### 准备资料工作流

单本书是 `batch` 中只有一个 item 的特例，不能通过两套逻辑实现。

```text
选择文件/拖拽多个文件
  → 创建 batch
  → 每本书创建 book_job
  → 解析识别
  → NLP 分句和词法
  → 批量翻译
  → 按 profile 讲解
  → TTS
  → 词级对齐
  → Opus 打包
  → 质量校验
  → 原子发布书包
  → 登记书库
```

#### 学习阅读工作流

```text
书库
  → 选择书籍
  → 选择 profile
  → 选择章节
  → 加载章节数据和音频
  → 阅读/听读/跟读
  → 查词
  → 用户确认后加入生词本
  → 本地保存阅读状态
  → 按 profile 同步 AIDU 数据
```

## 3. 工作流状态模型

### 3.1 Batch 状态

```text
created
  → queued
  → running
  → cancel_requested
  → canceled
  → completed
  → partial
  → failed
```

Batch 只描述一组输入，不直接承载句子结果。

### 3.2 BookJob 状态

```text
queued
  → running(stage)
  → paused
  → cancel_requested
  → canceled
  → completed
  → partial
  → failed
```

GPU 资源默认串行，CPU-only 阶段可以有限并行，但调度策略必须由 JobManager 决定，不由前端直接 spawn。

### 3.3 StageRun 状态

每个阶段独立记录：

```text
pending → running → succeeded
                  → partial
                  → failed
                  → canceled
```

阶段：

```text
parse / nlp / translate / explain / tts / align / pack / publish
```

重试规则：

- 解析失败：不能进入后续阶段。
- 翻译失败：重试 translate 及其下游阶段。
- 讲解失败：只重试 explain 及其下游阶段。
- TTS 失败：只重试 tts、align、pack。
- 对齐失败：只重试 align、pack。
- pack/publish 失败：不重新推理，只重试打包/发布。

## 4. 统一观测协议

每条进度事件必须包含：

```json
{
  "schemaVersion": 1,
  "batchId": "...",
  "jobId": "...",
  "bookId": "...",
  "stageId": "...",
  "stage": "tts",
  "status": "running",
  "current": 120,
  "total": 1000,
  "failed": 2,
  "sequence": 42,
  "ts": 0,
  "message": "正在合成第 120 句",
  "errorCode": null
}
```

事件规则：

- `batchId/jobId/bookId` 不能为空。
- 同一个 job 的 `sequence` 单调递增。
- 前端按 jobId 更新任务行，不允许更新“最后一行”。
- `stage_failed` 必须在 Python schema、Rust enum、前端 adapter 三处一致。
- 任务状态、quality.json 和最终书包状态必须来自同一状态机。
- 日志、UI 摘要和技术详情分层，不能把 traceback 直接当唯一用户提示。

## 5. 新架构总览

### 5.1 Rust/Tauri

```text
src-tauri/src/
├── main.rs                    只负责组合根和依赖注入
├── commands/
│   ├── library.rs             参数转换 + 调 application service
│   ├── jobs.rs
│   ├── reader.rs
│   ├── vocab.rs
│   ├── settings.rs
│   └── sync.rs
├── application/
│   ├── library_service.rs
│   ├── job_service.rs
│   ├── reader_service.rs
│   ├── vocab_service.rs
│   ├── dictionary_service.rs
│   └── sync_service.rs
├── domain/
│   ├── book.rs
│   ├── bookpack.rs
│   ├── batch.rs
│   ├── job.rs
│   ├── vocab.rs
│   ├── dictionary.rs
│   ├── sync.rs
│   └── errors.rs
├── ports/
│   ├── repositories.rs
│   ├── component_store.rs
│   ├── process_runner.rs
│   ├── http_client.rs
│   └── secret_store.rs
├── infrastructure/
│   ├── sqlite/
│   ├── filesystem/
│   ├── worker_http/
│   ├── process/
│   ├── credential_manager/
│   └── components/
└── app/
    ├── app_state.rs
    └── job_manager.rs
```

依赖方向只能是：

```text
commands → application → domain + ports → infrastructure
```

禁止：

- command 直接写 SQL。
- command 直接发 HTTP。
- main.rs 直接编排任务阶段。
- domain 依赖 Tauri、SQLite、HTTP。
- 多个模块写同一张业务表。

### 5.2 Python 侧车

```text
prep/aidulc_prep/
├── domain/
│   ├── models.py
│   ├── job.py
│   ├── quality.py
│   └── errors.py
├── application/
│   ├── job_runner.py
│   ├── job_context.py
│   └── stage_plan.py
├── stages/
│   ├── parse_stage.py
│   ├── nlp_stage.py
│   ├── translate_stage.py
│   ├── explain_stage.py
│   ├── tts_stage.py
│   ├── align_stage.py
│   ├── pack_stage.py
│   └── publish_stage.py
├── ports/
│   ├── loader.py
│   ├── llm.py
│   ├── tts.py
│   ├── encoder.py
│   ├── checkpoint.py
│   └── logger.py
├── adapters/
│   ├── loaders/
│   ├── llama_cpp.py
│   ├── kokoro.py
│   └── ffmpeg.py
├── infrastructure/
│   ├── checkpoint_store.py
│   ├── logging.py
│   ├── paths.py
│   └── model_registry.py
└── cli/
    └── main.py
```

### 5.3 前端

```text
reader/
├── main.js
├── app/
│   ├── bootstrap.js
│   ├── router.js
│   ├── store.js
│   └── error_boundary.js
├── ipc/
│   └── bridge.js
├── services/
│   ├── library_service.js
│   ├── job_service.js
│   ├── reader_service.js
│   ├── settings_service.js
│   ├── dictionary_service.js
│   └── vocab_service.js
├── sessions/
│   ├── reader_session.js
│   ├── audio_controller.js
│   └── reading_progress.js
├── views/
│   ├── shell_view.js
│   ├── library_view.js
│   ├── prep_view.js
│   ├── reader_view.js
│   └── settings_view.js
├── components/
│   ├── chapter_renderer.js
│   ├── player_bar.js
│   ├── dictionary_panel.js
│   ├── task_row.js
│   └── error_banner.js
└── core/
    ├── timeline.js
    ├── shadow.js
    └── search_index.js
```

单文件软上限：

| 类型 | 建议上限 | 超过处理 |
|---|---:|---|
| Rust 业务文件 | 300 行 | 按 application/domain/infrastructure 拆分 |
| Python stage | 300 行 | 拆出 adapter、checkpoint、quality |
| JS view | 250 行 | 拆 session/controller/component |
| CSS 文件 | 400 行 | 按页面和 token 拆分 |

测试文件可以超过软上限，但必须按领域拆分，不能用大测试文件隐藏耦合。

## 6. 执行阶段

### G0：恢复绿色基线

必须先修：

- Rust `cargo test --no-run` 当前 f64 测试编译错误。
- v3 migration 重复添加 `dictionary.payload` 的问题。
- `store/mod.rs` 与 `store/store_mod.rs` 的迁移实现漂移。
- 统一实际数据库迁移入口。
- 重新运行 Python 94、Rust 全量、前端语法检查。

DoD：

- `cargo build` 通过。
- `cargo test` 真正执行并通过，不是只运行旧测试二进制。
- 新建空数据库可迁移成功。
- 含 v1/v2 数据的旧数据库可升级、回滚和校验。

### G1：AIDU canonical 数据和隐私边界

实现：

- canonical profile 采用 AIDU `default`，现有 `self` 显式迁移。
- vocab/dictionary 使用 profile + lemma/sense 的稳定 identity。
- SQLite 保存完整 canonical JSON payload 和查询 projection。
- 补齐 `deepData`、`lastReview`、`lastGrade`、浮点 `interval`。
- `null` 和字段缺失保持区分。
- dictionary 实现 sense-level normalize/merge/list。
- Worker 改为 `GET/POST ?profile=<id>` 和 `{vocab,dictionary,meta}`。
- token 接入 Windows Credential Manager。
- sync pull 后按 `updatedAt` 合并并写回。
- sync push 不得包含 token、阅读状态、书包、源路径、任务日志和设置。
- 增加 AIDU `.aidu-data` JSON 无损导入/导出，CSV 明确标记为有损。

DoD：

- AIDU vocab 全字段 roundtrip。
- AIDU dictionary 多 sense roundtrip。
- `default/kid` profile 隔离。
- AIDU Worker mock roundtrip。
- `self → default` migration 有迁移报告和回滚副本。
- 私有字段和 token payload 断言通过。

### G2：完整资料准备工作流

数据模型：

```text
Batch
  ├── id
  ├── profile_id
  ├── source_language
  ├── target_language
  ├── status
  └── items[]

BookJob
  ├── id
  ├── batch_id
  ├── book_id
  ├── input_path
  ├── output_path
  ├── status
  └── stages[]

StageRun
  ├── stage
  ├── status
  ├── current
  ├── total
  ├── error
  └── checkpoint_key
```

实现：

- 单本导入 = 一个 item 的 Batch。
- 多文件导入 = 一个 Batch，下面多个独立 BookJob。
- 每个 Job 的阶段状态独立保存。
- 前端显示 Batch 总进度和每本书/每阶段进度。
- 支持取消单本、取消整个 batch、暂停排队任务。
- 停止使用协作式取消，最终以 Job Object 杀进程组兜底。
- 每个阶段输出日志、错误摘要和技术详情。
- 成功书包通过 schema/quality/exit code 后原子 publish。
- publish 成功才进入 books 表。
- 失败书包可以 partial 入库，但必须显示失败阶段和可重试入口。
- 失败句重试按阶段选择，成功句 hash 不变。

DoD：

- 1 本书和 10 本书批量流程共用同一套代码。
- 阶段可观测、可取消、可恢复。
- 任务重启后从数据库恢复，不依赖内存队列。
- 任务事件带 batchId/jobId/bookId/stageId/sequence。
- 书包 publish 是原子操作，不会把半成品登记为 ready。

### G3：长书性能

前端：

- bookpack 按章节加载。
- 阅读器窗口化/虚拟列表，不渲染全书。
- 章节音频使用受控 asset/range 读取，禁止整章 `Vec<u8>` IPC 复制。
- 音频 Blob URL 切换时必须 revoke。
- 章节切换必须 dispose 旧 ReaderSession、AudioController、listeners。
- 搜索建立章节索引。
- rAF 只更新两个词节点，不能全量查询 DOM。

Python：

- loader 改成章节迭代器。
- NLP 使用 `nlp.pipe`。
- checkpoint 使用 JSONL/SQLite index 或批量提交。
- TTS raw WAV 成功编码后清理或移到可选 debug cache。
- 模型只在 JobContext 生命周期内存在。
- pack 阶段流式生成 manifest/quality，减少峰值内存。

Rust：

- HTTP 同步和大文件操作移出同步 IPC 线程。
- SQLite 事务和批量查询。
- JobManager 使用 actor 或单一状态机。
- 书包内容和音频路径必须受控、可取消、可流式读取。

性能 DoD：

| 指标 | 门槛 |
|---|---|
| 高亮更新 p95 | ≤1ms |
| 播放期间帧耗时 p95 | ≤16.7ms |
| 10k 句章节首句可见 | ≤300ms |
| 10k 句章节可交互 | ≤1.5s |
| 切换 30 章后 Heap | 基线 ±20% |
| 取消任务 p95 | ≤2s |

### G4：模块化重构

顺序：

1. 先把 `main.rs` 命令拆到 `commands/`。
2. 建立 application service，commands 不再直接 Repo/HTTP。
3. JobManager 独占任务状态。
4. Python Runner 只编排 stage，模型/文件/日志通过 ports 注入。
5. ReaderView 拆 ReaderSession/AudioController/ProgressService/DictionaryController。
6. 删除旧的重复 migration、占位 loader 和过期模块。
7. 用依赖检查和静态规则阻止 domain 依赖 infrastructure。

DoD：

- `main.rs` 只剩启动和依赖注入。
- `commands/` 不直接执行 SQL 或 HTTP。
- 一个 service 可以用 fake repository 单测。
- View 不直接调用通用 `invoke`。
- 每个 listener、模型、音频和 Blob 都有 dispose/release。
- 重要业务文件不超过软上限。

### G5：轻量外壳和组件管理器

目标目录：

```text
aidulc.exe                         外壳
%LOCALAPPDATA%\aidulc\
├── components\prep\<version>\<variant>\
├── components\engine-llm\<version>\<variant>\
├── components\engine-tts\<version>\<variant>\
├── components\ffmpeg\<version>\
├── models\objects\<sha256>\
├── models\refs\
├── downloads\
└── state\active.json
%APPDATA%\aidulc\config.toml
%APPDATA%\aidulc\data.db
```

manifest 必须包含：

```text
component_id
version
platform
variant
size
sha256
signature
dependencies
runtime_compatibility
download_url
```

实现：

- 首次启动向导：数据目录、书库、GPU、组件、已有模型扫描。
- 模型对象按 SHA-256 去重，已有合法文件直接复用。
- 组件下载支持 `.part`、断点续传、哈希、签名和原子激活。
- 更新前保留旧版本。
- 新版本健康检查失败自动回滚。
- SQLite 迁移前备份数据库和 WAL。
- 初始安装包不包含模型和重型 CUDA runtime。
- 组件中心显示版本、体积、状态、依赖、更新和修复按钮。

DoD：

- 初始安装包目标小于 50 MiB，不含模型和可选 engine。
- 干净目录可以首次安装组件后运行。
- 断点下载、校验失败、升级失败、自动回滚都有测试。
- 不依赖开发机路径。

### G6：用户体验成熟化

主界面必须包含：

- 书库。
- 最近阅读。
- 新建批量准备任务。
- 任务进度和日志。
- 组件/模型中心。
- 设置/profile。
- 生词本/个人词典入口。
- 同步状态。

首次运行：

1. 选择数据和书库目录。
2. 检测 WebView2/GPU/磁盘。
3. 扫描已有模型。
4. 安装或修复组件。
5. 导入第一本书。

错误反馈必须包含：

- 发生了什么。
- 是否影响当前书。
- 可以做什么。
- 查看技术日志的入口。
- 重试/取消/忽略/打开目录等动作。

### G7：最终商用质量门禁

必须有：

- Python unit/integration tests。
- Rust migration/service/job tests。
- Frontend Playwright/CDP tests。
- AIDU Worker mock roundtrip tests。
- 1k/10k/100k 性能报告。
- 两本真实书、至少两章。
- 翻译失败、TTS 失败、对齐失败 fixture。
- 重启、取消、恢复、失败重试。
- 干净目录安装、升级、回滚。
- 私有数据 payload 断言。

发布门槛：

- Python、Rust、前端测试全部绿色。
- Rust 测试必须从当前源码重新编译，不能运行旧 test binary。
- 迁移从空库和历史库都能通过。
- 任务完成状态同时由 exit code、bookpack schema、quality 决定。
- 失败数与 UI、quality.json、books/jobs 表一致。
- 没有未解释的 warning、硬编码开发路径或未处理的 schema 事件。

## 7. 商用软件的控制点

如果由产品负责人控制这项工程，必须坚持以下五个门：

### 门 1：数据门

没有 golden roundtrip、迁移报告和隐私 payload 断言，不允许开同步。

### 门 2：工作流门

没有可取消、可恢复、可重试和可观测的 Job 状态机，不允许称为批量准备系统。

### 门 3：性能门

没有 1k/10k/100k 对比数据，不接受“应该够快”。

### 门 4：交付门

没有签名 manifest、哈希、组件激活和回滚，不允许发布自动更新。

### 门 5：发布门

当前源码无法重新编译、迁移不能回滚、前端没有关键流程自动测试时，不允许标记 release ready。

## 8. 明确不做

本方案仍不包含：

- aidulc 内置 SRS 复习算法。
- 声音克隆和多音色旁白。
- 中译英和立即实现所有语言。
- 跟读录音回放对比。
- EPUB3 Media Overlays 导出。
- 多机远程推理。
- 为了“看起来现代”而整体迁移 React/Vue。

但多语言必须从现在开始预留 `source_language`、`target_language`、语言注册表、NLP adapter、prompt adapter 和 TTS adapter，不能把英语/中文写死在 domain 层。

## 9. 推荐下一步

第一轮不要继续加 UI，而是严格执行：

1. 修复当前 `cargo test --no-run` 的 f64 编译失败。
2. 修复重复 `dictionary.payload` migration。
3. 清理 `store/mod.rs` 与 `store/store_mod.rs` 漂移。
4. 通过空库、历史库和回滚测试。
5. 完成 AIDU dictionary/token/profile conformance。
6. 再开始 G2 批量工作流状态机。

这条顺序的理由：如果数据协议和测试基线不可靠，继续做组件管理和 UI 会把错误包装得更漂亮，但不会让软件更成熟。

## 10. 执行报告模板

```text
阶段:
目标:
修改文件:
迁移/协议变化:
新增测试:
性能基线和结果:
实际执行命令:
实际测试结果:
端到端结果:
包体积变化:
已知风险:
回滚方式:
下一阶段前提:
```
