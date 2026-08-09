# aidulc 需求账本 — 每周期精化结果

> 需求分析师周期产出的账本。结构稳定: 现状快照 → 决策记录 → 优先级清单 → 本轮不做什么。
> 每个周期重写本文件(保留历史价值的信息进决策记录, 不叠加存档)。
> 与 ROADMAP.md 的分工: ROADMAP 记录"还没做的功能缺口", 本文件记录"每周期对缺口的
> 判定 + 下一批可执行需求(带证据/代价/验收)"。已采纳需求完成后回 ROADMAP 删项。
>
> **双维度纪律 (2026-08-08 起)**: 优先级清单每条需求必须同时写清
> **用户角度**(痛点 → 价值 → 用户能感知的验收) 和 **技术角度**(落点 → 路径 → 风险),
> 缺一不可。防止两类病: 纯技术视角做出用户感知不到的东西; 纯用户视角变成无法落地的空话。

> 端到端的导入 → 配置译本 → 准备 → 阅读流程基线见 `docs/BOOK_WORKFLOW.md`。

## 现状快照(本轮周期开始时)

- 基线 commit `916534b`(fix: 大书打开阅读器卡死)。
- **工作区有未提交的 R0-R4 改动**(reader/ 模块化拆目录、reader_renderer 渐进渲染、
  epub2 toc.ncx/PDF/插图链路、build.rs 前端 rerun-if-changed、check.ps1 加 cargo build、
  scripts/run.ps1), 是 memory/pipeline.md "2026-08-08 R0-R4" 的实现但尚未 commit ——
  下一实现会话开工前应先提交这批, 避免需求改动混入未提交基线。
- 已完成: P0(书库路径)、P1(位置设置+导出导入 zip)全部; 向导完成判定已由前端
  `main.js:45-55` 通过 `wizard_state` command 实现。
- 未接线(TODO(未接线) 共 7 处): 本次核实后 4 处中的 2 处其实已被前端/preflight 覆盖
  (见决策记录 R2-2), 真缺口剩 2 个(同步断开、模型下载), 另 2 处(profile 单条查询、
  ipc/registry 测试清单)属"为测试而存在", 不算产品缺口。
- 本轮新增: 播放控制交互已改为"三角/全局键点一下开始、再点一下停止, 锚点在句子"
  (reader/views/reader/player.js, 未 commit)。
- 本轮深化(2026-08-08 后续会话): 对 R1-1/R1-2/R2-1 做了源码取证, 各发现一处需求原文未覆盖的
  边界(见下方"可执行任务卡"): R1-1 恢复位置后 anchorIndex 不跟、R1-2 生词 lemma 是词面不是 NLP
  lemma、R2-1 断开需同时清 config.toml 的 URL。据此把三条展开成可直接开工的任务卡。
- 本轮新发现(2026-08-08 第二轮取证): ① R3-1 推荐徽章只在"无已 active 模型"时自动(register
  语义, 已修任务卡验收); ② R3-1 链路已实证闭合(preflight_check→resolve_for_book); ③ 新增
  候选缺陷 R4-1 书签跨章串位(静态取证, 见优先级清单)与架构摩擦点 F1-F6(docs/ARCHITECTURE.md §9.5,
  含 book_id 双端复制、job_request 契约卫生、NLP 短语局限等)。
- 本轮第三轮取证(2026-08-08): 摩擦点扩到 F1-F15 —— 新增 F6 书签跨章串位(升为候选 R4-1)、
  F8 关应用位置不落盘(并入 R1-1)、F11 切章锚点串章(并入 R1-1)、F13 重试失败句丢 profile(升为
  候选 R5-1)、F14 profiles 表从未被 UI 写(F13 的根因之一)、F15 单书"开始阅读准备"依赖会话内存
  batch_id(升为候选 R6-1, 若复现应 P0/P1)、F16 向导第 5 步硬编码"已就绪"且第 4 步 scan 不
  register(与 R3-1 同根, 修 R3-1 时一并核对向导)。另有 R2-1 的 UX 边界: sync_status 不返回
  已配置 URL, 前端无法展示"断开的是哪个 Worker"。
- **本轮实测验证(2026-08-08 运行结果)**: 在含 R0-R4 未提交改动的工作区跑了全部测试与门禁项 ——
  `sync_schema.ps1 -Verify` 通过(contracts/ 与 prep/schemas/ 一致, R4 的 images schema 已正确同步)、
  pytest 154 全绿、`cargo test --release -- --test-threads=1` 121 全绿、vitest 39 全绿、
  `cargo clippy --release -p aidulc` 恰 8 条警告(与 CLAUDE.md 基线 8 精确一致, 分布也吻合:
  job_orchestrator.rs×3 / library_service.rs×1 / commands/library.rs×1 / commands/models.rs×1 /
  sync_service.rs×1 / commands/reader.rs×1)、`cargo fmt --check` 干净、**css:no-raw-hex 门禁通过**
  (tokens.css 之外无裸 hex, 本会话补跑了这一项)。
  门禁基线成立。另实测了侧车预览链路:`cli.py --preview-book contracts/fixtures/sample_book/alice_sample.epub`
  正确产出 title/health(chapter_count/sentence_counts/toc_source/anomalies)/chapters JSON,
  与 `library_preview` 的解析约定一致(R3.3 端到端通);`--pymupdf-version` 实测输出 1.28.2。
  **还实测确认了 F19**: 用与 Cargo.toml 相同的 reqwest 配置(无 TLS feature)建 scratch 工程,
  https 请求返回 `error sending request` —— 下载链路在 TLS 层必断, 已升为 R3-1 第一必修项。
  memory/pipeline.md 记录的旧测试计数(126/100/32)已过期, 本会话已更新。
  实测补充(F1-F42 中实测确认的 F 项): F5(schema 归一化不合法)、F19(reqwest 无 TLS)、
  F21(词典查询每次 5.7-7.4s, 根因=每次重载 2.4GB 模型)、F22(侧车/便携 6.3GB)、F36(便携版整体
  过期, 旧前端+旧侧车)、F37(便携版 config.toml 开发机残留); 外加 R4 compat、全门禁 8 项、
  preview 链路(0.44s)、LLM 推理(3.2s 加载/0.7s 两行)与 TTS(45.8s 加载)吞吐。
  其余静态取证 —— 交互模块无自动化测试(见 F9), 需实现会话先在 exe 复现。

## 书籍资产模型(阶段 A，待用户确认)

### 领域定义

本需求把“用户导入的原文件”和“由它生成的可阅读成品”定义为两类不同资产，不能继续用一张
混合实体表和两个 `kind` 值表达。

- **原书(source)**：用户导入的 EPUB、PDF 或 TXT 文件本身。
  - 属性：标题、源文件路径、语言、导入时间。
  - 原书不可阅读，因此没有 `pack_dir`、阅读进度或书签。
  - 原书是 edition 的父资产；同一本原书可以关联多个 edition。
