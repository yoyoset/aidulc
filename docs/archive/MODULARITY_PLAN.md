# aidulc 模块化重构计划 (M 系列: 按软件成熟度/专业度)

## 0. 状态: 全部完成 (M1~M5 + P1~P8 + R1~R6 + S1~S7)

**最终门禁: Rust 97 / Python 126 / 前端 29 文件全绿; portable 已重新打包 (11:33)。**

资产模型重构 (S1~S7, 三模块架构: 书库/阅读准备/完成库):
- S1 数据层: books.source_book_id (v8) — 成品关联原书; register_book 记录本次处理模型快照
  (llm_id/tts_id/nlp_id, 资产键: 不同模型=不同资产); 原书状态=投影 (不重复存储)。
- S2 进度算法: jobs.progress (v9) — 后端算全书完成度 (7 阶段权重均分), 前端只显示。
  实测: translate 151/5352 → p=29 (之前显示 0%)。
- S3 校验前置: preflight_check 补 ffmpeg/侧车文件性检查; "开始处理"前全量校验。
- S4 原文预览: cli.py --preview-book (复用 loader) + library_preview 命令 + 书库"预览原文"模态
  (打开的是原始书籍); 修 Windows GBK stdout 编码 (sys.stdout.reconfigure utf-8)。
- S5 完成库: 成品卡模型标签 (不同模型=不同资产可视)。
- S6 渲染优化: atomic-block content-visibility: auto (Chromium 原生, 870 句章节不卡)。
- S7 验收: CDP 实测 预览 41 章/进度 29%/任务健康推进 全通。

域分离重构 (R1~R6):
- R1 两段式: `batch_import` (只登记书 pending, 不自动处理) + `batch_start_prep` (前置检查→入队)。
  导入不再 pump_queue — 用户明确"开始阅读准备"后才处理。
- R2 前置检查: `preflight_check` (书文件/模型注册/模型文件/侧车) 结构化原因;
  `preflight_batch` 分区 (可入队 vs 跳过+原因); 组件健康检查缺失时显示预期路径。
- R3 暂停/继续: Job 状态机加 `paused`; `job_pause` (运行中 kill 子进程/排队移出) + `job_resume` (paused→queued 续跑);
  `pause_all`/`resume_all`; pump_queue 收尾不覆盖 paused; 队列跳过 paused。
- R4 书库: 待处理/失败书卡"开始阅读准备"按钮; 检查失败 → 可读原因 + 跳转模型中心; 筛选补 failed。
- R5 阅读准备: 7 阶段流水条 (识别→分词→翻译→讲解→语音→对齐→排版, 已完成✓/当前高亮/未到置灰);
  单任务暂停/继续; 全局全部暂停/继续。
- R6 验收: CDP 实测 导入→0 任务→书 pending→开始准备→enqueued→running→暂停→paused→继续→running→done→
  阶段流水条 7 段/全部控制/书库按钮 全通。

苹果级闭环 (P1~P8):
- P1 后端: 导入即登记书 (pending 状态, 书库立刻可见);
  `resolve_for_book` 书级绑定优先 → 语言全局推荐回落; `models_book_binding` 读接口。
- P2 全局组件: `toast.js` (成功/失败/信息, 自动消失可堆叠) + `modal.js` (遮罩/Esc/焦点)。
- P3 书库: 书卡状态徽章 (就绪绿/部分失败黄/处理中蓝/待处理灰) + 打开禁用 (处理中) +
  删除模态 + 书设置弹窗 (语言 + LLM/TTS 覆盖, 默认跟随全局) + 导入 toast 反馈。
- P4 阅读准备: 空态引导 (去书库) + 任务状态色 + 失败重试按钮可见 + 批次进度百分比。
- P5 阅读器: 进度保存节流 3s→2s + cleanup flush + 词典失败可重试 + Blob revoke (已有)。
- P6 模型中心: 推荐徽章 + 缺模型引导 + 注册/扫描 toast (去 alert)。
- P7 生词本: 空态三步引导 (打开书→点词→加入) + 删除模态 + 导出 toast。
- P8 验收: CDP 实测 导入→pending 书卡→处理→done→就绪徽章→设置弹窗 (模型下拉跟随全局+注册模型) 全通。

M5 单一真相源 (模型架构修复):
- 问题: 模型状态两套 (SQLite model_registry + config.toml), 写入在注册表、读取在 config.toml →
  "模型中心有, 设置页组件检查缺失, 导入报缺模型"。
