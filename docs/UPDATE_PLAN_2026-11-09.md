# 1109 更新计划 —— 书库丢失后的防护与初始化改进

> 给执行方(另一个模型)的自包含任务卡。编排/审计: Claude, 周四(2026-11-12)逐条核对。
> 审计只认**机械可核对的事实**: 测试名存在且通过、`check.ps1` 输出、commit 哈希。报告里写"已完成"不算数。

## 背景(已实测, 不用再查)

- 8/12 数据根整根迁到 `E:\aidulc_data`, 指针存在 `%APPDATA%\aidulc\data_root.txt`。
- 11/5~11/8 之间该目录被永久删除。11/9 启动时 `src-tauri/src/main.rs` 里
  `read_data_root(..).filter(|p| p.is_dir()).unwrap_or_else(|| default_data_dir.clone())`
  **静默**退回 `%APPDATA%\aidulc` 并新建空库。用户看到的是书库空、生词 0、模型登记空。
- `backups/` 和 `logs/` 都在数据根里面, 一起丢了, 所以事后既没有备份也查不到日志。
- 模型文件还在 `F:\hf_cache`(环境变量 HF_HOME), 丢的只是 DB 里的 `model_registry` 登记。

## 硬性规矩(违反即审计不通过)

- 全量门禁: `.\scripts\check.ps1` 必须全绿。Rust 测试必须 `--test-threads=1`。
- 新 Tauri 命令要在 `src-tauri/src/ipc/registry.rs` 登记, `path` 字段写成真实的 `模块::函数`。
- 前端颜色/间距只用 `reader/styles/tokens.css` 的令牌, 不写裸 `#hex`。
- 单个函数 ≤150 行, 新文件 ≤600 行; 不许调高任何基线数字。
- 每一项单独一个 commit, message 开头写编号(如 `P0-1: ...`)和真实依据, 末尾加 `Co-Authored-By` 行。
- `git add` 只加本项涉及的文件, **不要** `git add -A`。工作区里 `.claude/`、`.mcp.json` 和 `.gitignore`
  的删改不属于本计划, 不要暂存。

## 第 0 步: 先清掉在途改动(不做完不许开始 P0)

工作区里有一批未提交的「摘录自定义标签」改动(`highlight_tags_repo.rs`、`highlights.js`、`store_mod.rs`、
`main.rs`、`registry.rs` 等), 和下面要改的文件有重叠。先跑 `check.ps1`:
- 全绿 → 把这批文件单独提交一次, message: `新增: 摘录自定义标签(在途改动收尾)`。
- 不绿 → **停下**, 把失败输出原样报告给用户, 不要自己修, 也不要开始 P0。

## P0-1 书库丢失时明确提醒, 不再静默回退

- `main.rs`: 指针存在但目标不是目录时, 往 `DataPaths` 新增 `data_root_missing: Option<PathBuf>`(值是指针路径)。
  本次会话仍然用默认目录启动(否则程序打不开)。
- 新命令 `data_root_status` → `{ missing, pointer, fallback }`。
- `reader/main.js` 在向导拦截**之前**调用它。`missing=true` 时弹一个点外部关不掉的模态框, 标题「找不到书库」,
  正文写明指针路径、可能原因(移动硬盘没插 / 被移动或删除)、当前临时位置。三个按钮:
  「重新指定书库位置…」「在原位置新建空书库」「改用默认位置」(这一项清掉指针)。
- 验收: Rust 单测 `data_root_missing_detected`; smoke 检查「标题为"找不到书库"、有 3 个按钮」。

## P0-2 数据库快照放到数据根外面

- 每天第一次启动时 `VACUUM INTO` 到 `%APPDATA%\aidulc\snapshots\data-YYYYMMDD.db`(不管数据根在哪), 最多保留 7 份。
  失败只记日志, 不阻断启动。
- 验收: 单测 `snapshot_rotates_keeps_7`(造 9 份 → 剩最新 7 份)、`snapshot_outside_data_root`。

## P1-3 向导「书库位置」步骤能改位置

- `reader/views/wizard_view.js::_stepDataDir` 加「选择其他位置…」按钮, 调 `AiduMiscService.libraryDirPickAndSet()`
  (不传参数, 后端会弹出选文件夹对话框, 已经支持)。
- 加「找回已有书库…」, 复用已有的 `library_dir_pick`/`library_dir_scan`/`library_dir_import`。
- 显示「当前位置: xxx」; P0-1 判定为 missing 时加一行红字。
- 验收: smoke 检查: 有该按钮, 点击后 `libraryDirPickAndSet` 被调用且参数为空。

## P1-4 向导不能被侧栏误退出, 没走完可以继续

- 在 shell 组件里新增 `setNavEnabled(bool)`, 向导显示时禁用侧栏, 只能通过向导内的「跳过」离开。
- `wizardState` 不是 `done` 时, 书库页顶部显示「首次设置还没完成 · 继续」横条, 点击跳到 `#/wizard`。
- 验收: smoke 两条: 向导显示时侧栏不可点; 未完成时书库页有该横条。

## P1-5 模型登记为空时自动发现

- 模型与依赖页: 登记数为 0, 且 HF_HOME 或默认模型目录里扫得到模型时, 显示「发现 N 个本地模型, 一键登记」横条,
  复用 `models_scan`。
- 验收: smoke 检查: 登记为空、扫描返回 2 个时出现横条, 点击后调用 `models_scan`。

## P2-6 测试不再往真实凭据管理器里留垃圾

- 现状: 凭据管理器里有 409 条 `cf-server-user-me-<hash>`。来源是 `sync_service.rs` 的测试
  `m3_sync_now_all_pushes_to_enabled_backends_only`: mock 用随机端口, 写了 `save_server_user_for_endpoint`
  却从不删(这一项根本没有删除函数)。
- 修: `src-tauri/src/services/credentials.rs` 补 `delete_server_user_for_endpoint`, 测试结尾清理。
- 新建 `scripts/cleanup_test_credentials.ps1`(UTF-8 **带 BOM**): 只删值为 `me` 的 `cf-server-user-me-*`;
  默认只打印将要删的条数, 加 `-Apply` 才真删。**执行方不要跑 `-Apply`**, 留给用户决定。
- 验收: 连跑两次 `cargo test` 前后, `cmdkey /list` 里 `cf-server-user-me-` 的条数不变(报告里贴前后数字)。

## P2-7 启动日志固定写一份

- 每次启动把 `data_dir`、是否回退、指针内容追加到 `%APPDATA%\aidulc\startup.log`, 超过 1MB 截掉前一半。
- 验收: 单测 `startup_log_written_to_default_dir`。

## 不做的事

不恢复已删文件; 不做云端备份; 不改整根迁移流程(`data_migration.rs`); 不动 graft 相关文件。

## 交付报告格式(每项一行)

`编号 | commit 哈希 | 新增测试名 | check.ps1 结果`, 最后附 `git log --oneline -10`。
