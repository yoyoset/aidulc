# aidulc pack 可靠性阶段文档(P 系列)

> 创建:2026-08-07(周五)| 阶段:pack 失败根因修复 + 二轮算法审查
> 关联记忆:`memory/pipeline.md`(运行态细节)| 前置阶段:`LEARNING_LOOP_PLAN.md`(I 系列)

## 0. 状态:全部完成(P1~P4 修复 + 二轮算法审查),三本书全部交付

**门禁:Python 126 全绿;Rust 100 全绿(单线程,并行有隔离问题见 §6);前端 29 未动。**
**打包:sidecar 18:03 / release exe 17:51(2026-08-07),portable 已同步。**

起因(2026-08-07 上午):Breath、Hitchhikers 两本书导入在 pack 阶段失败 → 深挖出 **ffmpeg 集成层三连坑**,
逐一实测复现、修复、重打包。修复后三本书(含此前 Wolf 21)全部 done。

### 时间线(2026-08-07)

| 时间 | 事件 |
|---|---|
| 13:49 | 首次修复分块合并后打包 sidecar |
| 14:00-15:31 | Breath 重试:explain 补 2518 句欠账(原任务 pack 失败时 explain 只完成 64%),done |
| 15:58-16:09 | Hitchhikers 重试:ch005 大章(3972 句/4.7h 音频)最终编码超时被杀 → failed |
| 16:42 | P2/P3/P4 修复打包 |
| 17:16-17:29 | Hitchhikers 重试成功:38 章 done,讲解 99.9% |
| 17:51 | release exe 重建(失败摘要 error 字段) |
| 18:03 | 二轮审查修复(B3/A2)打包

---

## 1. 阶段目标

- 定位并修复"两本书 pack 失败"的根因(非表面症状)
- 让重试从 checkpoint 续跑不再卡死/超时/重复劳动
- 失败可读:不再出现"任务失败 (无详情报告)"
- 二轮算法审查:找修复引入的新问题 + 长期隐患

## 2. 问题诊断链(全部实测证据,非推断)

| # | 现象 | 实测证据 | 根因 |
|---|---|---|---|
| P1 | ffmpeg 一次性 concat 645+ wav 卡死 600s | 手动跑 ch008 的 concat 命令卡死无输出;645 wav 采样率/声道其实一致 | ffmpeg concat demuxer 对大量输入段挂起 |
| P2 | 分块后大章最终编码仍超时 | 40 个 mid(814MB pcm ≈ 4.7h 音频)→ opus 需 **279s** > 180s 超时被 kill;留下 38MB 部分产物(完整 63MB);编码速率实测 ~55x 实时 | **不是卡死是慢**——libopus 编码大章超时不足。Breath 最坏章 68 分钟(180s 够)所以没暴露 |
| P3 | `.tmp` 扩展名 ffmpeg 拒绝 | stderr: `use a standard extension for the filename` 退出码 -6(0xFFFFFFFA) | ffmpeg 按输出扩展名推断 muxer,`.opus.tmp` 不可识别 |
| P4 | 重试 pack 全量重编码 | 38 章 × 1-6 分钟 = 2-3 小时,用户感知"又停了" | pack 无章级跳过,checkpoint 只在 LLM 阶段生效 |
| P5 | 进度显示 `5/1` | DB current=5,total=1 | stage_progress 的 total 写死 1,current 按章递增 |

## 3. 修复清单(P1~P5 + 过滤优化)

**P1 分块合并**(`pack.py::_encode_chapter`):每 100 个 wav 一批(强制 `-ar 24000 -ac 1` 转 pcm_s16le)→ 中间文件 → 最终 opus。验证:ch008 645 wav → 7 批每批 ~2s,产物与原文件逐字节一致。

**P2 动态超时**:`encode_timeout = max(300, int(total_sec/55) + 120)`(55 = 实测编码速率倍率)。验证:4.7h 章 279s 完成。

