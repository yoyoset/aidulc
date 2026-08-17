# Changelog

> 本项目按"一次逻辑独立的大改动一个 commit"记录。近期变更在顶部。
> 项目初建时无版本控制(实测交付 3 本书后建立, 见 tag `v0.1.0-working-3books`)。
> 时间线中的 commit 名可 `git show <commit>` 查看完整说明。

## [Unreleased]

### fix: EPUB 解析质量 —— 三个静默丢内容的 bug(2026-08-16 ~ 08-17)

这一批的共同点是**都不报错**: 书能跑完、界面显示"已就绪", 但产出是残缺的。全部由
"拿 10 本真实书跑一遍再逐项核对"发现, 不是读代码读出来的。

**行内标签把句子切碎, 标签里的词直接消失**(影响面最大)

`_strip_tags` 把**所有**标签一律换成换行, 包括 `<em>/<a>/<span>` 这类**行内**标签 ——
它们出现在句子中间, 不是段落边界。拿 Charlotte's Web 开篇名句复现:

```
输入   '"Where is Papa going with that <em>ax</em>?" said Fern to her mother...'
旧输出 ① '"Where is Papa going with that'
      ② '?" said Fern to her mother as they were setting the table.'
```

一句变两个残句, 且 "ax" 被 `_is_real_sentence` 当碎片过滤掉, 从正文里彻底消失。约
**20% 的段落**含行内标签(Charlotte's Web 30/148, Hatchet 34/159), 下游翻译/讲解/配音/
对齐全都建立在这些残句上。

改成按 HTML 语义区分块级/行内: 行内标签去掉但不断行; 段落内部的源码换行/缩进压成空格
(calibre 那类把一段硬折成多行的 HTML, 光修行内标签仍会被源码换行切碎)。

10 本书前后回归(判据: 有内容丢失则字符数必降)——**非空白字符数 10/10 本全部增加,
无一减少, 合计 +13086**(Wild Robot +5957 / Wonder +2447 / Frindle +1679 / Holes +1392 …)。
章数两处 -1 都不是正文(一个出版社广告页、一个空章)。

同一根因还解决了两件事: Frindle 21 章标题全是 'Nick'(标题被 `<a>` 挤到下一行 → 全部
退回 TOC 兜底标题, 修复后标题去重 1 → 21); 以及 2026-08-16 为 Hatchet 试过又放弃的
"向后吸收下一行"启发式 —— 那个方案是在猜, 实测会误吞正文丢句。

**EPUB 路径未 URL 解码 → 95% 正文静默丢失**

TOC/OPF 里的 href 是 URL 编码的(`Chapter%201.xhtml`), zip 内真实成员名不编码
(`Chapter 1.xhtml`), 路径比对失败 → `_read_member` 静默返回空串 → 整章消失且不报错。
实测 Tuck Everlasting 丢了 25/27 章。归一化时加 `unquote`; `_read_member` 读不到时
记 warning 不再闷声吞。

**封面正则写死了属性顺序**

`<meta name="cover" content="id"/>` 的正则要求 name 出现在 content 之前, 但 XML 属性
顺序是任意的。实测 Winn-Dixie / Holes 写的都是 `<meta content="..." name="cover"/>`,
匹配失败 → 这两本没封面。改成两个顺序都认, 10/10 本都能解析出封面。

**另外两处**: 出版社宣传性尾页(致谢/花絮/书评摘录/预告/讨论指南)漏过滤, 被当正文
跑完整流程; 章节标题回退用"第几个产出的章"冒充真实章节号, 跟相邻真实标题的编号打架
(实测 Wild Robot 目录里 "17. Chapter 17" 后面紧跟 "18. CHAPTER 16"), 改成诚实的
`(Untitled)`。

### feat: 源书统一标准 S1-S6 + 导入时把关(2026-08-17)

以前"导入"只把文件路径登记进库, 完全不碰内容 —— 一本正文丢 95% 的书照样"导入成功",
要等用户点了开始处理、烧掉 parse 阶段才发现。

- `prep/aidulc_prep/core/standard.py`: 6 条判据的**唯一定义**(纯函数无 I/O)。
  S1 打不开 / S2 正文文件读取失败 / S3 章句规模 / S4 句数分布 / S5 章节标题可用性 /
  S6 前后言混入。三处复用同一份: 手动体检脚本、导入把关、备料 parse 拦截。
- `application/book_audit.py` + `cli.py --audit-book` + Rust `book_audit_sources` 命令 +
  前端 `core/import_gate.js`: 不达标的书**不进书库**(它们跑下去必然 parse 失败, 躺在
  库里只会让人以为"导进来了就是好的"); 有警告的照常导入只提示一句; 判不了的
  (非 EPUB / 侧车不可用)一律放行, 体检本身不许挡住用户。
- 阈值**按 10 本真实书标定**, 不是拍脑袋: S4 旧规则在 9/10 本上报警(异常率 0%~14.4%),
  报了等于没报 → 改成"严重异常无条件报, 普通离群占比 >20% 才报"; S5 补"标题去重数/章数"
  维度(Frindle 21 章标题全是 'Nick', 无题 0% 反而判达标)。
- `scripts/audit_sources.py`: 对书库里已登记的源书批量体检出表。

配套修复: 无 h1-h6 的整本书单文件兜底切分(实测 Frindle 整本正文在一个 124KB HTML 里、
零个 h1-h6, 二次切分找不到边界 → 退化成 1 章 675 句, 阅读器无法按章导航; 用
`<p class="ChapterTitle">` 这类 class 命名兜底, 严格限定在"一个 h1-h6 都没有"时启用)。

### feat: 讲解字数可调 (K33) + 讲解截断修复(2026-08-16)

- 实测 Wonder 一书讲解**中位 512 字符**(原文的 10.7 倍), 逐句核对发现约 93% 是开场白/
  复述常识/总结陈词/记忆口诀。学习档案新增 `explain_max_chars`(50-300 可选)和
  `explain_min_sentence_chars`(讲解触发门槛, 短句不值得讲), 提示词里明确禁止那几类
  跑题内容。同书对照: **512 → 59 字符, 超限率 0.11%**; explain 单次耗时也从此稳定在
  1.0-1.5s(耗时基本正比于生成 token 数)。
- 修 explain 阶段的截断即永久失败: deep 策略提示词要求"讲得啰嗦一点没关系", 而
  `max_tokens` 默认 400 → 长讲解在 JSON 右花括号写完前被截断, 且单次调用不重试。
  实测 Wonder 2983/7357 句全部报"讲解 JSON 解析失败"。改成首次 700 tokens、失败用
  1100 重试一次(致命错误不重试)。

### feat: 重跑与任务 UX(2026-08-17)

- 「重跑…」+「重试失败句」两个并排按钮**合并成单一「重新处理…」**, "只补失败句"降级成
  对话框里的默认重跑范围。入口从 failed/partial 扩到 done 和 **paused**(暂停恰恰是最
  需要改设置的时刻)。
- 对话框可**重选学习档案**(此前只能换模型, 改档案得回书库重建译本 = 整本重跑)。
  换档案**不改 book_id** —— 那是"就地改设置重跑", 不是"生成另一本书"。
- 新增 `reader/core/rerun_scope.js`(零 DOM 纯逻辑): 按"改了什么"推导够用的**最小**重跑
  范围 —— 分词变→全部, 翻译引擎变→从翻译, 只改讲解三字段→从讲解, 只改音色/语速→从语音。
  用户手动选过之后不再被联动覆盖。
- 生词本「补全发音」从前端 `for` 循环(无任务/无进度/无取消/切页就断)改成 **Rust 侧
  后台任务**, 在"处理中"页有独立进度行和取消按钮。刻意**不进 jobs 队列**: 那条队列是
  "一次只跑一本书"的严格串行(显存安全), 而补发音走常驻语音守护, 塞进去会排在几小时
  备料后面。计数分三档报(新合成/已有缓存跳过/失败)—— 跳过是幂等命中不是失败。
- 「最近完成」的判据从"完成时间是不是今天"改成**按条数**(默认 20, 可选 10/20/50/全部)。
  旧判据下昨晚 23:59 跑完的书今天 00:01 打开就进历史了。
- 书库卡片"紧凑/大图"改为持久化(原先是纯内存状态, 切页即回退)。

### perf: 书库页封面只读文件头(2026-08-17)

书库列表为了取一个封面文件名, 走的是整份读 + 整份 JSON 解析。实测 bookpack.json 一本
**5-39 MB**(Wild Robot 39.2 MB), 10 本合计约 **154 MB**, 每次打开书库页都来一遍 ——
而 `cover` 是顶层字段, 就在**第 252 字节**。改成只读文件头 64KB 扫描; 原版分支顺带
修掉一处对同一份文本的**两次**完整解析。

### fix: 「补封面」入口从写出来就点不到(2026-08-17)

K12 把这个入口只写进 `library_view` 的 `kind === 'product'` 分支, 而 `main.js` 全项目
只挂了 `new LibraryView(store, 'original')` 一个视图 —— 那个分支在 UI 上根本到不了。
接到「创建译本」旁边的 `⋯` 菜单里; 封面属于译本不属于原书, 所以目标是第一个缺封面的
译本。补 4 条 smoke 断言锁定"点得到", 防止再退化成不可达。

### chore: 成熟度审计 K1-K32 + 文件规模治理(2026-08-13 ~ 08-15)

九个功能域逐域审计(书库/封面、阅读器、生词与词典、摘录笔记、同步、模型中心、备料流程、
设置、多用户), 共记录 30+ 条缺口并按 K 编号逐条落地, 其中值得单独一提的:

- **K3**: 单句 TTS 失败拖垮整本 pack(句子 audio 校验不许 null)
- **K5/K8**: 阅读进度/阅读器设置硬编码 `default` 档案, 多用户共享设备会串数据
- **K14**: `cancel_prep_job` 只杀进程不写库 → 留幽灵任务
- **K21**: 生词本不再跟着阅读档案分区, 独立成个人词典
- **K29/K32**: 生词发音接常驻本地 TTS 守护 + 增量预生成缓存
- **文件规模门禁**: `scripts/check.ps1` 新增 `file-size` 一项(默认上限 600 行, 正当例外
  登记进 `scripts/file_size_baseline.json`, **只能降不能加**)。据此拆分了
  `commands/reader.rs`(1710 行 → 5 个按域文件)、`commands/vocab.rs`、`commands/misc.rs`、
  `settings_view.js` 的巨型 `render()`(1178 行 → 5 个 tab 子模块)等。

### chore: 性能取证(2026-08-16)

给 translate/explain/tts 每次真实模型调用加计时探针(写进 `run.log`), 据此**更正了一个
错误判断**: 原以为"批量化是最大杠杆", 实测 explain:translate 的耗时比(28.6x)与输出长度比
(27x)几乎完全一致 —— 耗时正比于**生成的 token 数**, 不是调用次数。真正的杠杆是把讲解
写短(即 K33), 而不是攒批。分析见 `docs/GOAL_2026-08-16_PERF.md`。

### chore: 跑批观察日志(2026-08-17)

10 本书连跑一夜, 每小时抽查一次, 记录在 `docs/WATCH_2026-08-17.md` +
`scripts/watch_run.py`(只读体检脚本)。这份日志里保留了**两次自我更正**:
用文件 mtime 判断 checkpoint 内容新旧不成立(重跑时 translate 会重写整个文件, 刷新 mtime
但保留旧 explanation), 正确判据是本轮 explain 调用次数 vs 讲解条数; 以及"字数上限=0"
是脚本的显示问题(键缺失时 `.get` 默认 0), 不是配置成 0。

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
