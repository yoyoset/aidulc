# aidulc 成熟度优化计划

## 0. 文档定位

这不是下一轮功能清单，而是把当前“开发机可运行原型”推进到“可长期使用、可升级、可维护软件”的工程计划。

主要优化方向：

- 性能：长书不因全量 DOM、全量音频、全量内存而失控。
- 逻辑完整性：任务、书包、失败、恢复、同步和版本状态必须有明确状态机。
- 软件工程模块化：外壳、组件管理、Python pipeline、Rust service、前端 view 各自有边界。
- 用户易用性：用户不应该知道 Python、CUDA、ffmpeg、模型路径和缓存目录。
- 交付和升级：安装包保持轻量，依赖和模型按需下载、校验、升级和回滚。
- AIDU 兼容：无损承接 AIDU 生词本、个人词典和 profile 数据；私有数据不误推云端。

**当前状态不能以“测试全绿”作为成熟度结论。** 当前已有较好的原型和纯函数测试基础，但发行、长书性能、数据协议、生命周期和用户流程仍未达到成熟软件标准。

## 1. 当前审查结论

### 1.1 发行包现状

当前审查实测近似体积：

| 组件 | 体积 | 结论 |
|---|---:|---|
| Tauri release 外壳 | 约 11.65 MiB | 外壳本身足够轻量 |
| reader 前端 | 约 77 KiB | 不是包体积问题 |
| PyInstaller prep 侧车 | 约 6.12 GiB | 当前不可作为成熟发行包 |
| 侧车内 torch | 约 3.54 GiB | 主要浪费来源之一 |
| `llama_cpp` CUDA DLL | 约 0.91 GiB | GPU engine 应独立组件化 |
| CUDA runtime | 约 0.81 GiB | 当前存在重复/重复打包风险 |
| ffmpeg | 约 0.30 GiB | 应作为独立 engine 组件 |
| 模型池 | 外置，约数十 GiB | 不应打进安装包，应做缓存管理 |

当前包的问题不是“压缩一下就够了”，而是**交付边界错误**：重型运行时、GPU engine、模型和外壳没有分离。

### 1.2 配置和依赖现状

- `config.toml` 目前只是读取默认值，缺少真正的修改、校验和版本管理。
- `model_dir`、ffmpeg 配置没有完整接入 pipeline。
- 代码仍存在 `F:\hf_cache`、`F:\my_ai\subgen`、`F:\my_ai\comic-gen` 等开发机路径。
- sidecar 构建脚本没有和 Tauri bundle 正式组装。
- 没有 release manifest、SHA-256、签名、原子切换、回滚和升级通道。
- 没有首次运行健康检查和依赖修复向导。

### 1.3 长书性能现状

前端：

- 整章一次性生成全部 DOM。
- 每个词绑定多个事件闭包。
- 全书/整章 bookpack 常驻 WebView 内存。
- 整章音频通过 IPC 返回完整 `Vec<u8>`，再复制为 `Uint8Array` 和 Blob。
- 章节切换后 Blob URL 没有稳定释放策略。
- view 每次渲染重复注册 store/Tauri listener，存在监听器泄漏。
- 搜索仍是线性扫描。

Python：

- loader、Runner、各 pipeline stage 持有完整 `Book`。
- spaCy 仍逐句调用，未使用 `nlp.pipe`。
- checkpoint 以大量小 JSON 反复读改写。
- TTS 阶段曾存在 `chapter.sentences.index(s)` 的 O(n²) 路径。
- 讲解逐句串行调用，长书耗时与请求数线性放大。
- 每句 WAV 留在 `audio_raw`，长书会产生 GB 级临时文件。

Rust：

- SQLite 是单 `Mutex<Connection>`，所有访问串行化。
- 大文件读写和同步网络仍可能阻塞命令线程。
- Job 状态由多个 Mutex 分散维护，状态转换不是单一原子状态机。
- `main.rs` 承担配置、书库、IPC、任务、路径安全和进程治理，职责过重。

### 1.4 AIDU 兼容现状

当前 aidulc **不能无损兼容 AIDU**。

AIDU canonical 生词字段包括：

```text
word lemma pos meaning senseId phonetic context level collocations deepData
stage interval easeFactor nextReview reviews lastReview lastGrade addedAt updatedAt
```

AIDU 个人词典包括：

```text
word lemma pos meanings meaning senses selectedSenseId phonetic level
collocations examples source confidence context createdAt updatedAt
```

