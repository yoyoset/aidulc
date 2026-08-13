# aidulc 项目规约

本地整本书英语精读/跟读工作站。Rust 外壳(Tauri, `src-tauri/`) + Python 侧车(`prep/`, 离线批处理,
一本书跑一次) + WebView 前端(`reader/`)。三者靠 `contracts/` 下的 JSON Schema 通信。

审计与规约生效日期 2026-08-07。此前项目零版本控制历史地跑通过 3 本书交付,本文件是审计后新建的
强制规约,记录的是**实测验证过的现状**,不是设计意图的复述——发现现状与本文件矛盾时以现状为准并回来改本文件。

## 存储所有权(强制)

`src-tauri/src/store/` 下每张表只允许一个 repo 写。新代码不得绕过:

| 表 | 唯一写者 | 说明 |
|---|---|---|
| `vocab` | `vocab_repo.rs` | SRS 学习状态 (V1 起带 user_id, user ≠ profile) |
| `dictionary` | `dict_repo.rs` | 个人词典资产 (V1 起带 user_id) |
| `users` | `users_repo.rs` | **V1 新增**: 身份 ("谁"), 与 profile("讲解策略")分开; 顶栏切人 |
| `profiles` | `profile_repo.rs` | 讲解策略/音色/语速/高亮粒度 |
| `reading_state` | `reading_repo.rs` | 阅读进度/书签/播放位置 (V1 起复合主键 user_id+book_key) |
| `highlights` | `highlights_repo.rs` | 摘录标注 (V1 起带 user_id) |
| `reading_daily` | `reading_repo.rs` | 按日阅读时长 (V1 起复合主键 user_id+book_key+day) |
| `books` | `books_repo.rs` | 原书(source)登记；不承载可阅读成品 |
| `editions` | `editions_repo.rs` | 译本/成品(edition)及生成参数快照 |
| `reader_settings` | `settings_repo.rs` | 阅读器设置 |
| `jobs` | `jobs_repo.rs` | 备料任务 |
| `batches` | `batches_repo.rs` | 批量任务 |
| `model_registry` | `model_repo.rs` | 模型绑定 |
| `sync_state` | `sync_state_repo.rs` | **V6 新增**: 每 user 的同步状态 (last_push_at 算待推数, last_pull_rev 增量拉取) |
| `wizard_state` | `application/wizard_service.rs` | **例外**:唯一不走 `store/*_repo.rs` 模式、直接发 SQL 的表。新代码沿用现状(改这里前先问是否该补一个 `wizard_repo.rs` 而不是继续叠加直连 SQL) |

跨表只读查询允许(如 `transfer_service.rs` 为导出功能 `SELECT DISTINCT profile_id FROM vocab UNION ...`),
禁止的是跨 repo **写**同一张表。

**第二处例外(2026-08-13 审计确认)**:`application/library_asset_service.rs` 的级联删除
(`cleanup_orphans`/`delete_edition`/`delete_source`/`cleanup_orphan_batches`)直接发 SQL 删
`reading_state`/`reading_daily`/`highlights`/`jobs`/`editions`/`batches` 多张表。这是刻意的:
跨表级联删必须在**单个事务**里原子完成,而各 repo 的写方法各自锁 `db.conn`(std Mutex 不可
重入),在 service 已持锁的事务里调 repo 会死锁。改成"repo 收 `&Connection` 参数"是更大的
重构。这处是删除路径(数据丢失敏感),有 6 个单测锁定其行为——改它前先补 repo 级 bulk 方法,
不要直接叠直连 SQL。

## contracts/(强制)

`contracts/*.schema.json` 是 Rust/Python/前端三端唯一共享的契约来源,`prep/aidulc_prep/schemas/` 是随
侧车打包用的**拷贝**,不是第二份权威。改 `contracts/` 后必须跑:

```powershell
.\scripts\sync_schema.ps1          # 同步拷贝
.\scripts\sync_schema.ps1 -Verify  # 校验一致(接入 scripts\check.ps1, 不一致即门禁失败)
```

忘记同步不会在业务代码里报错——侧车会静默拿旧 schema 校验,只有 `-Verify` 能抓到,这是 2026-08-07
从"只有拷贝脚本没有校验"的真实缺口里补的。

## 测试(强制)

一条命令跑全部:

```powershell
.\scripts\check.ps1
```

单独跑某一层:

- Python: `prep\.venv\Scripts\python.exe -m pytest prep\tests`
- Rust: `cargo test --release -p aidulc -- --test-threads=1` ——**必须 `--test-threads=1`**,并行跑因共享
  临时 DB 状态冲突会假失败(`memory/pipeline.md` 记录过, 2026-08-07 复核仍然如此)
- 前端: `cd reader && npx vitest run`

`scripts/check.ps1` 额外跑 `cargo fmt --check` 和 `cargo clippy`(clippy 用基线放行 7 处已知结构性警告
——参数过多/类型复杂, 分布在 `job_orchestrator.rs`/`library_service.rs`/`sync_service.rs`/
`commands/library.rs`/`commands/models.rs`(2026-08-13 治理拆分 `commands/reader.rs` 后复核过一遍
分布, 已从原来的 8 处降到 7, `reader.rs` 不再在名单里——原来那处警告是随文件一起被拆没的, 不是专门
修的)。真正清零需要把多参数函数改成接收请求结构体, 是比挪文件更大的改动, 留在 `docs/ROADMAP.md` P3。
**不要为了让门禁变绿而调高基线数字,只能调低**)。还额外跑一项文件规模基线(见下"文件规模"一节)。

## 文件规模(强制)