- **译本/成品(edition)**：针对某本原书执行一次备料产生的可阅读资产。
  - 每个 edition 独占一个 `pack_dir`，不能与原书或其它 edition 共用。
  - 每个 edition 有独立的阅读进度和书签。
  - edition 的生成参数组合由以下字段共同确定：`profile`、目标语言、LLM 模型、TTS 模型、
    NLP 模型。参数快照必须能随 edition 展示和复核，不能只依赖当前全局模型绑定。
  - edition 必须明确指向一个 source；不能通过“原书 id 等于自身”或其它自指关系伪造父子关系。

### 关系与用户可见行为

- 书库应呈现“1 本原书 → N 个译本/成品”的层级关系，而不是两个互不相关的平铺列表。
- 原书卡展示原文件信息和其下的 editions；edition 卡展示可阅读状态及其 profile、目标语言和模型
  参数差异。
- 打开阅读只能打开 edition，不能打开 source。
- 删除 edition 只影响该 edition：删除其阅读进度、书签、相关备料任务引用及其独占的 `pack_dir`；
  同一 source 的其它 editions 必须仍可打开阅读。
- 删除 source 的级联范围取决于下方待确认决策；无论采用哪种策略，删除后都不得留下指向不存在
  source 或 edition 的 `reading_state`、书签、`jobs` 等悬空引用。
- 应提供孤儿清理或启动自检，处理历史数据中已经存在的悬空 `reading_state` 和 `jobs` 行，避免
  书库为空时启动仍尝试打开已删除的 pack。

### 已确认的产品决策

1. **同一 source 使用完全相同的生成参数组合再次备料：覆盖原 edition。**
   - 相同参数组合代表同一个逻辑成品，不制造用户无法区分的重复 edition。
   - 保留稳定的 edition 身份，生成完成后以原子方式替换其 `pack_dir`；不能先删旧成品再写新成品。
   - 阅读进度和书签默认保留。若新书包无法解释旧状态，必须在替换时明确清理并向用户反馈，不能静默
     留下悬空或误指向的数据。
2. **删除 source：级联删除全部 editions。**
   - 同时删除各 edition 的阅读进度、书签、任务引用和独占 `pack_dir`。
   - 删除完成后不得留下指向该 source 或其 editions 的悬空 `reading_state`、书签、`jobs` 等记录。

### 阶段 A 边界与后续验收

本阶段只冻结上述领域定义和两个决策，不修改现有 `books` 数据、不执行迁移、不改变前端或 Rust
行为。阶段 B 评估拆分为 `books`(source) 与 `editions`(edition) 两张表，
分别设置唯一写入 repo，设计可逆迁移和级联删除测试。

阶段 B/C 的真实 exe 验收至少包括：导入一本 source、用两组不同参数生成两个 editions 并看出差异；
删除一个 edition 后另一个仍能阅读；按确认的 source 删除规则清理全部关联且无悬空行；冷启动及人为
后端失败时不出现空白页。

## 决策记录(本轮对每条的最终判定)

### 采纳

| 编号 | 判定 | 理由(一句话) |
|---|---|---|
| R1-1 | 采纳, P0 | 直接破坏"继续上次阅读"这一天天用的核心流; 已核实为真实时序 bug(loadChapter 未 await) |
| R1-2 | 采纳, P1 | 渲染器已有该能力(atomic_block saved-bubble), 只是没人喂数据; 前端小改, 价值直接可见 |
| R2-1 | 采纳, P1 | 同步 token 一旦配置无法撤销, 用户被锁死在同步状态; credentials.rs 已有 delete_cf_token, 只差出口 |
| R2-2 | 采纳, P2 | 3 个 `#[allow(dead_code)]` + 2 处 TODO(未接线) 是"被替代的死代码", 删比接线更诚实 |
| R3-1 | 采纳, P2(窄范围) | 模型下载确实无 UI 出口(相对 subgen 的倒退), 但完整异步下载器是大特性, 本轮只接最小闭环 |
| — | **R3-1 优先级复核**: 2026-08-04 用户分析把"一键下载"列为 P0 且至今唯一未兑现(见 R3-1 用户角度)。范围仍是"最小闭环"(进度条另立), 但**优先级建议从 P2 提到 P1** —— 它同时卡着新用户 onboarding(F16 向导假承诺)与 F19/F4 两个实测硬伤 |

### 深化补充(2026-08-08 源码取证, 三条采纳需求各补一处原文未覆盖的边界)

| 需求 | 新证据(文件:行) | 判定 |
|---|---|---|
| R1-1 | `_restoreState` 里 chapter 不一致时 `await this._loadChapter()` 后又走回 setPosition 判断(reader_view.js:253-269), 但二次加载的音频也还没就绪 → 位置仍丢; 且恢复位置后 `anchorIndex` 仍是 -1, 按全局播放键从句 0 播 | 修复必须覆盖第二条路径 + 设置 anchorIndex(见任务卡) |
| R1-2 | `add_to_vocab` 的 lemma = 词面小写(dictionary_service.rs:163), 书包 segments 的 lemma 是 spaCy lemma(atomic_block.js:98 只查 seg.lemma) → 保存的词即使词面相同也不高亮 | 匹配集合必须含 lemma+word 双键(见任务卡) |
| R2-1 | `sync_status` 的 configured = url 非空 && token 非空(sync_service.rs:51), 只删 token 状态机已回 unconfigured, 但 config.toml 残留旧 URL, 日后重配 token 会复活旧地址 | 断开必须同时清 config.toml 的 cf_worker_url(见任务卡) |

### 推迟

| 项 | 依据 | 理由 |
|---|---|---|
| 虚拟滚动 | ROADMAP P4 | 无新证据证明分帧渲染不够用, 保持"实测不够再立项" |
| findSentenceIndex 缺 audio 二分带偏 | ROADMAP P4 + timeline.test.js:79-97 | 生产书包有静音占位 audio(B3), 不触发; 测试已锁定行为防止回归 |
| explain 逐句批量化 | ROADMAP P4 | 改 prompt 有回归风险, 收益是性能不是正确性 |
| 字号/间距令牌存量迁移 | ROADMAP P4 | 独立工作量, 每处要核视觉, 风险收益单独评估 |
| explain 失败句无限重试 | ROADMAP P4 | 有意的产品决策(需要"补"), 加上限需要先定产品规则 |
| 阅读器内单句失败重试 | atomic_block.js:167 注释 | prep 页已有任务级"重试失败句", 单句重试要新 command + 产品决策, 不在本轮 |
| 双击书签死交互 | atomic_block.js:48-50 vs reader_view.js:226 | 行为无害(点了没反应), 是否接成书签取决于后续 UX 决策, 不占本轮 |

### 明确不做 / 被驳回

- **不做 SRS 复习流**: vocab_repo.rs:10 注释自证"aidulc v1 不做复习, 保留给 aidu 扩展",
  用户复习走 CF 同步到 aidu。硬做是范围扩张, 驳回。
- **不调 clippy 基线数字**(铁律)。
- **存量 3 本书不重跑**(铁律); 若未来用 Hitchhiker's 做回归, 必须用 R3.1 之后 loader 重处理
  (BASELINE.md 已警告旧书包分章错乱)。

