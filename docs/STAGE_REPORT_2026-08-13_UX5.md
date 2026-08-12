# STAGE REPORT 2026-08-13 UX5 —— 五条 UX 决策落地 + 在线引擎 deepseek-v4-flash + 附加项

来源任务: `docs/GOAL_2026-08-13_UX5.md`。顺序按文档执行: **#1 → #5 → #6 → #2 → #4 → #3 → #7**。
每条一个提交, 落地前 `.\scripts\check.ps1` 24 项全绿。7 个任务提交:
`04c6a51` #1 / `13f9854` #5 / `1ddccad` #6 / `4649eca` #2 / `cc3d364` #4 /
`85642af` #3 / `5147e2d` #7 + 收尾提交(截图脚本 + 报告 + 一处真机发现的 bug 修复)。

**根因与文档矛盾处全部以实测为准**, 两处如实在下:
- **#4 真机渲染发现**: 向导第 2 步(数据目录)在真实页面一渲染就崩 —— 视图调用
  `AiduMiscService.dataRootRecommended()`, 但真实 `services/misc_service.js` **漏了这个方法**
  (只在测试 stub 里有)。这正是 UX4 M2 的同款陷阱: 测试替身掩盖了真实缺失, smoke 全绿但真机白屏。
  修复: misc_service.js 补 `dataRootRecommended`/`libraryRootStatus`, 并给 smoke 2g 加了静态守卫
  (读真实 service 源码断言方法存在), 让这类回归以后能被门禁抓到。
- **#2 语音降级边界**: 文档写「桌面用原句原声, 手机用 speechSynthesis」。实测桌面 review_view
  是唯一实现, 手机 PWA 有独立 app 不共用此视图; 把"手机/系统级"落地为 review_view 的
  **降级路径** (词条无来源定位或音频加载失败 → speechSynthesis, 慢速 rate 0.6), 两端按钮文案一致。

---

## 一、需要用户本人操作(DS 做不了)

| # | 事项 | 说明 |
|---|---|---|
| U1 | **真机最终点验** | 截图已用真实 Chrome headless 渲染生成(教训 8 截图表 + `docs/UX5_screenshots/`): 加载的是线上 reader/index.html, 只 stub `window.__TAURI__`, main.js/views/services/CSS 全是线上代码。剩用户真机点按(整本在线翻译真实外发、多后端真实同步、整根迁移真实重启)为最终验收 |
| U2 | **检查 Credential Manager 残留**: `m3_sync_now_all` 测试会写入 `cf-worker-token-me-<hash>` 与 `cf-server-user-me-<hash>` 两组凭据 | 测试内已清理 (delete_cf_token_for_endpoint ×2); 若历史跑过有残留可手动删, 不影响功能 |
| U3 | 整根迁移后的旧根目录 (models/backups/logs 等) 残留 | Phase 2 cleanup 只删 jobs_out/data.db/config.toml/models; 旧根的空壳目录可手动删 (文档记录, 不自动) |
| U4 | `git push origin main` | 本地已超前 110+ 提交 |
| U5 | 真机验证「使用推荐位置」在首次向导的迁移 | 会触发整根迁移 + 重启, 需真机跑一遍 |

---

## 二、八条协作教训的证据

### 教训 1: 同类要扫描给清单

- **#3 M3 存储层**: `SyncStateRepo::get(user_id)` 单主键签名被改复合主键 `get(user_id, endpoint_key)` 后,
  全项目扫描调用点: `resolve_state` / `pending_count` / `force_full_reset` / `sync_now` / `sync_pull`
  全部改签名; `record_sync`/`last_sync_for` 的内存态 map key 也从 `user_id` 改为 `user_id|endpoint_key`
  (`reset_last_sync` 改成按前缀清)。一处没改就会编译错, 编译期兜住。
