# aidulc 项目规约

本地整本书英语精读/跟读工作站。Rust 外壳(Tauri, `src-tauri/`) + Python 侧车(`prep/`, 离线批处理,
一本书跑一次) + WebView 前端(`reader/`)。三者靠 `contracts/` 下的 JSON Schema 通信。

审计与规约生效日期 2026-08-07。此前项目零版本控制历史地跑通过 3 本书交付,本文件是审计后新建的
强制规约,记录的是**实测验证过的现状**,不是设计意图的复述——发现现状与本文件矛盾时以现状为准并回来改本文件。

## 存储所有权(强制)

`src-tauri/src/store/` 下每张表只允许一个 repo 写。新代码不得绕过:

| 表 | 唯一写者 | 说明 |
|---|---|---|
| `vocab` | `vocab_repo.rs` | SRS 学习状态 |
| `dictionary` | `dict_repo.rs` | 个人词典资产 |
| `profiles` | `profile_repo.rs` | 讲解策略/音色/语速/高亮粒度 |
| `reading_state` | `reading_repo.rs` | 阅读进度/书签/播放位置 |
| `books` | `books_repo.rs` | 书库登记 |
| `reader_settings` | `settings_repo.rs` | 阅读器设置 |
| `jobs` | `jobs_repo.rs` | 备料任务 |
| `batches` | `batches_repo.rs` | 批量任务 |
| `model_registry` | `model_repo.rs` | 模型绑定 |
| `wizard_state` | `application/wizard_service.rs` | **例外**:唯一不走 `store/*_repo.rs` 模式、直接发 SQL 的表。新代码沿用现状(改这里前先问是否该补一个 `wizard_repo.rs` 而不是继续叠加直连 SQL) |

跨表只读查询允许(如 `transfer_service.rs` 为导出功能 `SELECT DISTINCT profile_id FROM vocab UNION ...`),
禁止的是跨 repo **写**同一张表。

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

`scripts/check.ps1` 额外跑 `cargo fmt --check` 和 `cargo clippy`(clippy 用基线放行 8 处已知结构性警告
——参数过多/类型复杂, 分布在 `job_orchestrator.rs`/`library_service.rs`/`library.rs`/`models.rs`/
`sync_service.rs`/`reader.rs`。S2.1(2026-08-07)已把业务编排从命令层挪到 `application/`,但挪文件
不会减少参数个数, 基线仍是 8——真正清零需要把多参数函数改成接收请求结构体, 是比挪文件更大的改动,
留在 `docs/ROADMAP.md` P3。**不要为了让门禁变绿而调高基线数字,只能调低**)。

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

2026-08-07 清 clippy 死代码警告时发现,`#[allow(dead_code)]` + `TODO(未接线)` 标注在源码里,任务列表
里也各有登记:model bundle 完整性检查(`model_service.rs`)、首次运行向导完成状态判断
(`wizard_service.rs::is_done`)、CF 同步断开连接(`credentials.rs::delete_cf_token`)、首次下载 URL 构造
(`infrastructure/downloader/mod.rs`)。改这几处附近代码前先看 `TODO(未接线)` 注释, 别假设它们已经在跑。

## 项目记忆

`memory/pipeline.md` 记录 pipeline 踩过的坑(ffmpeg concat/编码超时、TTS 时间轴对齐等),
`docs/BASELINE.md` 是 `v0.1.0-working-3books` tag 时的非回归基准。改动前后如果涉及这两份文件覆盖的
领域,先读一遍。