## 优先级清单(按 价值/代价 排序, 每条含双维度四字段)

### R1-1 修复阅读位置恢复竞态(打开书总是从句首开始) — P0

**用户角度**
- 痛点: 读到第 180 页关掉, 再打开从第一章句首开始, 每次都要手动拖回原处。
- 价值: "继续上次阅读"是精读场景的基本承诺, 位置丢了就是"这本书没记住我读到哪"。
- 验收: 真 exe 里打开 Wolf 21 → 播到某章中段 → 退出重启应用 → 再开同一本: 回到原章且
  播放位置落在保存句(词级高亮正确落句), 连续 3 次全过。**先复现"位置丢失"再验修复**。

**技术角度**
- 落点: `reader/views/reader_view.js:242`(loadChapter 未 await) + `:269`(audio 就绪前
  setPosition 被 `if (this.player.audio && ...)` 拦住)。
- 路径: 让 `player.loadChapter` 返回可 await 的就绪 Promise; `_restoreState` 等音频就绪 +
  `loadedmetadata` 再 `setPosition`。首屏渲染不受影响(音频本就后台加载)。
- 风险: 仅前端; 不碰 contracts/存量书包。低风险。
- 证据: `player.js:83-104` 分块读取(大章几十次 IPC)完成后才赋 `this.audio`(`player.js:108`);
  `_restoreState` 首个 await 是单次 `reading_get`, 必然先返回 → audio 恒 null。

### R1-2 生词已存高亮(已入生词本的词在正文可见) — P1

**用户角度**
- 痛点: 背过的词在正文里和没背过的一样, 精读时总在重复查已经会的词。
- 价值: 一眼看出"这个词我记过了", 把注意力留给真正生疏的词。
- 验收: exe: 阅读器中把某词加入生词本 → 返回书库重开该书 → 该词在正文以 saved-bubble
  样式区别于普通词; 生词本删除该词后重开不再高亮。

**技术角度**
- 落点: `reader/views/reader_view.js:222` 渲染时 `savedSet: new Set()` 恒空;
  `atomic_block.js:98` 高亮逻辑(`if (savedSet.has(lemma))`)存在但从未收到真实数据。
- 路径: `open()` 加一次 `vocab_all(profileId)` IPC → 构建 lemma 集合喂给渲染器。
- 风险: 仅前端; 量级可忽略; 与词典面板"已在生词本"语义一致。不碰 contracts。
- 证据: 前端自证功能半成品(saved-bubble 代码在、数据恒空)。

### R2-1 CF 同步增加"断开同步"出口 — P1

**用户角度**
- 痛点: 同步一旦配置就无法撤销; 用户换机器/不想同步时被锁死, 只能删配置文件。
- 价值: 主动可控的同步开关, 是"我的数据我做主"的基本权利。
- 验收: exe: 配置同步 → 点"断开同步" → 状态回"未配置"; **重启应用后 `sync_status` 仍为
  未配置**(证明 token 真删, 不是只清内存)。

**技术角度**
- 落点: `settings_view.js:126-165` 同步区只有 保存/立即同步/拉取, 无断开;
  `credentials.rs:30 delete_cf_token` 写了测试但零 command/前端调用。
- 路径: 新薄 command(仅删 token + 清内存态, 不写 DB 表, 不违反存储所有权) + 设置页按钮;
  token 在 Windows Credential Manager, 与 config.toml 的 URL 分开清。
- 风险: 低。需确认断开后 job/sync 状态机不残留"已配置"标记。
- 证据: `#[allow(dead_code)]` + TODO(未接线) 自证无出口。

### R2-2 删除被替代的 3 个未接线函数(死代码清理) — P2

**用户角度**
- 价值: 用户无直接感知, 但减少维护负担 → 未来改动的回归风险下降(间接价值)。
- 验收: `scripts/check.ps1` 全绿; grep 确认 3 个函数无残留引用; exe 里向导仍在未完成时
  弹出(不回归)。

**技术角度**
- 落点: 删 `wizard_service.rs::is_done`、`model_service.rs::bundle_complete`、
  `model_service.rs::book_bundle_complete` 及对应测试。
- 路径: 纯删代码 + 移除 `#[allow(dead_code)]` 与 TODO(未接线)。TODO 从 7 处降到 3 处
  (profile 单条查询、ipc/registry 测试清单属"为测试存在", 保留)。
- 风险: clippy 基线不升(基线 8 是参数个数警告, 与死代码无关)。
- 证据: 向导判定已由前端 `main.js:45-55` 实现; `model_service.rs:53/174` 注释自证
  "可能与 preflight_check 重复", 而 `:183 preflight_check` 确已覆盖。

### R3-1 模型下载最小闭环(窄范围) — P2

**用户角度**
- 痛点: 模型中心只有"扫描/登记", 没有模型时无法下载, 新用户卡在"缺翻译引擎/缺语音引擎"。
- 价值: 从"买了工具不会用"到"照着模型中心点两下就能开始读"。本轮回合不做进度条, 但
  "下载→自动登记→preflight 通过"的主链路必须闭环。
  **(优先级依据)2026-08-04 的用户需求分析(archive/USER_NEEDS_ANALYSIS.md)就把
  "组件中心不暴露技术路径, 改为'需要下载 → 一键下载'的纯用户界面"列为 P0** —— 这是
  唯一一条至今仍未兑现的 P0 用户需求; R3-1 + F16 就是它的落地。其余 P0/P1(P0 向导/
  失败可读, P1 词典弹窗/生词本页/书签面板/同步入口/书库搜索)均已实现。
- 验收: exe: 模型中心点"下载"已知小模型 → 完成后自动出现在列表且带"推荐"徽章 → 导入一本书
  preflight 不再报"缺翻译引擎/缺语音引擎"。

**技术角度**
- 落点: `model_service.js:32` download 无任何视图调用; `downloader/mod.rs:97/108` URL 构造
  仅测试引用; `commands/models.rs:130 models_download` 注册了但无 UI。
- 路径: models_view 加"下载"按钮 + 至少一张已知模型 URL 表(硬编码); 下载完成后自动
  `models_register`。**接线前必修硬伤**: `commands/models.rs:139` 固定 `timeout_secs=60`
  且是 reqwest blocking —— GB 级模型整个下载必超时, 须先改为按规模动态
  (比照 pack.py 的 `max(300, total_sec/55+120)` 思路)。
- 风险: 下载是阻塞调用, 大文件短暂卡 UI —— 本轮接受(与现状一致), 异步 + 进度留"以后"。
- 证据: 全仓 grep 仅 `model_service.js:32` 一处引用; 超时 60s 对 GB 级模型是必然失败路径。

### R4-1 书签跨章串位(候选, 静态取证待实测) — 待复现后定 P1/P2

**用户角度**
- 痛点: 在某章打了几个书签, 切到下一章, 看到新章里同序号的句子被标成书签高亮, 书签面板
  也列出无关句子 —— 书签"串位"到别的章。
