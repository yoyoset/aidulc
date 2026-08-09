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
