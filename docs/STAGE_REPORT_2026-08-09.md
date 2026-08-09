# 阶段报告 STAGE-2026-08-09

| 项 | 值 |
|---|---|
| 版本 | 应用 `0.1.0`(tauri.conf.json);git 基线 `v0.1.0-working-3books` → `d8451c4` → 本阶段 |
| 日期 | 2026-08-09 |
| 状态 | 已提交,`scripts/check.ps1` 全绿 |
| 交接对象 | 下一会话 / 下一工程师 |

本阶段覆盖三个逻辑单元:① UX 用户旅程审计落地;② 数据/磁盘/内存无限成长修复;③ 幻觉·占位·硬编码审计修复。
①③ 的细节记忆分别落在 `memory/ux_audit_2026-08-09.md` 与本文档 §4,② 的坑记录见 §2。

---

## 1. 本阶段成果

### 1.1 UX 用户旅程审计落地

审计范围:13 个用户操作入口 × 四段旅程(前置/进行中/结束/再次进入)。全量结论见
`memory/ux_audit_2026-08-09.md`(含"最初以为 A 实测发现是 B"的修正记录)。落地的关键项:

- **移除任务三态确认**:running 告知"立即停止处理并丢弃当前进度"、queued 告知"不再进入处理"、done 仅移除记录。
- **任务队列自愈**:`pump_queue` 弹出已删任务 id 时跳过继续,不再整条队列停摆且无反馈。
- **进度条与百分比一致**:后端 `stage_progress/stage_done` 事件新增 `progress`(全书完成度),前端条与标签共用同一值。
- **任务完成全局 toast**:任何页面都能看到"《x》处理完成/失败",不必自己回阅读准备刷新。
- **导入单对话框**:去掉隐藏 `<input type=file>`(WebView + rfd 双对话框),点击只 `pickFiles` 一次。
- **创建译本弹窗 A1 修复**:档案/语言/模型三节同步挂载(此前的"删重复挂载"差点误删唯一挂载点)。
- **记住上次档案**:`localStorage.aidulc.lastProfile`,导入卡与创建译本弹窗自动预选。
- **设置页去重复模型中心**:只留组件健康检查;向导磁盘检查改查书库实际所在盘;缺组件指引改指对地方。
- **阅读器设置保存失败不静默**:`.catch` 走 `_setStatus` 反馈通道。

### 1.2 无限成长修复(本次会话重点,见 §2)

### 1.3 幻觉 / 占位 / 硬编码审计修复

- **文档幻觉对账**:`CLAUDE.md` / `docs/ROADMAP.md` 中"已知未接线的功能"清单里有 2 条指向
  **已删除**的代码(`model_service.rs::bundle_complete`、`wizard_service.rs::is_done`,R2-2 已删),
  已剔除并注明;补入漏记的 `profile_repo.rs::get`。
- **占位(死代码)**:`books_repo::remove` 接线进 `delete_source`(顺带消除裸 SQL 跨 repo 写 books);
  `books_repo::touch_opened` 确认真死删除。
- **硬编码去重**:内建 `default`/`kid` 档案参数 + 音色候选原本在 `import_service.js`/`settings_view.js`/
  `library_view.js` 三处各写一份 → 收敛到 `reader/core/builtin_profiles.js`(纯逻辑零 DOM,新增 6 项单测)。

---

## 2. 无限成长:发现问题、决策与实测依据

审计起点:阅读准备页批次列表 `batch_list` 无 LIMIT、`batches`/`jobs` 表行从不清理、`out_dir/jobs/`
目录从不删除、`BookpackCache` 无上限。

| 位置 | 类型 | 量级 | 处理 |
|---|---|---|---|
| `out_dir/jobs/` 目录 | 磁盘 | GB 级/本(大书 checkpoint+TTS) | **修复**:`job_remove` 顺带删无 edition 引用的目录 + 启动 `cleanup_orphan_job_dirs` 清孤儿 |
| `BookpackCache` | 内存 | ~23.88MB/条(Wolf 21 实测)× 会话内开书数 | **修复**:LRU cap=6(最坏 ≈144MB,有界) |
| `batches`/`jobs` 表行 | DB | 行小但无限 | **收口磁盘侧;表侧留作后续**(见 §4.3) |

**关键决策与依据**:
- **LRU cap=6**:取"够开会话内最近读的几本"量级;最坏 6 × 24MB ≈ 144MB,不再随开书数涨。
- **目录删除安全边界**:只删 `out_dir/jobs/` 下以 `job-` 开头、且不被任何 job 行 / edition `pack_dir`
  引用的目录。成功产书的任务其目录 = edition.pack_dir(被引用 → 保留),跑在启动早期、队列泵起之前,
  无"目录正被使用"竞态。
- **`job_remove` 不删书**:移除任务时若 `output_dir` 仍是某个 edition 的 `pack_dir`,只删记录不删盘
  (书还在书库里)。
- **存储所有权(G5)**:books 表唯一写者是 `books_repo`;`delete_source` 从裸 SQL 改为走 `repo.remove`,
  符合 CLAUDE.md 所有权表。

---

## 3. 验证(改动落地前全绿)

`scripts/check.ps1` 全量通过(2026-08-09,3 个提交前各跑一次):

