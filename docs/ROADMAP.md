# aidulc ROADMAP — 唯一活跃的待办来源

> `docs/archive/` 下 7 份文档是 2026-08-04~07 的历史执行记录(DeepSeek Flash 阶段性快照),
> 全部自称"已完成",仅供追溯"当时为什么这么做"、不代表现在仍然有效。
> **现在要看还有什么没做,只看这份文件** —— 不要去 archive/ 里挖"未完成项",
> 里面提到的开放项要么已被后续阶段解决,要么已经拣选进本文件(见下方逐条来源标注)。

## 使用方式

- 完成一项就从这里删掉,不要留"已完成"的勾选项发霉。
- 新发现的缺口按下面的分类加进来,附来源(审计/用户反馈/代码 TODO)。
- 涉及具体代码位置的项,附文件路径,方便直接跳转不用重新翻找。

---

## P0(阻断可用性)——空,已清

~~书库路径未锚定 exe_dir~~ 已修(2026-08-07)。`main.rs` 新增 `resolve_out_dir` 纯函数
(比照 `resolve_prep_path` 的既有模式),裸相对路径统一 `exe_dir.join()`,`AIDULC_OUT`
环境变量显式指定时不做加工;启动日志新增 `out_dir=... (存在: true/false)` 一行,不用再靠猜。

**修复过程中发现并顺带解决的架构债**:项目里曾经有两个不同步的"书目录"概念——
`library_dir`(仅两处遗留兜底逻辑引用, **没有一本书真正存在这里**)和 `PrepConfig.out_dir`
(真正的书包存放位置)。用户反馈"不知道书包在哪"的真正根因其实是 out_dir 此前没有
`config.toml` 持久化入口(只能靠 `AIDULC_OUT` 环境变量), 不是 library_dir 本身。已合并成一个:
`Config.out_dir` 是唯一配置来源, `LibraryState` 整个结构体已删除, `load_bookpack`/
`components_health` 两处消费方改读 `PrepConfig.out_dir`。副作用修复: `components_health`
的磁盘空间检查此前查的是 library_dir 所在盘, 和书实际写入的 out_dir 可能不是同一块盘,
结果具有误导性——合并后这个问题自动消失。

**历史遗留、这次没解决的**:`docs/BASELINE.md` 里 Wolf 21/Breath/Hitchhikers 三本书当时具体
落在哪个目录仍然未知(修 bug 只保证以后的运行可预测,不能倒推过去的运行落在了哪)——如果这三本书
的数据还在意义重大,需要用户提供当时的实际路径或干脆重新处理。

---

## P1(产品需求,用户已明确提出)——已完成

### 书库位置可见可改 + 书包导出导入

用户原话:书库路径"应该可以在设置里修正";处理过的书包"也是资产,是可以导出导入的,这样跨端也可以了"。

产品决策(已与用户确认):改位置时自动搜旧目录并搬迁(与 subgen 一致的策略);导出格式为 zip。

- [x] **P1.1 后端**(2026-08-07):`library_dir_get`/`library_dir_pick_and_set` 命令。
  搬迁逻辑 `infrastructure/dir_migration.rs`——同盘 rename 瞬间完成, 跨盘复制到临时名→
  核对文件数+总字节数→原子改名→删源, 单条目失败不中断整体(5 个测试覆盖)。
  **重启后生效, 不是热切换**:`PrepConfig` 是 Tauri 启动时一次性 `.manage()` 的不可变状态,
  运行时可变需要包 Mutex 并改遍全部直接字段访问点, 风险和收益不成比例, 这是明确的范围
  取舍不是遗漏, 命令返回值里带 `restart_required: true` 供前端提示。任务处理中禁止更改
  (参照 subgen"处理任务进行中不能改模型目录"的既有纪律)。
- [x] **P1.2 前端**(2026-08-07):设置页"书库位置"区块,当前路径 + "更改..."按钮,
  迁移中/成功(含失败明细)/取消/被拒绝(任务处理中)四种场景都有对应文案。
  用真实 `SettingsView` 类(mock 其余依赖服务, 不是复制一份渲染逻辑)在浏览器里
  过了成功/部分失败/被拒绝三种场景, 确认渲染和交互与设计一致。
