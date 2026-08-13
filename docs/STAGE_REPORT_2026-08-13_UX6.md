# STAGE REPORT 2026-08-13 UX6 —— 手动重跑收尾 + 词典/生词查词三条治理

来源任务: `docs/GOAL_2026-08-13_UX6.md`。顺序按文档执行: **#1(收尾半成品) → #2 → #3 → #4**。
落地前 `.\scripts\check.ps1` 24 项全绿, clippy 基线 7 未升。共 5 个提交:
`d190391` #1(含前几轮未提交的审计/TTS/权威化) / `00928d4` #2 / `9cef9ce` #4 /
`a96529f` #3 回归断言 / `ede8128` memory。

**文档与实测矛盾处全部以实测为准**, 一处关键 A→B 如实记录(见 #2 节, 是本次最值钱的发现):

---

## 一、需要用户本人操作(DS 做不了)

| # | 事项 | 说明 |
|---|---|---|
| U1 | **真机点验手动重跑** | 失败/部分完成任务行出现「重跑…」, 点开有 3 模型下拉 + 重跑范围单选, 点开始真正按所选阶段重跑。smoke 已锁 DOM 与调用参数, 真机最终点按 |
| U2 | **真机点验查词自愈** | #2 修后本地查词冷启动不再报"侧车未就绪"。请重点一次真机生词查询(此前该路径从未真正工作过) |
| U3 | **真机点验面板收起** | 打开词典面板后点正文任意处 → 面板收起; 点正文的词 → 面板刷新不收起; 面板内按钮不收起 |
| U4 | **侧车重打包后的整体回归** | 便携版已重打 (exe 13:20 / 侧车 11:48 / 干净 config)。侧车 build_prep.ps1 在 #1 期间跑过, 之后 prep 源码未再改动, 便携版侧车即最新 |
| U5 | `git push origin main` | 本地已超前 120+ 提交 |

---

## 二、核心发现:词典守护"启动超时"的根因是参数名不匹配(A→B)

用户真机反馈: 点生词 → 「词义查询失败 (词典守护启动超时 (侧车未就绪))」。本地查词失败。

**最初以为是 A(超时)**: 文档/直觉把矛头指向"侧车 `--lookup-server` 冷启动加载 2.4GB LLM 超
过 `recv_timeout`"。**实测推翻 A**:
- `dict_server.py` 的 ready 行 `{"ok":true,"ready":true}` 在**模型加载之前**就写出(模型懒加载,
  第一个请求才调 `LlmServer`)。所以 ready 行与 2.4GB 加载无关。
- 换正确参数实测打包侧车: `--lookup-server --lookup-model <path>` → **~713ms** 内发 ready 并存活。

**实测是 B(秒退, 被吞掉的原因被误标)**: Rust `dict_daemon.rs::spawn` 传的是
`--lookup-server --model <path>`, 但打包入口是 `cli.py`, 它只认 `--lookup-model`
(`dict_server.py` 自己的 argparse 才接受 `--model`) → 侧车 argparse **秒退 exit 2**。此时:
1. stderr 被 `Stdio::null()` 整个吞掉(用户永远看不到 "unrecognized arguments: --model");
2. reader 线程读 EOF → tx 丢弃 → `recv_timeout` 返回 `Disconnected`;
3. 旧代码把 `Timeout` 和 `Disconnected` **一视同仁**标成「词典守护启动超时 (侧车未就绪)」。

于是"参数错 → 秒退 → 被误标成超时 → 原因被吞"三条叠加, 用户只看到一句空话。

**为什么一直没暴露**: F21 的 ready 行消费逻辑是直接对 `dict_server.py`(它接受 `--model`)测的,
Rust 单测用假 `.bat` 也不走 `cli.py`, Python 测试直连 `serve()` —— **集成边界(真实入口 cli.py)
全被绕开**, 这个 bug 从 F21 起就存在, 查词路径其实从未真正工作过。

**修复**(`00928d4`):
- `spawn` 参数改 `--lookup-model`(与 cli.py 契约对齐)。
- stderr 改 `piped` + 尾部缓冲线程: 秒退时把 argparse 报错上屏("词典守护启动失败 (侧车提前退出): unrecognized arguments: ..."), 不再吞。
- 区分两套文案: 真超时(进程还活着没 ready)→「启动超时 (侧车未就绪, 可稍后重试...)」; 秒退(Disconnected)→「启动失败 (侧车提前退出) + stderr」。
- 回归锁: Rust `sidecar_exiting_early_surfaces_stderr_not_timeout`(假 .bat 秒退 → 断言报"启动失败"非"超时"且 stderr 上屏) + Python `TestCliContract`(cli.py 接受 `--lookup-model` 拒绝 `--model`)。
- 前端查词失败面板本就带「重试本地」按钮(#3 确认的恢复路径), 与后端自愈(失败后 registry 清空, 下次查词重建)配合, 不是死路。

**实测数字**: 修后打包侧车 `--lookup-server --lookup-model` 启动就绪 **~713ms**(远低于 60s
START_TIMEOUT); 冷/热查词进入 LOOKUP_TIMEOUT(30s)内。portable 侧车同样验证通过。

**教训**: 参数名契约要看真实入口(cli.py), 别按内部模块的 argparse 猜; 单测/冒烟一旦绕过真实
进程边界, 集成错误会长期潜伏。

---

## 三、八条协作教训的证据

### 教训 1: 同类要扫描给清单

- **#2 stderr 处置**: 全仓只有 `dict_daemon.rs::spawn` 用 `Stdio::null()` 吞子进程 stderr; 查词与
  job spawn(`spawn_prep` 用 `Stdio::inherit()`)处置不一致, 本提交把查词路径对齐为 piped+缓冲。
- **#4 收起监听**: document 级 click 只加在面板 show 时(`_bindDocClick`/`_unbindDocClick` 成对),
  与 modal/review 的 Esc 处理不冲突; 确认 `_onWordClick` 只有一处入口(reader_view.js:981), 排除 `.bubble` 后无重复收起路径。

### 教训 2: 数字贴命令 + 原始输出

- **clippy 棘轮**: 收尾 `cargo clippy --release -p aidulc` 计数 **7**, 等于基线 7, 未升高
  (#1 的 `job_retry_custom` 命令薄壳加 `#[allow(clippy::too_many_arguments)]` 压回, orchestrator 层已 allow)。
- **门禁项数**: 24 项全绿(与 UX5 相同, 本轮未新增门禁)。
- **cargo test**: `267 passed; 0 failed; 1 ignored`(#1 基础上 +1 Rust 单测 `sidecar_exiting_early_surfaces_stderr_not_timeout`)。
- **pytest**: `180 passed`(#1 是 178; #2 新增 `TestCliContract` 2 例)。
- **vitest**: 124 passed。**smoke views**: 全绿(新增 1e 手动重跑 17 项 / 2d3 面板治理 9 项含 #3 回归)。
- **no_silent**: 100 按钮点按全通过(新增「重跑…」「开始重跑」按钮均有点按反馈)。

### 教训 3: 真实数据副本跑一次, 给前后计数

- **#2 用真实打包侧车实测**(不是假 .bat): `aidulc-prep.exe --lookup-server --model <path>` → 秒退
  exit 2, stderr 是 "unrecognized arguments: --model"; 同参数换 `--lookup-model` → 存活并发 ready。
  前后对照给出根因铁证, 这也是"先实测再下结论"对文档假设的修正。
- **#1 用真实 exe 构建 + 侧车 PyInstaller 重打**: `cargo build --release` 267 测试全过;
  `build_prep.ps1` 产物 `prep/dist/aidulc-prep/aidulc-prep.exe`(11:48, 66711176 字节)复制进便携版,
  便携版 `--lookup-server --lookup-model` 实测发 ready。

### 教训 4: 断链回归测试不要改断言去适配实现

- **#4 smoke 2d3** 直接断真实 DOM: `.dict-sec-head` 标题齐全(释义/例句/用法/搭配)、点段头切换
  `dict-sec-collapsed`、`.dict-source` 文案含"不是查询历史"、点正文空白 → `open` 类移除、点面板内
  按钮/正文 `.bubble` → 不收起。test stub 补了 `closest`/`contains`(此前缺失, 是 stub 与真实 DOM 的
  行为差, 补上让断言可写)。
- **#1 smoke 1e** 断 3 模型下拉 + 5 单选默认自动 + 点开始调 `retryCustom` 的参数(自动=null /
  从语音=['tts'] / 全部=四阶段全列)。

### 教训 5: 预想文档/验收基准

- 本 GOAL 的 #2 验收"本地查词冷启动不报侧车未就绪"在测试层面体现为: 修后打包侧车就绪 ~713ms +
  Rust/Python 契约回归; 真机最终点验见 U2。

### 教训 6: 一处坑一处防 / 一处修复一处测试

- #2 的 `--model` vs `--lookup-model` 是"参数名"这个维度, 新增 Python `TestCliContract` 专锁 cli.py
  的 `--lookup-server` 入口契约, 防止将来再有人按 dict_server 的 argparse 猜参数名。
- #4 的 document 收起监听排除 `.bubble` 是"点词不收起"这个交互, smoke 2d3 专锁。

### 教训 7: 口头命令回执到单据

- #1 的「重跑…」对话框选项语义(cli.py→FORCE_STAGE_CASCADE)与 `checkpoint.clear_stages` 的级联
  严格对齐(translate→清 translation+explanation / tts→清 audio+words), 前端 `FORCE_MAP` 与
  contract `force_stages` enum 一致, 由 pytest `TestClearStages` 锁定。

### 教训 8: 验收证据落到 DOM 选择器 + 文案

- #1: 失败行有「重跑…」且紧挨「重试失败句」; 对话框 3 个 `select` + 5 个 radio(自动/从翻译/从讲解/
  从语音/全部); 点「开始重跑」→ `AiduJobService.retryCustom(id, llmId, ttsId, nlpId, forceStages)`。
- #4: 打开面板点正文 → `.dict-panel` 的 `open` 类移除(面板收起); `.dict-sec-head` 有 释义/例句/用法/搭配;
  `.dict-source` 明确"不是查询历史"; 点 `.bubble` 不收。
- #3: 本地命中面板不含「用在线 AI 查一次」按钮。

---

## 四、门禁汇总

| 项 | 结果 |
|---|---|
| schema:verify | PASS |
| cargo fmt --check | PASS |
| cargo clippy (baseline<=7) | PASS(7, 未升) |
| cargo build --release | PASS |
| cargo test --release -- --test-threads=1 | PASS(267) |
| pytest | PASS(180) |
| vitest | PASS(124) |
| node smoke(DOM/视图/契约/worker/server/手机×2/UI) | PASS |
| mobile:build-version 一致性 + version-bumped | PASS |
| node import_old_aidu --self-test | PASS |
| test:no-prod-endpoint | PASS |
| css:no-raw-hex / no-blk-texture / dashed-rule / contrast | PASS |

**便携版重打**: `dist/aidulc-portable/` = 新 aidulc.exe(13:20, 嵌新前端, build.rs rerun-if-changed
保证前端最新)+ 新侧车 `prep/aidulc-prep.exe`(11:48)+ 干净 config.toml(无开发机路径)。`--lookup-server
--lookup-model` 实测发 ready。

---

## 五、遗留与方向

- **真机最终点验**: 见 U1-U3。尤其 U2——#2 修的是"此前从未真正工作的路径", 请用户真机查一次生词
  确认本地 LLM 查词全链路(词典 DB 未命中 → 守护 → 存本地词典 → 面板渲染)。
- **会话内查询历史**: #4 判断**不加**(用户原话是疑问句"底部是不是查询历史", 不是要历史)。已通过
  分节标题 + 来源说明把底部讲清楚; 若后续真想要"本会话查过哪些词", 内存数组即可, 不落库。
- **dict_daemon 残余风险**: 运行期侧车 stderr 只留尾部 8 行缓冲, 查词超时排查仍靠 aidulc.log 的
  `dict` 日志 + stderr 尾部; 不做运行期全量收集(避免无界增长)。
- **clippy 基线 7**: 未动, 仍按 docs/ROADMAP.md P3 的"参数过多改请求结构体"方向消化。
