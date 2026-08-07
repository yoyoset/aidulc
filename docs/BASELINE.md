# BASELINE — 2026-08-07 之前状态的非回归基准

> 这是 `v0.1.0-working-3books` tag 时的已知状态快照，后续任何重构如果打不开这三本书、
> 或质量指标明显劣化，就回到这个 tag。

## ⚠️ 数字来源说明（2026-08-07 补充: 已用真实数据核实, 免责声明解除）

审计当时（S0.4）尝试在磁盘上定位这三本书的实际书包目录以独立核实数字，搜索了
`dist/`、`AppData/Local/com.aidulc.app`、`Documents`、`Desktop`、`E:\`，均未找到，
于是本节数字一度只能标"未核实"。

**根因回顾**：`library_dir` 是相对路径、从未与 `exe_dir` 拼接（P0 已修）；更深一层是
`library_dir` 和真正的 `PrepConfig.out_dir` 本来就是两个不同步的概念（P1.1 已合并）。

**2026-08-07 排查"点开始阅读无法渲染"的 bug 时，顺带核实了这三本书的真实落点**：
`data.db` 的 `books` 表里 `pack_dir` 字段完整指向 `jobs_out/jobs/job-<timestamp>-<pid>-<n>/`，
目录和 `bookpack.json` 都在，不是丢失——只是从未在设置界面里露出过，用户看不到。
下表已用真实 `bookpack.json` 核实替换（不再是 `memory/pipeline.md` 的自述数据）：

## 三本书（2026-08-07 已用真实 bookpack.json 核实）

| 书 | 章数 | 总句数 | 单章最大句数 | failed_count | bookpack.json 大小 |
|---|---|---|---|---|---|
| Wolf 21 | 30 | 4245 | 332 | 55 | 19.3MB |
| Breath | 20 | 7050 | 1817 | 271 | 32.2MB |
| Hitchhiker's Guide | 38 | 21972 | 5351 | 8788 | 92.3MB |

memory.md 自述的"讲解完成率 97.5%/99.9%"这类数字未重新核实（`failed_count` 是
`books` 表里的字段，语义可能与 memory.md 的"完成率"口径不同，没有深挖，只确认了
"书确实都在、都能读取"这个之前完全不确定的事实）。

## 与自述数字矛盾的证据（审计中发现，需要澄清）

`.spikes/out/jobs/wolf3/jobs/job-1785855234899-31256-1/quality.json` 是一个真实存在、
可读取的 quality 报告，`align.successRate = 0.763`、`explain.successRate = 0.69`——
远低于上表 Breath/Hitchhikers 的 97.5%/99.9%。

**不确定这是不是"Wolf 21"的某次中间调试跑（bug 修复前）**，还是完全无关的 spike。
`.spikes/out/` 里还有 `wolf/`、`wolf2/`、`wolf3/` 三个同名不同编号的 job 目录，
像是同一本书反复重跑调试的痕迹。**这本身是个信号**：如果连哪次跑是"最终交付版"
都分不清，说明任务产物缺少一个"这是正式交付"的标记，而不只是众多调试 job 之一。

## 待完成（不阻塞 S0 其余步骤，但应尽快做）

1. ~~修复 library_dir 路径 bug（任务 #6）~~ **已修（2026-08-07）**：`main.rs` 新增
   `resolve_library_dir` 纯函数 + 4 个单测，启动日志新增 `library_dir=...` 一行。
2. ~~本节数字仍未核实~~ **已核实（2026-08-07）**：三本书的 `pack_dir` 从 `books` 表
   读出、`bookpack.json` 都在且可解析，数据没有丢失，见上方新表。
3. ~~补充产品需求（任务 #7）：书库位置设置界面可见可改 + 书包导出导入~~ **已完成
   （2026-08-07）**：设置页新增"书库位置"区块（P1.2）+ 书包导出/导入 zip（P1.3-P1.5）。

## 新发现: 大书打开阅读器会卡死（2026-08-07 用户实测撞见, 已修）

排查"点开始阅读没反应"时发现: `load_bookpack` 曾经把整本书(含每句译文/讲解/逐词
时间轴)一次性通过 IPC 传给前端。Hitchhiker's Guide 的 92MB 字符串在 JS 侧
`JSON.parse` 是同步的, 会把界面主线程卡死好几秒甚至更久; 即便解析完, 该书单章
最多 5351 句, 原来的渲染逻辑一次 `forEach` 同步建全部 DOM(每句还要按 segments
逐词建 span), 单章下来是 10 万+ DOM 节点, 一样会冻结界面。

修复（详见 `src-tauri/src/commands/library.rs` 的 `strip_chapters_to_meta`/
`load_bookpack_chapter` 和 `reader/components/reader_renderer.js` 的分帧渲染）:
- `load_bookpack` 只回元信息(每章 sentences 只留 `original_text`, 供全文搜索用),
  新增 `load_bookpack_chapter` 按需取单章完整内容。Hitchhiker's Guide 的元信息载荷从
  92MB 降到 3MB(实测), 最大单章按需载荷 8MB(仍可控, 一次性 JSON.parse 无感)。
- `reader_renderer.js` 建 DOM 改成按 200 句一批、每批之间让出一帧(`requestAnimationFrame`),
  用浏览器实测验证过 3500 句章节渲染期间主线程仍持续响应(17 帧完成, 总耗时 1.56s)。

**已知未做**: 分帧渲染解决的是"建 DOM 时冻结"，没有解决"DOM 节点总数仍然很大"本身——
5351 句 × 每句多个 span，最坏情况下单章仍有数万到十万级 DOM 节点常驻，滚动这类长章节
理论上仍可能不够流畅。真正的虚拟滚动(只渲染可视区域附近的句子)是更大的改动(要重写
`highlightAt`/书签/搜索跳转依赖"所有句子的 DOM 都已存在"这个假设)，本次没有做，
如果后续实测证明分帧渲染还不够，再单独立项。

## 顺带发现的 bug（写 BASELINE.md 过程中定位，已于 2026-08-07 修复，见任务 #6）

`src-tauri/src/main.rs` 曾经：
- `db_path` 正确地 `exe_dir.join("data.db")`
- `lib_dir` 直接用 `cfg.library_dir`（`config.toml` 里的裸相对路径 `"library"`），
  **没有 `exe_dir.join()`，没有 `canonicalize()`**

`config.rs` 注释写"便携配置(exe 同目录)"，但实现和这个声明不符——实际解析出的路径
取决于进程启动时的当前工作目录，不是 exe 所在目录。这是本次审计从代码里实测确认的，
不是猜测。修复见 `main.rs::resolve_library_dir`。