- 决策: **model_registry 是唯一模型真相源**; config.toml 模型字段删除 (llm_model_path/tts_model_path)。
- 实现: `model_service::resolve_paths(db, lang)` 从注册表推荐 (active) 解析 llm/tts/spacy;
  components_health / runtime_config / word_lookup / batch_start 前置校验全部改走 resolve_paths;
  batch_start 缺模型时用注册表补全再校验;
  PrepConfig 删 llm_model/tts_model 字段; config.rs 删模型字段。
- 书级绑定 (models_bind_book) 已存在, 书语言+模型跟随书 (bookpack source_language/llm_id/tts_id), 是默认推荐的覆盖层。

完成记录:
- M1 Rust: 同步三套 → 唯一 (application/sync_service + domain::merge_envelopes 接线 + to_envelopes);
  now_ms 统一 store::now_ms_for_store; config.toml 单一写者 (services::config, 命令层不再落盘);
  bookpack 登记提取 application/library_service.rs 共享 (jobs + library 两处重复消除);
  main.rs 3 命令移出 commands/misc.rs; 硬编码 F:\hf_cache 路径清除;
  死代码清理 (scan_model_pool/list_payloads/PrepSpawn/sync_merge)。
- M2 前端: bridge 纪律恢复 (删死命名组 prep/vocab/dict/sync; 新增 pickFiles/openPath;
  4 处直连 __TAURI__ → bridge; 视图裸 invoke → service);
  新增 settings_service/reading_service/misc_service; library_service 补 readAudioRange;
  dictionary_service 补 vocab 域; prep_view 死代码 (_startBatchImport/_profile/_addTaskRow/getModels 悬空) 清理;
  reader_view 调试全局 (__aidulcAudio) 移除; shell_view 死构造参数清理。
- M3 Python: runner 提取 nlp/stage.py + align/stage.py (四阶段对称: llm/tts/nlp/align);
  FATAL_STAGES 收敛 core/models (checkpoint 引用); AIDU_POS 收敛 (pos_map 引用);
  echo 检测收敛 batch.looks_untranslated; 围栏剥离收敛 llm/json_util;
  dict_lookup 归位 application/ + __init__.py 补齐; txt 归位 loader/txt.py;
  guard_batch 接线到 batch retry 流; tts 走 registry.create_engine;
  死代码清理 (EXPLAIN_SYSTEM/stop_engine/iter_txt_chapters/format_job_failure 壳)。
- M4 规范: reader.css 去 body 重复定义; 全量门禁 + CDP 全流程 + 重新打包。

---

## 1. 审查结论 (三端 explore 代理 2026-08-04)

分层意图均存在(commands→application→domain/store/infra、services→views、core→pipeline),
但**分层纪律执行不严**:重复实现、死代码、上帝文件、领域规则被绕过。

### 结构性债务 (按严重度)

| # | 位置 | 问题 | 等级 |
|---|---|---|---|
| 1 | Rust 同步三套 | `ipc/commands.rs:88-149` / `application/sync_service.rs` / `commands/reader.rs` 逐行重复推拉; `domain::merge_envelopes` 有 6 测试却被绕过 | P0 |
| 2 | `commands/reader.rs` 16 fn × 6 领域 | 查词/生词/词典/同步/书签/日志混装; `sync_config_set` 内联写 config.toml 绕过 services::config | P0 |
| 3 | `commands/jobs.rs::pump_queue` 184 行 | 调度+spawn+解析+DB+广播+登记全塞一个函数 | P0 |
| 4 | bookpack 登记两处重复 | `commands/jobs.rs:388-420` vs `commands/library.rs:110-158` | P0 |
| 5 | `now_ms()` 三份 | store_mod / jobs / library; models.rs 跨命令引用 | P0 |
| 6 | main.rs 3 命令 + 硬编码路径 | `runtime_config`/`components_health`/`boot_ping` 定义在 main; `F:\hf_cache\...gguf` 硬编码 | P0 |
| 7 | 前端 bridge 门面三套 | bridge 命名组(一半死代码)+ services 薄透传 + 视图裸 invoke(6 处)+ 直连 __TAURI__(4 处) | P0 |
| 8 | `reader_view.js` 517 行 × 10 职责 | 播放/搜索/书签/词典/进度/渲染全混; `window.__aidulcAudio` 调试泄漏 | P0 |
| 9 | Python `runner.py` 职责过载 | nlp/align 实现内联(与 llm/tts stage 模式不对称); 语言解析复制两次 | P1 |
| 10 | fatal 阶段规则跨层复制 | `core/models.py:mark_failed` vs `infra/checkpoint.py:save_stage_result` | P1 |
| 11 | 死代码 ~15 处 | sync_merge/to_envelopes/scan_model_pool/list_payloads/getModels(悬空)/guard_batch/create_engine/iter_txt_chapters 等 | P1 |
| 12 | 重复实现 ~9 处 | echo 检测/静音生成/POS 枚举/```json 围栏剥离/翻译 prompt/子进程 spawn 模式 | P1 |
| 13 | `dict_lookup.py` 根目录 | 应归 application 层; ```json 剥离与 llm/stage 重复 | P1 |
| 14 | `loader/txt.py` 伪模块 | txt 逻辑写在 __init__ 分发器里 | P2 |
| 15 | CSS 重复/错位 | body 重复定义、dark token 分家、library.css 名不副实 | P2 |
| 16 | `application/` 缺 __init__.py | 全包唯一不一致 | P2 |