| 门禁 | 结果 |
|---|---|
| schema:verify | PASS(contracts ↔ prep/schemas 一致) |
| cargo fmt --check / clippy(基线≤8) | PASS(clippy 仍 8,未调高) |
| cargo build --release | PASS |
| cargo test --release -- --test-threads=1 | 154 passed(Rust 必须单线程,见 memory/pipeline.md) |
| pytest | 160 passed |
| vitest | 13 files / 91 tests passed(新增 builtin_profiles 6 项) |
| node smoke(reader DOM 渲染路径) | 全部通过 |
| node smoke(视图层 prep/settings/library) | 全部通过 |
| css:no-raw-hex / no-blk-texture / contrast | 全部通过 |

---

## 4. 团队交接记录

### 4.1 提交清单(本阶段 3 个提交)

| Commit | 内容 |
|---|---|
| `87c27bc` feat: UX 审计 2026-08-09 落地 + 内建档案单一真相源 | 前端全部改动 + `job_orchestrator.rs`(pump_queue 自愈/progress 字段) + `check.ps1` 接冒烟 + `memory/ux_audit_2026-08-09.md` |
| `80316bb` fix: 无限成长修复 + 存储所有权接线 | `bookpack_cache.rs`(LRU)、`commands/jobs.rs`(删目录)、`main.rs`(启动清孤儿)、`library_asset_service.rs`、`books_repo.rs` |
| 本文档所在提交 | docs: 幻觉对账 + 阶段报告 |

### 4.2 改动文件清单

前端:`reader/main.js`、`views/{prep,reader,settings,library,wizard}_view.js`、`services/import_service.js`、
`core/builtin_profiles.js`(新)、`tests/builtin_profiles.test.js`(新)、`tests/_smoke_views.mjs`(新)、`index.html`。
Rust:`src-tauri/src/{infrastructure/bookpack_cache.rs, commands/jobs.rs, application/job_orchestrator.rs,
application/library_asset_service.rs, store/books_repo.rs, main.rs}`。
脚本/文档:`scripts/check.ps1`、`CLAUDE.md`、`docs/ROADMAP.md`、`memory/ux_audit_2026-08-09.md`(新)、`.gitignore`。

### 4.3 已知未处理(显式移交,不要当不存在)

1. **`batches` / `jobs` 表行无限累积**(只收口了磁盘侧):每导入/每备料一行,`batch_list`/`job_list` 无 LIMIT。
   建议:完成 N 天后的批次可删 / `batch_list` 加 LIMIT。当前 UI 已 `.slice(0,5)` 限制显示,DB 行数小,低优先级。
2. **`completed` 中文映射 bug**:`prep_view.js::_refreshBatches` 状态映射写的是 `done: '完成'`,DB 实际写
   `completed` → 批次行显示英文 "completed"。改法:映射键加 `completed`。
3. **TODO(未接线) 仍 4 处**:`credentials.rs::delete_cf_token`(无"断开 CF 同步"UI)、
   `downloader/mod.rs::github_release_asset_url` / `hf_resolve_url`(URL 构造函数无调用方,下载链路本身已通
   走 `models_download`)、`profile_repo.rs::get`(界面只走 list)。
4. **clippy 基线 8**:`job_orchestrator.rs`(3)/`library_service.rs`(1)/`sync_service.rs`(1)/`library.rs`(1)/
   `models.rs`(1)/`reader.rs`(1) 参数过多/类型复杂。清零需改请求结构体,见 ROADMAP P3。
5. **字号/间距令牌存量迁移**:`rem`/`px` 存量未迁阶梯令牌,无 lint(见 CLAUDE.md)。
6. **中文编码注意**:新 `.ps1` 必须 UTF-8 BOM(PowerShell 5.1),2026-08-07 实测复现过。

### 4.4 需真人最终确认项

- **暂停→继续交互**(checkpoint 续跑):GUI 层人工点一遍确认(代码与测试已就位)。
- **档案新建/编辑模态**在真实 WebView 下的表单交互。
- **重建后重启应用**:`aidulc.exe` 需重新构建启动才会吃到新二进制(本阶段曾因运行中进程锁文件,
  结束进程后才 `cargo build --release` 通过)。

### 4.5 记忆与踩坑指针(改相关代码前必读)

- `memory/ux_audit_2026-08-09.md` — 本阶段 UX 审计全量结论(含"最初以为 A 实测 B"修正)。
- `memory/pipeline.md` — pipeline 坑(ffmpeg concat/编码超时、TTS 时间轴对齐、Rust 测试必须单线程)。
- `memory/maturity.md` — M6/M7/S5 记忆(档案系统、F13 profile 快照、F25 阅读器设置)。
- `docs/BASELINE.md` — `v0.1.0-working-3books` 非回归基准,改动涉及先读。
- `docs/ARCHITECTURE.md` — 结构 + 未接线清单(本阶段已对账)。

### 4.6 未提交工件 / 环境说明

- `完整设计交付确认.zip`(根目录):设计交付件二进制,**已加入 .gitignore 不入库**;需要时从本地取。
- `out_dir/jobs/` 历史遗留孤儿目录:下次启动会自动被 `cleanup_orphan_job_dirs` 清理,无需手工删。
- 本阶段无 schema 改动(未动 contracts/),`sync_schema.ps1` 不需要跑。

### 4.7 测试命令(与 CLAUDE.md 一致)

```powershell
.\scripts\check.ps1                                            # 全量门禁
prep\.venv\Scripts\python.exe -m pytest prep\tests             # 仅 Python
cargo test --release -p aidulc -- --test-threads=1             # 仅 Rust(必须单线程)
cd reader; npx vitest run                                      # 仅前端单测
cd reader; node tests\_smoke_views.mjs                          # 视图层冒烟(独立于 vitest)
```