当前确定的不兼容点：

- AIDU Worker 期待 `?profile=<id>` 和 `{vocab, dictionary, meta}`。
- aidulc 当前使用 `action/key/envelopes`，协议不兼容。
- aidulc 未正确把 profile 放进 Worker URL。
- `self` 与 AIDU 的 `default` profile 不一致。
- `deepData`、`lastReview`、`lastGrade` 会丢失。
- AIDU 的 `interval` 允许浮点，当前 Rust 使用整数。
- 个人词典没有真正进入同步链。
- 远端较新的 SRS 不能可靠覆盖本地旧 SRS。
- CF token 当前没有接入 Credential Manager。
- aidulc 当前没有 AIDU 数据导入、导出和完整 golden conformance。

## 2. 总体产品决策

### 2.1 轻量外壳 + 可管理组件

最终产品形态不是“一个 6GB exe”，而是：

```text
aidulc.exe                         轻量 Tauri 外壳
reader/                            前端资源
bootstrapper/                      首次运行和组件修复

%LOCALAPPDATA%\aidulc\
├── components\
│   ├── prep\<version>\<variant>\
│   ├── engine-llm\<version>\<variant>\
│   ├── engine-tts\<version>\<variant>\
│   └── ffmpeg\<version>\
├── models\
│   ├── objects\<sha256>\
│   └── refs\
├── downloads\                   .part 临时下载文件
└── state\active.json             当前激活版本指针

%APPDATA%\aidulc\
├── config.toml
├── data.db
├── data.db-wal
└── logs\

用户选择的书库目录\
└── <book-id>_<profile-id>\
    ├── manifest/bookpack.json
    ├── audio/
    ├── quality.json
    └── run.log
```

原则：

- 安装包只包含外壳、前端、bootstrapper 和最小基础资源。
- prep、LLM engine、TTS engine、ffmpeg 按需安装。
- 模型永远不默认进入安装包。
- 已存在的 AIDU/comic-gen/subgen 模型必须扫描、校验后复用，不盲目复制。
- 用户数据、书库、数据库、日志不放安装目录。
- 所有重型组件都可以独立升级和回滚。

### 2.2 组件 manifest

新增签名 manifest，至少包含：

```json
{
  "manifestVersion": 1,
  "channel": "stable",
  "appVersion": "0.2.0",
  "components": [
    {
      "id": "engine-llm",
      "version": "...",
      "variant": "cuda12.4-x64",
      "url": "...",
      "size": 0,
      "sha256": "...",
      "requires": {"driver": "..."}
    }
  ],
  "signature": "..."
}
```

每个模型还要有模型清册：

```text
model_id
version
repo
filename
size
sha256
magic_bytes
required_files
runtime_compatibility
source_url
```

### 2.3 升级状态机

```text
discovered
  → downloading
  → downloaded
  → verified
  → staged
  → health_checked
  → active
```

失败路径：

```text
downloading/verified/staged/health_checked 失败
  → failed
  → 保留旧 active
```

升级规则：

- 下载到 `.part`，支持断点续传。
- 下载完成后先校验长度、SHA-256 和签名。
- 新版本放在独立目录，不覆盖当前版本。
- 健康检查通过后，原子更新 `active.json`。
- 保留上一版本，启动失败自动回滚。
- 数据库迁移前备份数据库和 WAL 文件。
- 更新失败不影响已有书库、词典、生词和阅读进度。
- 支持 stable/beta channel，但默认只用 stable。

## 3. 成熟度优化路线

执行顺序：M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7。

### M0：建立性能和交付基线

目标：先让后续优化有可重复证据，不凭感觉改。

工作内容：

- 固定 Windows、GPU、模型、Python、Rust、WebView2 版本记录。
- 准备 1k、10k、100k 句测试集。
- 建立 benchmark 命令，记录：章节打开耗时、首句可见耗时、完整交互耗时、Python RSS、Rust IPC 延迟、DOM 节点数、WebView Heap、帧耗时、TTS/LLM 吞吐。
- 建立安装包体积清单，区分外壳、prep、engine、model、ffmpeg。
- 建立“干净目录”环境变量和测试目录，不再使用开发机默认路径。

验收：

- 同一输入可重复生成性能报告。
- 报告至少包含 1k 和 10k 句两个规模。
- 包体积能够按组件分别统计。

### M1：AIDU 数据协议和隐私边界

目标：先解决数据无损和私有数据误同步风险。

#### Profile 规则