## 1. 目标结构 (重构后)

### Rust: 命令层按领域拆分
```
commands/
  library.rs      # 书库: list/register/remove/open/load_bookpack/pick_files
  jobs.rs         # 任务/批次: start/batch/pump/retry/cancel
  models.rs       # 模型: list/register/scan/download/hardware/wizard
  reader.rs       # 阅读: bookpack/audio/settings/reading/书签
  dictionary.rs   # 词典/生词: word_lookup/add_vocab/dict_*/vocab_*
  sync.rs         # 同步: status/now/pull/config (统一走 application::sync_service)
  misc.rs         # runtime_config/components_health/boot_ping/log_* (从 main.rs 移出)
```
- 同步推拉**唯一实现**在 `application/sync_service.rs`, 接线 `domain::merge_envelopes`
- `services::config` 是 config.toml 唯一读写者
- `now_ms()` 统一到 `store::now_ms_for_store()`
- bookpack 登记提取为 `application/library_service.rs` 共享

### 前端: 消除第三套门面
- `ipc/bridge.js` 只留 `invoke`/`listen` 底层 + 每域一个命名组(与 service 一一对应)
- 新增 `services/settings_service.js`、`services/reading_service.js`
- 视图禁止裸 invoke / 直连 __TAURI__ (4 处直连改走 bridge)
- 死代码: bridge 的 prep/vocab/sync 组、prep_view 悬空 getModels/_startBatchImport/_addTaskRow
- `reader_view.js` 拆分: `services/audio_service.js`(分块音频)+ `services/reading_service.js`(进度)+ 书签面板已独立; 移除调试全局

### Python: 阶段对称 + 规则单一
```
pipeline/nlp/stage.py    # 从 runner 提取 (对称 llm/tts stage)
pipeline/align/stage.py  # 从 runner 提取
application/dict_lookup.py  # 从根目录移入
```
- fatal 规则收敛到 `core/models.py`, checkpoint 只读规则
- POS 枚举、echo 检测、围栏剥离、静音生成各一份
- txt 逻辑归 `loader/txt.py`
- 死代码删除或接线(guard 防线接入 batch 重试流 / language_registry prompt 接入)

## 2. 执行顺序 (每步门禁全绿 + CDP 回归)

- **M1**: Rust P0 — 同步统一 + commands 拆分 + now_ms + config 单一写者 + main 命令移出 + bookpack 登记共享
- **M2**: 前端 P0 — bridge 纪律 + services 补全 + 视图改道 + reader_view 拆分 + 死代码清理
- **M3**: Python P1 — runner 提取 nlp/align stage + 规则收敛 + dict_lookup 归位 + 死代码清理
- **M4**: 规范 — txt 归位 + __init__.py + CSS + 调试残留 + 全量门禁 + CDP 全流程

## 3. 验收底线
1. Rust 测试不减反增 (重构中补"重复消除"回归测试)
2. 前端 0 处直连 __TAURI__ / 0 处视图裸 invoke
3. Python 阶段模块四对称 (llm/tts/nlp/align)
4. 全量门禁绿 + CDP: 向导→导入→处理→阅读→查词→生词本全流程
5. 死代码清零 (grep 无定义无调用)