- 价值: 书签是精读的锚点, 串位比没有书签更误导。
- 验收(先复现): exe 里任意 ≥2 章的书: ch1 打 2 个书签 → 切 ch2 → **复现** ch2 同序号句被
  高亮/面板列出错句; 修后: 切章书签清零或按 (chapter,index) 语义恢复, 面板只列本章书签。

**技术角度**
- 落点: `reader_view.js:222`(`bookmarkIndices: this.bookmarks.bookmarks` 每章原样传) +
  `_switchChapter`(:285-291)/chapter 下拉(onSelectChapter)不清书签集;
  `bookmarks.js` 单 `Set<句下标>` 无章维度; `reading_repo.rs` 存 `{chapter, bookmarks[]}` 一行/书,
  数组与单 chapter 配对 —— 前端 Set 生命周期跨章, `_saveProgress` 会把旧章下标连同新 chapter
  一起覆写回存储。**所以不只是视觉串位, 是书签数据损坏**: 在 ch1 打书签 → 切 ch2 再存 →
  ch1 的书签数组被"ch2 的下标"覆盖, 切回 ch1 书签丢失。
- 路径(未定, 实现会话按产品语义选一): (a) 切章清空 Set(书签=当前章句序, 最简单, 与现有存储
  语义一致); (b) 书签改为 (chapter, index) 键(需要改 reading_state 存储语义 + 面板/恢复逻辑,
  改动更大)。推荐先 (a), 但需产品确认"书签是否应随书保留、跨章可见"。
- 风险: 纯前端; 不碰 contracts。改 (b) 才碰存储语义。
- 证据: 静态取证(路径完整但未在 exe 实测), 先复现再修, 符合"实测为准"纪律。

### R5-1 重试失败句保持原 profile(候选, 静态取证待实测) — 待复现后定 P1/P2

**用户角度**
- 痛点: 用"陪小孩读"(deep 讲解/慢速/特定音色)跑的书有失败句, 在备料台点"重试失败句"后,
  重试的句子用回了默认音色/速度/浅讲解 —— 同一本书里两种音色, 且孩子听的难度变了。
- 价值: "重试"应是"补做没做成的部分", 而不是"换一套设置重做"。
- 验收(先复现): kid profile 跑一本书留几个失败句 → 重试失败句 → 观察新生成的音频/讲解用的是
  kid 的音色/速度/deep 策略还是默认的 af_heart/1.0x/brief。

**技术角度**
- 落点: `job_orchestrator.rs:515-521 job_retry_failed` 重造 job_request 时 profile 硬编码
  `brief/af_heart/1.0/sentence`; 原 `job_dir/job_request.json` 仍保留原始 profile 快照(正确来源),
  但被丢弃; profiles 表从未被 UI 写(F14), 也不能当来源。
- 路径: `job_retry_failed` 改为读原 `job_dir/job_request.json` 的 profile 字段复用(保留原始
  快照语义), models 仍按现状从注册表 resolve(那是已修的语义)。
- 风险: 低; 纯后端小改; 不碰 contracts。
- 证据: 源码取证(硬编码 profile 一目了然; 原 job_request.json 在 job_dir 未删), 未 exe 实测。

### R6-1 单书"开始阅读准备"的 batch_id 依赖会话内存(候选, 静态取证待实测) — 待复现后定 P0/P1

**用户角度**
- 痛点: 一本书导入后当天没处理, 第二天重开应用点"开始阅读准备" → "开始失败: 批次不存在",
  书卡着没法处理; 一次导入多批时, 后面点的书都归到最后一批, 批次统计错乱。
- 价值: "导入→稍后处理"是基本工作流, 不能因重启就断。
- 验收(先复现): 导入一本书不处理 → 重启应用 → 点"开始阅读准备" → **复现**"批次不存在";
  修后: 能正常入队。另: 同会话导入两批, 分别点两批的书 → 各自归各自的批次。

**技术角度**
- 落点: `library_view.js:233 _startPrepForBook` 用 `this._lastBatchId || 伪造新 id`;
  `job_orchestrator.rs:188 batch_start_prep` 对不存在批次直接 Err; `books` 表无 batch_id 列,
  书↔批次关联只存在于前端会话变量。
- 路径(候选): (a) 书卡按钮不依赖导入批次, 自建/复用单书批次(简单, 但丢失"同批统计");
  (b) books 表加 batch_id(存语义, 改 schema v10 + 前端查询); (c) batch_start_prep 对不存在批次
  自动建。需产品定"批次"对用户是否有意义。
- 风险: 改 (b) 碰 store 层(schema_migrations +1)+ 存储所有权表新增列, 属中等改动。
- 证据: 静态取证(路径完整, batch_repo.get 的 Err 分支明确), 未 exe 实测。

## 可执行任务卡(供实现会话, 2026-08-08 深化)

> 在优先级清单的双维度基础上, 补全"涉及文件 / 改动要点 / 边界条件 / 验收步骤"。
> 括号内行号为工作区 R0-R4 未提交改动的当前代码, 若 R0-R4 已提交后行号漂移, 按文件名+函数名定位。

### 任务卡 R1-1 修复阅读位置恢复(接优先级清单 R1-1, P0)

- 涉及文件: `reader/views/reader/player.js`(loadChapter)、`reader/views/reader_view.js`
  (`_loadChapter` :242、`_restoreState` :248-272)、`reader/main.js`(关应用落盘, 见改动要点 5)。
- 改动要点:
  1. `player.loadChapter` 在 `audio` 触发 `loadedmetadata` 时 resolve, 并把该 Promise 存为
     `player.audioReady`(每次 loadChapter 重新赋值), 供宿主 await。
     **细化(2026-08-08 复查 player.js 后)**: `audioReady` 必须在 loadChapter **开头**创建为一个
     Promise, 并在**所有出口**都 resolve —— 成功路径(loadedmetadata)、分块读 error 路径
     (player.js:100-103 现在直接 return, 不设任何状态)、音频 error。若只在成功路径设置,
     失败时 `_restoreState` 的 `await this.player.audioReady` 是 `await undefined`(立即 resolve),
     位置恢复会静默跳过(不挂死, 但丢位置)—— 语义上仍要保证"音频失败时恢复降级为只恢复章节/
     书签, 不 setPosition", 靠 await 后的 `this.player.audio` 判空兜底。
  2. `_loadChapter` 里 `this.player.loadChapter(ch)` **保持 fire-and-forget** —— 大章分块读取要
     几十次 IPC, 若 await 会拖慢首屏渲染(这正是当前设计选择, 不要顺手改成阻塞)。
  3. `_restoreState` 在确认 chapter 后先 `await this.player.audioReady`, 再 `setPosition(pos)`,
     **同时把 `player.anchorIndex` 设为 `AiduTimeline.findSentenceIndex(this.sentences, pos)`**。
     (新发现)不加 anchorIndex 的话, 位置虽然恢复了, 但用户按全局播放键仍会从句 0 播, 等于没恢复。
  4. 复用既有 `_generation`/`_chapterGen` 竞态防护: await 期间切章/离开则丢弃恢复。
  5. **(新发现, F8)** 补"关应用时落盘": 全仓无 beforeunload/pagehide, 连续播放中直接关窗口
     位置不会存(只存了上次暂停点)。在 `main.js` 挂 `pagehide`(或 `visibilitychange(hidden)`)
     处理器: 若当前在 reader 路由, flush `_saveProgress()`。**不做这条, 只修竞态, "退出重启
     回到原句"仍会在"播放中直接关窗口"场景下失败。**
     **实现时先验证平台行为**: WebView2(Windows)窗口关闭时 `pagehide`/`visibilitychange` 是否
     可靠触发未保证 —— 若实测不触发, 备选: 播放中每 ~10s 落盘一次(interval), 或 Tauri 侧
     `on_window_event(CloseRequested)` 时经 invoke 触发最后一次保存。
  6. **(新发现, F11)** 顺带修"切章后锚点串章": `player.anchorIndex` 在 loadChapter/切章时
     不重置, 全局播放键会播旧章下标(越界误报"音频尚未就绪")。`_loadChapter` 里随新章
     `anchorIndex` 归零(或按新章合法范围钳制)。
