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
- **对齐风险 (未修, 已知)**: nlp 的 `_has_content` 过滤碎片句 (字母<3 的孤立标点) 会改变句子总数。实测 Hitchhikers 差异句全在**章尾** (前缀完全匹配), hydrate 按位置加载安全。若某书碎片句在**章中间** (引用块孤立引号), 位置会错位 → 音频时间戳错乱。发现即修: 改为按 original_text 匹配或保留 fragment 句。2026-08-07 Breath/Hitchhikers 均尾部过滤, 安全。

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

- Python: `prep\.venv\Scripts\python.exe -m pytest prep\tests` → 126 全绿
- Rust: `cargo test --release -p aidulc -- --test-threads=1` → 100 全绿 (并行有隔离问题)
- 前端: 29 个测试
- 打包: `pyinstaller --clean --noconfirm build_exe.spec` → `prep\dist\aidulc-prep\aidulc-prep.exe` → 复制到 `dist\aidulc-portable\prep\`; `cargo build --release` → `aidulc.exe` → 复制到 `dist\aidulc-portable\`。**应用运行时 exe 被锁定, 需先关应用再构建**。

## 交付状态 (2026-08-07 17:41)

- Wolf 21: done (30 章)
- Breath: done (20 章, 讲解 97.5%, 156 句碎片缺失 — 已确认为无价值碎片: 尾注 URL/标点)
- Hitchhikers: done (38 章, 21972 句, 讲解 99.9%, 音频 100%, 27.6h 音频)
- portable: sidecar 17:41 打包完成; **release exe 待用户关闭应用后重建** (quality_summary error 字段改动, 应用运行时被锁)

## 2026-08-07 算法审查第二轮 (修复 2 bug)

1. **TTS 空文本句时间轴 bug (B3, 必修)**: tts/stage.py 空文本句只 mark_failed 不推进 chapter_start_ms, 而 pack 会给缺失 wav 插 0.5s 静音 → 后续句时间轴整体偏早 0.5s, 阅读器高亮错位。修复: 空文本句同样写静音占位 wav + 推进时间轴 + 记 quality (与 translate 失败句路径一致)。
2. **explain 完整性校验误报 (A2, 必修)**: 首次跑时 translate 失败句 (status=failed/无翻译) 在 explain 阶段被跳过, 但校验没排除 → 翻译失败 >5% 会误报 "explain 阶段不完整"。修复: skipped_fatal 统计 (status failed / 无 translation / translate in failedStages), expected = total - skipped_fatal。
3. 清理: pack.py 重复 out_path 定义 + 未用 import shlex; pack_book job profile 用 .get() 防御 (KeyError 兜底)。
4. 审查结论 (观察项, 未修): explain 逐句 LLM 调用可批量 (性能 2-4x 但改 prompt 有风险); translate 无完整性校验 (优先级低); 空文本句当次运行 bookpack 有 audio (静音段) 重试后无 (checkpoint audio=None 不 hydrate) — 小不一致可接受。