- 以 AIDU `default` 为 canonical profile id。
- 当前 UI 的 `self` 迁移到 `default`，不能继续同时存在两个云端分区。
- `kid` 作为独立 profile。
- 所有本地表、设置、阅读状态、词典和同步都使用统一 profile id。
- 增加迁移报告，明确旧 `self` 数据如何转为 `default`。

#### 生词和词典存储

- SQLite 保留 canonical JSON payload，避免字段丢失。
- 补齐 `deepData`、`lastReview`、`lastGrade`。
- `interval` 使用 REAL/f64。
- vocab 和 dictionary 增加 `profile_id`，唯一 key 为 profile + lemma。
- 建立 `VocabService` 和 `DictionaryService`，IPC 不直接操作 repo。
- content upsert 只能修改内容字段，不重置 SRS。
- review update 只能由 SRS owner 修改 SRS 字段。
- sync import 允许可信远端较新记录覆盖本地，但必须按 `updatedAt` 合并。
- dictionary 实现 canonical normalize、sense merge 和字段无损 roundtrip。

#### Worker 协议

严格对齐 AIDU Worker：

```text
GET  <worker-url>?profile=<url-encoded-profile>
POST <worker-url>?profile=<url-encoded-profile>

body:
{
  "vocab": {},
  "dictionary": {},
  "meta": {}
}
```

同步规则：

- 只推当前 profile。
- `404` 表示新的 profile，不当成普通网络失败。
- pull 后客户端按 `updatedAt` 合并，再写回 SQLite。
- vocab-only push 不得擦除远端 dictionary。
- token 只存在 Windows Credential Manager，不进 WebView、不进日志、不进书包。
- `userSettings`、provider/model 配置、阅读状态、书签、播放位置、书包、源文件路径、任务日志不进入 Worker。
- 跨设备删除在没有 tombstone 协议前禁止伪装成已同步删除。

必须新增 conformance：

- AIDU JS normalize 与 Rust/Python normalize golden 一致。
- vocab/dictionary 全字段 roundtrip。
- `self → default` migration。
- legacy raw vocab map、404、dictionary 保留语义。
- Worker mock roundtrip。
- profile 不污染。
- 远端新 SRS 正确写回。
- payload 不包含私有字段和 token。

验收：

- aidulc 加词 → Worker → AIDU Chrome 扩展可见。
- AIDU 个人词典 → aidulc 无损显示。
- `default`、`kid` 两个 profile 完全隔离。
- 离线可用，联网后可重试同步。

### M2：数据流和生命周期正确性

目标：消除“能跑但重启/取消/切换后状态不确定”。

工作内容：

- checkpoint 使用临时文件写入后原子替换。
- checkpoint 带输入 hash、profile、model version、stage version。
- 每阶段拥有明确状态：queued/running/succeeded/partial/failed/canceled。
- 任务完成必须同时满足：本次子进程 exit code=0、bookpack 通过 schema、quality 与状态一致。
- 书包存在不能单独作为 done 判据。
- 启动时恢复 stale jobs 和持久队列。
- `PrepState` 改为单一 JobManager 状态机，不使用多个独立 Mutex 表示同一状态。
- 每个 view 和 Tauri listener 都必须有 `dispose()`。
- 路由切换必须取消异步请求、释放音频、revoke Blob URL、注销 listener。
- `ReaderSession` 使用 generation/token，阻止旧章节异步结果污染新章节。
- 所有错误统一为结构化错误：类别、用户摘要、技术详情、可执行动作。

验收：

- 杀掉进程后重启，任务和阅读位置可恢复。
- 取消任务 p95 ≤2 秒，无 Python/ffmpeg 孤儿。
- 重试一个失败句时，成功句 checkpoint hash 不变。
- 切换 30 个章节后内存回到基线 ±20%。

### M3：长书性能优化

#### 前端

- 书包改为 manifest + 按章节加载，不把全书 JSON 常驻 WebView。
- 阅读器使用虚拟列表或窗口化渲染，只保留可视区前后窗口。
- 长句/长章不生成全量 DOM。
- 事件委托替代每个词多个闭包事件。
- 词高亮只更新旧节点和新节点。
- 章节搜索建立索引，避免每次从头线性扫描。
- 音频使用受控本地 asset/range 读取，禁止整章 `Vec<u8>` 经 IPC 复制成 Blob。
- 如果使用 Blob，切换章节/书籍必须 `URL.revokeObjectURL`。

#### Python