`scripts/check.ps1` 的 `file-size` 一项扫描 `src-tauri/src/`、`reader/`(排除 `node_modules`、
`tests/`、`*.test.js`)下所有 `.rs`/`.js` 文件,**默认上限 600 行**,超过即门禁失败。不是任何超过
600 行的文件都必须拆——判断标准是"是不是真的塞了多个不相关域",不是行数本身(2026-08-13
`docs/GOAL_2026-08-13_FILESIZE.md` 审计确认过):

- **该拆的例子**:原 `commands/reader.rs`(1710 行)实际注册了词典/生词本/背单词/同步后端管理/
  日志五个不相关命令域,已拆成 `dictionary.rs`/`vocab.rs`/`srs.rs`/`sync_backend.rs`/`log.rs`/
  `reader.rs`(瘦身);原 `settings_view.js`(1178 行)一个 `render()` 方法塞了 5 个设置页 tab,
  已拆成 `reader/views/settings/{system,models,profiles,sync,reading}_tab.js`。
- **正当例外(登记进 `scripts/file_size_baseline.json`,只能降不能加)**:`store_mod.rs`(v1→v26
  顺序迁移链,顺序本身是文档)、`ipc/registry.rs`(F29 门禁校验用的注册表本身,`CommandInfo.path`
  字段会被解析成文件路径去反查函数签名——**挪动任何命令的物理文件位置,必须同步改这里对应的
  `path`,漏改不会报错,只会让 F29 校验静默去错的文件里找函数**)、`data_migration.rs`(单事务
  级联删除)、`job_orchestrator.rs`/`commands/library.rs`(单一命令域,方法数量正常、没混域)、
  `reader_view.js`/`library_view.js`/`models_view.js`/`prep_view.js`(方法数量正常, 没有
  `settings_view.js` 那种巨型函数)等。新文件想加进这份基线,要能说清楚"拆了为什么更糟"
  (通常是"拆分会破坏事务原子性/顺序可审计性/校验脚本的路径耦合"这三类理由之一),不是图省事。

## 前端(reader/)编码规约

- `reader/styles/tokens.css` 是颜色/圆角/字号/间距的唯一来源,新代码不得写裸 `#hex` 或裸 `px` 数值
  绕过令牌。**颜色(S3.1, 2026-08-07 已修)**:深色模式令牌已从 `app.css` 整体迁回 `tokens.css`,
  27 个 color role 深浅色全覆盖(此前只覆盖 18/27);`app.css` 的 43 处硬编码颜色已清零,新增
  `--md-sys-color-success/warning/info/neutral`(+对应 `on-*`)四个语义状态色和
  `--md-sys-color-scrim-surface`(+`on-scrim-surface`,固定深色不随主题反转,toast 用)。
  `scripts/check.ps1` 的 `css:no-raw-hex` 一项强制校验(零豁免):`tokens.css` 之外的样式文件
  出现裸 `#hex` 直接门禁失败。**字号/间距(仍是已知欠账)**:阶梯令牌(`--md-sys-font-size-*`/
  `--md-sys-space-*`)已建立,但存量 `rem`/`px` 用法尚未迁移替换,没有对应 lint(迁移是更大的
  改动,现在加约束会让门禁对着几百处存量代码常年变红)——新代码字号间距仍应优先用阶梯令牌。
- `reader/core/*.js` 是零 DOM 依赖的纯逻辑模块(挂在 `window` 上的 IIFE),改动配对 `reader/tests/*.test.js`。
  这类模块新增前先看能不能保持"无 DOM 依赖", 保持这个性质才能继续用轻量的 `window=globalThis` shim
  测试,不必引入 jsdom。

## 工具坑(实测确认过,不是文档假设)

- **PowerShell 5.1 + 中文注释的 `.ps1` 文件必须是 UTF-8 BOM**,不带 BOM 会解析错乱、报错看起来像语法
  错误实际是编码问题(2026-08-07 写 `scripts/sync_schema.ps1` 时复现)。写新 `.ps1` 脚本时确认编码。
- PowerShell 5.1 无 `&&`/`||`,写 `A; if ($?) { B }`。

## 已知未接线的功能(写了测试但没有 command/前端调用)

`#[allow(dead_code)]` + `TODO(未接线)` 标注在源码里,2026-08-09 复核后剩余:
CF 同步断开连接(`credentials.rs::delete_cf_token`)、旧单 token 读取(`credentials.rs::get_cf_token`,
2026-08-13 移除其生产调用后仅测试用)、首次下载 URL 构造
(`infrastructure/downloader/mod.rs::github_release_asset_url`)、
profile 单条查询(`store/profile_repo.rs::get`)。改这几处附近代码前先看 `TODO(未接线)` 注释,
别假设它们已经在跑。(`hf_resolve_url` 已接线——2026-08-13 审计确认 `normalize_hf_url` 用到了它,
早先把它列进未接线清单已过时。)

历史清单里另两项——model bundle 完整性检查(`model_service.rs::bundle_complete`/`book_bundle_complete`)
和首次运行向导完成状态判断(`wizard_service.rs::is_done`)——已按 R2-2 作为"仅测试引用的死代码"删除
(`memory/maturity.md` 有记录),不再列出;不要回去找不存在的函数。

## 项目记忆

`memory/pipeline.md` 记录 pipeline 踩过的坑(ffmpeg concat/编码超时、TTS 时间轴对齐等),
`docs/BASELINE.md` 是 `v0.1.0-working-3books` tag 时的非回归基准。改动前后如果涉及这两份文件覆盖的
领域,先读一遍。
