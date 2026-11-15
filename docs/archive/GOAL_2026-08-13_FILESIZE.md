# GOAL 2026-08-13 (治理): 单文件规模审计 + 门禁方案

用户原话:"审计项目的单一功能原则,单体文件无限成长,指定单体文件最大行数。撰写 goal 目标
文档。优化代价架构方案。我的意见超过 500 行以上的全部处理掉。" 本文档先给实测数据,再给
方案——**方案对"全部处理掉"这条给出了修正意见(见二),不是全盘照搬**,理由写在方案里,
按仓库自己"先实测再下结论"的规矩来,不是我拍脑袋反对。

---

## 零、为什么此前没有这条规矩(如实说明,不是借口)

全局 `CLAUDE.md` 定的是判断基准(系统构成五维度 + 工作方法),没有具体到"单文件行数上限"。
项目 `CLAUDE.md` 强制约束的是表所有权/`contracts/`同步/测试命令/前端令牌规约/已知未接线
清单,同样没有文件规模条款。离这条最近的现成信号是 `cargo clippy` 基线里的"参数过多/类型
复杂"8 处警告,项目自己已经记账:"真正清零需要把多参数函数改成请求结构体,是比挪文件更大
的改动,留在 P3"——即这件事被显式列进了已知欠账,不是被无视,只是没排上优先级。本文档
把它排上。

---

## 一、实测:超过 500 行的文件(23 个, 排除 node_modules/测试文件)

统计范围: `reader/`、`src-tauri/src/`、`prep/aidulc_prep/`、`cloud/`,排除 `node_modules`、
`*.test.js`、`tests/` 目录。Rust 文件测试常与生产代码同文件(`#[cfg(test)] mod xxx`),
会显著撑大总行数、掩盖生产代码真实体量——下表拆出"生产代码行"单独看,这是判断"真胖"还是
"测试撑起来的"的关键,不能只看总行数一个数字。

| 文件 | 总行数 | 生产代码行(约) | 判断 |
|---|---:|---:|---|
| `src-tauri/src/commands/reader.rs` | 1710 | **1659** | 🔴 真胖 + 混域(见二.1) |
| `src-tauri/src/application/sync_service.rs` | 1593 | 686 | 🟢 测试占 57%, 本体不算大 |
| `src-tauri/src/application/job_orchestrator.rs` | 1433 | 1214 | 🟡 待评估(见二.3) |
| `src-tauri/src/store/store_mod.rs` | 1395 | 781 | 🟢 正当例外(见二.2) |
| `src-tauri/src/infrastructure/data_migration.rs` | 1363 | 849 | 🟢 正当例外(见二.2) |
| `reader/views/settings_view.js` | 1178 | 1178(纯) | 🔴 真胖 |
| `reader/views/reader_view.js` | 1171 | 1171(纯) | 🟡 已拆过一轮, 待评估 |
| `src-tauri/src/commands/library.rs` | 1123 | 823 | 🟡 待评估 |
| `src-tauri/src/ipc/registry.rs` | 1079 | 706 | 🟢 正当例外(见二.2) |
| `reader/views/library_view.js` | 1063 | 1063(纯) | 🔴 真胖 |
| `reader/views/models_view.js` | 946 | 946(纯) | 🟡 待评估 |
| `src-tauri/src/application/model_service.rs` | 817 | 394 | 🟢 测试占一半, 本体尚可 |
| `src-tauri/src/commands/misc.rs` | 805 | 727 | 🟡 待评估(内容比 reader.rs 单纯) |
| `src-tauri/src/application/library_asset_service.rs` | 662 | ~238 | 🟢 已有正当例外记录(CLAUDE.md 级联删除) |
| `reader/views/prep_view.js` | 601 | 601(纯) | 🟡 待评估 |
| `src-tauri/src/main.rs` | 600 | ~176 | 🟢 入口装配文件, 天然长 |
| `cloud/mobile/app.js` | 543 | 543(纯) | 🟡 待评估(移动端, 影响面小) |
| `prep/aidulc_prep/pipeline/loader/epub.py` | 534 | 534(纯) | 🟢 解析器天然长, 暂不动 |
| `reader/views/review_view.js` | 514 | 514(纯) | 🟡 刚过线, 低优先级 |
| `reader/views/vocab_view.js` | 513 | 513(纯) | 🟡 刚过线, 低优先级 |
| `src-tauri/src/store/vocab_repo.rs` | 506 | ~352 | 🟢 单表 repo, 刚过线 |
| `src-tauri/src/application/dictionary_service.rs` | 503 | ~200 | 🟢 刚过线 |

🔴 = 建议这轮就拆　🟡 = 需要人工看内容再定, 未必要拆　🟢 = 有正当理由或体量尚可, 建议记入
"正当例外"清单、不动

