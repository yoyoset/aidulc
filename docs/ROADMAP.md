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

## P0(阻断可用性)

### 书库路径未锚定 exe_dir

`src-tauri/src/main.rs:168-169` 的 `lib_dir` 直接用 `config.toml` 里的裸相对路径,从未
`exe_dir.join()` 或 `canonicalize()`,实际落地位置取决于进程启动时的 CWD,不是文档声称的
"exe 同目录"(对比同文件 164 行 `db_path` 的正确写法)。这是审计 `docs/BASELINE.md` 时发现的
真实 bug,也是用户答不上"三本书的书包在哪"的根因。

**修法**:比照 `db_path` 的模式统一处理;启动日志打印解析后的绝对路径(参照 `prep_path` 已有的
`main.rs:180-182` 做法)。

来源:2026-08-07 审计,代码实测确认。

---

## P1(产品需求,用户已明确提出)

### 书库位置可见可改 + 书包导出导入

用户原话:书库路径"应该可以在设置里修正";处理过的书包"也是资产,是可以导出导入的,这样跨端也可以了"。

- 设置界面需要一个"书库位置: ... [更改...]"的入口(参照 subgen/comic-gen 的既有模式,不是只能改
  `config.toml` 文本文件)
- 书包导出/导入,用于跨设备迁移。`src-tauri/src/application/transfer_service.rs` 现在只做
  `.aidu-data`(词典/生词)的导入导出,不覆盖书包这个更大的资产类型,需要新设计

来源:用户在审计 S0.4 阶段的明确反馈。

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

## P3(架构收口,S2 阶段做)

### commands/jobs.rs 过大, 业务编排住在命令层

`jobs.rs` 947 行,其中 `pump_queue`(226 行)、`batch_start`(147 行)等是批处理调度器,应移到
`application/job_orchestrator.rs`,命令层只留薄壳(每个 command ≤30 行)。

`scripts/check.ps1` 的 clippy 检查目前用 `-ClippyBaseline 8` 放行这批"参数过多/类型复杂"的
结构性警告(集中在 `jobs.rs`/`library_service.rs` 等命令层),拆分完这里的基线数字要调低。

### 命名消歧

`services/sync.rs`(HTTP 客户端)与 `application/sync_service.rs`(编排)同名不同层,容易搞混,
拆分时一并理清命名。

来源:2026-08-07 审计。

---

## P4(已知限制,低优先级)

- **`findSentenceIndex` 对缺 `audio` 的中间句二分会带偏**(`reader/core/timeline.js`):中间句
  `audio` 字段为 null 时,二分查找可能锁定到错误的更早句子。生产环境理论上不会触发(`pack.py` 的
  B3 修复保证失败句也写静音占位 audio),但旧版书包/手工编辑可能撞到。测试已锁定现状行为,见
  `reader/tests/timeline.test.js`。
- **hydrate 对齐风险**(`memory/pipeline.md` "状态管理"节):nlp 的碎片句过滤若发生在章**中间**
  (非尾部)会破坏 checkpoint 位置对齐 → 音频时间轴错位。已实测的三本书碎片句均在章尾、位置安全,
  遇到中间碎片句的书再修(改按 `original_text` 匹配)。
- **explain 逐句 LLM 调用可批量化**(吞吐预估 2-4x),改 prompt 有回归风险,暂缓
  (来源:`docs/archive/PACK_RELIABILITY_PHASE.md` §6)。
- **translate 阶段无完整性校验**(explain 阶段已有的 skipped_fatal 校验,translate 阶段还没有),
  优先级低(来源:同上)。
- **explain 失败句无限重试,没有失败次数上限**:重试时 `failedStages` 里的句子每次都会再试,
  LLM 持续失败则永远失败,靠 quality 报告兜底可见但不会停止重试。当前是有意为之(用户需要"补"),
  但如果要限制资源消耗,后续可加一个失败次数上限(来源:`docs/archive/PACK_RELIABILITY_PHASE.md`
  §6,归档时唯一没有被 `memory/pipeline.md` 覆盖到的一条,单独拣选进本文件)。

---

## 已完成(仅作为近期变更记录,超过一个 Phase 周期后清理)

- 2026-08-07:建立版本控制(此前零历史)、聚合门禁 `scripts/check.ps1`、CLAUDE.md 强制规约、
  前端测试基建(0→32 测试)、清 Rust lint 债务(clippy 41→8 警告)、schema 同步改为可校验、
  文档收口(本文件)。
