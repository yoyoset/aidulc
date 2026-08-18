# GOAL 2026-08-18 —— 备料报告准确性 + 备料台易用性

来源: 8/18 第三轮重跑收官观察(`docs/WATCH_2026-08-18.md`)。10 本 34064 句跑完,
**真实内容失败只有 8 条**, 但用户在界面上看到的是"失败句数 9023 / 5551 / 3074 …"。
这批改动不碰讲解算法, 只修**报告的准确性**和**备料台的可读性** —— 都是"后台是好的,
但用户以为是坏的"这类问题, 和全局原则里"后台失败但用户以为成功"是同一枚硬币的两面。

不做的事(明确列出): 不碰 explain 提示词(刚定案, 有实测背书); 不动 align 失败率
(0.08%~1.79%, 已记基线, 没有证据说它是缺陷); **不做性能优化**——这一轮没有测到
任何性能问题, 没有数据就不改。

---

## A1. `nlp_realign` 不再计入失败句

**现状**: `pipeline/nlp/stage.py:87` 在 checkpoint 位置冲突时调 `quality.add_failure(..., ["nlp_realign"], ...)`。
但它不是失败, 是"已清空该位置历史数据强制重跑, 防止张冠李戴"的正常记账 —— 恰恰是
保护数据正确性的机制。

**实测放大倍数**(10 本成品):

| 书 | `failedSentences` 长度 | 其中 nlp_realign | 真实失败 |
|---|---|---|---|
| Wild Robot | 9023 | 8784 | 30 |
| Wonder | 5551 | 5321 | 75 |
| Holes | 3074 | 3049 | 25 |
| Number the Stars | 2757 | 2756 | 1 |

**改法**: `core/quality.py` 新增独立通道 `add_notice(chapter, index, kind, reason)`
→ `to_dict()` 输出 `notices: [...]` 和 `noticeCounts: {realign: N}`; `nlp/stage.py`
改调 `add_notice(..., "realign", ...)`。`_summary()` 只数 `failed_sentences`。
`contracts/bookpack.schema.json` 的 `quality` 加 `notices`/`noticeCounts`, 跑 sync_schema。

**验收(机械可核对)**:
- `prep\.venv\Scripts\python.exe -m pytest prep\tests` 全绿, 且新增单测断言
  "触发 realign 后 `to_dict()['failedSentences']` 为空、`noticeCounts['realign'] == 1`"
- `.\scripts\sync_schema.ps1 -Verify` 通过

## A2. 消费方对**历史产物**过滤 `nlp_realign`(向后兼容)

A1 只对新跑的书生效。磁盘上已有 10 本书的 `quality_report.json` 里仍混着 nlp_realign,
不能要求用户为了看对一个数字把书重跑一遍。

**改法**: 三处消费方在统计失败句数时排除 `stages` 里只含 `nlp_realign` 的条目:
- `reader/views/prep_view.js:438` 任务详情弹窗「失败句数」
- `src-tauri/src/application/library_service.rs:26` 书库卡片失败句读数
- `src-tauri/src/application/job_orchestrator.rs:1216` 人话失败原因(句数 + stage 列表)

判据抽成一个纯函数(JS 侧放 `reader/core/`, Rust 侧放对应模块的私有 fn), 不要在三处
各写一遍 filter。

**验收**: 拿真实产物断言 —— Wild Robot 的 `quality_report.json` 过滤后失败句数 = 30
(不是 9023)。Rust/JS 各一个单测, 用最小 fixture 覆盖"全是 realign / 混合 / 无 realign"三种。

## A3. 不可翻译内容记「跳过」, 不记「失败」

**现状**: 全部 5 条 translate 失败(Wild Robot 4 / Frindle 1)的原文是:

```
LBYR.com                      Twitter.com/LittleBrownYR
Clickety clickety click!      v 1.0 HTML
```

URL、版本号、拟声词。模型原样回显, 被判「翻译失败/回显」——判定本身没错, 但这些句子
**永远不会成功**, 每次重跑都重试一遍并留在失败清单里。和 K33 定的"门槛跳过要记成
跳过不能记成失败"是同一条规矩。

**改法**: `pipeline/llm/stage.py` 加纯函数 `is_untranslatable(text) -> bool`
(判 URL / 纯版本号 / 无字母词), 命中的句子跳过翻译并走 notice 通道, 不进 failed。
判定要保守 —— 宁可漏判也不能把正常句子判成不可翻译。

**验收**: 单测覆盖上面 4 个真实样本判 True, 外加至少 6 个正常句子(含带 URL 的完整
句子如 `Visit LBYR.com for more.`)判 False。

## B1. `batches.total_books` 回填

**现状**: 表里**所有**批次 `total_books = 0`, 备料台组头显示「0 本书」。根因
`application/job_orchestrator.rs:254` —— 前端 batch_id 在表里不存在时走自动建批次兜底,
硬编码 `total_books: 0`, 入队循环结束后从不回填。

**改法**: 入队循环结束后把实际入队数写回 batch。

**验收**: 新导入并开始一本书后, 组头显示「1 本书」; Rust 单测断言 upsert 后
`get(id).total_books == enqueued.len()`。

## B2. `total_books = 0` 时不判「已完成」

**现状**: `store/batches_repo.rs:131` 的状态判定 `WHEN ?1 + ?2 >= total_books ... THEN 'completed'`,
`total_books = 0` 时恒真 —— 表里那 10 个批次 job 还在 `queued`, 批次已经是 `completed`。

**改法**: 加 `total_books > 0` 前置条件, 否则保持 `running`/`created`。

**验收**: 单测 —— `total_books = 0` 且 done=0 时状态**不是** `completed`。

---

## 收尾

`.\scripts\check.ps1` 全绿(24/24), 每条一个独立 commit, message 带实测数字。
prep 侧有改动 → `scripts\build_prep.ps1` 重新打包侧车。