- 边界条件:
  - 保存的 chapter 与当前不一致时 `_restoreState` 已会先 `await this._loadChapter()`(已有), 但
    该次加载后仍需重新 await audioReady 再 setPosition —— 这是需求原文没写、代码里真实存在的
    第二条路径(reader_view.js:253-256)。
  - `pos` 为 0 / null → 跳过 setPosition(0 意味着从头, 不必跳)。
  - `audioReady` 必须在音频 `error` 时也 resolve(损坏文件不能挂死 `_restoreState`); B3 保证生产
    书包每句都有静音占位 audio, 正常路径必触发 loadedmetadata。
  - 词级高亮在恢复句正确落词已由 renderer.highlightAt 的 `ensureRendered` 兜底(reader_renderer.js
    :263-265), 无需额外处理。
- 验收步骤: exe 里开 Wolf 21 → 播到某章中段(记下句子)→ 退出应用 → 重开同一本 → 回到原章、
  位置落在保存句、按全局播放键从该句续播; 连续 3 次全过。**先复现"位置丢失"再验修复**
  (现状下大章几乎必然丢 —— 恢复路径 `if (this.player.audio && ...)` 在 audio 就绪前恒 false,
  小章可能恰好赶上就绪, 但就算 audio 就绪, `loadedmetadata` 未触发时 setPosition 也是空操作,
  所以"复现即成功"的预期是绝大多数情况)。补一条边界验收: **播放中直接关窗口**(不暂停)→ 重开 →
  仍回到保存句(验证 F8 落盘路径)。
- 风险: 仅前端; 不碰 contracts/存量书包; 低。

### 任务卡 R1-2 生词已存高亮(接优先级清单 R1-2, P1)

- 涉及文件: `reader/views/reader_view.js`(`_loadChapter` :221 `const savedSet = new Set()`)、
  `reader/components/atomic_block.js`(:98 saved-bubble 匹配)。建议新增 `reader/core/` 纯逻辑模块
  承载"生词条目 → 匹配集合"的构建(零 DOM, 可单测, 符合 core/ 纪律)。
- 改动要点:
  1. `open()` 里拉一次 `AiduDictionaryService.vocabAll(profileId)`(`vocab_all` 已注册,
     commands/reader.rs:196; 返回 `Vec<VocabEntry>`, 每项有 lemma 和 word), 构建匹配集合。
     **时序细化(2026-08-08 复查)**: renderer.render 在 `_loadChapter` 内被调用并收 savedSet
     (reader_view.js:222), 所以 vocab 拉取必须在 `_loadChapter` 之前完成 —— 放在 `settings_get`
     之后、`_loadChapter` 之前 await; 或与章节加载并行、在 render 前把 Set 传入。拉取失败
     (生词本接口报错)应降级为"空 Set"(与现状一致, 不阻断章节渲染), 不要因为生词拉取失败卡住
     打开书。
  2. **(新发现, 本次取证)lemma 对不上**: `add_to_vocab` 写入的 lemma = `word.trim().to_lowercase()`
     (词面, dictionary_service.rs:163), 而书包 segments 的 lemma 是 spaCy NLP lemma
     (如 "became" 的 seg.lemma = "become")。atomic_block:98 只查 `savedSet.has(seg.lemma)`
     → 即使保存了 "became", 正文里 "became" 也不会高亮。**修复必须在匹配集合同时放每条生词的
     lemma 和 word(双键)**, atomic_block 对 seg.lemma 与词面任一命中即高亮; 匹配逻辑抽到
     core/ 纯函数并配单测覆盖"变位形式"(saved "became" → 高亮 "became", 不要求高亮 "become",
     那是 NLP lemma 归一, 属另一档产品决策)。
  3. 集合喂给 renderer 的 savedSet(renderer 已支持, reader_renderer.js:53/178)。
  4. **(新发现, F32)接 onVocabAdded 钩子做即时高亮**: dictionary_panel.js 的 `onVocabAdded`
     (加词成功后回调)声明了但无人赋值。接上它: 加词后把该词并入当前 renderer 的 savedSet
     (或重渲当前章), 让"刚加入的词"立刻在正文高亮, 不必等重开书 —— 否则 R1-2 的验收
     ("加入生词本 → 重开 → 高亮")只覆盖重开场景, 会话内即时反馈缺失。
- 边界条件: 生词表为空 → 行为与现状一致(全不高亮); profileId 取 bookpack.profile.id(default
  兜底), 与词典面板一致; 删除生词后重开不再高亮(每次 open 重新拉取, 天然满足); 高亮样式走
  tokens(勿裸 hex)。
- 验收步骤: exe: 正文点 "became" → 加入生词本 → 返回书库重开该书 → "became" 在正文以
  saved-bubble 样式区别于普通词; 生词本删除该词后重开不再高亮。
- 风险: 前端小改; 不碰 contracts/后端; 低。数据量级忽略(生词几百到几千条)。

### 任务卡 R2-1 CF 同步断开出口(接优先级清单 R2-1, P1)

- 涉及文件: `src-tauri/src/commands/reader.rs`(新 command)、`src-tauri/src/services/credentials.rs`
  (`delete_cf_token` :32 已有)、`src-tauri/src/services/config.rs`(写 config.toml 复用)、
  `src-tauri/src/ipc/registry.rs` + `src-tauri/src/main.rs`(登记新 command)、
  `reader/services/sync_service.js`(加 disconnect 用例)、`reader/views/settings_view.js`
  (同步区 :126-165 加"断开同步"按钮 + modal 确认)。
