# aidulc 项目记忆 — 流水线 (prep pipeline)

按全局 CLAUDE.md 框架记录本项目维度现状、权衡、坑。以实测为准。

## 配置管理

- 用户可调参数: profile(id/voice/speed/explain_strategy/highlight_granularity) 存 DB books/profile, job_request.json 快照传给侧车。侧车不读 UI 状态, 只吃 job_request 快照 — 职责清晰。
- ffmpeg 运行时依赖: 环境变量 AIDULC_FFMPEG > PATH > 开发机兜底路径 (pack.py::find_ffmpeg)。侧车不捆绑 ffmpeg (spec 注释: 外部工具不打包)。
- 模型路径: job_request.json 的 models.llm / models.tts 绝对路径。kokoro 是唯一 TTS 引擎 (词级时间轴零成本); ggml-large-v3 是 Whisper 识别模型 (别处用的, 不可做 TTS); ggml-silero 未适配。

## 外部系统集成 (ffmpeg / 子进程)

### 已踩坑 (2026-08-07, 全部实测复现)
1. **ffmpeg concat 大量输入段卡死**: 645+ wav 一次 concat 600s 超时无输出。分块修复: 每 100 个 wav 一批 (强制 `-ar 24000 -ac 1` 转 pcm_s16le) → 再合并中间文件 → opus。
2. **大章 libopus 编码超时 (新坑, 比 1 更隐蔽)**: Hitchhikers ch005 (3972 句 ≈ 4.7h 音频, 814MB pcm) 最终合并 40 个 mid → opus 卡死。**实测不是卡死是慢**: 编码速率 ~55x 实时 (4000B/s opus vs 48000B/s pcm), 4.7h 需 ~280s > 180s 超时 → 被 kill 留下部分产物 (38MB vs 完整 63MB)。Breath 最坏章只有 68 分钟音频, 180s 够, 所以之前没暴露。修复: 超时按输入规模动态 `max(300, total_sec/55 + 120)`; 产物先写 `.tmp.opus` 再 rename (失败不留部分产物, "存在即完整"供跳过复用)。
3. **`.tmp` 扩展名陷阱**: ffmpeg 按输出扩展名推断 muxer, `ch_005.opus.tmp` 无法识别 → "Error initializing the muxer... Invalid argument" 退出码 -6 (0xFFFFFFFA)。修复: 临时文件命名 `xxx.tmp.opus` (以 .opus 结尾)。**教训: 给 ffmpeg 的任何路径, 扩展名必须能推断格式**。
4. **进度 total 写死 1**: pack 的 stage_progress total=1 但 current 按章递增 → 显示 5/1。修复: total=len(chapters)。stage_start 同步修。

### 已完成的章跳过 (2026-08-07)
- 重试时 pack 全量重编码 38 章 = 2-3h, 用户感知"又停了"。修复: `_chapter_opus_ok` 校验 opus 大小 ≈ wav 总量/12 (32kbps vs 48000B/s) 且 ≥90%, 通过则跳过编码直接 emit 进度。已完成的章秒过。
- 注意: 小章 (<0.15MB opus) 判定临界会重编码, 无害 (1-2s)。

## 状态管理 (checkpoint / 句子生命周期)

- 每句一个 checkpoint JSON (checkpoints/chXXX/sNNNNN.json), 逐句原子落盘。阶段: parse → nlp → translate → explain → tts → align → pack。
- hydrate: 重试时把 checkpoint 的 translation/explanation/audio/words 重新载入内存句子。
- **对齐风险 (2026-08-07 审计当天已修)**: nlp 的 `_has_content` 过滤碎片句 (字母<3 的孤立标点) 会改变句子总数。实测 Hitchhikers 差异句全在**章尾** (前缀完全匹配), hydrate 按位置加载曾经安全, 但这是运气不是保证——若某书碎片句在**章中间**, 位置会错位 → 音频时间戳错乱。
  修复: `pipeline/nlp/stage.py` 新增纯函数 `reconcile_position_checkpoint(existing, new_original_text)`, 在写 nlp 产物前比对该位置旧 checkpoint 的 `original_text` 是否等于这次解析出的文本, 不等则判定"这个位置换了句子", 旧的 translation/explanation/audio/words 不能沿用。
  **踩了一个连带坑**: 第一版实现只在内存里把 `existing` 清成 `{}` 再传给 `save_sentence`——但 `save_sentence` 是"读磁盘旧内容 + `dict.update()`"合并语义, 不出现在传入 dict 里的键会保留磁盘原值, 所以内存清空**不会**清掉磁盘上的旧字段, 是空转。用 `test_reconcile_then_overwrite_roundtrip` 测试真的写盘再读回来才发现（先故意验证坑存在, 再验证修复生效)。修复: `checkpoint.py` 新增 `overwrite_sentence`(整体替换, 不合并), 冲突路径专用; 无冲突路径继续用 `save_sentence`(合并), 否则会破坏"重试只补失败阶段"这个更重要的既有语义。
  测试: `prep/tests/test_g2_checkpoint.py::TestPositionReconciliation`(6 个用例, 含正例/反例/向后兼容/端到端 roundtrip)。