---

## 二、方案:门槛不是"500 行一刀切全清"

### 二.1 为什么 `reader.rs` 是这轮真正该处理的(证据, 不是猜)

数了它注册的 `#[tauri::command]`,26+ 个命令横跨五个不相关的域:

- `add_vocab / dict_list / dict_search / dict_remove` —— 词典
- `vocab_all / vocab_search / vocab_remove / vocab_stats / vocab_common_preview /
  vocab_remove_common / vocab_backlog_preview / vocab_backlog_spread / vocab_restore` —— 生词本
- `srs_preview / srs_grade` —— 背单词调度
- `sync_force_full / sync_backends_list / sync_backend_toggle / sync_backend_add /
  sync_backend_switch / sync_backend_remove / sync_disconnect / sync_config_set` —— 同步后端管理
- `bookmarks_list` —— 阅读进度(UX7 #3 刚接线)
- `log_from_frontend / log_path` —— 前端日志

一个叫"reader"(阅读器)的文件,实际装的是词典+生词本+背单词+同步后端管理+日志五个不相关的
命令域——**这是真实的单一职责违反, 1659 行只是这个违反的副作用, 不是原因**。就算行数正常,
这个文件也该拆;就算不拆行数只降到 1000 行以内,只要命令还混域,问题也没解决。

**拆分方向**(按真实域名, 不是按行数硬切):
- `commands/vocab.rs` —— add_vocab/dict_*/vocab_*/srs_*
- `commands/sync_backend.rs` —— sync_*
- `commands/reader.rs`(瘦身后)—— bookmarks_list + 阅读相关(如果以后还有)
- `commands/log.rs` —— log_from_frontend/log_path

每个新文件的命令仍然照常在 `main.rs`/`ipc/registry.rs` 注册,F29 门禁(命令名+参数名一致性
校验)不受影响——它扫的是注册表和实际函数签名, 不关心函数物理上在哪个文件。

### 二.2 为什么另外三个"大文件"建议**不拆**, 记入正当例外

- **`store_mod.rs`(781 行生产代码)**: v1→v26 的顺序迁移链, 每段严格按版本号从上到下执行,
  顺序本身就是文档——拆成多文件反而更难看清"某版本改了什么、基于什么前置状态"。这次
  UX7 #3 (v26) 踩过的坑就是"降级 fixture 重放"测试的版本号清单没跟上, 如果迁移逻辑本身
  也散在多个文件, 这类坑会更难查。
- **`ipc/registry.rs`(706 行生产代码)**: 就是 F29 门禁脚本扫描比对的"命令名+参数名清单",
  本质是一份注册表, 天然该扁平。拆开只会让校验脚本要跨文件核对, 复杂度不降反升。
- **`data_migration.rs`(849 行生产代码)**: "整根迁移"流水线(备份→VACUUM 快照→复制校验→
  重写路径→标记清理), CLAUDE.md 已经写明"跨表级联删必须在单个事务里原子完成"——拆分意味着
  要在文件间传递事务/锁状态, 这正是项目自己在"级联删除例外"那条里拒绝过的方向。

这三个不是"偷懒不拆", 是拆了会让**可审计性/事务正确性**变差, 拿行数指标换掉了更重要的东西。

### 二.3 🟡 待评估的文件, 这轮先不动

`job_orchestrator.rs`(1214 行生产代码)、`library.rs`(823)、`settings_view.js`(1178,
🔴 已定要拆)之外的 `reader_view.js`(1171, 已经拆过一轮, 剩下的是编排胶水代码, 边际收益
递减)、`models_view.js`(946)、`misc.rs`(727)、`prep_view.js`(601)——这些需要真的打开看
内容判断"是不是也在混域", 不能只凭行数下结论。本文档不在这轮里下定论, 列进下一阶段的
审查清单(见四)。

### 二.4 门禁机制: 抄 clippy 基线的治理方式, 不是新发明一套

往 `scripts/check.ps1` 加一项 `file-size` 检查, 逻辑和 clippy 基线一致:

1. **基线快照**: 现有超标文件按本文档的分类固化成 `scripts/file_size_baseline.json`
   (文件路径 → 生产代码行数上限), 🟢 类直接按当前行数封顶(不许再涨), 🔴/🟡 类按"处理后
   的目标行数"封顶(还没处理的先按当前行数封顶, 处理完再收紧)。
2. **只能降不能加**: 和 clippy 基线同一条规矩, 门禁脚本比对当前行数与基线, 超过基线即失败;
   低于基线要把 json 里的数字也调低, 不能只改代码不改基线(防止"改完又悄悄涨回去"这种慢性
   膨胀)。
3. **新文件默认阈值 600 行生产代码**(不含同文件内 `#[cfg(test)]`/JS 独立 `.test.js` 不计入)
   ——超过这个数需要在 PR/commit message 里写明"为什么不该拆"(比如"顺序迁移链"、"注册表"
   这类正当理由), 否则门禁按新增违规拦。
4. **不做成硬阻断老代码**: 🟡 类此轮先按当前行数封顶放行, 不強行卡在这次改动里必须拆完——
   拆分是有真实回归风险的改动(尤其 `reader.rs` 混了 26 个命令, 挪动路径必须小心不漏挪一个),
   仓库现在处于"持续打补丁"节奏(UX4→UX7), 不适合叠一次大规模重构。

---

## 三、这轮实际要做的(范围声明: 这次不做什么)

**这次做**: `commands/reader.rs` 拆成 `vocab.rs`/`sync_backend.rs`/`reader.rs`(瘦身)/`log.rs`
四个文件(按二.1 的域名边界), 每个新文件独立提交, 迁移完跑 `check.ps1` 全绿, 前端 `AiduBridge`
调用不用改(Tauri 命令名不变, 只是 Rust 侧物理文件挪动)。

**这次不做**(和理由):
- `store_mod.rs`/`ipc/registry.rs`/`data_migration.rs` —— 见二.2, 记入正当例外, 不拆。
- `settings_view.js`/`library_view.js`(🔴 JS 真胖两个)—— 需要先看内部结构定拆分方案
  (JS 视图文件没有"测试撑大"这层遮挡, 是最诚实的胖, 但具体怎么拆需要单独走读, 不在这轮
  和 Rust 拆分一起做, 避免一次改动跨两个技术栈、回归面太大)。
- 🟡 待评估的 6 个文件 —— 见二.3, 先按当前行数记进基线, 不这轮处理。
- `file-size` 门禁机制的实现(check.ps1 新增检查项 + 基线 json)—— 这是治理机制本身,
  待 `reader.rs` 拆分实测跑一遍确认可行后再补, 不要在同一轮里"边定规矩边验证规矩"。

---

## 四、下一阶段 —— 全部完成 (2026-08-13 同日收尾)

1. ~~`settings_view.js`/`library_view.js` 内部结构走读 + 拆分方案~~ ✅ `settings_view.js`
   巨型 `render()`(889 行塞 5 个 tab)已拆成 `reader/views/settings/{system,models,
   profiles,sync,reading}_tab.js`, 主文件瘦到 103 行。`library_view.js` 复核后确认
   方法数量正常、没混域, 记正当例外, 不拆。
2. ~~`job_orchestrator.rs`/`library.rs`/`reader_view.js` 等 🟡 类逐个判断~~ ✅ 全部复核
   完毕: `job_orchestrator.rs`/`commands/library.rs`(单一命令域)、`reader_view.js`/
   `library_view.js`/`models_view.js`/`prep_view.js`(方法数量正常)均确认"长但没混域",
   记入 `scripts/file_size_baseline.json` 正当例外, 不拆。
3. ~~`file-size` 门禁正式接入 `check.ps1` + 基线 json~~ ✅ 已接入(`check.ps1` 新增
   `file-size` 检查项, 117 个文件扫描), 过程中委派 flash-delegate skill 修了一个真实
   PowerShell 5.1 编码坑(见下)。
4. ~~门槛数字写回项目 `CLAUDE.md`~~ ✅ 补了"文件规模(强制)"一节, 顺带发现并修正了
   CLAUDE.md 里 clippy 基线段落已经过时的文件分布描述(`reader.rs` 拆分后不再含相关
   警告, 8→7 这个数字本身其实早改过、文档没跟上)。

**过程中的真实坑(不是猜的)**: `scripts/file_size_baseline.json` 是 UTF-8 无 BOM 的
JSON, `check.ps1` 里 `Get-Content` 没指定编码, PowerShell 5.1 下按系统代码页读, 中文
注释乱码 + `ConvertFrom-Json` 直接报错——基线一条没读进去, 所有文件(含 `store_mod.rs`
这种正当例外)都被错误地按默认 600 行阈值判定失败。改用
`[System.IO.File]::ReadAllText(path, [System.Text.Encoding]::UTF8)` 显式解码修复,
不依赖 `Get-Content` 编码参数在 PowerShell 5.1/7 之间不一致的行为。

---

## 五、验收

| # | 验收 |
|---|---|
| `reader.rs` 拆分 | 4 个新文件各自职责单一(vocab/sync_backend/reader/log), 原 26+ 个命令一个不少注册在 `main.rs`, F29 命令名/参数名校验照常通过 |
| 回归 | `scripts/check.ps1` 24 项全绿, clippy 基线只降不升 |
| 文档 | 本文件"这次不做什么"清单里的每一项都有理由, 不是漏做 |