- 改动要点:
  1. 新薄 command(建议名 `sync_disconnect`): (a) `delete_cf_token()`; (b) 清内存态
     `AppServices.cf_token` 与 `cf_worker_url` 两个 Mutex; (c) **重写 config.toml 清空
     `cf_worker_url`**(复用 sync_config_set :276-285 的读→改→写模式)。
     (新发现)只删 token 也能让 `sync_status` 回 unconfigured(`configured = !url.is_empty() &&
     !token.is_empty()`, sync_service.rs:51), 但 config.toml 残留旧 URL 会在用户日后重新配 token
     时"复活旧地址", 语义不干净 —— 断开必须两处都清。
  2. 状态机无需改: `status(false, _)` → unconfigured 已覆盖(sync_service.rs:21-27)。建议断开时
     同时清进程内 `LAST_SYNC`(OnceLock, 防断开后旧 synced 时间残留展示, 现 fn status 已忽略,
     但清理更干净)。
  3. 前端: 断开按钮仅在 configured 状态可点; 成功后同步区状态刷新为"未配置"。
     (UX 边界) `sync_status` 不返回已配置的 URL(get_status 结构, sync_service.rs:50-62), 前端
     无法展示"当前连的哪个 Worker" —— 断开确认弹窗只能提示"将移除同步配置"。可选增强: status
     返回 masked url 供展示, 本轮不强求。
- 边界条件: 不写任何 DB 表 → 不违反存储所有权; 断开后重启验证(验收核心); `sync_config_set`
  已有 `create_dir_all`/写文件失败容忍语义可参考, 断开写 config.toml 失败应返回错误让用户知道
  (token 已删但 URL 没清干净)。
- 验收步骤: exe: 配置同步 → 设置页点"断开同步" → 状态回"未配置"; **重启应用后 sync_status
  仍为未配置**(证明 token 与 URL 都真删, 不是只清内存); 点"立即同步"提示未配置。
- 风险: 低; 跑 `cargo test --release -- --test-threads=1` 确认 credentials 与 sync 测试全绿。

### 任务卡 R2-2 删除被替代的死代码(接优先级清单 R2-2, P2)

- 涉及文件: `src-tauri/src/application/wizard_service.rs`(删 `is_done` + 相关测试断言)、
  `src-tauri/src/application/model_service.rs`(删 `bundle_complete`/`book_bundle_complete` + 对应测试)。
- 改动要点: 纯删 + 移除 `#[allow(dead_code)]` 与 TODO(未接线)注释。
  **注意**: wizard_service 的测试 `initial_state`/`step_advance_and_done` 里用了 `is_done`,
  删函数时同步删这两处断言; `get_state`/`set_step` 仍被 wizard commands 用, 不能删。
- 边界条件: clippy 基线 8 是参数个数警告, 与死代码无关, 本任务不碰; TODO(未接线)总数 7 → 5
  (profile 单条查询、ipc/registry COMMANDS 属"为测试存在", 保留)。
- 验收: `scripts/check.ps1` 全绿; grep 三个函数名全仓零残留引用; exe 里向导未完成时仍弹出
  (前端 wizard_state 判定不回归)。
- 风险: 低; 纯删代码, 但删的是被测试覆盖的函数, 删测试断言时注意别误删 get_state/set_step 的
  覆盖(wizard commands 依赖它们)。

### 任务卡 R3-1 模型下载最小闭环(接优先级清单 R3-1, P2, 窄范围)

- 涉及文件: `src-tauri/src/commands/models.rs`(`models_download` :130-142)、
  `src-tauri/src/infrastructure/downloader/mod.rs`(URL 构造已存在)、
  `reader/views/models_view.js`(加"下载"按钮)、`reader/services/model_service.js`(`download` 用例已有 :32)。
- 改动要点:
  1. **(新发现, F19, 实测确认)第一必修项不是超时, 是 TLS**: `Cargo.toml:15` reqwest 配了
     `default-features=false` + `["json","blocking"]`, **没有任何 TLS feature** —— 用同一配置的
     scratch 工程实测, https 请求直接 `ERR: error sending request`。HF/GitHub 全是 https,
     不补 TLS 后端, 超时修了也下不动。先在 Cargo.toml 给 reqwest 补 `native-tls`(或
     `rustls-tls`), 再谈超时。
  2. **接线前必修硬伤(次项)**: `models_download` 固定 `timeout_secs=60`(commands/models.rs:139)
     且 reqwest blocking —— GB 级模型整个下载必超时。改为按目标规模动态超时(比照 pack.py 的
     `max(300, total_sec/55 + 120)` 思路), 或在模型元数据带预估大小。
  3. models_view 加"下载"按钮 + 至少一张已知模型 URL 表(硬编码, 复用 downloader 的
     github_release_asset_url/hf_resolve_url); 下载完成后自动 `models_register`(命令已存在)。
  4. **(F16 顺带核对)** 向导第 4/5 步与下载缺口同根: 第 5 步硬编码"已就绪"、第 4 步 scan 到
     文件不 register(wizard_view.js:127-168)。接完下载后, 向导第 4 步应改为命中即
     `models_register` 或明确"去模型中心登记/下载", 第 5 步用 `components_health`/`models_list`
     渲染真实状态 —— 否则新用户仍被"自动就绪"承诺误导。本轮可只修第 4/5 步文案/行为, 不扩成
     向导内嵌下载。
- 边界条件: 下载是阻塞调用, 大文件短暂卡 UI —— 本轮接受(与现状一致), 异步 + 进度条/断点续传
  UI 留"以后"(downloader 已支持 .part 续传 + sha256, 只是 UI 不给进度); 下载目标目录 =
  "扫描已有模型"用的同一目录(runtime_config 的 llm_model 是文件路径, 取其父目录作为模型目录,
  与 models_view._scanAndRegister 的推导一致; 或配置的 model_dir)。
  **推荐徽章细节(本次取证)**: `model_service.rs:62-72 register` 仅在"该家族+语言尚无 active 模型"
  时自动置 active。所以"下载→自动登记→带推荐徽章"只对新用户(无任何已装模型)成立; 若该家族已有
  active 模型, 下载的模型不会自动带徽章(需手动"设为推荐")—— 验收文案按此限定, 不要写成无条件。
- 验收: exe: 模型中心点"下载"已知小模型 → 完成后自动出现在列表(新装时自动带"推荐"徽章) →
  导入一本书 preflight 不再报"缺翻译引擎/缺语音引擎"。
  (链路已实证: `preflight_check` 经 `resolve_for_book` 读书级绑定→全局推荐,
  model_service.rs:212-222, `register` 置 active 后此链闭合, 无需改后端)
- 风险: 中; ① 动 Cargo.toml(reqwest 加 TLS feature)触发全量重编 + 侧车无关但便携版要重打包
  (F36); ② 下载是阻塞调用, 大文件短暂卡 UI(接受); ③ 涉及后端(命令/超时)+ 前端(models_view),
  改后跑 check.ps1 全量确认。

## F1-F42 处置总表(2026-08-08, 全部取证于 docs/ARCHITECTURE.md §9.5/§9.7-9.10)