**P3 临时文件命名**:`xxx.tmp.opus`(以 .opus 结尾可推断 muxer)+ `os.replace` 原子落盘;超时/失败删 tmp → **"存在即完整"**。

**P4 章级跳过**(`_chapter_opus_ok`):opus 大小 ≥ wav 总量/12 × 0.9(32kbps vs 48000B/s pcm)→ 跳过。验证:ch005 63MB(完整)跳过,ch000 0.1MB(临界)重编码 1s 无害。

**P5 进度修正**:`total = len(book.chapters)`,stage_start 同步修 → 显示 `n/38`。

**过滤优化**(内容层,非 pack):epub TOC 词表补 `notes/endnotes/table of contents/also by` + 页码(vi/ix/271);`_is_real_sentence` 补裸域名 URL;nlp 分句后 `_has_content` 丢碎片句(字母<3)。Breath 重载实测:Notes 1817 句 + Index 573 句 + 前页 60 句全消失,20 章 → 14 章正文。**教训:preface/foreword/introduction 不能过滤(是正文章,曾误加又撤回)**。

## 4. 二轮算法审查(修复 2 bug + 2 清理)

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| B3 | 必修 | tts 空文本句不推进时间轴,而 pack 插 0.5s 静音 → 后续句高亮整体偏早 0.5s | 空文本句写静音 wav + 推进时间轴 + 记 quality(与 translate 失败句路径一致) |
| A2 | 必修 | explain 完整性校验误报:translate 失败句在 explain 跳过但校验没排除 → 翻译失败 >5% 误报"不完整" | skipped_fatal 统计,expected = total − skipped_fatal |
| 清理 | 低 | pack.py 重复 out_path 定义 / 未用 import shlex | 删除 |
| 防御 | 低 | pack_book `job["profile"]` KeyError | `.get()` 兜底 |

完整性校验本身(上轮加):首次全量跑(无 checkpoints 目录)时 explain 实际处理数 < 期望 95% → 显式报错。这是 Breath 早期 2518 句"循环漏跑但阶段标记完成"欠账的防御。

## 5. 交付状态(2026-08-07 17:29 三本全部 done)

| 书 | 章节 | 句数 | 讲解 | 音频 | 完成时间 |
|---|---|---|---|---|---|
| Wolf 21 | 30 | — | done | done | 前日 23:54 |
| Breath | 20(正文 14 章 1867 段落) | 7050 | 97.5% | 100% | 15:31 |
| Hitchhikers | 38 | 21972 | **99.9%** | 100%(27.6h) | 17:29 |

portable:sidecar 18:03(after 审查修复)/ release exe 17:51 均最新。

## 6. 遗留事项(已知,暂不处理)

1. **nlp 碎片句过滤的对齐风险**:碎片句若出现在章**中间**(非尾部)会破坏 checkpoint 位置对齐 → 音频时间轴错位。Breath/Hitchhikers 均尾部过滤(前缀完全匹配),安全。遇中间碎片再修:改 original_text 匹配或保留 fragment 句。
2. **explain 逐句 LLM 调用**:可批量化(吞吐 2-4x),改 prompt 有回归风险,暂缓。
3. **translate 无完整性校验**:优先级低(失败句在 explain 会跳过,已计入 A2 的 skipped_fatal)。
4. **Rust 测试并行隔离问题**:`cargo test --release -p aidulc` 并行 32 失败(共享临时 DB 状态),必须 `--test-threads=1`(100 全绿)。
5. **空文本句 bookpack 不一致**:当次运行有 audio(静音段),重试后 checkpoint audio=None → bookpack 无 audio。小不一致,影响可忽略。
6. **explain 失败句无限重试**:重试时 failedStages 句每次都会再试,LLM 一直失败则永远失败(有 quality 记录兜底)。未做失败次数上限,因为用户要"补"。

## 7. 记忆归档

全部坑的细节已入 `memory/pipeline.md`(配置/外部集成/状态管理/错误反馈/内容过滤/测试门禁/交付状态)。