- loader 改为章节迭代器。
- spaCy 使用 `nlp.pipe` 批处理。
- 消除 `chapter.sentences.index(s)` O(n²)。
- checkpoint 使用 JSONL/SQLite 索引或批量提交，减少每句多次打开文件。
- 讲解批量化，严格保留编号对齐。
- TTS 生成后及时删除或归档 raw WAV；书包只保留最终 Opus 和必要中间产物。
- 模型生命周期放在 `JobContext`，避免不可控导入单例。

#### Rust

- 大文件读写和同步网络放到异步 service/thread，不阻塞 IPC 主线程。
- SQLite 使用事务、批量查询和必要索引。
- 消除 repo N+1 查询。
- 任务队列使用 `VecDeque` 或 actor。

建议性能门槛：

| 指标 | 目标 |
|---|---|
| 高亮更新 p95 | ≤1ms |
| 播放期间帧耗时 p95 | ≤16.7ms |
| 长书 DOM | 不随总句数线性增长 |
| 10k 句章节首句可见 | p95 ≤300ms |
| 10k 句章节可交互 | p95 ≤1.5s |
| 取消任务 | p95 ≤2s |
| 切换 30 章后内存 | 基线 ±20% |

### M4：模块化重构

#### 前端目标边界

```text
reader/
├── app/                  router/store/session 生命周期
├── ipc/bridge.js         只做 DTO 转换和错误归一化
├── services/             library/job/reader/settings/dictionary service
├── views/                页面布局, 不直接访问 Tauri
├── components/           可复用 UI
├── core/                 纯函数和状态机
└── styles/
```

`ReaderView` 拆为：

- `ReaderSession`：当前 book/chapter/句子生命周期。
- `AudioController`：加载、播放、进度、释放。
- `ReaderProgressService`：位置和书签。
- `ChapterRenderer`：窗口化 DOM 和高亮。
- `DictionaryController`：词典面板和生词操作。
- `SearchController`：索引和跳转。

#### Rust 目标边界

```text
src/
├── app/                  AppState/JobManager/生命周期
├── commands/             只做参数转换和结果返回
├── services/             library/reader/jobs/sync/config/components
├── repos/                books/jobs/vocab/dictionary/settings/reading
├── domain/               纯数据和合并规则
└── infrastructure/      sqlite/http/process/credential/component store
```

`main.rs` 只负责组合根和依赖注入，不再承载业务逻辑。

#### Python 目标边界

- `core` 不做 I/O。
- `pipeline` 只编排 stage，不直接发现配置。
- `infra` 管 checkpoint、日志、进程和组件路径。
- `stage` 使用 Loader/LLM/TTS/Aligner Protocol，测试使用 fake engine。
- `pack` 显式接收 ffmpeg 路径和 JobContext。
- `run.log` 由统一 logger 写入，而不是散落 print。

### M5：组件管理器和轻量发行

目标：把“一个外壳管理所有依赖和模型”做成真正产品能力。

#### 组件拆分

- `app`：Tauri 外壳、前端、SQLite、组件管理器。
- `prep`：loader、NLP、任务编排、pack、契约校验。
- `engine-llm`：llama.cpp/llama_cpp CUDA 或 CPU variant。
- `engine-tts`：Kokoro/Torch runtime variant。
- `ffmpeg`：固定版本独立组件。
- `models`：GGUF、Kokoro、spaCy 资源对象。

当前 6GB 侧车可以先作为不可变 `prep-cuda12.4` 组件迁移，但不应成为外壳安装包默认内容。后续再拆 `engine-llm` 和 `engine-tts`，减少 prep 组件体积。

#### 首次运行向导

1. 选择书库目录和缓存目录。
2. 检测 WebView2、CPU/GPU、显存和磁盘空间。
3. 扫描已有 AIDU/comic-gen/subgen 模型目录。
4. 对已有文件做 SHA-256、字节数和 magic 校验。
5. 复用合法模型，不重复下载。
6. 按需安装 prep、engine、ffmpeg。
7. 运行健康检查：prep 启动、LLM 加载、Kokoro config/voices、spaCy、ffmpeg。
8. 检查通过后设置 active 组件。

#### 组件中心

用户可以看到：

- 当前版本和最新版本。
- prep/LLM/TTS/ffmpeg/model 的已安装状态。
- GPU/CPU variant。
- 组件大小、缓存位置和占用空间。
- 下载、暂停、继续、删除、重新校验、回滚。
- 检测到旧模型可复用时显示“已复用”，而不是重新下载。

