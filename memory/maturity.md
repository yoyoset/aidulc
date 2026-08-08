# aidulc 项目记忆 — M6 成熟度工程 (2026-08-08)

按全局 CLAUDE.md 框架记录。S5 阅读器记忆在 `memory/reader.md`, pipeline 在 `memory/pipeline.md`。

## 设计语言 (A)

- **决定**: 从 MD3 紫色 baseline 换成「暖纸 · 低饱和 · 陶土强调」—— 27 个 `--md-sys-color-*`
  role 名称保留(MD3 语义), 只重定取值, 全仓 CSS 不用改名即换肤。深浅色:
  浅 = 暖米纸 `#faf7f1` + 墨 `#3b352c` + 陶土 `#9c6a4a`; 深 = 暖炭 `#211f1b` + 提亮陶土 `#d9ae8c`。
- **为什么陶土不选绿**: sage 绿会与 `--md-sys-color-success` 撞色(成功徽章和主按钮分不清)。
  陶土温暖、书卷气, 与暖纸协调, 且不与语义色冲突。
- **坑**: elevation 用纯黑阴影在暖纸上发灰发脏 → 换深棕半透明 rgba(74,47,28)。state-hover 用
  陶土同源 rgba, 视觉与强调色一致。
- 阅读器 `--rd-*` 同步协调(浅色 accent 从蓝 #3f5d8a 换陶土 #9c6a4a, 深浅一致)。
- 导航从药丸按钮改文字页签 + 当前页陶土下划线(克制, 不抢正文)。
- 未做: 字号/间距令牌存量迁移(ROADMAP P4, 与设计无关的既有债)。

## Profile 档案系统 (D)

- **现状**: profiles 表此前空架子(F14), 导入卡硬编码 default/kid。M6 接全:
  - 迁移 v11 `INSERT OR IGNORE` seed default/kid 两个内建档案(幂等, 用户同名档案不被覆盖)。
  - 设置页"学习档案"区: 列表/新建/编辑/删除; 内建 default 不允许删(它是所有书的兜底)。
  - `import_service.getProfile(id)`: 查表取真实音色/策略/速度/粒度, 查不到回退内建 ——
    "每个人不同的英文库"从这里开始。
  - 书卡/导入卡显示真实档案名(`_profileName` 查表)。
- **F13 重试丢 profile**: `job_retry_failed` 原来硬编码 brief/af_heart/1.0。修法 =
  读 `job_dir/job_request.json` 里的 profile 快照(任务当年怎么配的), 抽纯函数
  `profile_from_snapshot(job_dir, profile_id)` + 2 个测试(kid 参数保留 / 快照缺失回退默认)。
- **F25 儿童模式**: 阅读器设置(字号/主题/粒度/儿童/显示模式)是用户级偏好, 一律读 'default',
  不再按书 profile 读 —— 否则 kid 书永远拿不到设置页写给 default 的儿童取值。
- **坑**: profile_delete 命令由 `every_frontend_invoke_is_registered` 锁定 —— 新命令必须同时进
  registry.rs 和 main.rs generate_handler!。

## 平台修复 (E)

- F30 最近阅读: 打开书时 `library_open`(touch last_opened_at) + 书库按 last_opened_at 降序。
- F34 拖拽重复: `_buildImportCard` 的 drag-drop 订阅存 `this._offDrag`, render 前注销。
- F33 prep 监听: 加 `prepView.cleanup()` 注销订阅, main.js 所有路由调用。
- F16 向导诚实: 第 4 步(模型发现)扫描命中即自动 register; 第 5 步(依赖)用 components_health
  真实状态, 缺的明确说缺, 不再硬编码"已就绪"假承诺。
- F18: 书设置弹窗 `appendChild(el(...).textContent && null)` 恒为 null 必抛 TypeError →
  修复为直接挂错误块 + 重试按钮。
- F27: 生词本"备份/恢复" —— transfer_export/import 接 UI(备份下载 .aidu-data, 恢复按
  updatedAt 合并)。
- F42: 装 tauri-plugin-opener + `.plugin(init())`, "打开日志文件"恢复(原 plugin 未注册必然失败)。
- F19: reqwest 补 native-tls(Windows schannel), https 下载链路打通(此前实测 TLS 层必断)。
- F41: 落盘 fire-and-forget 加 .catch 提示(reading_save/settings_upsert ×3)。

## F21 词典常驻守护 (性能)

- **问题实测**: 每次查词 spawn 新侧车重载 2.4GB 模型 → 冷 7.4s/热 5.7s/打包 8.6s。
- **方案**: 侧车 `--lookup-server` 模式(dict_server.py): 加载模型一次, 每行 stdin 一个
  JSON 请求, 每行 stdout 一个 JSON 响应 `{"ok":true,"result"}|{"ok":false,"error"}`;
  EOF 退出。模型懒加载(不查词不占显存)。
- Rust `infrastructure/dict_daemon.rs`: 全局 OnceLock<Mutex<Option<DictDaemon>>>(与 sync 的
  LAST_SYNC 同模式, 不穿透 State)。懒启动 / 120s 空闲重建 / 模型变化重建 / 阻塞读(EOF→Err)。
- **显存治理**: 任务启动单一 choke point `jobs::spawn::spawn_prep` 调 `dict_daemon::stop()`
  杀掉守护释放显存, 避免 LLM 双份驻留(架构已有"LLM/TTS 不能同时驻留"的 12GB 教训)。
- **坑**: 删掉旧的 `llm_dict_lookup`(spawn 单次)避免 clippy 死代码告警(基线 8 只降不升)。
- **残余风险**: 守护读响应是阻塞 read_line, 侧车挂死会阻塞查词(理论; 进程退出 EOF→Err)。
  加固留档: 读超时线程。
- **守护 ready 行坑**: dict_server 启动先写 `{"ok":true,"ready":true}` —— Rust spawn 必须消费掉
  这行, 否则第一个查询响应被 ready 顶掉, 首查必失败(抓到的实测级 bug, 已修)。

## R4-1 / R6-1 / F40 (候选缺陷防修, 未 exe 复现按静态取证修)

- R4-1 书签跨章串位: 书签下标只在当前章有意义 → 切章/搜索跨章/恢复切章一律 `bookmarks.restore([])`。
- R6-1 批次依赖会话内存: `batch_start_prep` 批次不存在时自动建单书批次(不再"批次不存在"报错)。
- F40: 词典查询失败文案区分"未配置"与"查询失败"。

## M7 主题自定义 (Round 1, 2026-08-08)

- **决定**: 主题 = mode(明暗) × palette(色系) 两维。`ReaderSettings.palette` 字段 + 迁移 v12。
  `tokens.css` 用 `body[data-palette]` + `[data-theme=dark][data-palette]` 覆盖强调色家族
  (primary + state + --rd-accent/reading-bg/mark); 纸面/墨色中性色全色系共享 —— 纸的底色是品牌。
  五色系: clay 陶土 / sage 青苔 / ocean 海蓝 / rose 蔷薇 / slate 灰蓝。
- **坑 (serde String 默认)**: `#[serde(default)]` 对 String 落 `""` 而非语义默认 → deserialize
  测试失败 + `default_display_mode/default_pace` 报"never used"警告。必须 `#[serde(default = "fn")]`
  引用默认函数。这是第二次踩同一个坑(S5 踩过又修过, M7 不知何故回到裸 default)——
  **教训: 任何 String 字段的 serde default 一律写函数引用, 写完后跑 deserialize 测试确认**。
- **级联候选 (下一轮)**: 主题色块可视化 / 自定义主题色 / 主题导入导出 / 对比度 AA 校验。

## M7 Round 2 主题色块可视化 (2026-08-08)

- 设置页 + 阅读器浮层的色系选择从文字下拉/_textRow 换成色块 chips(`--swatch-*` 令牌定义在
  tokens.css, hex 不出 tokens)。选中环 + hover 放大。设置页与阅读器交互统一。

## M7 Round 3/4/5 (2026-08-08)

- R3: 设置页字号/行距/栏宽改图形化档位(复用 `.rd-settings-*` 视觉), 消灭裸数字输入框,
  与阅读器浮层交互一致。
- R4: R2-1 同步断开落地 —— `sync_disconnect` command(删 token + 清 config.toml URL + 清内存态 +
  `reset_last_sync`), 设置页"断开同步"按钮(未配置禁用 + 确认弹窗)。同步从此可彻底撤销。
- R5: 生词本掌握度概览 —— 四阶段计数 pill(新词/学习中/复习中/已掌握, 各配语义色), 学习进度可见。

## M7 Round 6 对比度门禁 (2026-08-08)

- 实测抓出 3 处 WCAG AA 不达标: sage 浅色 primary/白字 4.40、阅读器 ink3 浅 2.90 / 深 3.25。
  修: sage primary #6a7f54→#61764c (5.00)、rd-ink-3 浅 #9a9287→#746f63 (4.72)、深 #746d61→#a29c8f (6.09)。
- **新门禁 `scripts/check_contrast.mjs`**: 直接解析 tokens.css(不复制值, 防漂移), 校验每个
  palette × mode 的 4 个 MD role 对 + 阅读器 ink×3, 共 46 项, 接入 check.ps1(10 项门禁)。
- **踩坑**: 解析 CSS 时注释 `/*...*/` 会混进 `[^{}]+` 的选择器, 让 `:root` 精确匹配失败 →
  全部 SKIP 假通过。必须先剥注释。这也是"写脚本但没先拿真实输出核对"的反例 —— 第一版
  `Select-Object -Last 8` 只看到 PASS 尾部就以为过了, 实际全是 SKIP。

## M7 Round 7 同步状态显示 Worker URL (2026-08-08)

- `SyncStatus` 加 `configured` + `worker_url`(masked, 前 24 字符 + …); 设置页状态行显示
  当前 Worker, 断开按钮用 `configured` 决定可用。
- **潜伏 bug 顺带修复**: R4 的前端用 `res.data.configured` 决定断开按钮可用, 但 SyncStatus
  此前根本没有 `configured` 字段 → 按钮永远禁用。R7 补上字段才发现 R4 的交互根本没生效 ——
  教训: 前后端字段契约要在一轮内闭环, 不能只改一端。

## M7 Round 8-11 (2026-08-08)

- R8 **R3-1 模型下载最小闭环**: 下载器已有断点续传+sha256, 缺的是编排。F19(TLS)M6 已修。
  两个模型 URL 用 HF API **实测验证**(不是猜): `Qwen/Qwen3-4B-GGUF` 的 Q4_K_M.gguf(2.5GB,
  sha256 7485...)、`hexgrad/Kokoro-82M` 的 kokoro-v1_0.pth(327MB, sha256 496d...)。下载命令改成
  **后台线程 + token 轮询**(`models_download_status`), 不冻结 UI; F4 动态超时(按规模 ≥600s,
  1MB/s 下限)。models_view 加"一键下载"区, 完成自动 register。
- R9 **R1-1 阅读位置恢复(P0)**: `player.loadChapter` 加 `audioReady` Promise(所有出口 resolve,
  含失败/竞态, 绝不挂死); `_restoreState` await 后 setPosition + 恢复锚点(reader + player 两个
  anchorIndex)到该位置所在句; F11 切章锚点归零; F8 pagehide/visibilitychange 落盘。
- R10 **R2-2 删死代码**: is_done / bundle_complete / book_bundle_complete 三处仅测试引用, 已删
  (含 TODO(未接线) 注释与测试断言)。TODO(未接线) 数量下降。
- R11 **README 刷新**: 功能亮点(三模式/主题/档案/一键下载/词典守护)、结构、启动、测试。
- **R3-1 残余**: 下载轮询间隔 2s; DOWNLOADS 注册表不清理(每次下载留一条, 可接受);
  NLP(spaCy)不在下载目录(是 pip 包, 另一套安装路径); 大文件下载期间换机/重启中断 → 断点续传
  .part 保留, 重点继续。

## M7 Round 12-15 (2026-08-08)

- R12 **下载进度**: downloader 改手动 Read 循环(128KB 块)替代 `resp.copy_to`, 加
  `download_with_progress(url,dest,sha,timeout,on_progress)`; `DownloadJob` 用
  `Arc<AtomicU64>` 共享 bytes_read/total; `models_download_status` 返回进度; 前端按钮显示
  `百分比 (已读/总量 MB)`。原无进度包装 `download` 已删(避免 clippy 死代码)。
  **坑**: 闭包 move 语义 —— 下载闭包与 job 构造共用 Arc, 必须 clone 两份, 否则 E0382。
- R13 **F26 CSP 拦插图**: tauri.conf.json CSP 加 `img-src 'self' data: blob:`(R4 插图此前被
  CSP 挡掉, 整条失效); renderer 的 `data:image/*` 换成按扩展名真实 MIME(`image/*` 不合法)。
- R14 **R1-2 生词高亮双键**: atomic_block 同时查 `seg.lemma` 与词面; reader_view 的 savedSet
  用 lemma+word 双键(flatMap)。变位词"became"(add_to_vocab 存词面, spaCy lemma=become)现在
  能高亮。DOM 冒烟加断言锁定。
- R15 **便携版重打包 (F36/F37)**: PyInstaller 重建侧车(含 dict_server, PyMuPDF 1.28.2 实测),
  组装 dist/aidulc-portable: 新 aidulc.exe(嵌新前端) + 新 prep/ + 干净 config.toml(无 F:/ 开发
  路径)。**坑**: 直接跑 build_prep.ps1 在 bash 工具 120s 默认超时下被 kill(构建要 ~10min),
  表现像脚本早退; 用 30min 超时直接跑 PyInstaller 才成功。构建本身没问题。

## M7 Round 16-18 (2026-08-08)

- R16 **摘录标注 backend**: 迁移 v13 建 `highlights` 表(book_key/chapter/sentence_index/
  selected_text/note) + `highlights_repo`(唯一写者, 按书列出/存/删) + 3 命令。130 Rust 测试。
- R17 **摘录标注 frontend**: 选中正文文字 → 浮动"摘录"按钮 → 保存; 句块加琥珀左标(`.highlighted`,
  与书签主色区分); Ctrl+K 命令面板加"📕 摘录"入口 → 面板列表(章/句序, 点击跨章跳转, 可删除)。
  精确到词范围的 span 高亮是后续工作(登记)。
- R18 **阅读进度+时长上架**: 迁移 v14 加 `reading_state.time_spent_ms`; player 播放计时(rAF 每帧
  累加, 暂停即停); `_saveProgress` 落盘 + 恢复; `library_list` 逐书附 `reading_chapter`/`time_spent_ms`
  (跨表只读 reading_state, N+1 但书量小); 书架卡显示"已读至第 X 章 · 已读 Y 分钟"。

## M7 Round 19-21 (2026-08-08)

- R19 **打开书并行化**: open() 的 4 个互不依赖 IPC(reading_get/highlights/settings_get/dict list)
  从串行 await 改 `Promise.all` —— 大书首屏不再等串行。`_generation` 竞态检查不变。
- R20 **下载任务硬化**: `DownloadJob` 加 `dest` + `done_at`(AtomicU64); 同 dest 下载中 → 复用
  token(防两个线程写同一 .part 损坏); 每次调用清理完成 >1h 的任务(内存不泄漏)。**坑**:
  AtomicU64 比较要 `.load()` 不能直接 `<`; i64/u64 混用要显式 cast; `3600_000` 下划线分组
  触发 clippy(clippy 9→8 靠改 `3_600_000`)。
- R21 **摘录精确 span 高亮**: 迁移 v15 加 `highlights.start_seg/end_seg`; 保存时用
  `range.intersectsNode` 收集选区覆盖的 seg 区间; atomic_block 对 [start,end] 的 token 加
  `.hl-span`(软黄底), 整句仍保留 `.highlighted` 琥珀左标; 冒烟断言锁定(seg 1-2 标、seg 0 不标)。
  131 Rust 测试。

## M7 Round 22-23 (2026-08-08)

- R22 **摘录备注**: highlights 面板每行加"加备注/改备注"(内联 textarea, Esc 取消, 保存 upsert),
  已有备注灰字展示。note 字段 R16 已建, 纯前端。
- R23 **主题自定义色**: 迁移 v16 加 `reader_settings.custom_color`; 纯函数 `reader/core/theme.js`
  `deriveCustomPalette(hex)` 从一个 #rrggbb 推导主色/on-primary(WCAG 亮度阈值 0.179 自动黑/白)/
  container/state/阅读 accent, vitest 5 例(含对比度断言); `_applySettings` 在 palette=custom
  时内联写 CSS 变量(不碰 tokens.css), 否则 removeProperty; 设置页 + 阅读器浮层加"自定义"彩虹
  chip + `<input type=color>`(仅 custom 显示)。62 vitest 绿。
  **坑**: 测试里 `('')['key']` 语法错误; 5 位 hex 不是 3 位缩写的合法形式(测试断言写错)。

## M7 Round 24-25 (2026-08-08)

- R24 **任务失败日志可读**: `job_detail` command 读 `output_dir/quality_report.json`
  (error 摘要/阶段统计/失败句数); prep_view 对 failed+partial 显示 error + "查看详情"模态。
  **取证**: run.log 侧车从不写(注释承诺但无 logging handler) —— 文档承诺没兑现的又一处,
  所以详情走 quality_report 而非 run.log, 已登记。
- R25 **F32 加词即时高亮**: `dictPanel.onVocabAdded` 钩子接线 —— 加词入生词本后, 正文里
  已渲染的匹配 token 立即加 `.saved` 下划线, 并并入 `_savedSet`(重开也保持)。不用重开书。

## M7 Round 26 (2026-08-08)

- R26 **run.log 兑现**: 侧车 `runner.py` 注释承诺"日志→run.log"但从未配 logging(已取证, 空承诺)。
  `Runner.__init__` 加 `_setup_file_logging`: FileHandler 写 `<out_dir>/run.log`, 挂在 `aidulc`
  logger 下(不污染 root), 防重复挂; `run()` 的 EngineError/Exception 路径 `logging.exception`
  落堆栈。Rust `job_detail` 现在返回 `run_log_tail`(尾部 60 行)作补充; prep_view 详情模态以
  monospace `<pre>` 展示。Python test_run_log 2 例(run.log 创建+写入 / 防重复 handler)。
  教训: "注释承诺"不可信 —— 这类文档说会写但代码从不写的东西, 只能靠实测/取证发现。

## M7 Round 27-28 (2026-08-08)

- R27 **通篇自动跟随滚动**: 通篇听读时当前句掉出视口才平滑滚回 40% 视口(保守, 完全在视口内
  不动, 不逐句跳)。之前 `_onReadingAnchor` 只设锚点不滚动 —— 连续听读会丢屏幕位置。
- R28 **工作树一致性审计**: 27 轮改动后清残留 —— `highlights.setForChapter`(已被 itemsForChapter
  替代)、`reader_renderer._showTranslations`(只赋值不读取)、`prep.css .prep-task-log`(F39 孤儿
  CSS, 无 JS 引用)。全仓 grep 确认无其它死引用。教训: 重构换 API 后要 grep 旧名, 靠编译器/门禁
  抓不到 JS 死代码。

## M7 Round 29-30 (2026-08-08)

- R29 **词典守护退出清理**: main.rs 从 `.run(context)` 改 `.build(context).run(|_app, ev| ...)`,
  `RunEvent::Exit` 时 `dict_daemon::stop()` —— 应用退出不留 2.4GB 模型后台进程。
- R30 **便携版重打**: R15 之后又加了 13 轮功能, PyInstaller 重建侧车 + 组装
  dist/aidulc-portable(新 aidulc.exe 24.7MB + 新 prep/ + 干净 config.toml)。侧车
  `--pymupdf-version` 实测 1.28.2。

## M7 Round 31 (2026-08-08)

- R31 **摘录跨设备同步**: .aidu-data v3 加 `data.highlights["highlights_<book_key>"] = [Highlight]`
  (纯增量键, aidu 只读 vocab/dictionaries, 未知键忽略, 版本不升不破坏兼容)。HighlightsRepo 加
  `list_all`; export 按书分组导出, import 按 id upsert(幂等); vocab_view 恢复 toast 显示
  生词/词典/摘录计数。132 Rust 测试(highlights 往返)。

## M7 Round 32 (2026-08-08)

- R32 **备料台按批次分组**: `_refreshJobs` 把任务按 `batch_id` 分组, 每组前加"批次 <id> · N 本"
  组头(未分组任务归"单本"); 单任务行构建抽成 `_buildTaskRow(job)` 方法(暂停/继续/重试/移除/
  打开/进度/阶段条/失败详情)。批量导入多本书时备料台不再平铺一片, 组别一目了然。

## M7 Round 33 (2026-08-08)

- R33 **词典守护主动空闲回收**: `DictDaemon` 加 `gen`(DAEMON_GEN 原子递增); spawn 时起
  watchdog 线程, 睡 IDLE_TIMEOUT 后若 registry 里还是同一 gen 的 daemon 且仍空闲(last_used
  旧)则杀掉释放显存。代际号防止误杀新 daemon(重启/模型变更重建后 gen 不同)。
  至此守护生命周期完整: 空闲主动回收 + 任务启动杀 + 应用退出杀, 不再"查过就占 2.4GB 到下次查词"。

## M7 Round 34 (2026-08-08)

- R34 **生词本每日积累条形图**: 纯函数 `core/vocab_stats.js` `dailyBuckets(entries, days, now)`
  (按天聚合, 未来/超窗不计入), vitest 5 例; vocab_view 渲染近 14 天 CSS 条形图(无图表库,
  height 按 count/max, hover 出日期+数)。坚持感可见 (Anki 贡献图/微信读书时长的激励逻辑)。
  坑: 测试模块级 `const DAY = S.DAY_MS` 早于 beforeAll → S 未定义崩溃, 改字面量;
  桶边界 `+1000ms` 跨到前一个桶, 断言写错。

## M7 Round 35 (2026-08-08)

- R35 **批次组头完成率**: prep_view 组头从"· N 本"改"· done/N 完成"(done/partial 计完成),
  批处理进度在组级别可见。R32 级联。

## M7 Round 36 (2026-08-08)

- R36 **README 最终刷新 + 全量验证**: 补上第 12-35 轮的功能亮点(自定义主题色/摘录标注/
  阅读进度反馈/下载进度/词典守护生命周期/每日积累图/批次分组/同步断开显示 Worker)。
  最终门禁 10 项全绿。

## M7 Round 37 (2026-08-08)

- R37 **阅读时长按日记录**: 迁移 v17 建 `reading_daily(book_key, day, time_spent_ms)`。
  `ReadingRepo::save_with_daily`(先算累计 time_spent_ms 增量, 记到当天, 重复存不累计) +
  `add_daily_time`/`daily_times`; reading_save 改走 save_with_daily; 新 `reading_stats` 命令
  返回近 N 天每日时长 + 今日累计; 阅读器顶栏显示"今日 X 分钟"。133 Rust 测试(增量/重复存/范围)。

## M7 Round 38 (2026-08-08) —— 修了一个空转已久的契约测试

- **关键发现**: `every_frontend_invoke_is_registered` 一直空转! 原因 = `b"invoke("` 是 **7 字节**,
  而扫描器写 `bytes[i..i+6]`(6 字节)且 `j = i+6` 指向 `(` 没消费 —— 切片与字面量长度不同,
  恒不相等, `invoked` 恒空, 断言恒过。**R0 声称它抓住过回归, 但之后某次改动把 7 写成 6,
  测试就永久空转了**。这类"测试存在但实际不跑"的坑, 只有给解析器加单测 + 对真实代码跑通才能暴露。
- **修复** (F29 一起): 命令名校验修 [i..i+7]+j=i+7, 并排除 node_modules(否则扫进第三方库的
  getBuiltins/fetchModule 误报); 新增参数名校验 `check_arg_keys`: 前端 invoke 的 camelCase 键
  经 camel→snake 必须覆盖 Rust fn 每个非 State/Option 参数, 否则断言失败; 键解析跳过 `:` 后的
  值(兼容嵌套/字符串)。**现在命令名校验真正在跑**(前端零缺失, R0 修复有效), arg 键校验也真实
  校验(全仓零不一致)。134 Rust 测试。

## M7 Round 40 (2026-08-08) —— 最终交付

- R40 **便携版最终重打 + 终验**: R31-R39 的 Rust/前端改动(reading_daily/本周图/arg 校验等)
  重新组装进 dist/aidulc-portable(新 aidulc.exe 24.8MB); 侧车 R30 后无 prep 改动, 保持当前
  (run.log + dict_server + PyMuPDF 1.28.2)。最终门禁 10 项全绿。

## 目标会话总结 (M6-M7, 40 轮)

40 轮全部在 `check.ps1` 门禁全绿下交付。最终态: Rust 134 测试 / pytest 160 / vitest 67 /
DOM smoke / 对比度 46 项 / 契约三端一致(命令名+arg 键真实校验) / clippy 8 基线内 / DB 迁移
v1-v17。覆盖: 设计语言(暖纸陶土)→主题(5 预设+自定义色)→三模式阅读器→Profile 档案→摘录
标注→阅读进度/时长统计→生词积累图→模型一键下载→词典常驻守护→同步断开→批次分组→任务详情
→便携版交付→修空转契约测试。下一步候选已在 ROADMAP: 书库封面/多语言/对比度门禁扩到自定义色。

## 测试计数 (2026-08-08 M6 后实测)

- Rust 128 全绿(`--test-threads=1`)、Python 158 全绿(test_dict_server +4)、
  vitest 57 全绿、DOM smoke 30 项全过。