- **#6 在线引擎**: `credentials.rs::delete_online_key` 原来 `#[allow(dead_code)]` 标注"未接线"——
  接 UI 后去掉了 allow, 同步把 `ipc/registry.rs` 的 `CommandInfo` 补上 (registry 测试断言清单与
  generate_handler 一致)。
- **#4 数据根**: `library_dir_get` 从返回 `cfg.out_dir` 改为返回 `DataPaths.data_dir`, 调用点
  (设置页展示 / 向导硬件检查磁盘) 都按"书库位置=数据根"重新解释。

### 教训 2: 数字贴命令 + 原始输出

- **clippy 棘轮**: 收尾 `cargo clippy --release -p aidulc` 计数 **7**, 等于基线 7, 未升高。
- **门禁项数**: 24 项全绿 (与 UX4 相同; 本轮未新增门禁)。
- **cargo test**: `260 passed; 0 failed; 1 ignored` (UX4 尾是 256; 本轮新增 4 个 Rust 单测)。
- **vitest**: 124 passed (不变)。**smoke views**: 全绿 (新增 3e/2d3/2d4/2f2/6f/UX5 相关断言)。
- **真机截图**: `docs/UX5_screenshots/` 共 10 张真实 Chrome headless 渲染 (教训 8 截图表)。

### 教训 3: 真实数据副本跑一次, 给前后计数

- **#4 整根迁移 (Rust 单测 `ux5_migrate_data_root_moves_config_db_out_models`)**: 造真实形状的旧根
  (config.toml + data.db + jobs_out/bookpack.json + models/Qwen.gguf) → `migrate_data_root` →
  **前后计数断言**: jobs_out 源 1 文件 == 目标 1 文件, models 源 1 文件 == 目标 1 文件;
  新根出现 config.toml/data.db/jobs_out/models/backups; 数据根指针 `read_data_root` 指向新根;
  `cleanup_pending` 按清单核验通过后旧 jobs_out/models 被删。
- **#3 M3 (Rust 单测 `m3_sync_now_all_pushes_to_enabled_backends_only`)**: 两个本地 mock worker,
  同主体启用两个后端 → `sync_now_all` 结果 2 个、每个 `last_wrote=2` (两边都收到各推 2 条);
  取消其一 → 只推另一个 (结果 1 个 name=a)。token 按 (user, endpoint) 写 CM, 测试后清理。
- **#7 样书 (Rust 单测 `r1_sample_book_import_is_idempotent_and_registers`)**: 首次导入
  `already=false` + 磁盘写出 bookpack + 登记译本与 original 书; 二次导入 `already=true` (幂等)。

### 教训 4: 功能名→代码路径对照表