- [x] **P1.3 后端**(2026-08-07):`commands::library::book_export` 命令, 用 `zip` crate
  (新增依赖)把某本书的 pack_dir 打包成 zip, 压缩方式选 Stored(不压缩)——音频已是
  Opus 编码, 再走 Deflate 只白费 CPU。实现在 `application/book_transfer_service.rs`
  (4 个测试: 往返/源目录缺失/zip 里没 bookpack.json 拒绝/目标已存在拒绝覆盖)。
- [x] **P1.4 后端**(2026-08-07):`commands::library::book_import` 命令, 解压 zip 到
  `out_dir/<new_id>/`(id 冲突自动加序号), 校验 `enclosed_name()` 防路径穿越, 校验含
  `bookpack.json` 才登记(否则清理残留目录返回错误), 复用 `library_service::register_book`
  完成入库。`application/transfer_service.rs` 现在只做 `.aidu-data`(词典/生词)的导入
  导出, 不覆盖书包这个更大的资产类型, 是独立实现不是复用它。
- [x] **P1.5 前端**(2026-08-07):"我的书"卡片新增"导出"按钮(product kind), 书库/我的书
  两个视图头部都加"导入书包(.zip)"入口。用真实 `LibraryView` 类(mock 其余依赖服务)
  在浏览器里验证了两个按钮存在且点击后正确调用后端命令、正确处理成功响应。

来源:用户在审计 S0.4 阶段的明确反馈 + 2026-08-07 后续实现中的架构发现。

---

## P2(功能缺口 —— 写了测试但未接入应用)

2026-08-07 清 clippy 死代码警告时发现:7 个 `pub fn` 只被自己的单元测试调用,从未被任何
`#[tauri::command]` 或前端真正使用。源码里已标 `#[allow(dead_code)]` + `TODO(未接线)` 注释,
这里是产品视角的清单:

| 功能 | 代码位置 | 说明 |
|---|---|---|
| model bundle 完整性检查 | `application/model_service.rs::bundle_complete` / `book_bundle_complete` | "这本书需要的模型是否齐全"——判断逻辑存在但没有界面出口。注意可能与 `preflight_check` 语义重复,接线前先确认 |
| 首次运行向导完成状态 | `application/wizard_service.rs::is_done` | 未接入 `main.rs` 启动流程,已完成向导的用户重启后可能仍会重复看到向导 |
| CF 同步断开连接 | `services/credentials.rs::delete_cf_token` | 界面上没有"登出/断开同步"的入口 |
| 首次下载 URL 构造 | `infrastructure/downloader/mod.rs::github_release_asset_url` / `hf_resolve_url` | 需确认"首次运行自动下载缺失模型"这条路径是否真的跑通,还是只有 URL 构造函数、没有编排下载流程的调用方——如果没有,是相对 subgen/comic-gen 的明显倒退,优先级应提高 |

来源:2026-08-07 lint 清理时代码实测发现(不是猜测,已逐个 grep 全仓库确认零调用方,仅测试引用)。

---

## P3(架构收口)

### clippy 基线(8)的真正清零需要函数签名重设计, 不只是挪文件

S2.1(2026-08-07)已把 `commands/jobs.rs`(原 947 行)的业务编排拆到
`application/job_orchestrator.rs`,命令层现在是薄壳(`pump_queue`/`batch_start`/
`start_prep_job`/`batch_start_prep` 等移走, `jobs.rs` 降到 228 行)。

但 clippy 基线**仍是 8,没有降**——这是诚实的结果,不是漏做:挪文件不会减少函数的参数
个数,`start_prep_job`(10 参数)等 3 个"参数过多"警告只是换了文件,原样跟过去了(挪的时候
特意验证过没有被静默压掉,`ipc/registry.rs` 的一致性测试也确认了这次拆分没有改变任何
command 的名称/路径)。真正清零基线需要把这些参数打包成请求结构体(如
`StartPrepJobRequest { book_path, profile, models, ... }`),这是比"挪文件"更大的改动
(要动 Tauri command 的调用约定, 前端 `invoke()` 传参方式也要跟着改), 留作独立任务,
不要和"分层"这件事混在一起做。

来源:2026-08-07 审计 + S2.1 完成后的复核。

---

## P4(已知限制,低优先级)

### 字号/间距阶梯已建, 存量替换未做