| 编号 | 一句话 | 严重度 | 处置 |
|---|---|---|---|
| F1 | book_id 构造规则双端复制(规范化不同) | 低(巧合一致) | 死表面审计 |
| F1b | 副词性小品词 prt 漏检(仅测试注释记录) | 低 | 记录, 暂缓 |
| F2 | 服务层纪律不统一(settings_view 直连 bridge) | 极低 | 记录 |
| F3 | 绕过路由裸 hash 跳转 | 极低 | 记录 |
| F4 | models_download 固定 60s 超时 | 中(GB 必超时) | R3-1 任务卡 |
| F5 | job_request 归一化产出不合法(实测) | 低(被 preflight 挡) | 死表面审计 |
| F6 | 书签跨章串位 + 覆写存储 | 高 | 候选 R4-1 |
| F8 | 关应用位置不落盘 | 高(配合 R1-1) | R1-1 任务卡 |
| F9 | 交互模块零自动化测试 | 低(范围取舍) | 记录 |
| F10 | JS 内联 hex 绕过 css 门禁 | 极低 | 记录 |
| F11 | 切章播放锚点串章 | 中 | R1-1 任务卡 |
| F12 | 导入对话框只给 3/6 格式 | 低 | 记录 |
| F13 | 重试失败句丢 profile | 高(kid 用户) | 候选 R5-1 |
| F14 | profiles 表从未被 UI 写 | 中 | 死表面审计 |
| F15 | 单书"开始准备"batch_id 依赖会话内存 | 高(重启断) | 候选 R6-1 |
| F16 | 向导第 5 步假"已就绪" | 高(误导新用户) | R3-1 任务卡 |
| F17 | 无调用方命令面 | 低 | 死表面审计 |
| F18 | 书设置弹窗错误分支死代码 | 低 | 顺手可修 |
| F19 | reqwest 无 TLS, https 必失败(**实测**) | **高(阻断 R3-1)** | R3-1 任务卡第一项 |
| F20 | 开发机绝对路径残留(comic-gen) | 低 | 记录, 移出生产 |
| F21 | 词典 LLM 查询每次 5.7-7.4s(**实测**) | **高(核心交互)** | 常驻复用/更小模型/异步 |
| F22 | 侧车/便携 6.3GB(**实测**) | 中(交付成本) | 以后优化 |
| F23 | 两个死配置字段 | 极低 | 死表面审计 |
| F24 | JS 引用但 CSS 未定义类 | 极低 | 记录, 可做 lint |
| F25 | 儿童模式对 kid 书无效 | 中(用户可见) | 顺手可修 |
| F26 | CSP 未放行 data: 拦 R4 插图 | **高(若实测成立)** | 待 exe 复现, P0/P1 |
| F27 | .aidu-data 备份/恢复命令零 UI | 中(用户需求未兑现) | 接 UI 即兑现 item 9 |
| F28 | progress schema 的 stage_failed 死事件 | 极低 | 契约卫生, 顺手删/实现 |
| F29 | 契约漂移测试不校验参数名 | 中(缺保护层) | 测试增强, 后续 |
| F30 | library_open 未接线,"最近阅读"无数据源 | 中(用户需求未兑现) | 打开书时调 library_open |
| F31 | nlp 分句构建逻辑双份实现(batch/单句) | 低(漂移风险) | 单句版改调共享函数 |
| F32 | onVocabAdded 钩子未接线,加词不高亮 | 中(配合 R1-2) | R1-2 任务卡点 4 |
| F33 | prep_view 监听离开不注销,冗余拉取 | 低(性能) | render 时对称清理 |
| F34 | 拖拽导入监听累积,可能重复导入 | **高(若实测成立)** | 存 unlisten 注销 |
| F35 | 预览失败原因被 stderr 丢弃 | 中(错误可读性) | stderr 接 pipe 读原因 |
| F36 | 便携版整体过期,缺 R0-R4 全部改动(实测) | **高(交付缺口)** | 整体重新打包便携版 |
| F37 | 便携版 config.toml 是开发机残留(实测) | **高(交付缺陷)** | 打包用干净默认 config |
| F38 | bookpack 只存 profile 身份,prep 配置不进书包 | 低(数据保留) | 记录; 印证 F13 修法来源 |
| F39 | 孤儿 CSS: word-panel 块 + .prep-task-log | 极低(死代码) | 删(确认非拼接类名) |
| F40 | word_lookup 失败兜底文案误导(实测) | 中(错误可读性) | 区分未配置/查询失败 + 读 stderr |
| F41 | fire-and-forget 写操作不检查结果(×4) | 低(静默丢变更) | 加 .catch 提示保存失败 |
| F42 | plugin:opener 未注册,"打开日志文件"退化为复制路径 | 中(功能失效) | 装 opener 插件或改走原生 |
| F43 | legacy product 可能共享同一 pack_dir，v18 尚未物理复制历史目录 | 高(违反 edition 独占资产) | 迁移时复制/校验 pack_dir，待处理 |
| F44 | jobs 旧记录只能按路径回填 edition_id，无法匹配的历史任务需人工/孤儿策略 | 中(历史关联不完整) | 启动孤儿清理已接入，保留可追溯记录策略待完善 |

## 实现会话执行顺序建议(2026-08-08, 把任务卡串成可排程的序列)

> 依赖与冲突原则: 同一文件的改动尽量集中; 候选缺陷先复现再立项; 每步结束跑一次
> `scripts/check.ps1`。R3-1 动 Cargo.toml, 会触发全量重编, 排后。

1. **提交 R0-R4 未提交改动**(docs/requirements.md 现状快照已说明) —— 新改动不混入未提交基线。
   **提交后立即整体重新打包便携版**(F36/F37 实测: 便携版 aidulc.exe + sidecar 都是 R0-R4 之前
   构建, config.toml 是开发机残留): 先 `cargo build --release`(嵌新前端)→ `scripts/build_prep.ps1`
   (打包侧车)→ 组装便携版(干净默认 config.toml)。**这一步是 R0-R4 交付的必要前提**,
   不是可选项 —— 否则用户跑的仍是旧前端+旧侧车。
2. **R1-1 阅读位置恢复**(P0, 纯前端): 先 exe 复现"位置丢失" → 按任务卡 6 个改动要点
   (audioReady / 二次路径 / anchorIndex / 竞态 / F8 pagehide 落盘 / F11 锚点归零) → 验收含
   "播放中直接关窗口"。纯 reader/ 文件, 不碰其它层。
3. **R1-2 生词已存高亮**(P1, 纯前端): 任务卡含 lemma+word 双键。可与 2 同批(都只动 reader/)。
4. **R2-1 同步断开**(P1): 新 command + 设置页按钮。动 commands/reader.rs + main.rs/registry +
   settings_view/sync_service, 不碰其它表。
5. **R2-2 删死代码**(P2, 后端): 删 wizard_service::is_done + model_service 两个 bundle_complete。
   **排在 R3-1 前**: R3-1 也动 model_service, 先删后改避免同文件改两遍。
6. **R3-1 模型下载最小闭环**(P2): 按任务卡顺序 —— ① Cargo.toml 补 reqwest TLS(**F19, 第一必修,
   先验证 https 能连); ② 动态超时(F4); ③ models_view 下载按钮 + URL 表 + 自动 register;
   ④ 向导第 4/5 步核对(F16)。改完 Cargo.toml 后全量重编 + 全量测试。