| UI 功能名 | 实现代码路径 |
|---|---|
| 译本展开持久化 / 轮巡增量 | `reader/views/library_view.js` `this._expanded` + `_updateJobProgress` (UX5 #1) |
| 专注模式单卡 + 双语音 | `reader/views/review_view.js` (UX5 #2) + `reader/views/reader/player.js` 音频管线复用 |
| 后端「同步此后端」勾选 | `settings_view.js` `renderBackends` + `commands/reader.rs::sync_backend_toggle` + `store/sync_state_repo.rs::set_enabled` |
| 书库位置整根迁移 | `commands/misc.rs::library_dir_pick_and_set` → `infrastructure/data_migration.rs::migrate_data_root` + `services/config.rs` 数据根指针 |
| 绿色生效徽章 | `commands/misc.rs::library_root_status` + `settings_view.js` `.lib-badge-ok` |
| 模型目录 / 版本判定 | `reader/views/models_view.js` `_loadModelDirs`/`_versionStatus` (UX5 #5) |
| 在线引擎预设 deepseek-v4-flash | `settings_view.js` onlineModel 预填 + `commands/misc.rs::online_config_*` |
| 整本外发入口 | 书卡 ⋯ 菜单 `_onlineWholeBook` → `commands/reader.rs::book_online_translate` → `online_client.rs::translate_book` |
| 内置样书 | `commands/library.rs::sample_book_import` + `wizard_view.js` 完成页 ② |

### 教训 5: 实测点击路径

| 卡 | 点击路径 | 结果 |
|---|---|---|
| #1 | 译本 (N) ▸ 展开 → 轮巡 (job poll) | `.edition-body` 无 collapsed、箭头 ▾ 保持; 其它卡仍折叠 (smoke 3e) |
| #2 | 生词本「开始复习」 | `.review-grid` 消失、`.review-card` + `.review-context` + `.review-backdrop` 出现; 双语音按钮「正常速度/慢速」; 翻面 SPACE |
| #3 | 同步与数据 → 后端行勾选 | 勾选「家里」→ `backendToggle(家里,true)`; 立即同步 → 「已同步 2 / 2 个后端」+ 各推 N 条 |
| #4 | 设置 → 更改… | pick → 确认框 (整根迁移+备份+校验) → `libraryDirPickAndSet(新根)` → 「已整根迁移到 X (备份: …) 重启后生效」; 徽章绿/红 |
| #5 | 模型页「扫描已有模型」→ 扫描 | 候选行带版本徽章: 已知→「可下载/可登记」, 目录没有→「版本未知, 无法判断」; 模型目录路径可见可增删 |
| #6 | 书卡 ⋯ →「整本翻译/讲解(在线)」 | ②未开 → toast 去设置; 开了 → 确认框含外发量 → 确认 → toast「在线整本翻译完成: N 句成功」 |
| #7 | 向导完成页 ② | 可点 (不再置灰) → `sample_book_import` → 进书库, 样书卡出现可打开阅读 |

### 教训 6: 发布步骤与线上版本号

- 本轮无 cloud/mobile 改动 (`mobile:version-bumped` 门禁 PASS, 工作区 cloud/mobile 未变)。

### 教训 7: (沿用 UX3 证据链, 本轮无新迁移冲突; #3/#4 各新增一条迁移, 见教训 3)

### 教训 8(本轮重点): UI 卡的断言落在用户可见的最终 DOM + 真机渲染截图

每张 UI 卡给出「断言的 DOM 选择器 + 断言的可见文案/类名」(smoke/单测锁住) + 真机截图:

| 卡 | 断言的 DOM 选择器 | 断言的可见文案 / 类名 |
|---|---|---|
| #1 | `.edition-toggle` / `.edition-body` | 展开后轮巡再断言: `.edition-body` 无 `collapsed`、箭头 `▾`; 其它书卡仍 `collapsed`; 整列重建后 expanded 保持; 轮巡只更 `.prep-bar-fill` 宽度 `25%` + `.book-progress-text` 含「翻译 50/200 句」 |
| #2 | `.review-grid`(消失) / `.review-card` / `.review-context` / `.review-backdrop` / `.review-voice-btn` | 单卡出现、语境块入卡、背景遮罩存在; 双按钮文案 `正常速度`/`慢速`; 点击后按钮 `.playing` 高亮; 慢速 `playbackRate=0.75` / 降级 `speechSynthesis rate 0.6` |
| #3 | `.sync-backend-enable input` / `.sync-backend-subject` / `.sync-status` | 勾选存在、已连接可点未连接置灰、回显 (a=勾选 b=未勾); 主体 `主体: 我`; 立即同步 → `已同步 2 / 2 个后端` + `推 2`/`推 5` |
| #4 | `.lib-badge.lib-badge-ok` / `.lib-badge-err` / 更改确认框 / `.import-tip` | 生效 `生效中`(绿) / 失效 `目录不存在`(红); 确认框标题 `整根迁移书库位置`、文案含 `备份`+`校验`; 结果 `已整根迁移到 X` + `重启`; 向导第 2 步含 `我的文档/aidulc` + `data.db/jobs_out/models/logs` |
| #5 | `.model-dir-row` / `.scan-candidate .book-badge` / `.scan-ver-cell` | 目录路径可见; 无已登记 nlp → 分词段不渲染; 候选版本: 已知 `可下载/可登记`、未知 `版本未知, 无法判断`、已登记 `已是最新`; 0 结果有 `去下载推荐模型` |
| #6 | `onlineModel` 输入值 / `清除在线引擎 key` 按钮 / `.vocab-menu-item` / 确认框 | 预填 `deepseek-v4-flash`; 清除有确认、清除后两档开关置灰+状态 `未配置`; 菜单含 `整本翻译/讲解(在线)`; 确认框含全书外发量 (章/句/字数) |
| #7 | `.wizard-choice`(②) / `.book-card-title` | ② 不再 `disabled`、不含 `即将支持`; 点击调 `sample_book_import`; 书库出现 `Sample: A Morning Walk (样书)` |

**真机截图**(真实 Chrome headless 渲染, `scripts/ux5_screenshots.mjs` 生成, 存 `docs/UX5_screenshots/`),
加载线上 reader/index.html, 只 stub `__TAURI__`, 截图时同步 dump 关键 DOM 互相印证:

| 截图文件 | 内容(截图时 DOM 实测) |
|---|---|
| `ux5-1-editions-expanded.png` | 书库: 「译本 (1) ▾」展开, 断言 `.edition-body` 无 collapsed (轮巡后仍展开) |
| `ux5-2-review-focus-card.png` | 专注模式单卡: reticent + 语境「He was reticent about the war.」+ 语音按钮「正常速度/慢速」; 断言 noGrid/hasCard/hasCtx/hasBackdrop |
| `ux5-2-review-card-back.png` | SPACE 翻面背面: 释义 + 来源定位 |
| `ux5-3-sync-backends.png` | 同步与数据: 后端行「同步此后端」勾选 + 「主体: 我」 |
| `ux5-4-library-root-badge.png` | 系统与书库: 数据根说明 + 绿色徽章「生效中」 |
| `ux5-5-model-dirs.png` | 模型与依赖: 模型目录 D:/aidulc-data/models + F:/hf_cache |
| `ux5-5-scan-versions.png` | 扫描候选版本徽章: 翻译/讲解「版本未知, 无法判断」、分词/NLP、未识别 |
| `ux5-6-online-engine.png` | 在线引擎设置: deepseek-v4-flash 预填 + 清除 key 按钮 |
| `ux5-6-wholebook-menu.png` | 书卡 ⋯ 菜单: 预览原文/设置/整本翻译/讲解(在线)/删除 |
| `ux5-7-sample-book.png` | 书库: Sample: A Morning Walk (样书) 卡出现 |
| `ux5-7-wizard-done.png` | 向导完成页三选一: ② 内置样书可用 (断言不置灰/不含即将支持) |

---

## 三、各卡要点与验证

### #1(P1) 译本展开状态持久化 + 轮巡增量更新
- `this._expanded = new Set<bookId>`: toggle 加入/移出; 整列重建时按 set 决定 `.edition-body` 折叠态与箭头
  (`▸`/`▾`) —— 书库每 5 秒轮询与 store change 重建都不再冲掉展开状态。
- 轮巡 `loadJobs` 不再整列 `_renderBooks`: 书卡加 `data-book-id`, `_updateJobProgress` 只刷对应卡
  `.prep-bar-fill` 宽度 + `.book-progress-text`; 处理中任务启动后也增量补进度条 (不重建卡片)。
- 验证: smoke 3e 按教训 8 断 DOM (见截图表)。

### #2(P1) 专注模式重做: 单卡 + 语境入卡 + 背景模糊 + 双语音
- 去三栏 `.review-grid`, 单卡: 正面=词+音标+原文语境块 (`.review-context-block`, 原右栏并入卡内),
  背面=释义+来源定位 (`.review-source-loc`); 背景 `.review-backdrop` (scrim + backdrop-filter blur,
  tokens 纸面变量, 无裸 hex)。
- 语音按钮「正常速度/慢速」: 词条带 `edition_id+chapter_index+sentence_index` →
  `loadBookpack`(basePath) + `loadBookpackChapter`(audio 区间) + `readAudioRange` 分块读原句 →
  Audio 定位句起点, 慢速 `playbackRate 0.75`; 无音频/加载失败 → 降级 `speechSynthesis` (系统级,
  慢速 rate 0.6); 播放中 `.playing` 高亮。Esc/退出复习保留进度。
- 队列信息收进 `.review-summary` 摘要行 (含每日上限顺延提示, H4 语义保留)。

### #3(P1) M3 落地: 主体 × 后端矩阵
- **存储(单独提交 + 迁移兜底)**: 迁移 v24 `sync_state` 主键 user_id → 复合 (user_id, endpoint_key)
  + `enabled` 列; 老行按各自 endpoint_key 落一行 (enabled=1), 空 endpoint_key 行丢弃
  (Rust 单测 `v24_migrates_legacy_sync_state_rows`)。credentials token/服务端 user 按
  (user, endpoint) 分账 (account 名 = 前缀 + user + endpoint_key 短哈希);
  `migrate_cf_token_for` 老 V6 key 读得到就迁、迁不动明确报错。
- **同步 = 对当前主体已启用后端依次先推后拉**: `sync_now_all` 聚合每后端结果; `enabled_endpoints`
  无行时当前生效后端默认启用 (老用户兼容)。Rust 单测 `m3_sync_now_all...`: 两个后端都收/取消其一只推另一个。
- **设置页**: 后端行加「同步此后端」勾选 (有 token 才可点) + 所属主体 (`.sync-backend-subject`);
  `sync_backend_toggle` 命令; 切主体后 `backends_list` 按当前 user 返回各自启用状态。
- **验收**: 同主体两个后端一次同步两边都收到 ✓ / 取消其一只推另一个 ✓ / 切主体看到各自的启用状态 ✓
  (smoke 2f2 + Rust 单测)。

### #4(P1) 书库位置 = 数据根
- **布局**: 根下直接放 data.db / config.toml / jobs_out/ / models/ / backups/ / logs/。
- **更改… = 整根迁移**: 前端选目录 → 确认 (L1 清单+备份+校验说明) → 后端 `migrate_data_root`
  (备份 export_aidu_data → 复制 config/db(VACUUM INTO 快照)/jobs_out/models → copy_tree_with_verify
  + sha256 清单核验 → 写迁移标记 → 写数据根指针 `data_root.txt`), 重启后 Phase 2 `cleanup_pending`
  按清单核验通过才删旧。**原位置文件一个没少**(单测前后计数一致)。
- **绿色生效徽章**: `library_root_status` 存在+可写 → `.lib-badge-ok`「生效中」; 失效 → 红 + 原因。
- **首次默认 = 我的文档/aidulc**: 向导第 2 步推荐路径 (`recommended_data_root`, 含 OneDrive Documents)
  + 完整结构引导 (data.db/jobs_out/models/backups/logs 各行说明) + 「使用推荐位置」/「保持当前默认」。
- **旧程序目录迁移折叠**: dataMigrationStatus 文案改「迁移到数据根」。

### #5(P1) 模型与依赖: 逻辑闭环
- 模型目录段 (.model-dir-list): 已登记 llm/tts 路径目录 + HF 缓存, 可增删, 与扫描弹窗共用 this._modelDirs。
- nlp 段: 无已登记 nlp 模型 → 整段隐藏; 有才显示。
- 版本/更新判定 `_versionStatus`: 候选 vs DOWNLOAD_CATALOG —— 无已登记 → 「可下载/可登记」;
  已登记且文件在 → 版本 + 「已是最新」/「有新版 vX, 可更新」; 目录无该文件 → 老实「版本未知, 无法判断」。
- 0 结果给「去下载推荐模型」出口 (关弹窗开缺失引擎下载单)。

### #6(P2) 在线引擎: deepseek-v4-flash + L8② 整本外发 + 清除 key
- 模型预设 `deepseek-v4-flash` (OPENCODE GO OpenAI 兼容端点, 设置页预填 + 占位提示)。
- **L8② 整本外发入口**: 书卡 ⋯ 菜单「整本翻译/讲解(在线)」—— 未开② → toast 去设置; 开了 →
  用源译本估算全书外发量 (章/句/字数) 每本确认 → `book_online_translate` (spawn_blocking 逐句调
  `translate_book`, 清音频字段生成无音频"在线版"译本并登记)。
- 「清除在线引擎 key」按钮接 `credentials::delete_online_key` (去掉 dead_code), 清除后两档开关置灰 +
  状态显示未配置。

### #7(P2) R1 内置样书
- 向导完成页 ② 从「即将支持」置灰 → 可用: 点击 → `sample_book_import` (内置原创样书包写入书库输出
  目录 + 登记译本, 幂等) → 进书库, 样书出现可打开阅读。
- 阅读器 `_loadChapter` 对无音频章节 (audioFile 空) 跳过音频加载, 不报「音频加载失败」。

---

## 四、门禁结论

收尾 `check.ps1` **24 项全绿**:

```
schema:verify                          PASS
cargo fmt --check                      PASS
cargo clippy (baseline<=7)             PASS   (实测 7, 未升高)
cargo build --release                  PASS
cargo test --release --test-threads=1  PASS   (260 passed, 1 ignored)
pytest                                 PASS   (167 passed)
vitest                                 PASS   (124 passed)
node smoke (reader DOM 渲染路径)         PASS
node smoke (视图层)                    PASS
node smoke (契约: ui:no-silent-action)  PASS   (100 次点击)
node smoke (worker 协议 v1)             PASS
node smoke (VPS server.mjs)            PASS
node smoke (手机端 core+同步)            PASS
node smoke (手机端 browserAdapter+IndexedDB) PASS
node smoke (手机端 UI)                  PASS
mobile:build-version 一致性             PASS
mobile:version-bumped                  PASS
node import_old_aidu --self-test       PASS
test:no-prod-endpoint                  PASS
css:no-raw-hex / no-blk-texture / dashed-rule  PASS
contrast (WCAG AA >= 4.5)              PASS
全部通过
```

## 五、遗留与方向

- **真机最终验收**: 截图已用真实 Chrome 渲染生成 (教训 8 截图表), #3/#4/#7 判定链已用真实数据副本
  (Rust 单测 + 真机渲染) 验证; 剩用户真机点按 (整本在线翻译真实外发、多后端真实同步、整根迁移真实重启) 为最终验收, 见 U1。
- **#4 旧根残留**: Phase 2 只删 jobs_out/data.db/config.toml/models, 旧根空壳目录留待手动清理 (文档记录)。
- **#2 手机端语音**: 桌面 review_view 的降级 speechSynthesis 即"系统级"路径; 手机 PWA 有独立 app,
  若要手机端也加同款单卡/语音, 需另立卡 (本轮未动 cloud/mobile)。
- **M3 后续**: 断开同步目前只清当前生效后端那一格 + 老 V6 key; 按 (user, endpoint) 全量清需要枚举
  Credential Manager, 不在本轮。
- **截图脚本**: `scripts/ux5_screenshots.mjs` 可复用 (改 bridgeSource 的 handler 数据即生成新截图);
  踩坑记录: 向导"会前进"的按钮列表需排除「完成设置」(它直接 finish 不进完成页), 且导航按钮在异步
  重渲染中会短暂消失, 用重查+点击而非先收集后点。