S3.1(2026-08-07)在 `reader/styles/tokens.css` 建了 `--md-sys-font-size-*`(15 档)和
`--md-sys-space-*`(7 档)阶梯令牌,颜色已强制走 `css:no-raw-hex` 门禁校验,但字号/间距
**没有对应约束**——现有代码里几十处 `0.9rem`/`1.4rem`/`12px` 这类裸值原样保留, 只是新代码
应该优先用阶梯令牌。存量迁移是独立工作量(要核对每处改动后的视觉效果, 风险和收益需要单独
评估), 不在这次令牌层地基搭建范围。

来源:2026-08-07 S3.1。

- **`findSentenceIndex` 对缺 `audio` 的中间句二分会带偏**(`reader/core/timeline.js`):中间句
  `audio` 字段为 null 时,二分查找可能锁定到错误的更早句子。生产环境理论上不会触发(`pack.py` 的
  B3 修复保证失败句也写静音占位 audio),但旧版书包/手工编辑可能撞到。测试已锁定现状行为,见
  `reader/tests/timeline.test.js`。
- **explain 逐句 LLM 调用可批量化**(吞吐预估 2-4x),改 prompt 有回归风险,暂缓
  (来源:`docs/archive/PACK_RELIABILITY_PHASE.md` §6)。
- **translate 阶段无完整性校验**(explain 阶段已有的 skipped_fatal 校验,translate 阶段还没有),
  优先级低(来源:同上)。
- **章节渲染只做了分帧, 没做虚拟滚动**(`reader/components/reader_renderer.js`):
  5000+ 句的超大章节分帧建 DOM 后不再冻结界面, 但 DOM 节点总数仍然很大, 滚动这类
  章节理论上仍可能不够流畅。真正的虚拟滚动需要重写 `highlightAt`/书签/搜索跳转依赖
  "所有句子 DOM 都已存在"的假设, 是更大的改动, 留到实测证明分帧不够用时再做
  (来源: `docs/BASELINE.md` 2026-08-07"新发现"一节)。
- **explain 失败句无限重试,没有失败次数上限**:重试时 `failedStages` 里的句子每次都会再试,
  LLM 持续失败则永远失败,靠 quality 报告兜底可见但不会停止重试。当前是有意为之(用户需要"补"),
  但如果要限制资源消耗,后续可加一个失败次数上限(来源:`docs/archive/PACK_RELIABILITY_PHASE.md`
  §6,归档时唯一没有被 `memory/pipeline.md` 覆盖到的一条,单独拣选进本文件)。

---

## 需求精化产出(2026-08-08 会话, 详细见 docs/requirements.md)

> 需求精化 + 架构记录会话的产出, 摘进这里作为活跃待办。完整任务卡/证据/验收在
> `docs/requirements.md`(可执行任务卡 + 优先级清单)和 `docs/ARCHITECTURE.md`(§9.5)。

- **候选缺陷(静态取证, 先 exe 复现再立项)**:
  - R4-1 书签跨章串位: `reader_view.js` 书签 Set 跨章不重置, 旧章下标套新章且覆写 reading_state。
    复现: ≥2 章书 ch1 打 2 书签 → 切 ch2 → 同序号句被高亮/面板列出错句。
  - R5-1 重试失败句丢 profile: `job_retry_failed`(job_orchestrator.rs:515-521)用硬编码默认
    profile, kid 用户重试后音色/策略/速度变默认。正确来源 = 原 job_request.json 快照。
  - R6-1 重启后"开始阅读准备"报批次不存在: `_startPrepForBook` 的 batch_id 依赖会话内存
    `_lastBatchId`, 重启后伪造 id 被 `batch_repo.get` 拒绝。复现: 导入不处理→重启→点按钮。
    若复现成立应 P0/P1(阻断"导入→稍后处理")。
  - F25 儿童模式对 kid 书无效: 设置页只写 'default', 阅读器按书 profile('kid')读且缺失不回退
    'default' → kid 书恒 18px/句级。复现: 开儿童模式 → 读 kid 书 → 字号没变。修法: reader_view
    改读 'default' 或缺失回退。
  - **F26 CSP 未放行 `data:`, R4 插图可能整条被拦(高置信, 待 exe 实测)**: tauri.conf.json CSP
    `default-src 'self'` 无 `img-src`, 而插图用 `data:image/*;base64`。若实测成立, R4 插图功能
    整体失效, 应 P0/P1。修法: CSP 加 `img-src 'self' data:`。
  - F27 .aidu-data 备份/恢复命令零 UI: transfer_export/transfer_import 注册但无任何前端调用,
    而 USER_NEEDS item 9("生词备份")因此未兑现。接 UI(如生词本/设置加"备份/恢复")即兑现。
    同类: bookmarks_list 死命令、boot_ping 开发探针。
  - F30 library_open 未接线 → "最近阅读"无数据源: 打开书不调 library_open, last_opened_at 恒
    None。USER_NEEDS item 12 明确要"最近阅读排序"。修法: 打开书时调 library_open。
  - **F34 拖拽导入监听累积(高置信, 待 exe 实测)**: library_view 每次 render 注册 drag-drop 监听
    且不注销, 多次访问书库后一次拖拽触发多次导入(重复 batch)。复现: 访问书库 3 次 → 拖一本书 →
    看是否重复导入。若成立应 P1。