#### P5 交付验收

- 外壳初始包不包含模型和重型 CUDA runtime。
- 干净目录可以通过组件中心安装所需依赖后运行。
- 下载中断可继续。
- 哈希失败不会激活组件。
- 升级失败自动回滚。
- 更新不覆盖书库、数据库、设置和模型缓存。
- 不依赖 `F:\my_ai\subgen`、`F:\my_ai\comic-gen` 或 `F:\hf_cache` 才能运行。

### M6：用户易用性成熟化

主流程：

```text
首次启动
  → 选择数据/书库目录
  → 硬件检测
  → 依赖/模型中心
  → 导入书籍
  → 任务进度
  → 自动入库
  → 打开阅读器
```

必须提供：

- 明确的书库空态和导入入口。
- 拖拽导入和原生文件选择。
- 最近阅读和最近任务。
- 任务失败的用户摘要、技术详情和操作按钮。
- 失败句数量和质量报告一致。
- 字号、行距、宽度、字体、主题、儿童模式。
- 词典弹窗、显式加入生词本。
- profile 切换时明确显示当前数据范围。
- 同步 pending、成功、失败、冲突状态。
- 组件/模型缺失时给出修复入口，不显示 Python traceback 作为唯一反馈。

### M7：最终质量门禁

#### 测试

- Python 纯函数测试不依赖真实模型和网络。
- Python fake LLM/TTS/ffmpeg 测试 partial、重试、恢复和取消。
- Rust 迁移、书库、路径安全、任务状态和同步 mock 测试。
- 前端 Playwright/CDP 测试主界面、导入、书库、章节、播放、字体、书签、查词和失败态。
- 性能基准进入 CI 或定期发布检查。
- AIDU Worker mock roundtrip 和 golden conformance 必须进入 CI。

#### 最终场景

- 两本真实书同时存在。
- 每本书至少两章。
- 至少一个翻译失败句、一个 TTS 失败句和一个对齐失败句。
- 导入、处理、入库、打开、章节切换、播放、词级高亮、查词、加词、重启恢复全部走通。
- AIDU vocab/dictionary 双向 roundtrip 无字段丢失。
- 离线阅读和加词可用。
- 任务取消无孤儿进程。
- 失败句重试不重跑成功句。
- 发行包可在干净目录安装组件、升级和回滚。

## 4. 推荐执行顺序

### 第一批：先保数据和协议

1. AIDU canonical 字段和 Worker adapter。
2. profile `self → default` migration。
3. vocab/dictionary 无损存储和 conformance。
4. checkpoint 原子写入和任务状态机。

### 第二批：再保长书性能

1. 章节按需加载。
2. 阅读器虚拟列表。
3. 音频 range/受控资源读取。
4. Python iterator、`nlp.pipe`、checkpoint 批量写。
5. raw WAV 生命周期和缓存清理。

### 第三批：重构模块边界

1. ReaderSession/AudioController/ProgressService。
2. Rust AppState/JobManager/Services/Commands。
3. Python JobContext/Stage Protocol/统一 logging。
4. 全部 listener、Blob、模型生命周期可释放。

### 第四批：做轻量发行和升级

1. component manifest。
2. cache/object/ref 目录。
3. 下载、校验、激活、回滚。
4. 首次运行向导和组件中心。
5. 干净目录安装测试。

### 第五批：用户体验和质量门禁

1. 任务和错误反馈。
2. 设置和 profile。
3. Playwright/CDP 流程测试。
4. 长书性能报告。
5. release smoke 和升级回滚测试。

## 5. 不做什么

本计划不新增以下范围：

- 在 aidulc 内实现 SRS 复习算法。
- 声音克隆和多音色旁白。
- 中译英和其它源语言。
- 跟读录音回放对比。
- EPUB3 Media Overlays 导出。
- 多机并发和远程推理。
- 为了“看起来现代”而整体迁移前端框架。

## 6. 每阶段报告模板

```text
阶段:
目标:
修改文件:
数据迁移:
新增测试:
性能基线/结果:
实际执行命令:
实际测试结果:
用户流程验收结果:
包体积变化:
未完成项:
回滚方式:
下一阶段前提:
```

**最终目标不是“能打开 demo”，而是：用户只面对一个轻量外壳，外壳负责管理组件、模型、书库、任务、数据、升级和回滚；Python、CUDA、ffmpeg、AIDU Worker 都必须被正确封装在边界之后。**