## 错误处理与反馈

- 失败可读链路: 侧车 EngineError → emit error → (I-C 修复) 异常路径也写 quality_report.json 含 error 字段 → Rust quality_summary 优先读 error → jobs.error。此前 pack 失败只显示"任务失败 (无详情报告)"。
- 阶段完整性校验 (I-C 2, 2026-08-07 加): explain 首次全量跑 (checkpoints 目录不存在) 时, 实际处理数 < 总句数 95% → EngineError "explain 阶段不完整"。这是 Breath 早期 2518 句欠账 (循环漏跑但阶段标记完成) 的防御。
- **测试隔离问题 (已知)**: `cargo test --release -p aidulc` 并行跑 32 个失败 (共享临时 DB 状态冲突), `--test-threads=1` 100 全绿。跑 Rust 测试必须单线程。

## 内容过滤 (loader/nlp)

- epub 章节: nav.xhtml TOC 划分 + NON_BODY_TOC 过滤 (cover/title/table of contents/contents/map/references/index/notes/endnotes/source notes/bibliography/acknowledgements/about the author/also by/epigraph/colophon/copyright/dedication/罗马数字页码/1-4 位数字页码)。**注意**: 别把 preface/foreword/prologue/introduction 加进过滤 (它们是正文章, Breath ch001 Introduction 就是正文) — 2026-08-07 曾误加又撤回。
- `_is_real_sentence`: 段落级过滤 (≤4 字符/纯数字/全大写短串/人名残句/网址含裸域名 `mrjamesnestor.com/breath` 这类 / 逗号开头续行)。
- `_has_content` (nlp 分句后): 字母<3 的碎片句丢弃。spaCy 会把孤立 `.` `"` `[` `.\xa0.` 拆成句 — 必须过滤, 否则产生无讲解无音频的垃圾句。
- Breath 实测: Notes 章 1817 句 + Index 573 句 + 前页 60 句, 原本全部进 pipeline (2.9h 白生成音频 + LLM 讲解全失败)。过滤后 20 章 → 14 章正文, 句数 7050 → 1867 段落。

## 测试门禁

- Python: `prep\.venv\Scripts\python.exe -m pytest prep\tests` → **158 全绿**
  (2026-08-08 实测; 含 test_dict_server.py 4 个 M6 新增)
- Rust: `cargo test --release -p aidulc -- --test-threads=1` → **128 全绿** (并行有隔离问题)
- 前端: `cd reader && npx vitest run` → **57 全绿** (S5 新增 reader_state/follow_presets);
  另有 `node tests\_smoke_dom.mjs` → **30 项全过** (最小 DOM stub 驱动 AtomicBlock+ReaderRenderer,
  已接入 scripts/check.ps1 的 `node smoke` 项, 2026-08-08)
- **计数会随 R0-R4 未提交改动增长**: 以上为 2026-08-08 在含 R0-R4 工作区实测的数字,
  历史版本(126/100/32)是 R0-R4 之前的基准。