- **词典查询性能(实测)**: F21 —— 每次点词 spawn 新侧车加载 2.4GB 模型, 实测冷 7.4s / 热 5.7s,
  用户每次查词等 5-7 秒。修复方向: 常驻词典服务 / 更小模型 / 异步。核心交互, 优先级上调。
- **便携版整体过期(实测, 高)**: F36 —— `dist/aidulc-portable/` 的 aidulc.exe(17:51, 旧前端)
  与 aidulc-prep.exe(18:03, 旧侧车)都早于 R0-R4: 侧车无 `--pymupdf-version`(误报 pymupdf 缺失)、
  `--preview-book` 无 health 字段(体检不显示)、不含 EPUB2 NCX/[[HEADING]]/插图提取; exe 嵌入旧
  前端(无模块化阅读器/渐进渲染/R4 插图)。**修法: 用 R0-R4 之后的代码整体重新打包便携版
  (先 cargo build 嵌前端, 再打包侧车, 整包替换), 这是 R0-R4 交付的必要一步。**
- **便携版 config.toml 是开发机残留(实测, 高)**: F37 —— `dist/aidulc-portable/config.toml` 含
  `F:/hf_cache`、`F:/my_ai/subgen` 等开发机绝对路径 + 旧字段名(library_dir/llm_model_path/
  tts_model_path)。换机器上 ffmpeg_path 指向不存在路径 → 误报缺失; 泄露开发目录结构。
  修法: 打包用干净默认 config.toml(或删除让它首跑生成)。
- **R3-1 模型下载接线前必修(实测确认)**: ① `Cargo.toml` reqwest `default-features=false` +
  无 TLS feature → https 下载必然失败(F19, scratch 工程实测); ② `models_download` 固定 60s
  超时(F4)。修完这两条才能谈下载按钮。
- **交付体积债(实测)**: 侧车/便携版 6.3GB(F22)—— torch 全量捆绑(约 2.5GB) + CUDA DLL 三重复制
  (cublasLt ×3 ≈ 1.35GB 浪费) + ggml-cuda 903MB。优化方向(去重/排除 cudnn engines/权衡 CPU build)
  见 ARCHITECTURE §9.5 F22。
- **死表面审计(P4 清理包)**: F5(job_id 死字段)/F14(profiles 表无 UI 写)/F17(无调用方命令)/
  F23(死配置字段)同根, 合并审计一次定去留。

---

## 已完成(仅作为近期变更记录,超过一个 Phase 周期后清理)

- 2026-08-07:建立版本控制(此前零历史)、聚合门禁 `scripts/check.ps1`、CLAUDE.md 强制规约、
  前端测试基建(0→32 测试)、清 Rust lint 债务(clippy 41→8 警告)、schema 同步改为可校验、
  文档收口(本文件)。
- 2026-08-07:书库位置可见可改 + 书包导出导入 zip(P1 全部完成)。
- 2026-08-07:修复大书打开阅读器卡死——用户实测撞见"点开始阅读没反应", 根因是
  `load_bookpack` 整本书(92MB, Hitchhiker's Guide)一次性 IPC 传给前端 + 章节渲染无分帧,
  改为按需拉取单章内容 + 分帧建 DOM, 详见 `docs/BASELINE.md`"新发现"一节。
