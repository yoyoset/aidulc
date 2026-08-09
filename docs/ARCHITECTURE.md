# aidulc 架构记录

> 本文件记录**实测验证过的现状**(源码取证 + 运行/测试结果), 不是设计意图的复述。
> 与 `CLAUDE.md`(强制规约)、`docs/requirements.md`(需求账本)、`memory/pipeline.md`
> (流水线踩坑)互为引用。发现现状与本文件矛盾时, 以现状为准并回来改本文件。
> 初次建立: 2026-08-08 (本会话在 R0-R4 未提交改动基础上取证, 对应 commit 916534b + 工作区 R0-R4)。

---

## 1. 系统构成(三端 + 契约)

```
┌────────────────────────────── WebView 前端 (reader/) ─────────────────────────────┐
│ index.html + main.js (入口/路由/向导拦截)                                           │
│  app/router.js, app/store.js                                                       │
│  views/  (library / products / prep / models / settings / vocab / wizard / reader) │
│    reader/ 模块化子目录: topbar / player / chapter_loader / bookmarks / search     │
│  services/*.js  用例层: library / model / misc / sync / reading / settings /       │
│                      dictionary / import / job  (只调用 AiduBridge, 不直连 __TAURI__)│
│  ipc/bridge.js  唯一 Tauri invoke/listen 出口 (3.7 安全边界)                        │
│  components/  atomic_block / reader_renderer / dictionary_panel / modal / toast     │
│  core/         纯逻辑零 DOM: timeline / shadow / search_index / render_plan         │
│  styles/       tokens.css(令牌唯一来源) + app/reader/prep/...                       │
└──────────────────────────────────┬─────────────────────────────────────────────────┘
                                   │ Tauri IPC (invoke) —— 命令注册在 main.rs
                                   │ generate_handler!, 审计在 ipc/registry.rs
┌────────────────────────── Rust 外壳 (src-tauri/) ─────────────────────────────────┐
│ main.rs         启动顺序 + 全部 command 注册 + AppServices/PrepConfig/PrepState     │
│ commands/       薄壳: jobs / library / models / reader / misc                     │
│ ipc/commands.rs 设置/Profile/阅读状态/传输命令 (M 系列归位)                          │
│ application/    编排: job_orchestrator / model_service / library_service /         │
│                  dictionary_service / sync_service / transfer_service /           │
│                  book_transfer_service / wizard_service                             │
│ store/          每表唯一写者 repo: books/jobs/batches/vocab/dict/profile/reading/  │
│                 settings/model + store_mod.rs(Db, schema_migrations)               │
│ domain/         bookpack(版本门) / vocab(aidu 契约 normalize) / sync(合并)          │
│ infrastructure/ dir_migration / aidu_worker_client(CF 同步) / downloader / log /    │
│                 model_store/scan                                                    │
│ jobs/           job_guard(作业对象) / progress / spawn(侧车子进程)                  │
│ services/       config(Config.toml) / credentials(Windows Credential Manager) /    │
│                 components(健康检查)                                                 │
└──────────────────────────────────┬─────────────────────────────────────────────────┘
                                   │ 子进程 spawn + job_request.json + progress 行流
┌────────────────────────── Python 侧车 (prep/) ────────────────────────────────────┐
│ cli.py          命令入口 (--preview-book / --pymupdf-version / job 执行)           │
│ core/           errors(EngineError→quality_report) / models / quality / schema(    │
│                 JSON-Schema 轻量校验) / word_alignment / pos_map                   │
│ pipeline/       runner(编排) → loader(epub/pdf/txt → 章节/句子)                    │
│                 → nlp(分句+lemma+segments) → llm(translate/explain)               │
│                 → tts(kokoro 词级时间轴) → align → pack(合并音频+写 bookpack)        │
│ infra/checkpoint.py  逐句 checkpoint, overwrite_sentence(冲突路径专用)             │
│ schemas/        contracts/ 的打包拷贝(唯一同步源, 见 §3)                            │
└────────────────────────────────────────────────────────────────────────────────────┘
```

依赖方向(只允许向下/向右):
- `reader → services → ipc/bridge → [Tauri command]`; views 不得直连 `window.__TAURI__`(bridge.js 注释)。
- `Rust: commands → application → store/domain/infrastructure`; store 不得反向依赖 application。
- `prep: cli → pipeline → loader/nlp/llm/tts/align/pack`; 各阶段只吃 checkpoint, 不读 UI 状态。
- `core/*.js` 零 DOM 依赖(用 `window=globalThis` shim 单测, 见 `reader/tests/setup.js`), 改动配对 `reader/tests/*.test.js`。

## 2. 存储所有权(强制)

来源 `CLAUDE.md`。每张表只允许一个 repo 写, 新代码不得绕过:

| 表 | 唯一写者 | 说明 |
|---|---|---|
| `vocab` | `vocab_repo.rs` | SRS 学习状态; aidulc v1 不做复习, 复习走 aidu 同步 |
| `dictionary` | `dict_repo.rs` | 个人词典资产(LLM 查询的沉淀缓存, 不自动进生词本) |
| `profiles` | `profile_repo.rs` | 讲解策略/音色/语速/高亮粒度 |
| `reading_state` | `reading_repo.rs` | 阅读进度/书签/播放位置 |
| `books` | `books_repo.rs` | 原书(source)登记；不承载可阅读成品 |
| `editions` | `editions_repo.rs` | 译本/成品(edition)及生成参数快照 |
| `reader_settings` | `settings_repo.rs` | 阅读器设置(字体/行距/宽度/主题/儿童模式) |
| `jobs` | `jobs_repo.rs` | 备料任务 |
| `batches` | `batches_repo.rs` | 批量任务 |
| `model_registry` | `model_repo.rs` | 模型绑定; **模型路径唯一真相源** |
| `wizard_state` | `application/wizard_service.rs` | **例外**: 唯一不走 store/*_repo.rs 模式、直接发 SQL 的表(现状, 改这里前先考虑补 wizard_repo.rs) |

跨表只读查询允许(如 `transfer_service.rs` 导出 `SELECT DISTINCT profile_id FROM vocab UNION ...`); 禁止跨 repo 写同一张表。
DB 模式演进: `store_mod.rs` 用 `schema_migrations` 表, 目前 19 个迁移版本(含 v18 的 source/edition 拆分和 jobs 显式 edition_id; v19 的 jobs 显式 source_id)。

### 迁移史(v1-v9, 摘自 store_mod.rs 注释, 2026-08-08 核实)

| 版本 | 内容 | 对应阶段 |
|---|---|---|
| v1 | 基础表(books/vocab/dictionary 等) | 初始 |
| v2 | books + reader_settings + jobs 表; vocab/dictionary 加 profile_id | P1/P3 |
| v3 | M1 AIDU 无损兼容: profile self→default 规范化; vocab 加 payload 列(存完整 canonical JSON, deepData/lastReview/浮点 interval 不丢) | M1 |
| v4 | batches 表 + jobs.batch_id | G2 |
| v5 | model_registry + wizard_state + books 语言/模型字段 | H1 |
| v6 | jobs.error 失败摘要(阶段+句数+原因) | I-C |
| v7 | books.kind: original(导入管理)/product(AI 成品可读); 存量 ready/partial→product | 架构分离 |
| v8 | books.source_book_id: 成品关联原书(不同模型=不同资产) | 资产模型 |
| v9 | jobs.progress: 后端算全书完成度(阶段权重 0-100) | 进度算法 |
| v18 | editions 表承载成品；legacy product 无损迁移；jobs 增加 edition_id | 书籍资产模型 |
| v19 | jobs 增加 source_id(显式关联原书, BOOK_WORKFLOW §2.3); 删除 source 按 source_id 级联清 job | 书籍主流程重构 |
| v20 | **身份模型 (V1)**: users 表 (默认 user "me"); vocab/dictionary/highlights 加 user_id 列并回填;
      vocab/dictionary key 改为 `{user}:{profile}:{lemma}`; reading_state/reading_daily 重建为含 user_id
      的复合主键。迁移不拆人(全部现有数据归一个 user), 事务内完成可回滚 | 背单词 STAGE-SRS |
| v21 | **来源定位 (V4)**: vocab 加 edition_id/chapter_index/sentence_index 列 (旧数据留空, UI 降级);
      加词时记录"从哪本书哪章哪句划出来的" | 背单词 STAGE-SRS |

## 3. contracts 三端链路

- **唯一真相源**: `contracts/*.schema.json` 三个文件 —— `bookpack.schema.json`(书包,
  `schemaVersion: 1`)、`job_request.schema.json`(备料请求)、`progress.schema.json`(进度行)。
- **同步**: `scripts/sync_schema.ps1` 拷贝到 `prep/aidulc_prep/schemas/`(侧车打包用);
  `-Verify` 做 SHA256 一致性校验, 接入 `scripts/check.ps1`(门禁第 1 项)。
  **坑(2026-08-07 补的缺口)**: 历史上只有拷贝脚本没有校验, 改 contracts/ 忘记同步,
  侧车静默拿旧 schema 校验, 只有 -Verify 能抓到。
- **消费方式**(三者不对称, 是实测现状):
  - Python: 运行时用 `core/schema.py` 的轻量 draft-07 子集校验器(draft 子集:
    required/type/const/enum/items/properties/$ref/allOf/if-then), 完整 jsonschema 库只用于测试期。
  - Rust: 运行时只做 `schemaVersion` 门(高版本明确拒绝, `domain/bookpack.rs`),
    其余字段靠 serde 结构体 + conformance 测试(`contracts/fixtures/sample_bookpack`)锁定, 不做运行时 schema 校验。
  - 前端: 直接消费书包 JSON 字段, 无 schema 校验(靠 Rust 侧结构与 `load_bookpack_chapter` 兜底)。
- **fixtures**: `contracts/fixtures/sample_bookpack/`(Rust/Python conformance 用)、
  `vocab_golden.json`(vocab normalize 契约)。
- **契约演进的"向后兼容"模式(实证)**: R4(2026-08-08)给 chapter 加 `images: [{file, at}]`
  可选字段 —— 老书包无此字段仍合法,**不升 schemaVersion**。契约的兼容策略是"只加可选字段、
  不改必填、不 bump 版本", 与 `domain/bookpack.rs` 的"高版本明确拒绝"配合:
  未来若出现必须破坏兼容的改动才升 schemaVersion。
  (2026-08-08 用 `validate_bookpack` 实测: 无 images 与有 images 校验结果一致, images 缺 `at`
  会报错 —— 向后兼容与字段约束都已验证。)

## 4. 启动顺序(main.rs, 实测)

1. `exe_dir` 解析(`current_exe().parent()`)。
2. `Config::load(&exe_dir)` → config.toml(`AIDULC_DB` 环境变量可换 db 路径)。
3. `Db::open` → 跑 schema_migrations。
4. `resolve_out_dir(exe_dir, cfg.out_dir, AIDULC_OUT)` —— 唯一书库路径解析
   (相对路径锚定 exe_dir, 环境变量显式时不加工)。**这是 2026-08-07 修的"书包在哪"根因**。
5. `resolve_prep_path` 四级探测(环境变量 → exe 同级 prep/ → 仓库 prep/dist → 兜底)。
6. 日志初始化 + 启动日志打印 exe_dir/prep_path/out_dir 及存在性。
7. `job_guard::init_child_job_object`。
8. 启动时 `reset_stale`(running→queued)+ 收集恢复队列。
9. 从 Windows Credential Manager 读 CF token。
10. `.manage()` 注入 Db / AppServices / PrepState / PrepConfig。
11. setup 回调: 卡 processing 的书恢复 pending + `pump_queue`(自动恢复队列)。
12. `generate_handler!` 注册全部 command(与 `ipc/registry.rs` COMMANDS 一致性有测试锁定)。

## 5. 数据流

### 5.1 导入 → 备料 → 成品(核心闭环)
```
前端拖拽/pick_files → batch_import(建批次 + 登记 books, kind=original, status=pending)
  → 书卡"开始阅读准备" → batch_start_prep → preflight_batch(模型/格式/ffmpeg)
  → application/job_orchestrator → jobs_repo 写 job → jobs/spawn 启动侧车子进程(CREATE_NO_WINDOW)
  → job_request.json(profile 快照 + 模型路径 resolve_for_book) → 侧车 cli.py
  → pipeline: loader → nlp → translate → explain → tts → align → pack
  → 每句 checkpoint 原子落盘; 进度行按 progress.schema 流式 emit
  → 产物 out_dir/jobs/<job_id>/<bookpack.json + audio + images>
  → 退出码/quality_report → Rust 侧 library_service 登记 product 书(kind=product)
  → 前端成品架可见可读
```
- 注: 导入走 `batch_import`; 单书 `library_register`/`start_prep_job`/`batch_start` 命令已注册但
  前端零调用(旧兼容面, 见 F17)。
- 大书关键路径: `load_bookpack` 只传元信息(每章 original_text), `load_bookpack_chapter`
  按需拉单章完整内容 —— 92MB 书包整传 IPC 卡死的修复(916534b)。
- **取消/暂停语义(2026-08-08 核对)**: Rust 侧 cancel_prep_job/job_pause 都是 `child.kill()`
  直接杀进程; 侧车的优雅 `cancel()` 回调从未接线(cli.py:126 建 Runner 不传 cancel → 恒
  `lambda: False`, 各阶段的 `raise EngineError("已取消")` 不可达)。正确性靠 checkpoint 兜底
  ("取消与意外中断效果相同, 重跑自动续上")——kill 即 checkpoint 保留, resume 续跑。

### 5.2 阅读(逐句)
```
reader open → load_bookpack(meta) → settings_get(profile) → _loadChapter
  → load_bookpack_chapter → renderer 渐进渲染(首屏 50 句 + IntersectionObserver 哨兵)
  → player.loadChapter 分块读音频(2MB/块, base64→Blob→ObjectURL) → 播放
  → rAF tick: timeline.findSentenceIndex/findWordIndex → highlightAt(词/句级)
  → pause/离开 → reading_save(reading_state: chapter/position_ms/bookmarks)
  → 打开恢复: reading_get → _restoreState(见 R1-1 任务卡, 当前存在竞态缺陷)
```

### 5.3 生词 / 词典 / 同步
```
点词 → atomic_block onBubbleClick → word_lookup(本地词典优先, 未命中 spawn 侧车
  dict-lookup LLM 补全 + 沉淀 dict_repo; 8s 超时兜底)
  → "+ 加入生词本" → add_vocab → vocab_repo(lemma = 词面小写, 非 NLP lemma —— 见 R1-2 注意)
  → sync_now/sync_pull → aidu_worker_client(CF Worker, token 在 Credential Manager)
  → 状态机 unconfigured|offline|synced|failed(上次结果存进程内 OnceLock, 不持久化)
导出: transfer_export(.aidu-data 词典+生词) / book_export(书包 zip, Stored 不压缩)
```

`.aidu-data` 格式(transfer_service.rs:55-62): `{version:3, timestamp, data:{vocab:{"vocab_<profile>":{lemma:VocabEntry}}, dictionaries:{"dictionary_<profile>":{lemma:payload}}}}`,
与 aidu v3 备份格式兼容; 导入按 updatedAt 合并(新者胜), 不覆盖本地更新的条目。
书包 zip(book_transfer_service.rs): 压缩方式 Stored(音频已是 Opus, Deflate 白费 CPU), 内含
bookpack.json + audio/ + images/; 导入时校验含 bookpack.json 才登记, `enclosed_name()` 防路径穿越。

## 6. 关键权衡与决策历史

| 决策 | 选择 | 理由/代价 |
|---|---|---|
| 书库位置变更 | 重启生效, 不热切换 | PrepConfig 是 Tauri 一次性 manage 的不可变状态; 热切换要包 Mutex 改遍所有读取点, 收益不成比例; 命令返回值带 restart_required:true |
| 大书加载 | 元信息 + 按需单章 + 分帧建 DOM | 虚拟滚动要重写 highlightAt/书签/搜索"所有句 DOM 已存在"假设, 留到实测证明分帧不够用再立项(P4) |
| 生词存储 | 以 payload 列为准的 canonical JSON | 兼容 aidu; 保留 deepData/lastReview/lastGrade/浮点 interval; 只有 SRS owner 能改 SRS 字段 |
| 模型路径 | model_registry 单一真相源 + resolve_paths | M 系列; 不再散落硬编码/全局变量; 运行时可解析 |
| 同步 token | Windows Credential Manager(keyring), 永不落明文 | 失败返回错误而非静默空 token, 避免"以为已配置实际没配置" |
| schema 校验 | Python 运行时轻量子集; Rust 只查版本 | 运行时性能 vs 完整校验; conformance 测试兜底字段级 |
| 下载超时 | models_download 固定 60s(现状缺陷, 见 R3-1) | GB 级模型必超时; 比照 pack.py 动态超时思路待修 |
| 进度/task | 串行队列 + job_guard + 恢复队列 | 任务死(进程被强杀)→ 恢复 pending/queued; 书卡 processing → pending |
| clippy | 基线 8 只降不升 | 3 个参数过多警告集中在 job_orchestrator 等; 真正清零要请求结构体重构(P3) |
| 语言结构 | `application/language_registry.py`: 语言是数据不是代码 | nlp 模型/tts 语言码/音色/提示词模板都是注册表条目; 未知语言/未实现语言 fallback 'en' + 明确警告(不崩溃)。en 已实现, ja 预留未验收 —— Rust 侧 misc.rs 也硬编码 "en 是当前唯一支持语言", 多语言接入 = 填 spec + 模型, 不改 pipeline |
| LLM/TTS 驻留 | 先停 LLM 再起 TTS(runner.py _tts_pack) | R5 实测 12GB 显存装不下两个同时驻留; 阶段切换先 `stop_server()` 释放显存 |

## 7. 踩过的坑(有源码/运行证据, 详见 memory/pipeline.md)

1. ffmpeg concat 645+ wav 卡死 → 每 100 个一批强制转 pcm_s16le; 大章 opus 超时是慢不是死
   → 超时 `max(300, total_sec/55 + 120)` + `.tmp.opus` rename("存在即完整"供跳过复用)。
2. ffmpeg 按扩展名推断 muxer: `ch.opus.tmp` 不可识别(退出码 -6) → 临时文件必须 `.tmp.opus`。
3. nlp 过滤碎片句改变句总数 → 位置 checkpoint 对齐风险 → `reconcile_position_checkpoint` +
   `checkpoint.overwrite_sentence`(合并语义 save_sentence 清不掉磁盘旧字段, 实测踩中)。
4. R0(2026-08-08): "改前端不生效"根因 = `generate_context!` 编译期嵌 `../reader` 但 cargo 不
   rerun-if-changed → build.rs 递归 emit; check.ps1 加 `cargo build --release` 让门禁蕴含 exe 最新。
5. clippy 计数在 PS 5.1 `2>&1` 管道下漏行(同代码跑出 8 和 7) → 改 cmd 文件重定向。
6. PS 5.1 + 中文注释 .ps1 必须 UTF-8 BOM(否则报错像语法错误实为编码)。
7. `cargo test` 并行因共享临时 DB 冲突假失败 → 必须 `--test-threads=1`。
8. 应用运行时 exe 被锁 → 构建前先关应用。
9. 书库路径: library_dir/out_dir 两个不同步概念合并为一个; components_health 盘空间检查误查
   library_dir 所在盘的副作用随合并消失。
10. EPUB2 toc.ncx(银河系真实撞见): 只认 nav.xhtml 会退化成 spine 每文件一章 → 1 句碎片章 +
    5351 句巨章; `_find_toc_source` 回退 toc.ncx + `_parse_ncx` 递归展平 navPoint。
11. **TTS 词时间轴 ↔ spaCy segments 对齐**(只在 `core/word_alignment.py` docstring, 未进
    memory/pipeline.md): Kokoro 一个 token 可能对应 spaCy 多个 segment
    ("daisy-chain" ↔ ["daisy","-","chain"]; "I've" ↔ ["I","'ve"]), 旧实现精确逐词匹配
    失败即 break → 该句后续全部丢时间轴(半句无高亮)。改为双指针顺序贪心(1 token 匹配
    1..N 连续 segment) + 按字符数比例切分时间区间 + 标点段缺失不视为失败。

## 8. 未接线清单(TODO(未接线), 2026-08-08 复核)

7 处标注中, 本次复核**真缺口剩 2 个**, 其余是"被替代的死代码"或"为测试而存在":

| 位置 | 状态 | 判定 |
|---|---|---|
| `credentials.rs::delete_cf_token` | 真缺口 | R2-1 采纳: 无 command/前端出口, 同步配置无法撤销 |
| `downloader/mod.rs::github_release_asset_url/hf_resolve_url` | 真缺口 | R3-1 采纳: 只有 URL 构造, 无下载编排调用方; 相对 subgen 倒退 |
| `wizard_service.rs::is_done` | 被替代 | R2-2 采纳: 向导判定已由前端 main.js:45-55 经 wizard_state 实现 |
| `model_service.rs::bundle_complete/book_bundle_complete` | 被替代 | R2-2 采纳: 注释自证"可能与 preflight_check 重复", preflight_check 已覆盖 |
| `commands/reader.rs` profile 单条查询(若有) | 为测试存在 | 保留 |
| `ipc/registry.rs` COMMANDS | 为测试存在 | 保留(审计清单本来就是给测试比对用) |

## 9.5 未写进任何文档的摩擦点(2026-08-08 源码取证)

- **F1 book_id 构造规则双端复制**: `commands/library.rs:12 book_id_from_path`(Rust)与
  `prep_view.js:164-167`("与 Rust book_id_from_path 同规则")各写一份。两条规则**规范化不同**:
  Rust 先 `to_lowercase()` 再把非字母数字替换为 `_`; 前端只做替换**不 lowercase**。
  两者目前巧合一致(产品书 id 取自 job 输出目录名 = `job-<ms>-<pid>-<n>`, 数字+连字符,
  规范化后两版结果相同)。job 目录名一旦出现字母/大写等, "打开书籍"按钮会静默算错 id →
  load_bookpack 失败。更干净的方案是 job 记录直接带 book_id 字段供前端取, 而不是前端重算规则。
  (注意: 现 `uuid_short()` 是 `{ms}-{pid}-{counter}` 数字串, 与 BASELINE.md 记录的存量目录
  `job-<timestamp>-<pid>-<n>` 同构 —— 目录命名其实没变过。)
- **F1b 已知 NLP 局限只写在测试注释里**: `prep/tests/test_loader_nlp.py:187-188` 记录
  "spaCy 把 away 标为 ADV(dep=advmod), 不触发 prt 短语检测 —— 副词性小品词依赖 prt 抓不到,
  v1 接受"。短语动词功能存在(atomic_block 有 linked-pv 连体), 但这类副词性小品词漏检是
  已知缺陷, 仅测试注释记录, 未进任何文档/ROADMAP。
- **F2 服务层纪律不统一**: `settings_view.js:204,224` 直连 `AiduBridge.settings.upsert`,
  而同一视图的读取走 `AiduSettingsService`(:167,185)。不违反"视图不得绕过 bridge"的硬规则
  (bridge.js 是唯一出口), 但破坏了"视图只调 services 层"的惯例(models_service.js 自述)。
  无行为差异, 属惯例债。
- **F3 绕过路由**: `prep_view.js:90-94` 与 `vocab_view.js:97` "去书库/去书库选书"用裸
  `window.location.hash`, 而 `router.navigate` 已支持同路由强制刷新(router.js:23-25)。
  可用 `router.navigate` 替代, 现实现只是工作得多。
- **F4 下载超时固定 60s**: `commands/models.rs:139` `models_download` 硬编码 60s,
  GB 级模型必超时 —— 已接 R3-1 任务卡, 列入架构欠账。
- **F5 job_request 契约两个卫生问题**(2026-08-08 取证, **已实测**):
  1. `job_id` 是 schema required 且侧车运行时校验(cli.py:119-123), 但侧车**从不读它**
     —— runner 只读 book_path/profile/models; 且 Rust 写的是 `job-<pid>`(spawn.rs:25,
     只有 pid), 与 jobs 表真实 id `job-<ms>-<pid>-<n>`(job_orchestrator.rs:20-24)不同。
     死字段 + 误导性取值。
  2. `build_job_request` 的两处"归一化"都产生**不合法**结果(2026-08-08 用
     `validate_job_request` 实测): 空 models 数组 → `{}` 缺 `models.llm/tts`(required)失败;
     字符串 profile → `{"id": s}` 缺 explain_strategy/voice/speed/highlight_granularity(required)
     也失败。正常流被 preflight 挡在门外(llm/tts 必配)且 profile 走前端 buildProfile 完整对象,
     所以不触发 —— 属"看起来在防御、实际没生成合法结果"的误导性归一化, 测试只断言了 shape
     没跑 schema。
- **F6 书签跨章串位(静态取证, 未 exe 实测)**: `bookmarks` 是单个 `Set<句下标>`, 在
  `reader_view.js:222` 每章渲染时都原样传给 renderer(`bookmarkIndices: this.bookmarks.bookmarks`),
  而 `_switchChapter`(:285-291)与 chapter 下拉切换都不重置/不按章隔离。书签的下标只在"保存时的
  那一章"有意义(reading_state 存 `{chapter, bookmarks[]}`, 下标与 chapter 配对), 一旦切章,
  旧章下标套到新章 → 新章错误高亮 + 书签面板列出错句。静态推断路径完整, 尚未在 exe 实测
  (需一本 ≥2 章的书: 在 ch1 打书签 → 切 ch2 → 观察 ch2 同序号句被高亮)。
- **F7 跟读状态机与书签交互契约**: 见 §9.6。
- **F8 阅读位置只在暂停/离开时落盘, 窗口关闭可能丢**(静态取证, 未 exe 实测):
  `_saveProgress` 只在 audio `pause` 事件(player.js:142)与 `cleanup`(player.js:238, 路由切走时)调用,
  全仓无 `beforeunload`/`pagehide`/`visibilitychange` 处理器。连续播放中直接关应用窗口,
  WebView 销毁时 audio 不会可靠触发 pause → 最终位置不落盘, 恢复的是上一次暂停的位置。
  与 R1-1(恢复竞态)是互补的两个缺口: 一个管"存下了怎么恢复", 这个管"关应用时到底存没存"。
  修复候选: main.js 挂 `pagehide`/`visibilitychange(hidden)` 时若在 reader 路由则 flush。
- **F9 阅读器交互模块零自动化测试**: `reader/tests/` 只有 5 个纯逻辑模块的测试
  (timeline/shadow/search_index/render_plan + setup), player/chapter_loader/bookmarks/search/
  topbar/atomic_block/reader_renderer/reader_view 均无测试 —— 靠浏览器手测。core/ 抽离正是为了
  让逻辑可单测; 交互模块引入 jsdom 才能测, 是明确的范围取舍(CLAUDE.md 已声明 core/ 才配轻量测试),
  记录在案而非遗漏。
  **Rust 侧同类**: commands 层(tauri 命令薄壳)无单元测试 —— 121 个测试集中在 store/domain/
  infrastructure/application 的纯逻辑层, 命令层只靠 `every_frontend_invoke_is_registered`(命令名
  漂移)与 exe 手测覆盖。因命令多为薄转发, 风险低, 但新增命令若带逻辑应下沉到 application 层(可测),
  不要在命令壳里写逻辑。
- **F10 JS 内联样式绕过 css:no-raw-hex 门禁**: `scripts/check.ps1` 的 `css:no-raw-hex` 只扫
  `reader/styles/*.css`, JS 里的内联 style 不覆盖 —— `reader_renderer.js:89`(`color:#999` 空态提示)、
  `library_view.js:293`(`var(--md-sys-color-error, #b3261e)` 带 hex fallback)是现存两例。
  低优先级(视觉无伤), 记录为令牌纪律的覆盖面盲区。
- **F11 切章后播放锚点不重置(静态取证, 未 exe 实测)**: `player.anchorIndex` 只在 `playFrom`
  里更新, `loadChapter`(player.js:69-144)与 `_switchChapter`(reader_view.js:285-291)都不重置。
  在 ch1 播到句 200 → 切到只有 30 句的 ch2 → 按全局播放键 → `playFrom(200)` → `sentences[200]`
  为 undefined → 误报"音频尚未就绪, 请稍候再试", 实际是锚点串章。与 R1-1 的锚点恢复同源,
  已并入任务卡(切章时 anchorIndex 归零/随新章重置)。
- **F12 导入对话框只给 3 种格式, 后端支持 6 种**: loader/preflight 支持
  epub/pdf/txt/mobi/azw3/fb2(loader/__init__.py:19 与 model_service.rs:200 一致), 但前端
  `pick_files(['epub','pdf','txt'])` + `fileInput.accept='.epub,.pdf,.txt'`
  (library_view.js:465,469) 把对话框过滤成 3 种。mobi/azw3/fb2 只能走拖拽导入, 按钮选不了。
  低优先级 UX 缺口。
- **F13 重试失败句用硬编码默认 profile(静态取证, 未 exe 实测)**: `job_retry_failed`
  (job_orchestrator.rs:515-521)重造 job_request 时 profile 写死
  `brief / af_heart / 1.0 / sentence`, 而不是复用原 `job_request.json`(job_dir 里仍保留)快照
  或查 profiles 表。→ 重试句的音色/讲解策略/速度/粒度与原始任务不一致: kid profile(deep +
  0.9x + 其它音色)重试后变成 brief + 1.0x + af_heart。数据保真缺陷。正确来源 = 原
  job_request.json 里的 profile 字段。
- **F14 profiles 表从未被 UI 写**: `profile_upsert`/`profile_list` 命令 + bridge 封装存在, 但
  全前端零调用(grep 证实); profile 只存在于 import_service.buildProfile 的内联构造 + 每个 job 的
  job_request.json 快照。CLAUDE.md 存储所有权表里的 profiles 目前是"空架子"。影响: 无 UI 能改
  voice/strategy(导入卡只选 id, 参数是 buildProfile 写死的); F13 也因此没法从表里取到真实 profile。
- **F15 单书"开始阅读准备"依赖会话内存 batch_id(静态取证, 未 exe 实测)**: `library_view.js:233`
  `_startPrepForBook` 用 `this._lastBatchId || 随机新 id` 当 batch_id。两个缺陷:
  (a) 同一会话导入多批 → 只有最后一批的 id 被记住, 所有书都归到它下面(批次统计错);
  (b) 重启应用后 `_lastBatchId` 丢失 → 伪造 `batch-<ts>-<rand>` → `batch_start_prep`
  `batch_repo.get(&batch_id).ok_or("批次不存在")`(job_orchestrator.rs:188) → 用户看到
  "开始失败: 批次不存在"。`books` 表没有 batch_id 列, 书↔批次的关联只存在前端会话变量里,
  重启即断。修复候选: 书卡按钮按需自建单书批次(不依赖导入批次), 或 books 表存 batch_id。
- **F16 向导第 5 步硬编码"已就绪", 与新用户真实状态脱节(静态取证)**: `wizard_view.js:153-168`
  `_stepDeps` 把 Qwen3-4B/Kokoro/spaCy/文档组件全部写成"已就绪", 文案"以下引擎会在第一次处理
  书籍时自动就绪" —— 但下载器零调用方(R3-1 现状), 没有任何"自动就绪"机制。第 4 步 `_stepModels`
  (wizard_view.js:127-151) scan 到的文件只展示、"将直接使用", **从不 register** —— 用户照向导
  走下去, 导入时照样 preflight 报"缺翻译引擎/缺语音引擎"。新用户被向导虚假承诺误导。修复方向:
  `_stepDeps` 用 `components_health`/`models_list` 真实状态渲染; `_stepModels` 命中即 `models_register`
  或明确提示"还需到模型中心登记/下载"。与 R3-1 是同一块地的两个坑(下载缺口 + 向导承诺)。
- **F17 一批注册了但无调用方的命令(grep 逐条核实)**: 71 条命令里, **16 条不是任何视图 UI 可达的**:
  - 全前端零字面量(4): `transfer_export`/`transfer_import`(并入 F27)、`bookmarks_list`、
    `boot_ping`(开发探针)。
  - 只在 bridge/service 封装里、无视图/组件调用(12): `library_register`、`start_prep_job`、
    `batch_start`(旧前端兼容)、`profile_upsert`/`profile_list`(并入 F14)、`dict_list`/
    `dict_search`/`vocab_search`/`vocab_stats`(词典/生词视图都走客户端过滤或 word_lookup)、
    `library_open`(并入 F30)、`read_audio`(player 只用 read_audio_range)、`models_recommend`
    (书设置弹窗用 models_by/list)。
  与 TODO(未接线)不同, 这些是"命令面在、无 UI 消费"的兼容壳, 不是死代码(删了可能破坏未来/旧
  调用方)。记录在案: 新增命令前先确认是否真的需要一个新的命令面, 而不是给已有薄封装再包一层。
  **服务层还有 14 个无视图调用的死方法**(2026-08-08 逐方法核对): import_service 的
  startPrep/startBatch/buildModels, job_service 的 importBooks(与 import_service.importBooks
  重复)/startBatch/startSingle/batchDetail, dictionary_service 的 list/search/vocabStats,
  model_service 的 recommend, library_service 的 open/readAudio —— 多数包着 F17 的死命令,
  job_service.importBooks 则是同一命令的重复封装。服务层"每命令一封装"纪律下, 重复/死封装
  应随 F17 一起审计。
- **F18 书设置弹窗"加载失败+重试"分支是死代码(静态取证)**: `library_view.js:366-371` 错误路径
  写 `body.appendChild(el('div','global-error', msg).textContent && null)` —— 表达式恒为
   `null`/空串, `appendChild(null)` 恒抛 TypeError → 落入下方 `.catch`(只显示泛化"加载失败"+e,
  无重试按钮), 真实后端错误详情与重试入口都丢失。修复: 直接 `body.appendChild(el('div','global-error', msg))`。
- **F19 reqwest 无 TLS 后端, https 下载必然失败(2026-08-08 实测确认, 非推断)**:
  `src-tauri/Cargo.toml:15` `reqwest = { features=["json","blocking"], default-features=false }`
  —— **没带任何 TLS feature**(native-tls/rustls-tls 都没加)。用同一 reqwest 配置建了 scratch
  cargo 工程实测:`https://huggingface.co/...` 请求返回
  `ERR: error sending request for url (https://...)`。所以 `downloader::download` /
  `models_download` 对 HF/GitHub 的 https 下载**在 TLS 层面就断了**, 即使修好 60s 超时也没用。
  这是 R3-1 接线前必须修的第一项(Cargo.toml 给 reqwest 补 `native-tls` 或 `rustls-tls`)。
  (补充: URL 构造测试不实际下载, 所以这个坑从未被测试暴露。)
- **F20 开发机绝对路径残留(2026-08-08 取证)**: `llm/server.py:28` 的 CUDA DLL 候选表含
  `r"F:\my_ai\comic-gen\.venv\Lib\site-packages\torch\lib"` —— 借 sibling 项目 venv 的 CUDA
  runtime。开发机上该目录存在会被 `add_dll_directory` 加入搜索路径(与打包产物 `_internal/cuda_runtime`
  并列), 若 comic-gen 的 torch 版本与 llama_cpp 不匹配可能加载错 CUDA runtime(实测没炸, 但脆弱);
  换机器上该路径不存在, `isdir` 检查跳过, 无害。**同型第二处**: `pack.py:49` 的 ffmpeg 兜底
  `F:\my_ai\subgen\dist\ffmpeg\...\ffmpeg.exe`(AIDULC_FFMPEG > job_request > PATH > 该兜底,
  换机器上该路径不存在则 raise "找不到 ffmpeg")。属"开发机借债"残留, 应移出生产代码
  (候选: 只走 AIDULC_FFMPEG/PATH, 开发期用环境变量覆盖)。
- **F21 词典 LLM 查询每次 5.7-7.4s(2026-08-08 实测, 非推断)**: `commands/reader.rs` 的
  `llm_dict_lookup` 每次点词都 spawn 一个新侧车子进程 → 重新加载 2.4GB LLM 模型。实测(本机,
  Qwen3-4B GGUF): 冷启动 7.4s、热(OS 页缓存)5.7s —— **每次查词用户都等 5-7 秒**。两个修正:
  ① 原 F21 担心的 8s 死线其实不兜底 —— `read_to_string` 阻塞读无超时, 死线只防"输出完不退出",
  慢查询会完成但用户白等; ② dict_lookup.py docstring 自称"单词查询 ~1-2s"只算了推理, 没算
  每次的模型加载。**打包侧车更慢**: 实测 `prep/dist/aidulc-prep` 的 dict lookup **8.6s**
  (冻结环境 + CUDA 初始化开销), 超过 8s 死线但不会被杀(阻塞读), 用户白等 8.6s。根因: 每次查询
  独立进程加载模型, 无常驻复用。修复方向(未定): 常驻词典服务(复用 llama server 单例)/ 换更小
  模型 / 查询异步化不让 UI 干等。这是核心交互(点词查义)的真实性能缺陷, 优先级应上调。
- **F22 侧车/便携版 6.3GB, torch 全量捆绑 + CUDA DLL 三重复制(2026-08-08 实测)**:
  `prep/dist/aidulc-prep` 与 `dist/aidulc-portable` 实测均 6.3GB。构成(build_exe.spec + 目录实测):
  - torch 全量捆绑 ~2.5GB: `torch_cuda.dll` 913MB + `torch_cpu.dll` 240MB + cuDNN 全家桶
    (`cudnn_engines_precompiled64_9.dll` 562MB + `cudnn_adv` 230MB + `cudnn_ops` 103MB +
    `cusparse` 263MB + `cusolver` 110MB + `cublas` 96MB)。根因: kokoro(TTS) import torch,
    PyInstaller 把 torch+CUDA 全量拉入, `excludes` 只排了 tkinter/matplotlib/PySide6。
  - `ggml-cuda.dll` 903MB(llama_cpp CUDA build, 真实推理成本)。
  - **重复浪费 ~1.35GB**: `cublasLt64_12.dll` 出现 3 份(torch/lib + _internal 根 + cuda_runtime),
    `cufft64_11.dll` 2 份 —— build_exe.spec 的 `_cuda_datas` 显式拷贝与 torch 自带库重复。
  影响: 便携版分发/更新 6.3GB; 磁盘占用高。优化方向(均有实测依据): ①去掉 `_cuda_datas` 显式拷贝
  (torch/lib 已有, 省 ~1.35GB); ②评估排除 `cudnn_engines_precompiled64_9.dll`(kokoro 小模型
  未必用 cuDNN, 省 562MB); ③换 llama_cpp CPU build 可省 903MB 但吞吐降 ~5x(Phase 0-A 实测
  17 vs 68-80 t/s), 需权衡。非紧急(本地运行), 属交付成本债, 列入"以后优化"。
  (便携版根结构干净: prep/ onedir + aidulc.exe + config.toml, 无根级重复 exe —— 早先误记的
  "根目录重复 aidulc-prep.exe"是 PowerShell -Depth 1 把 prep/ 内容平铺显示造成的, 已纠正。)
- **F23 两个死配置字段(grep 证实零读取)**: `config.rs:15 model_dir`(默认 "models")与
  `config.rs:19 cf_namespace` 只存在于 Config 结构体与 config.toml 里, 全仓无任何读取。
  `models_scan`/`hardware_detect` 的 model_dir 是**命令参数**(前端从 runtime_config 的
  llm_model 路径推导), 不走 Config; 同步只用 url+token, 不用 namespace。
  用户若手改 config.toml 的这两个字段会"改了个寂寞"——典型"登记了但没接线"残留。
  与 F14(profiles 表空架子)/F17(无调用方命令)/F5(job_id 死字段)同属一类: 代码库积累的
  "表面在、消费在别处或没有"的壳。清理候选: 从 Config 删除或标注 deprecated。
- **F24 JS 引用但全 CSS 未定义的类(2026-08-08 grep + 脚本全量核对)**: 系统审计(扫描全部 JS 的
  className 字面量 vs 全部 CSS)确认无"该有样式却没有"的视觉破坏 —— 未定义类全部无害:
  `render-sentinel`(reader_renderer.js:97, 内联 height:1px)、`chapter-loading`(reader_view.js:203,
  裸块占位)、`reader-container`(reader_renderer.js:57, 裸包装 div)、`models-view`/`vocab-view`
  (根包装, 子类 models-list/model-row/vocab-row 等已在 app.css)、`js-play-btn`(atomic_block.js:59,
  JS 选择器钩子, 本就不该有样式)。属"根类空壳"卫生债 —— 新增视图时若忘记给根类加样式,
  这类检查能提前暴露(可做 lint: JS 引用的 className 是否在任一 css 里出现过)。
- **F25 儿童模式对 kid 书无效(静态取证, 未 exe 实测)**: 设置页只读写 `'default'` profile
  (settings_view.js:167 硬编码 `AiduSettingsService.get('default')`, child_mode 开关也 patch 到
  'default'), 但阅读器按书 profile 读设置:`reader_view.js:71-73` 用 `bookpack.profile.id`
  ('kid' 书 = 'kid')调 `settings_get`, 且 `settings_repo.get` 对缺失 profile 返回**默认值**
  (settings_repo.rs:66-89, 18px/sentence/serif/light), **不回退到 'default'**。结果: kid 书永远拿
  默认 18px/句级高亮, 儿童模式开关对 kid 书零效果; 用户开儿童模式后读 kid 书发现"没变"。
  语义上: 阅读器设置(字号/主题/粒度)是用户级而非书级, 应按 'default' 读, 或缺失时回退 'default'。
  修复候选: reader_view 改为 `settings_get('default')`(最简单, 与设置页一致)或缺失时回退 'default'。
- **F26 CSP 未放行 `data:`, R4 插图可能整条被拦(静态取证, 未 exe 实测, 高置信)**: tauri.conf.json
  的 CSP 是 `default-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:` ——
  `img-src` 未指定, 回退到 `default-src 'self'`, **不含 `data:`**。而 R4 插图正是
  `imgEl.src = 'data:image/*;base64,' + b64`(reader_renderer.js:221,228, read_image 返回 base64)。
  WebView2 对 meta CSP 强制时, `data:` 图片会被拦截 → 正文插图全不显示。R4 链路"提取(实测
  Wolf 21 48 张全提取)→ 拷书包 → schema → read_image → 前端渲染"里,**前端渲染一环很可能被 CSP
  掐掉**。修复: CSP 加 `img-src 'self' data:`(media-src 已放行 blob: 同理, 图片走 data: 是现状)。
  需 exe 实测确认(打开含图的书看正文图是否显示)再定优先级。
- **F27 .aidu-data 备份/恢复命令零 UI 调用(2026-08-08 grep 全量核对)**: `transfer_export` /
  `transfer_import`(ipc/commands.rs, .aidu-data 词典+生词备份/迁移)注册了 71 条命令里, 但全前端
  **没有任何 invoke 字面量调用它们**。用户需求 USER_NEEDS_ANALYSIS.md item 9("存了几百个词怕丢 →
  需要生词本导出/备份")的后端入口因此未接线; 现有"生词本导出 JSON"(vocab_view.js:130)是前端
  纯客户端 Blob 下载, 不是 .aidu-data 格式, 也不能导入恢复。同类: `bookmarks_list`(前端走
  reading_get 取书签, 此命令死)、`boot_ping`(开发探针, 非产品功能)。
  这是 F17(无调用方命令面)的精确化: 71 命令里 4 个全前端零字面量(transfer_export/import、
  bookmarks_list、boot_ping), 另有 5 个只出现在 bridge/service 封装里但无视图调用
  (library_register、start_prep_job、batch_start、profile_upsert、profile_list)。
- **F28 progress schema 的 stage_failed 是死事件类型(2026-08-08 跨层核对)**: progress.schema.json
  的 `type` 枚举含 `stage_failed`, 但 prep 全仓不 emit(只有 stage_start/progress/done/sentence_done/
  job_done/error)、Rust `parse_progress_line` 也不解析(progress.rs 六分支无 stage_failed, 若收到会
  Err "未知事件类型")。三方里只有 schema 一方声明了它。无害(侧车从不发), 属契约卫生债 ——
  要么从 schema 删掉, 要么实现"阶段失败"语义让三方一致。
- **F29 契约漂移测试只校验命令名, 不校验参数名(2026-08-08 核实)**: `ipc/registry.rs:452
  every_frontend_invoke_is_registered` 只扫 `invoke('cmd'` 的第一参数(命令名), 不检查第二参数
  (args 对象)的键。Tauri 把前端 camelCase 键转成 Rust snake_case 参数 —— 若前端某个 arg 拼错
  (如 `bookID` vs `bookId`/`book_id`), 命令名测试照样绿, 但运行时会静默拿到 undefined → 参数默认值,
  行为错误且无报错。现状各服务层的 arg 名经抽查全部一致(bookId→book_id 等), 但**缺一层保护**:
  扩展该测试去比对 args 键(需把 COMMANDS 条目加上参数名清单)是后续增强, 属测试覆盖缺口。
- **F30 `library_open` 未接线 → "最近阅读"无数据源(2026-08-08 grep 核实)**: `library_open`
  (commands/library.rs:96) 更新 books.last_opened_at(books_repo.rs:160 的 touch), 但**全前端无
  视图调用它**(bridge.library.open 存在但没人用)—— 打开书籍走 store.currentBook + router, 不
  登记打开时间。结果 last_opened_at 恒 None, library_view.js 头部注释自称的"最近阅读"功能没有
  数据源。USER_NEEDS_ANALYSIS.md item 12 明确要求"书库...最近阅读排序"。修法: 打开书时调
  `library_open`(或把 touch 并进 load_bookpack)。同类: `read_audio`(单次整读)死命令, player
  只用 read_audio_range。
- **F31 nlp segments/短语构建逻辑双份实现(2026-08-08 核实)**: `nlp/__init__.py` 的
  `process_chapter_nlp_batch`(生产路径, nlp/stage.py:60 调用)走 `_sentence_from_spacy`(:59-88),
  而 `process_chapter_nlp`(单句版, 只被测试用)把这套逻辑**内联复制**了一份(:115-143)。两版内容
  相同但已漂移风险: 改一版另一版不跟着改, 测试就测不到生产路径的 bug。M 系列"提取公共逻辑"做了一半
  (batch 提取了, 单句没改)。修法: 单句版也调 `_sentence_from_spacy`, 删内联副本。
- **F32 `dictionary_panel.onVocabAdded` 钩子未接线(2026-08-08 grep 核实)**: dictionary_panel.js:12
  声明 `onVocabAdded`、:150 在"加入生词本"成功后调用, 但全仓无人给它赋值 —— 钩子写了没人接。
  影响: 阅读中加词入生词本, 当前章的 saved-bubble 高亮不会即时出现(要重开书才生效, 见 R1-2
  的 open() 拉取设计)。R1-2 实现时应接上这个钩子: 加词后把该词补进 renderer 的 savedSet
   (或重渲当前章), 让高亮即时可见。
- **F33 prep_view 事件监听离开页面不注销(2026-08-08 核实)**: prep_view.render 注册 4 个
  listen(job-progress/library-changed/job-list-changed/batch-progress), 只在**再次 render**时
  注销旧监听(prep_view.js:55), 路由切走时没有 cleanup(main.js 各路由只调 readerView.cleanup)。
  结果: 处理任务期间用户在其他页面, 每个 job-progress 事件仍触发 prep_view 的回调 → 对游离 DOM
  更新 + 可能整表重拉 job_list(冗余 fetch)。对比 readerView 有 cleanup(), prep_view 缺对称清理。
- **F34 拖拽导入监听每次 render 累积(2026-08-08 核实, 高置信)**: library_view.render →
  `_buildImportCard` 每次调用 `AiduBridge.listen('tauri://drag-drop', ...)`, **返回的 unlisten
  被丢弃**(library_view.js:456), 无任何注销。每次访问书库就多一个监听; 多次访问后一次拖拽会
  让所有监听都触发 `_startBatchImport(paths)` → 同一批文件导入多次(多个 batch)。需 exe 实测
  (访问书库 3 次 → 拖一本书 → 观察是否重复导入), 修法: 存 unlisten 并在 render 前注销
  (比照 prep_view.js:55 的模式)。
  **前提 caveat**: `tauri://drag-drop` 是 Tauri v1 的事件名; 本项目是 Tauri v2 且未配拖拽插件
  (Cargo.toml 无 plugin 依赖, tauri.conf.json 无 plugin 配置) —— v2 下该事件是否仍触发未验证。
  若 v2 不触发, 拖拽导入根本不会工作(与监听累积是两回事), 复现 F34 时先确认事件是否触发。
- **F35 预览失败原因被 stderr 丢弃(2026-08-08 实测)**: `library_preview`(library.rs:464-477)以
  `.stderr(Stdio::null())` 启动 `--preview-book` 子进程 —— 侧车失败时写人话原因到 stderr
  (实测:"不支持的文件格式: .md"/"EPUB 文件损坏", exit 1, 无 stdout JSON), Rust 端读不到,
  返回"预览无输出"。用户点"预览原文"失败时只见泛化错误, 看不到具体原因。修法: stderr 接
  pipe 并读最后一行并入错误信息(比照 dict_lookup 的超时兜底逻辑)。
- **F36 便携版整体过期, 缺 R0-R4 全部改动(2026-08-08 实测)**: `dist/aidulc-portable/` 的三个
  产物都是 R0-R4 之前构建 —— `aidulc.exe` 17:51(嵌入旧前端, reader_view.js 等 R0-R4 前端文件是
  08-08)、`prep/aidulc-prep.exe` 18:03(旧侧车)、`config.toml` 开发机残留(见 F37)。实测证据:
  ① 打包侧车 `--pymupdf-version` 报 `unrecognized arguments`(exit 2, R3.4 新增); ② 打包侧车
  `--preview-book` 输出**缺 `health` 字段**(R3.3 体检, 当前 cli.py 有); ③ 便携版 aidulc.exe 比
  当前 release build(24.1MB)小(12.6MB), 时间戳早于 R0-R4 前端改动。**用户跑便携版 = 旧前端
  (无模块化阅读器/渐进渲染/R4 插图) + 旧侧车(无 EPUB2 NCX/[[HEADING]]/插图提取/PyMuPDF 探测/
  体检 health) + 开发机配置**。后果: components_health 误报 pymupdf 缺失、预览不显示体检异常、
  处理旧格式书仍会分章错乱。**修法: 用 R0-R4 之后的代码整体重新打包便携版(前端已由
  generate_context 嵌进 exe, 需先 cargo build 再整包), 这是 R0-R4 交付的必要一步, 不是可选项。**
- **F37 便携版自带 config.toml 是开发机残留(2026-08-08 实测)**: `dist/aidulc-portable/config.toml`
  内容实测: `library_dir = "library"`(旧字段, 已并入 out_dir)、`model_dir = "models"`(F23 死字段)、
  `llm_model_path = "F:/hf_cache/Qwen3-4B..."`、`tts_model_path = "F:/hf_cache/..."`、
  `ffmpeg_path = "F:/my_ai/subgen/dist/ffmpeg/.../ffmpeg.exe"`。问题: ① 当前 Config
  (config.rs)只有 out_dir/model_dir/log_level/cf_worker_url/cf_namespace/ffmpeg_path,
  没有 llm_model_path/tts_model_path/library_dir —— 这些是旧字段, serde 忽略它们, 但
  **ffmpeg_path 被读到 → 换机器上指向不存在的 F:/my_ai/subgen 路径 → ffmpeg 组件误报缺失**;
  ② 泄露开发机目录结构(F:/hf_cache、F:/my_ai/subgen)。  修法: 打包时用干净的默认 config.toml
  (或打包前删掉, 首次运行生成默认)。这是交付缺陷, 优先级高。
- **F38 bookpack 只存 profile 身份, prep 配置(音色/策略/速度)不进书包(2026-08-08 核对)**:
  job_request.profile 要求 5 字段(id/explain_strategy/voice/speed/highlight_granularity),
  bookpack.profile 只要求 2 字段(id/name) —— 书包只保留身份, prep 配置被消费后不随书持久化,
  只存在于 job 目录的 job_request.json 快照里。`bookpack.profile.name` 前端从不读(只读 .id,
  reader_view.js:71/348), 是写死字段。  影响: ① 若 job 目录被清理, 书的 prep 配置无从恢复
  (R5-1/F13 的重试来源只能是 job_request.json 快照, 印证了 F13 的修法方向); ② 前端无法展示
  "这本书用什么音色/策略"(只能从 books 表的 llm_id/tts_id 看模型)。属契约/数据保留卫生债,
  不是 bug(身份/配置分离是刻意设计)。
- **F39 孤儿 CSS: word-panel 特征块 + .prep-task-log(2026-08-08 全量核对)**: F24 的反向审计
  (CSS 定义 vs JS 引用, 含 el() 助手/参数传递/拼接): `reader.css:84-102` 的 `.word-panel`/
  `.word-panel.show`/`.word-panel-word`(一整块词面板样式)与 `prep.css:59` 的 `.prep-task-log`
  有样式但全 JS 零引用 —— 疑为已移除功能(词面板弹窗/备料日志行)的 CSS 残留。可删
  (删前确认不是动态拼接类名)。
- **F40 word_lookup 失败兜底文案误导 + 原因被 stderr 丢弃(2026-08-08 实测)**: commands/reader.rs
  的 `llm_dict_lookup` 以 `.stderr(Stdio::null())` 起子进程 —— 侧车失败写人话原因到 stderr
  (实测 "dict lookup failed: LLM 模型文件不存在: F:/nonexistent.gguf", exit 1, 无 stdout),
  Rust 端读不到, `llm_dict_lookup` 返回 Err → `word_lookup` 落兜底占位
  `"{w} 的词义待补充(未配置 LLM 模型)"`。**文案误导**: 模型已配置但损坏/超时/查询失败时,
  用户看到的是"未配置 LLM 模型"(与事实不符)。修法: 区分"未配置"(无模型/文件缺失 → 现文案)
  与"查询失败"(模型在但失败了 → 显示"查询失败"+原因/重试), stderr 接 pipe 读原因(同 F35 模式)。
- **F41 fire-and-forget 写操作不检查结果(2026-08-08 grep 核实)**: 4 处写操作调用后不检查返回值
  —— reader_view.js:282 `AiduReadingService.save`(位置/书签落盘)、settings_view.js:185/204/224
  `settings_upsert`(字号/主题/儿童模式)。本地 SQLite 写失败(磁盘满/锁)会静默丢变更, 用户以为
  已保存实际下次打开还原 —— 正是全局 CLAUDE.md "后台失败但用户以为成功是要优先排除的最差情况"
  所指。  修法(低成本): 这些调用加 `.catch(() => AiduToast.show('保存失败, 请重试', 'error'))`
  (bridge 已归一化 {ok:false, error}, 无需额外后端改动)。
  同类较轻: 删除类操作(vocab_remove/library_remove/job_remove)有 .then 但无 .catch —— 失败时
  静默但可见(行还在, 用户能发现没删掉), 影响低于设置/位置丢失。
- **F42 `plugin:opener|open_path` 未注册, "打开日志文件"永远走剪贴板兜底(2026-08-08 核实)**:
  bridge.js:42 的 `openPath` 调 `invoke('plugin:opener|open_path')`, 但 Cargo.toml 无
  tauri-plugin-opener 依赖、main.rs 无 `.plugin()` 注册、src-tauri 全仓无 plugin 引用 ——
  Tauri v2 里该命令必然 "command not found"。settings_view.js:33-38 的"打开日志文件"因此**永远
  失败**, 只落"已复制到剪贴板"兜底(功能退化为复制路径)。契约漂移测试排除 `plugin:*`, 所以没被
  抓到。修法: 装 tauri-plugin-opener 并注册, 或改走应用内 `log_path` + 原生 open 命令, 或干脆
  改文案为"复制路径"。

- **F43 legacy product 可能共享同一 `pack_dir`(v18 后仍待物理收口)**: 旧版 `books` 的
  original/product 行曾实测共用目录。v18 已把 product 行迁移为 editions 并保留字段，但迁移本身
  尚未复制共享目录；因此历史 editions 仍可能违反"每个 edition 独占 pack_dir"。后续必须在迁移或
  一次性修复工具中校验并复制目录，不能只改数据库字符串。
- **F44 历史 jobs 无法全部可靠回填 edition_id**: v18 按 `output_dir=pack_dir` 回填；无法匹配的
  旧任务保留原数据，启动孤儿清理只删除既无 source 路径又无 edition 目录关联的记录。需要为无法
  匹配的任务提供可追溯人工处理/明确保留策略，不能静默猜测。

## 9.6 阅读器交互模型(2026-08-08 取证, R2 拆分后)

`reader/views/reader/` 五个模块 + `core/` 三个纯逻辑模块 + `reader_renderer.js` 的协作:

- **core/shadow.js(纯逻辑, 已单测)**: 跟读状态机。输入 = 时间事件(sentence done / 用户动作),
  输出 = action(`repeat` / `next`)。repeat_n 单句重复 N 次、ab_loop A-B 循环、gap 句末留白、
  speed 变速不变调(playbackRate)。
- **views/reader/player.js**: `<audio>` 生命周期 + 分块加载(2MB/块, base64→Blob→ObjectURL)。
  rAF tick 驱动 `renderer.highlightAt` + 进度条 + AB 循环回跳。锚点 `anchorIndex` 决定全局
  播放键从哪句续播(R1-1 任务卡涉及恢复时锚点跟随)。
- **views/reader/chapter_loader.js**: `load_bookpack_chapter` 封装 + 防重入/竞态
  (`_chapterGen`, 同章加载中跳过)。
- **views/reader/bookmarks.js**: 单 `Set<句下标>` + 抽屉面板; 下标语义=章内句序(见 F6)。
- **views/reader/search.js + core/search_index.js**: 全书索引(仅用元信息 original_text),
  跨章命中 → 切章 → 等渲染完 → 滚动定位(ensureRendered)。
- **components/reader_renderer.js**: 渐进渲染(首屏 50 句 + IntersectionObserver 哨兵 +300/批),
  `ensureRendered(index)` 是唯一补渲染入口(书签/搜索/播放定位统一走它);
  `core/render_plan.js`(纯逻辑)收敛"补建到哪个下标/分几片"的边界决策。
- **视图组装**: `reader_view.js` 只做组装 + 竞态分层(chapterLoader 管 fetch, 视图管渲染期)。

跟读动作链路: audio `ended` → `_onSentenceEnded(idx)` → `shadow.sentenceEnded(idx)` →
  onAction(repeat/next) → player 跳 currentTime/playFrom。AB 循环: rAF tick → `shouldLoopBack`。

## 9.7 IPC 信任面与路径防护的"语义边界"(2026-08-08 取证)

- `read_audio`/`read_audio_range`/`read_image`(commands/library.rs:278/308/292)都做
  `canonicalize + starts_with(base)` 校验, 防 `file` 参数逃出 `base_path`。**但 `base_path`
  本身是前端传入的**(open() 从 load_bookpack 拿到 basePath 再透传)——防护语义是"file 逃不出
  base", 不是"base 必须落在 out_dir 内"。若前端被改(本地应用, 前端即代码), 可
  `read_audio("C:/", "Windows/...")` 读任意文件。当前无真实攻击面(WebView 只跑本地代码,
  攻击者要控前端 = 已有本机权限), 属纵深防御语义, 不是漏洞; 记录以防未来引入远程内容时踩坑。
- `resolve_book_pack_dir`(:106-124)三级解析: DB 登记路径 → book_id 当绝对路径直接判
  (目录且含 bookpack.json) → book_id 当 out_dir 下子目录名。`load_bookpack`(:182-202)在
  book_id 未登记时会自动按 `book_id_from_path(target, profile)` 登记 —— 这是"打开书籍"按钮
  即使 id 算错(见 F1)也能靠兜底路径解析勉强工作的原因, 也是 F1 暂时不爆的原因之一。

## 9.8 prep LLM 阶段吞吐特征(2026-08-08 取证)

- **translate: 已批量**。按章分批 `BATCH_SIZE=15`(llm/batch.py, 与 subgen 生产一致), 走
  `translate_batch_with_retry`: 编号对齐解析 → echo/长度守卫(`guard_batch`) → 整批失败对半
  递归重试 → echo 命中行单行重试。失败行保留原文 + 记 quality。
- **explain: 仍逐句**(llm/stage.py explain_sentences): 每句一次 `complete_fn`, 每 10 句回调
  一次进度。这是 ROADMAP P4"explain 批量化 2-4x"项的真实基础 —— 吞吐差不在 translate 在 explain。
- 两者都支持 cancel 检查(每句/每批 `raise EngineError("已取消")`)。

### prep 领域模型 ↔ bookpack schema(core/models.py, 2026-08-08 取证)

- `Segment = [word, POS, lemma]` 三元数组 —— 前端 atomic_block 的 `Array.isArray(seg)` 分支正是
  为此;**R1-2 的 lemma 是 spaCy lemma 的证据就在这**(数组第三位)。
- `WordTiming = {seg_idx, start_ms, end_ms}`: 词级时间轴指向 segments 下标(句内相对 ms)。
- `SentenceAudio = {chapter, start_ms, end_ms}`: 章节累计绝对 ms, timeline 二分查找的前提。
- 失败语义单一事实源: `FATAL_STAGES = {translate, nlp, translation}`; `mark_failed` 中
  translate/nlp 失败 → 整句 failed(无译文可读), explain/tts/align → partial(句子仍有译文)。
- `ChapterImage = {file, at}`(R4, at=渲染在第 at 句之前, 句下标)。
- **MuPDF 兜底的质量局限(2026-08-08 取证)**: pdf/mobi/azw3/fb2 走 `pdf.py` 按**行**切句
  (get_text("text") 的每行 = 一个 Sentence, pdf.py:35-36), 不像 epub 有段落级结构 —— 排版折行
  会造成大量"半句碎片"句, nlp 阶段把它们当独立句子处理(翻译/讲解质量受损)。这是 MuPDF 路径的
  已知质量局限, 不是崩溃; 用户的书若以 PDF 为主, 备料质量会明显低于 epub 书。

## 9.9 模型扫描与 TTS 引擎实测细节(2026-08-08 取证)

- **模型扫描**(model_store/scan.rs): 认两种布局 —— 平铺(根目录 `*.gguf/*.pth/*.bin`)与
  HF 标准(`hub/models--owner--name/snapshots/<sha>/*`); 结果用于"复用检测", sha256 匹配注册表
  则直接登记不下载。`scan_and_suggest` 跳过已登记同路径。
- **TTS 引擎**(tts/engine.py): Kokoro `KPipeline.join_timestamps` 直接给出每词
  start/end(秒) → 词级时间轴**零对齐成本**(memory/pipeline.md"词级时间轴零成本"的来源)。
  运行依赖: espeak(misaki)+ spaCy en_core_web_sm; 模型目录需含 `config.json` + `voices/`,
  否则 EngineError。CUDA 不可用时自动降 CPU。

## 9.10 实测性能与体积数据(2026-08-08 取证, docs/measurements/*.json)

- **nlp 分句吞吐**(scripts/bench_report.py, spaCy en_core_web_sm, 确定性合成文本):
  perf_1000(1224 句/18 章): 11.7s, ~105 句/s; perf_10000(11861 句/158 章): ~44s, ~265 句/s
  —— 吞吐随规模摊销上升(spaCy pipeline 预热被摊薄)。
- **loader**: txt 纯文本加载 10-30ms(规模无关, 近似常数)。
- **侧车体积 6.3GB**(见 F22): torch 全量捆绑 + ggml-cuda 903MB + CUDA DLL 三重复制 ~1.35GB 浪费。
- **tauri exe**: ~18MB(release)。前端资源: ~198KB 源码(js+html+css, 2026-08-08 实测不含
  node_modules/tests; 历史 ~86KB 是 R0-R4 模块化之前的尺寸)。
- 测量脚本可复现:`scripts/gen_perf_book.py` 生成确定性文本 → `scripts/bench_report.py` 产出 JSON。
  (注: 这些数字是 2026-08-08 之前某次跑的, 不是本会话重测; 归入历史基准。)
- **2026-08-08 本会话重测**: perf_1000 nlp 12.4s / 98.8 句每秒(历史 11.7s/104.7, 正常方差),
  数据可复现。**bench_report.py 的 reader_frontend 指标不可靠**: 它对整个 reader/ 目录 `dir_size`
  (含 node_modules), 历史 86KB vs 现在 39MB 都是"reader 目录大小", 不是"前端产物大小"
  (前端真正嵌进 exe 的是源码 ~86KB)。该指标应改为只算 reader/ 下非 node_modules 的源文件。
- **2026-08-08 LLM 实测(Qwen3-4B GGUF, 本机)**: 模型加载(进程内 llama_cpp)3.2s; 2 行翻译
  推理 0.7s(~44 输出字符/s)。对照 F21: 词典查询 5.7-7.4s 的绝大部分是**每次子进程重新加载
  模型**(进程启动 + DLL/CUDA 初始化 ~4s + 模型加载 3.2s), 推理本身只 ~0.7s —— 印证 F21 根因
  是"每次查词重载模型"而非推理慢。
- **2026-08-08 TTS 实测(kokoro, 本机高负载)**: 引擎加载(espeak+misaki+torch CUDA)45.8s ——
  每个任务一次性成本, 在 LLM 停止后加载; 单句(~18 词)合成 ~5.1s(≈1x 实时)。memory/pipeline.md
  记的 x18.1 实时是空闲机实测, 本机负载下低得多 —— 单次测量, 归入历史数据, 不做吞吐承诺。
  (注意: engine.synth 返回元组顺序与直觉不同, 用时先检查结构, 这是本会话探针踩的坑。)

## 9.11 跨层表面总览(2026-08-08 精确盘点)

| 表面 | 数量 | 备注 |
|---|---|---|
| Tauri commands | 71 | ipc/registry.rs 与 main.rs 一致(测试锁定); 视图 UI 可达 55, 不可达 16(见 F17) |
| 前端 invoke 字面量 | 67 | 全部命中已登记命令(漂移测试绿); 仅校验命令名, 不校验参数名(F29) |
| contracts schema | 3 | bookpack / job_request / progress; progress 的 stage_failed 是死事件(F28) |
| Tauri 事件 | 4 应用 + 1 内建 | job-progress / library-changed / job-list-changed / batch-progress + tauri://drag-drop(内建) |
| config.toml 字段 | 6 | out_dir / model_dir / log_level / cf_worker_url / cf_namespace / ffmpeg_path; model_dir/cf_namespace 死(F23) |
| 环境变量 | 5 | AIDULC_PREP / OUT / DB / LOG / FFMPEG |
| DB 表 | 10 | 见 §2; profiles 从未被 UI 写(F14) |
| DB schema 迁移 | 9 | v1-v9, 见 §2 |

## 10. 与其它文档的引用关系

- `CLAUDE.md`: 存储所有权/contracts 同步/测试命令/前端令牌纪律 的强制来源, 本文件不重复正文。
- `docs/requirements.md`: 本会话对 R1-1/R1-2/R2-1 的深化证据(竞态细节、lemma 不匹配、config.toml
  清理)记录在账本"可执行任务卡"节。
- `memory/pipeline.md`: 流水线层踩坑全集, 本文件 §7 只收与架构相关的摘要。
- `docs/ROADMAP.md`: P0-P4 缺口来源; 本文件 §8 未接线清单与其 P2 对应。
- `docs/BASELINE.md`: v0.1.0-working-3books 非回归基准; 旧书包分章错乱风险已警告。