- 打包: `pyinstaller --clean --noconfirm build_exe.spec` → `prep\dist\aidulc-prep\aidulc-prep.exe` → 复制到 `dist\aidulc-portable\prep\`; `cargo build --release` → `aidulc.exe` → 复制到 `dist\aidulc-portable\`。**应用运行时 exe 被锁定, 需先关应用再构建**。

## 交付状态 (2026-08-07 17:41)

- Wolf 21: done (30 章)
- Breath: done (20 章, 讲解 97.5%, 156 句碎片缺失 — 已确认为无价值碎片: 尾注 URL/标点)
- Hitchhikers: done (38 章, 21972 句, 讲解 99.9%, 音频 100%, 27.6h 音频)
- portable: sidecar 17:41 打包完成; **release exe 待用户关闭应用后重建** (quality_summary error 字段改动, 应用运行时被锁)
- **⚠️ 2026-08-08 实测(F36)**: **整个便携版都是 R0-R4 之前构建** —— aidulc.exe(08-07 17:51,
  嵌旧前端)与 aidulc-prep.exe(18:03, 旧侧车)都早于 R0-R4: 侧车无 `--pymupdf-version`、无预览
  体检 health、不含 EPUB2 NCX/[[HEADING]]/插图提取; exe 嵌旧前端。**R0-R4 交付必须整体重新打包
  便携版(先 cargo build 嵌前端, 再打包侧车, 整包替换)**, 否则便携版处理旧格式书仍会分章错乱。
  详见 docs/ARCHITECTURE.md §9.5 F36。
- **⚠️ 2026-08-08 实测(F37)**: `dist/aidulc-portable/config.toml` 是开发机残留 —— 含
  `F:/hf_cache`、`F:/my_ai/subgen` 绝对路径 + 旧字段(library_dir/llm_model_path/tts_model_path)。
  换机器上 ffmpeg_path 指向不存在路径 → 误报缺失。打包时必须用干净默认 config.toml。

## 2026-08-07 算法审查第二轮 (修复 2 bug)

1. **TTS 空文本句时间轴 bug (B3, 必修)**: tts/stage.py 空文本句只 mark_failed 不推进 chapter_start_ms, 而 pack 会给缺失 wav 插 0.5s 静音 → 后续句时间轴整体偏早 0.5s, 阅读器高亮错位。修复: 空文本句同样写静音占位 wav + 推进时间轴 + 记 quality (与 translate 失败句路径一致)。
2. **explain 完整性校验误报 (A2, 必修)**: 首次跑时 translate 失败句 (status=failed/无翻译) 在 explain 阶段被跳过, 但校验没排除 → 翻译失败 >5% 会误报 "explain 阶段不完整"。修复: skipped_fatal 统计 (status failed / 无 translation / translate in failedStages), expected = total - skipped_fatal。
3. 清理: pack.py 重复 out_path 定义 + 未用 import shlex; pack_book job profile 用 .get() 防御 (KeyError 兜底)。
4. 审查结论 (观察项, 未修): explain 逐句 LLM 调用可批量 (性能 2-4x 但改 prompt 有风险); translate 无完整性校验 (优先级低); 空文本句当次运行 bookpack 有 audio (静音段) 重试后无 (checkpoint audio=None 不 hydrate) — 小不一致可接受。

## 2026-08-08 R0-R4 (阅读逻辑修复 + 格式兼容 + 插图链路)

### R0: "改前端不生效"的根修
- **根因**: exe 里嵌的是旧前端——`generate_context!` 编译期嵌 `../reader`, 但 cargo 不
  rerun-if-changed 那些文件, 只改 JS/CSS 不重编 → exe 永远旧前端。`build.rs` 现在递归
  emit `cargo:rerun-if-changed=` 覆盖 `../reader` 每个文件+目录, 实测 touch 一个 JS 即触发重编。
- `scripts/check.ps1` 新增 `cargo build --release`, "门禁全绿"蕴含"exe 最新"。
- `scripts/run.ps1`: 先构建再启动 (UTF-8 BOM, PS 5.1 中文注释必需)。
- **契约漂移测试**: `ipc/registry.rs` 新增 `every_frontend_invoke_is_registered`, 扫描
  reader/**/*.js 的 `invoke('cmd')` 字面量 (排除 plugin:*) 断言都在 COMMANDS。这次回归
  正是"前端调不存在的命令"型 (旧 reader_view 不知道 load_bookpack_chapter), 这条才闭环。

### R1: 渐进式滚动渲染 (reader_renderer.js)
- 不再一次建完整章。初始 50 句 + 底部 IntersectionObserver 哨兵 (rootMargin 400px 预取),
  滚到哪建到哪, 已建不回收。
- `ensureRendered(index)` 是唯一补渲染入口 (书签/搜索/播放定位统一走它), 远跳分帧。
- 纯边界决策抽到 `reader/core/render_plan.js` (零 DOM, 可单测), `reader/tests/render_plan.test.js`。

### R2: 阅读器模块化 (reader_view.js 600+ 行 → 组合根)
- 拆分目录 `reader/views/reader/`: topbar / player / chapter_loader / bookmarks / search。
  reader_view 只做组装; 竞态防护拆两层 (chapterLoader 管 fetch, reader_view 管渲染期)。
- 音频全部进 player (`loadChapter` 分块读→Blob→ObjectURL), 进度条/时间/跟读动作都在模块内。

### R3: 格式兼容 (epub.py / pdf.py / loader / cli)
- **EPUB2 toc.ncx 支持** (银河系真实撞见): `_find_toc_source` 先 nav.xhtml 后 toc.ncx
  (spine toc 属性→manifest id→media-type→文件名)。此前只认 nav.xhtml, 认不出就退化成
  spine 每文件一章 → 1 句碎片章 + 5351 句巨章。`_parse_ncx` 递归展平 navPoint。
- **[[HEADING]] 二次切分**: `_strip_tags` 早就有 `[[HEADING]]` 标记但被当垃圾过滤; 现在
  按它切分大文件 (≥LARGE_FILE_SPLIT_THRESHOLD=200 句), 每个 heading 段一章。小文件仍整文件一章。
- **PyMuPDF 兜底**: loader 的 pdf.py 扩展成通用 MuPDF 加载器, SUPPORTED_EXT 加
  mobi/azw3/fb2。pyproject 声明 `doc = ["pymupdf>=1.24"]`。build_exe.spec 加 pymupdf collect。
  缺失时懒加载给人话提示 (组件健康页一键安装: `doc_parser_install` 找 prep venv pip install)。
- **处理前体检**: `--preview-book` 输出加 `health` (format/toc_source/chapter_count/
  sentence_counts/anomalies)。library_preview 侧车链路透传, 前端预览模态显示红字异常。
  Rust `preflight_check` 加"不支持格式"检查。
- **组件健康**: components.rs 加 `check_pymupdf` (探测 `--pymupdf-version`), settings_view
  对缺失行给"一键安装"按钮。

### R4: 原书插图链路
- schema: chapter.images `[{file, at}]` 可选字段 (老书包无此字段仍合法, 不升 schemaVersion)。
- epub.py: `_strip_tags` 把 `<img>` 标成 `[[IMG:src]]` 记号; `_extract_images` 换算
  `at` = 该图之前累计真实句数; `_img_srcs` 把相对 src 归一化到书根路径。
- pack.py: `_copy_chapter_images` 从源 EPUB zip 拷图到 `images/ch_NNN_<name>`, 改写 file;
  图缺失/非 zip 源 → 去掉该条不中断打包。
- Rust: `read_image` 复用 read_audio 的 canonicalize+startsWith 防越界, 返回 base64。
- 前端: reader_renderer 按 at 在句块前插 `<figure>`, `setBasePath` 后预取 base64。
- 实测 Wolf 21: 35 章 48 张图全提取。

## 2026-08-08 需求精化会话实测补充 (本机, 见 docs/ARCHITECTURE.md §9.10)

- **词典查询 5.7-7.4s/次 (F21 实测)**: `word_lookup` 每次 spawn 新侧车加载 2.4GB LLM 模型,
  冷 7.4s / 热 5.7s。推理本身只 0.7s —— 根因是每次重载模型, 不是推理慢。
  dict_lookup.py docstring 的"~1-2s"只算了推理, 没算模型加载, 是误导。
- **LLM 进程内加载 3.2s**(llama_cpp), 2 行翻译推理 0.7s(~44 输出字符/s)。
- **TTS(kokoro)引擎加载 45.8s**(espeak+misaki+torch CUDA, 每任务一次), 单句合成 ~5.1s
  (本机高负载 ≈1x 实时; memory 旧记的 x18.1 是空闲机)。
- **nlp 吞吐**: perf_1000 nlp 12.4s / 98.8 句每秒(可复现, 与历史 104.7 正常方差)。
- **preview 链路**: 样例 epub `--preview-book` 0.44s。
- **bench_report.py 的 reader_frontend 指标不可靠**: dir_size 含 node_modules
  (历史 86KB vs 现在 39MB 都是"reader 目录大小"), 不是前端产物大小。



## 2026-08-10 背单词/同步阶段实测补充 (STAGE-SRS V5-V7)

- **CF KV 免费额度实测** (V0②): 值上限 25MiB (26214400 字节; 26MiB 写返回 413);
  读 100k/天、写 1000/天、同键 1 次/秒 (官方 KV limits 页抓取)。5000 词最小集 ≈1.43MB
  单值可放, 但整包 GET 每次 ~1.1-1.5s → 同步必须走增量 since={rev}, 首拉才整包。
- **curl 直连 CF Worker 的假"JSON 解析失败"**: 本机 Windows curl `-d ''{"x":1}''` 对
  worker 全部 500, Node fetch 同 body 正常 200 —— 是 curl/PowerShell 引号处理问题,
  不是 worker bug。**排查服务端先拿 Node fetch 复验。**
- **Windows node fetch keep-alive + server.close 触发 libuv 断言**: 手机端测试最初用
  真实 TCP 服务转发 worker.fetch, 退出时 `uv async.c:76` 断言 (退出码 -1073740791)。
  **修法: 测试 fetchImpl 直接调 worker.fetch(new Request(...)), 不走真实 TCP。**
- **PS 5.1 Set-Content -Encoding UTF8 破坏中文**: 整文件写回把 dictionary_service.rs 的
  中文注释变 mojibake, 只能 git checkout 重做。**含中文的 .rs/.js 一律用 edit 工具改。**

## 2026-08-10 P0-A: 桌面端"点几个 tab 后整窗未响应"定位 (真机复现级)

- **现象**: `src-tauri/target/release/aidulc.exe` 点几个 tab 后整窗未响应, 只能强杀。
  强杀后 data.db 里 jobs 有 1 行卡在 running, 书 status=processing, 批 running。
- **最初以为是 A (mutex 死锁)**: `std::sync::Mutex` 不可重入, 持 conn 锁再调 repo 方法
  即死锁。静态扫描 repo 方法都是"进函数锁一次、出作用域释放", 没有真的嵌套; 迁移
  (store_mod::migrate) 全程持锁但那是启动时单线程, 不构成卡窗口。
- **实测是 B (stale running 任务启动时被自动拉起)**: `reset_stale` 把 running → queued,
  `setup` 把 queued 收集进 recover_queue 再调 `pump_queue` → 启动即 spawn 侧车。
  侧车是 66MB PyInstaller onefile, 启动先整包解压 + 加载模型, 机器被拖到
  "窗口未响应"。**DB 证据链**: 最后一次启动的日志时间戳 1786333621012, 任务
  updated_at=1786333621755 (+643ms 被 pump 回 running); 任务目录 run.log 仍停在
  08-09 旧时间戳(0 字节) → 侧车还没解包完就被强杀。日志里几十次"应用启动"也是同一
  剧本反复重演。
- **修复 (单独提交)**: `reset_stale` 把 running → **paused**(不是 queued), 保留
  stage/current/total/progress(暂停行显示"⏸ 讲解 1234/21972", 用户知道断在哪);
  recover_queue 只收集 queued, 启动不再自动拉起侧车; 用户在处理台点"继续"
  (= resume, 与暂停→继续同一语义) 才重启。回归测试 `reset_stale_marks_running_as_paused_not_queued`。
- **遗留观察 (未修)**: 任务 paused 但批次状态仍 running (batches_repo 无 paused 态),
  批次摘要显示"处理中"但任务行显示"已暂停" —— 不阻塞使用, 未扩大改动面。

## 2026-08-10 S0-S7 (08-10plan.md): CF 配额护栏 + VPS 后端 + 阅读器体验

- **CF 免费档撞配额根因 (S2 起点)**: worker 推送一词一个 KV 键 (srs:{user}:{word}),
  首次全量写次数 = 词条数+1。1424 词 > 1000/天必撞。DESIGN_NOTES_SRS 那句"一次会话
  O(1) 次写"对首次全量是错的 (实测样本只到 100 词)。修: 前置估算拒绝 (待推+1>配额→
  人话提示) + worker 部分结果 (written_keys, 客户端只把真正写成功的算已推)。
- **S0 设置页卡死**: components_health 同步命令跑主线程 + spawn 6.3GB 侧车后无超时读
  stdout 到 EOF。与 P0-A (启动拉起 stale 侧车) 是两条独立路径。修: async+spawn_blocking
  + 探测 5s 超时 (read_stdout_with_timeout, 测试注入永不输出假进程断言超时返回)。
- **F29 参数解析器撞 State<'_, T>**: async 命令带生命周期后 rust_fn_params naive split(',')
  把泛型内逗号切断成假参数 (crate/store), 门禁假失败。改 bracket 深度感知。
- **Node server.mjs 坑**: res.end(await response.arrayBuffer()) 崩溃 (end 只收
  Buffer/string/Uint8Array) + Response.headers 是 Headers 对象要转普通对象; 子进程
  kill 触发 libuv 断言 → 进程内 startServer/stop + destroy keep-alive 连接。
- **S6 配色门禁**: 通道是线条不承载文字, ③ 只查会承载文字的底色 (reading-bg + hl 28%
  叠色); ② 用 ΔE76≥10 判通道可判别差 (比 ΔL 贴近人眼色相区分)。

## 2026-08-10 VPS 部署实测 (S7, 香港机 149.104.29.84)

- **机房面板 L7 拦截公网 HTTP**: 公网访问 80 端口返回 provider 的 Cloudflare lander
  (实测 server: cloudflare), A 记录 + 橙云方案不可行 → 改用 CF Tunnel (服务器主动出站)。
- **CF Universal SSL 只覆盖 2-label 子域名**: 3-label (sync.aidulc.viiyd.com) HTTPS 握手失败
  (alert 40, openssl s_client 确认 no peer certificate); 换 2-label (sync.viiyd.com) 立即正常。
- **cloudflared systemd ExecStart 不能内联 $(cat)**: 用 --token <内嵌 token> 才起得来。
- **tunnel token 获取**: GET /accounts/<acct>/cfd_tunnel/<id>/token 返回 result 是 base64 JWT。
- **桌面端连 VPS**: worker_url 填 https://sync.viiyd.com, 用新 ROOT_SECRET 换 token;
  实测推 1424 词 wrote=1424, KV_DIR srs_ 1424 + deck 1, 拉取 changed=1424。

## 2026-08-31 "跟读错位且无法修正"根因 + 人工校准 (用户报 Winn-Dixie ch5)

### 根因: 陈旧章节 opus 被"大小 ≥90%"判据放行
- `pack.py::_chapter_opus_ok` 用 **opus 文件大小 ≈ wav 总量/24 且 ≥90%** 判断该章是否已完成、
  可跳过重编码 (当初为省 2-3h 全量重编加的)。**±10% 容差换算成时间就是几十秒**:
  只要陈旧 opus 的时长误差在 10% 内就被判"完好", 重跑备料**永远不会重编那一章** ——
  这就是用户说的"无法修正"的确切机制。
- 实测证据 (mtime): Winn-Dixie `audio/ch_005.opus` 生成于 08-17 08:44, 而 `audio_raw/ch005/`
  的 wav 是 08-20 01:36 重跑的; 同书 ch008/ch000/ch025 的 opus 是 08-20 01:45 那批, 时长误差
  只有 +6ms (opus 正常编码前导)。
- **影响面**: 扫全部 16 个 job, **10 本书共 137 章 opus 陈旧** (Wild Robot 29 章 / Wonder 32 /
  Despereaux 28 / Winn-Dixie 16 / Holes 19)。只有一次跑通没重试过的书是干净的。
- **修法建议 (未做)**: `_chapter_opus_ok` 加 **mtime 校验**(opus 必须比所有输入 wav 新, 否则
  强制重编) + 用 ffprobe 比**实际时长**而非文件大小。删掉陈旧 opus 重编约 7s/章 (55x 实时)。

### 误差形状是阶跃函数 (决定了"平移一次就够"成立)
暴力搜索"使该段句边界最吻合实际静音的恒定偏移", 逐段看是否稳定:
- ch007: 句 0-49 恒定 **-240ms**, 句 50-99 恒定 **-9500ms**, 每段命中 10/10
- ch016: 句 0-30 恒定 -220ms, 句 31-94 恒定 **-13720ms**, 命中 10/10
- ch005: 句 0-27 约 -280ms, 句 44-91 恒定 **-4150ms** (跳变点正落在狗叫台词 s34/36/38/41 处)

"命中 10/10" = 用一个固定偏移能让该段**所有**句边界落在真实静音 150ms 内。所以
**"从某句起整体平移一个常量"是与误差形状匹配的正确校正**, 不是权宜之计。用户的直觉
("从狗叫以后整体后移, 之后不会再往前, 调一次就够")完全正确。

### 测量方法论上踩的坑 (三次结论被自己推翻, 后来者必看)
1. **狗叫词不是对齐失败的原因**: 四句狗叫 (Aaaaaarrooo/Arrrroooowwww/Arrruiiiiipppp/Owwwwww)
   词覆盖 9/9、10/10 全覆盖; 拿音频能量包络逐 50ms 格比对, 标注区间与真实发声完全吻合。
2. **诊断脚本不能用 checkpoint 文件数当句数**: 章节重新解析后会留**孤儿 checkpoint/wav**
   (ch006 有 58 个 checkpoint 但当前只有 56 句, s00056/57 的原文与 s00054/55 逐字相同)。
   pack 只遍历当前句列表, 孤儿 wav 不进 opus。用文件数算会得出"12 章漂移最严重 -17s"的**假结论**。
   正确做法: 用 `bookpack.json`(阅读器真正消费的那份)的句列表。
3. **比 wav 不等于比 opus**: 拿 checkpoint 时间轴和 wav 时长比, 28 章全部零漂移; 但和最终
   `audio/ch_*.opus` 的 ffprobe 时长比, 才暴露出 ch005 -3944ms / ch007 -9694ms / ch016 -13544ms。
   **误差是在 ffmpeg 拼接/编码这一步(跳过重编)产生的, 上游任何一层都看不到。**

### 对齐器指针停滞 (独立的第二个问题, 未修)
`core/word_alignment.py::align_tts_words_to_segments` token 匹配失败时 `si` 原地不动, 之后
每个正常 token 都拿去和卡住的位置比、必然全败 → **该句从此处起所有词丢失时间轴**。唯一的
恢复路径只有"跳过标点"。实测触发词是**缩写和连字符复合词**, 不是拟声词:
- ch18 #0 `'s` → 后续 24 词全丢; ch7 #42 `little-miss-know-it-all` → 19 词; ch5 #30 `n't` → 1 词
- Winn-Dixie 14 例, The Giver 17 例
建议修法: 前视窗口重同步 + 锚点间按字符比例插值 (保证覆盖率恒 100%、时间恒单调、绝不冻结),
并单独记"插值词数"质量指标以免把问题藏起来。

### 已落地: 人工校准 (v34 `timing_offsets`)
分段锚点 `(edition_id, chapter_index, from_sentence, offset_ms)`, 从某句起生效到下一条为止。
- 存 DB **不写回 bookpack.json** —— bookpack 是备料产物, 重跑就没了, 存 DB 才能"下次打开还在"
- **不带 user_id**: 修的是成品音频自身的偏差, 谁听都一样偏, 与 vocab/highlights 性质不同
- 防无限成长: 复合主键让反复微调走 UPSERT(行数=锚点数不是点击数)、偏移归零删行、
  与前一条等值的冗余锚点删行、每章硬上限 64、删成品时级联删除(否则孤儿行永久堆积)
- **性能**: 锚点在开书时并进已有的 `Promise.all` 拉一次(通常 0 行), 切章零 IPC; 偏移在章节
  加载时**一次性**平移进 `sentence.audio`(一趟 O(n)), 每帧 `_tick`/`highlightAt` 零额外开销。
  词时间轴是**句内相对**的(`reader_renderer.js` 用 `currentTimeMs - sentence.audio.start_ms`),
  句子一挪词自动跟着走, 不必遍历词。
- **坑**: `findSentenceIndex` 是二分查找、要求 start_ms 单调不减, 而句长只有 2-4s 却要平移
  -4150ms, 朴素实现会让锚点句跑到前一句前面**破坏二分前提** → 平移后必须跟一趟单调性修复。
  又因单调性修复是**有损钳位**, `applyToSentences` 必须**基于原始快照重算**而不是在现值上
  累加, 否则实时微调会叠加多遍、且钳过一次就调不回去。

### 2026-08-31 补: 陈旧 opus 判据重写 + 两类错位必须分清

`_chapter_opus_ok` 的判据从"比文件大小"换成"比时长"。实现过程中订正了三个我最初的判断:

1. **旧判据的容差不是 10%, 是 55%**。注释断言"wav 是 float32(96000B/s)"因此按
   `total/24` 算期望, 但 `tts/stage.py` 走 `sf.write(path, float32数组, SR)` ——
   **soundfile 的 WAV 默认 subtype 是 PCM_16, 数组 dtype 不决定文件位深**。实测 wav 头
   `audioFormat=1(PCM) 位深=16 字节率=48000`, 真实期望应按 `/12` 算。用 /24 让期望值只有
   真值的一半, `>= 期望*0.9` 等价于 `>= 真值*0.45`。2026-08-13 那次"修复"把 /12 改成 /24
   前提就错了, 反而把判据放松了一倍。**这解释了它为什么对 28 章 0/4 全漏。**
2. **mtime 判据不能用**(第一版写了, 拿真实数据验完删掉)。"opus 比输入 wav 旧就判陈旧"
   看着合理, 实测把 28 章里 24 章判成陈旧 —— **Kokoro 是确定性的, 同样文本重新合成得到
   同样音频**, wav 被重写不代表内容变了(ch001~004 的 wav 都比 opus 新, 时长只差
   -118/-68/-94/+82ms)。它也提供不了加速: ch025 是 mtime 说完好、时长说坏, ffprobe 每章
   都得跑。既不安全也不省事。
3. **孤儿文件检查(2026-08-19 加的)已被时长判据覆盖, 删掉**。孤儿 wav 只是磁盘残留,
   **不证明 opus 是拿它们编的**(`_encode_chapter` 只遍历当前句列表)。真拿旧的更大句集
   编的, 时长会多出以秒计的量, 一定抓得到。留着它实测把 21 个好章判成坏的, "重试不全量
   重编"这个优化基本失效。**代理指标 vs 直接测量, 有直接测量就别留代理指标。**

**容差取 50ms 的依据**: 实测分界非常干净 —— 本轮真编出来的章差值**稳定就是 +6ms**
(28 章无一例外), 输入变过的章最小也差到 32~44ms 往上, 大的到 -13544ms。不是拍脑袋。

**两类错位必须分清(我最初混为一谈)**:
```
ch005/007/016:  opus−wav = −3944/−9694/−13544 ; 时间轴−wav = 0      → opus 陈旧
ch025:          opus−wav = +6                 ; 时间轴−wav = −1675  → 时间轴错
```
`_chapter_opus_ok` 只回答"opus 与当前 wav 是否吻合", ch025 判"可跳过"是**正确的**。
ch025 那类(有 wav 却没写 audio checkpoint 的句子, 时间轴不认账)是 tts/bookpack 侧的
**独立缺陷, 尚未修** —— 早前 ch006/ch011 的"尾部句 status=ok、磁盘有 wav、checkpoint
无 audio 字段"是同一个病。

## 2026-08-31 对齐器指针停滞根治 (word_alignment 重写)

### 根因 (代码上可直接验证, 不是猜测)
`align_tts_words_to_segments` 里 token 失配后 **`si` 原地不动**, 之后每个正常 token 都拿去
和卡住的位置比、必然全败 → 整句从失配处起全丢时间轴。唯一恢复路径只有"跳过标点"。
(2026-08-04 那次修复把 `break` 改成 `continue`, 只解决了"提前终止", 没解决"指针不推进"。)

**ch7 #42 的确切机制**: spaCy 把 `little-miss-know-it-all` 切成 **9 个** segment
(little/-/miss/-/know/-/it/-/all), 而 `MAX_SPAN = 6` —— 拼接最多试到 6 个, **永远拼不出
这个词**, 必然失配。这条不需要跑 Kokoro 就能确认。

### 实测触发的是缩写和连字符复合词, 不是拟声词
狗叫台词实测是**好的**(9/9 全覆盖 + 能量包络逐格吻合), 早先怀疑它们是错的。
真实失配 (Winn-Dixie 11 个位置 / The Giver 17 例):
```
ch018 #0   34 segs 只覆盖 6   "Gloria Dump's" 的 's 卡住 → 后面 28 个全丢
ch007 #24  21 segs 覆盖 11    little-miss-know-it-all
ch005 #30   4 segs 覆盖 3     wasn't 的 n't
ch002/016/017/018/025  1-2 segs 覆盖 0  "Bad." / "Yes" / "Now."
```
**最后那类是另一回事**: 单词句 Kokoro 压根没吐 token, 没有任何锚点, 插值也救不了 ——
照旧上报 uncovered 才是对的, 不要为了让覆盖率好看去硬填。

### 三条修复
1. `MAX_SPAN` 6 → 12: 直接覆盖多段连字符复合词。
2. **前视窗口重同步** (`RESYNC_WINDOW=4`): 失配时在窗口内往后找落脚点, 不再原地卡死。
   原来那条"跳过标点"是它的特例, 已并入。
3. **锚点间空洞插值**: 两个成功锚点之间没对上的 segment 按字符比例分摊中间时间。

### 两条防线 (都是被自己写的测试逼出来的)
- **反误锚**: 短 token ("a"/"it"/"to") 满仓都是, 允许它跳着找落脚点几乎必然锚错, 而
  **锚错比不匹配更糟**(后面全跟着错位)。所以 `len(tok) < 3` 只允许原地匹配。
- **缩写附着成分要能跳过** (`CLITIC_PREFIXES`): spaCy 把缩写切成"词根 + 附着成分"
  (`wasn't`→[was, n't], `Dump's`→[Dump, 's]), 这些成分**从不单独发音**, 和标点一样可
  安全跳过。**第一版漏了这条**, 结果 `'s` 后面紧跟的短词 "I" 被挡住 —— 正是 ch018 #0
  的形状。测试 `test_unmatchable_token_at_head_does_not_kill_the_rest` 抓到的。

### 诚实边界
- **只插值"两个锚点之间"的内部空洞**, 头尾空洞照旧上报 uncovered。尾部缺失通常意味着
  Kokoro 真的没念那个词, 硬填等于伪造时间轴。
- **只插非标点**: 标点本来就常常没时间轴 (`check_segment_coverage` 从不把标点算缺失),
  给它补一个既无意义又会改变既有行为。第一版填了标点, 被既有测试
  `test_punct_segment_between_words` 抓到。
- **插值必须单独上报**: `align_tts_words_to_segments` 返回第三项 `interpolated`,
  tts/stage 记成 `quality.add_notice(..., "align_interpolated", ...)` 进 `noticeCounts`。
  插值让覆盖率恒为 100%, **不单独记等于把对齐质量下降藏起来**, 以后回归了没人发现。
  用 notice 而不是 failure: 它不是错误(高亮仍单调、不冻结), 只是精度提示。

### 真实数据验证 (拿 checkpoint 里的真 segment 列表 + 按 Kokoro 习惯合成的 token 流)
```
位置        segs  旧覆盖  新覆盖  插值   结果
ch018 #0     34      6     31     0    全覆盖
ch007 #24    21     11     18     0    全覆盖
ch007 #42    42     22     41     0    全覆盖
ch005 #30     4      3      4     0    全覆盖
ch008 #21    16     14     14     0    全覆盖
ch017 #100   55     53     51     0    全覆盖
```
**插值次数全是 0** —— 说明重同步 + MAX_SPAN 提升就已经精确对上了, 没有退化成近似值。
插值是兜底, 不是主力。