7. **候选缺陷复现(不实施, 只验证)**: R4-1 书签跨章(≥2 章书, ch1 打书签→切 ch2)、
   R5-1 重试丢 profile(kid profile 留失败句→重试→听音色)、R6-1 重启后"开始阅读准备"
   (导入不处理→重启→点按钮)、F26(CSP 拦图: 打开含图的书看正文图)、F34(拖拽重复导入:
   访问书库 3 次→拖一本书)、F25(开儿童模式→读 kid 书看字号)。
   任一复现成功即按对应优先级补任务卡, 失败则记录"未复现, 暂缓"。
   **F21 已是实测确认**(词典查询 5.7-7.4s), 修法候选: 常驻词典服务/更小模型/异步, 属 P1 性能项,
   不占复现环节。
8. **低优先级债(按精力决定, 不排硬截止)**: 其中**"死表面审计"**是一个可合并的 P4 清理包 ——
   本次已取证的一类问题同根: 表面在、消费在别处或没有。包括 F5(job_id 死字段 + 误导性归一化)、
   F14(profiles 表从未被 UI 写)、F17(library_register/start_prep_job/batch_start/profile_upsert
   等无调用方命令 +    bookmarks_list/transfer_export/import/boot_ping 零字面量)、F23(cf_namespace/
   model_dir 死配置字段)、F28(progress schema stage_failed 死事件)、外加本次核对的
   bookpack.models 写死快照(pack.py:131 写, 前端/Rust 都不读)、prepVersion 写死戳、
   `format_job_failure`(errors.py, 注释说"供 Rust UI 和 Python CLI 共用措辞"但只有测试引用)、
   Store 的 4 个死 state 字段(store.js: settings/profiles/jobs/ready, 全前端零读取, 只用
   books/currentBook)、`ReaderSettings.font_family`(schema 有字段但 CSS 无 var、UI 不可设、
   阅读器不应用, 恒 serif)、`bookpack.profile.name`(F38, 前端只读 .id)、
   `SyncError`(errors.py, prep 从不 raise —— 同步是 Rust 侧; format_job_failure 也不处理它,
   落到通用分支)、各阶段"已取消"EngineError raise 点(§5.1: cancel() 回调未接线, 恒不可达)——
   一次审计把这些面的"谁在消费、是否该删/该接/该标 deprecated"定下来, 比逐条零散修更省。
   其余 F1/F2/F3/F9/F10/F12/F18/F20/F21 单独评估。

## 本轮不做什么(及理由)

- **不引入 SRS 复习流**: 设计上复习走 aidu 同步, 见决策记录。
- **不碰 P4 各项**(虚拟滚动/null-audio/批量 explain/令牌迁移/无限重试): 无新证据, 维持原判。
- **不做单句重试、不接双击书签**: 需要产品决策或已有覆盖, 见决策记录。
- **不把 R3-1 扩成异步下载器**: 进度条/断点 UI 是独立大特性, 与"最小闭环"分开, 避免过设计。
- **不动 R0-R4 未提交改动**: 那批是既定交付, 与需求精化无关, 由实现会话先提交再开工。
- **不处理架构摩擦点 F1-F42**(book_id 双端复制 / NLP 局限 / 服务层惯例 / 绕路由 / 下载超时 /
  job_request 契约卫生 / 书签串位 / 位置落盘 / 测试覆盖 / JS 内联 hex / 锚点串章 / 导入格式 /
  重试 profile / profiles 表空架子 / 单书批次会话内存 / 向导假"已就绪" / 无调用方命令面 /
  书设置弹窗死代码分支 / **reqwest 无 TLS 后端(实测)** / 开发机绝对路径残留 / 词典冷启动超时 /
  **侧车 6.3GB 体积(实测)** / 死配置字段 / JS 引用但 CSS 未定义的类 / **儿童模式对 kid 书无效** /
  **CSP 未放行 data: 可能拦 R4 插图** / **.aidu-data 备份恢复命令零 UI** / **progress schema
  stage_failed 死事件** / **契约漂移测试不校验参数名** / **library_open 未接线"最近阅读"无数据源**
  / **nlp 分句构建逻辑双份实现** / **onVocabAdded 钩子未接线** / **prep 监听不注销** /
  **拖拽导入监听累积** / **预览失败原因被 stderr 丢弃** / **便携版整体过期(实测)** /
  **便携版 config.toml 是开发机残留(实测)**):
  已记录到 `docs/ARCHITECTURE.md` §9.5(及 §9.7-9.10)。F4/F19 已并入 R3-1 任务卡(F19 是接线前
  第一必修项); F6/F11 并入 R1-1/R4-1 任务卡; F13/F15 单列为候选 R5-1/R6-1; F16 与 R3-1 同根
  (下载缺口 + 向导承诺), 修 R3-1 时一并核对向导第 4/5 步文案与行为; F22 列"以后优化"; F25 是
  用户可见 UI 交互缺陷(开儿童模式读 kid 书"没变"), 顺手可修; **F26 若 exe 实测成立, 会让 R4
  插图功能整体失效, 应优先(P0/P1)**; F27 是"生词备份/迁移"用户需求(USER_NEEDS item 9)的未接线
  后端, 接 UI 即可兑现该需求; 其余留低优先级债。
- **不修 R4-1/R5-1/R6-1(本轮只登记, 不实施)**: 都是静态取证、未 exe 实测, 先由实现会话复现再立项
  (见优先级清单 R4-1/R5-1/R6-1)。R6-1 若复现成立应升级 P0/P1(阻断"导入→稍后处理"主流程)。

## 下一步 3 件事(供实现会话直接开工)

> 完整改动要点/边界/验收见上方"可执行任务卡"节。这里只留一行动态口令。
> 完整执行顺序(含 R2-2 先于 R3-1、候选复现、低优先债)见"实现会话执行顺序建议"节。

1. **R1-1 阅读位置恢复** (P0): 按任务卡 R1-1 —— player.audioReady + _restoreState 二次路径 +
   anchorIndex 跟随; 先在 exe 里复现"位置丢失"再修。验收 = 重启后回到保存句且播放键从句续播, 连续 3 次。
2. **R1-2 生词已存高亮** (P1): 按任务卡 R1-2 —— vocab_all 构建 lemma+word 双键集合喂 savedSet
   (勿忘 lemma 不匹配坑)。验收 = 已存词面在正文带 saved-bubble 标记。
3. **R2-1 同步断开** (P1): 按任务卡 R2-1 —— sync_disconnect 清 token + config.toml URL + 内存态,
   设置页按钮。验收 = 断开后重启仍为未配置。
   (紧跟其后:R2-2 删死代码 → R3-1 模型下载 —— 优先级已从 P2 建议提到 P1, 见决策记录与
   R3-1 用户角度; R3-1 先修 F19 TLS 与 F4 超时, 见任务卡。) 
