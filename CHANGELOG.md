# Changelog

> 本项目按"一次逻辑独立的大改动一个 commit"记录。近期变更在顶部。
> 项目初建时无版本控制(实测交付 3 本书后建立, 见 tag `v0.1.0-working-3books`)。
> 时间线中的 commit 名可 `git show <commit>` 查看完整说明。

## [Unreleased]

### feat: 书籍主流程重构(按 docs/BOOK_WORKFLOW.md, 2026-08-09)

用户实测反馈的三件事(导入疑似重复 / "开始阅读准备"边界混乱 / 打开大书卡死)驱动了这次
全流程重构。以 `docs/BOOK_WORKFLOW.md` 为基线文档, 阶段 0 先真实 exe 取证(报告见
`docs/FORENSIC_P0.md`), 再按阶段 1-7 逐步落地。

**导入(阶段 2)**
- `batch_import` 后端拆出可测的 `register_import_batch`(不需要 AppHandle): 同一路径同一
  profile 重复导入**只登记一条 source**, 二次进入 `skipped`; 全跳过时不建无意义批次。
  返回 `{batch_id, registered[], skipped[]}` 供前端提示。
- 前端 `core/import_guard.js`(纯逻辑, 可单测): `ListenerSlot` 单一槽位管理拖拽监听
  (重渲染/离开页面不累积, 修复 F34 顺序 bug——原先注册新监听后立刻被 render 里
  `_offDrag()` 杀掉); `ImportDedup` 短窗口去重(单次拖拽/连续点击只触发一次导入)。
- source 卡**不可直接打开阅读**(原书只是来源); 主动作统一为"创建译本"; 文案改为
  "已导入原书, 下一步创建译本"。
- 配套测试: `import_same_path_twice_yields_one_source_and_skips_second`(Rust)、
  `import_guard.test.js`(ListenerSlot 3 条 + ImportDedup 3 条)。

**阅读卡死(阶段 3)**
- 取证(Wolf 21 真实书包 23.88MB): `load_bookpack`/`load_bookpack_chapter` 每次请求都整文件
  读 + 全量 JSON 解析(实测单次 open ≈470ms、每切一章 ≈419ms)。新增
  `infrastructure/bookpack_cache.rs`: 按包目录缓存解析结果, `load_bookpack` 写入、
  `load_bookpack_chapter` 优先取缓存; 删除 edition/source 时失效。
- 阅读器加载态补齐: 书包/章节加载失败显示可读错误 + 重试 + 返回书库(`_showReaderState`),
  后端失败不再落空白页; 音频加载失败经状态条可见。
- 回归测试: `bookpack_path_tests`(真实书包解析 + 缓存复用 + 失效)、
  `reader_state_ui.test.js`(loading/error/retry/back)。

**译本配置(阶段 4)**
- source 卡"创建译本"进入配置面板: 学习档案 / 源语言 / 目标语言 / LLM / TTS, preflight
  失败留在面板显示原因 + 下一步, 不假成功。
- 模型快照从 job_request.json 读入 edition(此前空串导致不同参数塌缩成同一 edition)。
- 相同参数组合覆盖原 edition 且保留稳定 id; 不同参数组合生成多个 edition; 每个 edition
  独占 pack_dir。
- 配套测试: `same_params_overwrites_edition_keeping_stable_id`、
  `different_params_create_multiple_editions`。

**流程/契约细化**
- 迁移 v19: jobs 表新增 `source_id` 列并回填(book_path 精确匹配 books.source_path),
  `batch_start_prep`/`start_prep_job`/`batch_start` 建 job 时显式写 source_id
  (BOOK_WORKFLOW §2.3); `delete_source` 按 source_id 级联清 job, `cleanup_orphans` 认
  source_id 锚。真实 DB 已迁移 v19 且回填正确。
- `add_vocab` 接受可选 context 并持久化(生词本词条卡显示来源句, 设计交付 §04);
  重加不覆盖旧上下文。
- 失败任务详情模态新增"复制日志"动作(设计交付 §03 失败三动作)。

**设计交付(阶段 6, `完整设计交付确认/`)**
- 令牌层: `--rd-grain-*` 纸纹、`--md-sys-motion-*` 动效、`--md-sys-radius-xl` 标废弃;
  app.css `body::before` 纸纹单一实例(深色换暖灰)。
- 导航三层结构(左 我的书·生词本 / 右 导入·处理中(n) / 最右齿轮, 处理中徽章常驻);
  models 路由并入 settings(旧路由保留重定向)。
- 书库状态分段筛选(全部/已就绪/处理中/未处理)带计数; 跟读新增第四个预设「孩子」;
  生词本每日图表只有当天用强调色。
- 新 lint `css:no-blk-texture`(atomic-block 禁 backdrop-filter/background-image)。

**用户视角细化(阶段 7)**
- `docs/UX_REQUIREMENTS.md`: 6 组 30+ 条需求明细; 落地快赢项(库刷新即时化 / prep 用
  edition_id 不再重算 book_id / 模型路径只显示文件名 / done→已就绪徽章)。

**文档**
- 新增 `docs/FORENSIC_P0.md`(阶段 0 取证报告, 更新 F45/F46)、`docs/ACCEPTANCE_P5.md`
  (真实 exe 验收 10 条, 9/10 已实测 + GUI 复核清单)、`docs/UX_REQUIREMENTS.md`。
- README 同步更新(见下)。

**验收(阶段 5)**
- 真实 exe 冷启动多次验证, 抓到并修复 2 个前端 bug: `import_guard.js` 未注册进 index.html、
  `shell_view.js` 重构时误删 nav 根节点。门禁 `scripts/check.ps1` 11 项全绿
  (Rust 150 + 前端 85 + DOM smoke + css lint + contrast)。

---

## v0.1.0-working-3books(2026-08-07 基线)

首次建立版本控制前的实测交付: 3 本书(Number the Stars / Breath / Hitchhiker's Guide)跑通
全流程。建立后逐步补齐:

- **P0-P1**(2026-08-07): 书库路径锚定 exe_dir(合并 library_dir/out_dir 两个不同步概念)、
  书库位置可见可改 + 书包导出/导入为 zip。
- **S1-S3**(2026-08-07): 契约同步可校验(sync_schema.ps1 -Verify)、令牌层地基(颜色清零 +
  字号/间距阶梯)、命令注册表可审计。
- **S2.1**(2026-08-07): commands/jobs.rs 业务编排拆到 application/job_orchestrator.rs。
- **916534b**(2026-08-07): 大书打开卡死修复 —— load_bookpack 只回元信息 + 按需单章 +
  章节渲染分帧(真实 92MB Hitchhiker's 撞见)。
- **R0-R4**(2026-08-08): 阅读链路修复(模块化拆分/渐进渲染/书签/搜索跳转/播放锚点) +
  格式兼容(EPUB2 toc.ncx 回退/PDF) + 插图链路; build.rs 前端 rerun-if-changed。
- **F38/F39 登记**(2026-08-08): EPUB2 toc.ncx 书丢掉绝大部分正文(实测 11953→331 段) +
  处理前体检对此无效。
- **786ca83**(2026-08-08): M6 成熟度(MD3 紫 → 暖纸陶土设计语言 / Profile 系统 / 词典常驻
  服务 / 平台修复) + M7 个性化(6 套调色板 / 摘录标注 / 一键下载引擎 / 主题自定义) +
  S5 三模式阅读器。门禁新增 node smoke + contrast。
