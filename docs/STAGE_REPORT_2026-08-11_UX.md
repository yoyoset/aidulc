# STAGE REPORT 2026-08-11 UX —— 真机试用 5 处不可用

来源任务: `docs/GOAL_STAGE_UX.md`。顺序 A → B → E → D → C,每条一个提交,落地前
`.\scripts\check.ps1` 全绿。本文每条:现象 → 根因(带文件行号)→ 改法 → 验证证据
(真实数字/门禁输出)。**根因与文档矛盾处全部以实测为准**,修正过程如实记录。

五个提交:

| 提交 | 内容 |
|---|---|
| `2005b81` | A(P0)同步: endpoint_key + 推/拉条数显示 + 手机端去裸 catch + worker GET / |
| `64bd99c` | B(P0)阅读: 设置面板补「播放」节 |
| `7333108` | E(P1)布局: #app 定高 + 视图滚动归 .app-view + 今日队列折叠 |
| `10eeefb` | D(P1)模型中心: 三态判据加磁盘 |
| `df153fe` | C(P1)颜色: 门禁量渲染后合成色 + --rd-select + 混合比例数字决定 |

每次提交前 `check.ps1` 全绿。末次门禁摘要(逐字):

```
schema:verify                             PASS
cargo fmt --check                         PASS
cargo clippy (baseline<=8)                PASS   (警告数 8, 未新增)
cargo build --release                     PASS
cargo test --release -- --test-threads=1  PASS   (202 passed, 0 failed)
pytest                                    PASS
vitest                                    PASS
node smoke (reader DOM 渲染路径)           PASS
node smoke (视图层: prep/settings/library) PASS
node smoke (worker 协议 v1 本地实测)        PASS   (55 passed)
node smoke (VPS 后端 server.mjs HTTP 入口) PASS   (5 passed)
node smoke (手机端 core + 同步链路)         PASS   (47 passed)
node smoke (手机端 UI 控制器)              PASS   (42 passed)
mobile:build-version 一致性                PASS
node import_old_aidu --self-test           PASS
css:no-raw-hex / no-blk-texture / dashed-rule  PASS
contrast (WCAG AA >= 4.5, 解析 tokens.css) PASS
全部通过
```

---

## A(P0)同步: 显示"已同步"但服务端是空的

**现象**: 桌面填 URL + ROOT_SECRET → 换 token → 立即同步 → 显示完成; 手机扫码打开
正常,**一个单词都没有**。

**根因**(与文档一致):
- `store_mod.rs:647-659` (v22) 建的 `sync_state` 每行只有 `user_id + last_push_at +
  last_pull_rev`, **不记录这份进度属于哪个服务端**; 唯一写者 `sync_service.rs` 三处
  (252/298/407) 全是同步成功后推进,换 URL / 换 token 都不重置。
- 于是换服务端后 `sync_service.rs:261` 的 `e.updated_at > last_push_at` 选出空集 →
  `sync_service.rs:266` 的 `to_push.is_empty()` 分支返回 `ok:true, wrote:0` → UI 显示
  "已同步",服务端仍是空的。这是规约要求优先排除的最差情况:后台没做事,用户以为成功。

**改法**:
- **A1** 迁移 v23 (`store_mod.rs:660` 起)给 `sync_state` 加 `endpoint_key`
  (= worker_url|auth_device 返回的服务端 user_id)。`sync_state_repo.rs` 读/写带上新列;
  `sync_service.rs:56-76` 新增 `endpoint_key_for` / `resolve_state`:endpoint_key 为空
  (老行)或不匹配(换 URL/换服务端 user)→ `last_push_at/last_pull_rev` 按 0 处理,**全量
  重推(宁可多推,不可少推)**。auth_device 返回的服务端 user_id 此前被丢掉,现由
  `sync_auth_device` 存进 Credential Manager (`credentials.rs` 新增
  `save/get_server_user_for`),命令层读出来传给服务比较。
- **A2** `SyncStatus` 加 `last_wrote/last_pulled/deck_exists`
  (`sync_service.rs:21-33`);`settings_view.js:214-230` 显示「本次推 N 条 / 拉 M 条」,
  且同步后 N=0 且服务端 deck 为空 → 警示文案,不显示"已同步"。
- **A3** 手机端:去掉 `app.js:444` 的 `.catch(() => {})` 裸吞错误,失败显示人话原因 +
  chip 保持失败态(`lastSyncError`,`app.js:31/87/90/160-161`);设置页加「同步诊断」
  (URL / 有无 token / 上次 rev / 本次拉回条数 / buildQueue 分组计数,
  `app.js:120 renderDiag`),一眼区分"拉到 1424 词但今日只放 6 个新词"与"一个词都没
  拉到"。
- **A4** `cloud/worker/src/index.js:111-120` 的 `GET /` 返回一行人话纯文本,不再
  `未找到路由: /`。

**实测修正(与文档根因不同的部分,以实测为准)**:
写 A1 验收测试"换端点必须全量重推"时,第二次同步 `last_wrote` 恒为 0,测试一直红。
加 DEBUG 打印发现:第一次同步的**拉取合并**把本地两条词的 `updated_at` 打成 0
(`entries before s2: [("bank",0),("languid",0)]`)。最初以为是我端点比较写错,实测
发现是**独立的既有数据损坏 bug**:

1. 服务端词条是 snake_case 最小集(`updated_at/interval_ms/ease_factor/next_review`,
   `to_minimal_payload` 构造),而 `VocabEntry` 的 serde 只认 camelCase
   (`vocab.rs:59` `#[serde(rename="updatedAt")]`)→ 拉回解析全变默认值(updated_at=0、
   interval_ms=0、ease_factor=0、next_review=None)。
2. `merge_remote_into_local` 写回条件按 `r.updated_at == m.updated_at` 在合并结果里找
   —— 时间戳**相等**时合并结果就是本地 envelope,照样命中,把"解析成 0 的远端最小集"
   写回本地。也就是说每次全量拉取都把本地 SRS 状态清零一遍(该 bug 被既有测试漏过:
   `pull_writes_back` 只断言 meaning/stage,没断言 updated_at/interval/ease)。

修:`remote_to_entry`(`sync_service.rs:436`)补读 snake_case 字段;写回条件改为"**远端
严格更新**(远端 updated_at > 本地)才写,相等=本地是源头不写"(`sync_service.rs:502`)。
新增 `pull_equal_timestamp_does_not_overwrite_local` + 强化 `pull_writes_back` 断言锁住。

**验证证据**:
- 新增 Rust 单测 `endpoint_change_triggers_full_repush`:首轮推 2 条(1 次 push);换服务端
  user → 第二次**必须再推 2 条**(push 计数 1→2);同端点再同步推 0 条(push 计数保持 2)。
- 新增 `pull_equal_timestamp_does_not_overwrite_local`:相等时间戳写回条数 = 0,本地
  updated_at/interval_ms/ease_factor 不被清零。
- cargo test `--test-threads=1`: 202 passed, 0 failed(含 sync_state_repo 的
  endpoint_key roundtrip 测试)。
- mobile `app_test.mjs`: 47 passed(含同步诊断 last_rev/last_pulled 元数据、1424 词
  队列 6 新词 vs 空词库一眼可辨);worker `local_test.mjs` 55 passed(含 GET / 人话
  文本 3 断言)、`server_test.mjs` 5 passed。
- 单测断言数字:首轮 `last_wrote=2`,换端点后 `last_wrote=2`(全量重推),同端点
  `last_wrote=0`。

---

## B(P0)阅读: 点句前三角还是一路读到章末

**现象**: 句前三角点了就一路播到章末,没有"只播这一句"的入口。

**根因**(与文档一致): 代码已经对了,入口没有。
- `reader_view.js` 的 `_toggleSentencePlay` 只在 `rd.pace === 'sentence'` 时调
  `_playOne`(单句停);
- `core/reader_state.js:33` 默认 `pace='flow'`,切换只有藏在提示行(`reader_view.js:441`)
  的 `S` 快捷键;
- `views/reader/settings_overlay.js` 只有字号/行距/栏宽/语速/高亮/深色/儿童,
  **没有任何播放控制**。用户找不到,是因为它确实不在。

**改法**:
- `settings_overlay.js:61-78` 加「播放」节:播放粒度 通篇⇄逐句(复用 `rd.setPace`,
  不新增状态)→ `onPatch({pace})`;跟读预设四档(初听/跟读/盲跟/孩子,复用
  `core/shadow.js` 的 repeat N,不新写)→ `onPatch({preset})`。
- `reader_view.js:960` 新增 `_setPaceFromSettings`:进逐句走 `_enterSentencePace` /
  退走 `_exitSentencePace`(与 S 键同一条路径),保证跟读条可见性/跟读目标/持久化一致。
  `_onSettingsPatch`(`reader_view.js:943`)里 pace/preset 走专用方法,不走裸
  `_applySettings`。
- `_selectPreset` 回写 `_settings.preset/speed`,防 `_applySettings` 用旧 speed 盖掉
  预设速度。
- gear 打开前把 live 的 pace/preset 同步进 settings 快照(`reader_view.js:323-331`)。
- **③ 句前按钮 title 随 pace 变:实测确认已在 S5 落地**(`atomic_block.js:293 setPace` +
  `reader_view.js:462 _updateFollowDataAttrs` 逐块下发),本文档不重复实现,只验证。

**验证证据**:
- `_smoke_views.mjs` 新增第 8 节 7 项断言:「播放」节渲染、默认档位=通篇+跟读、
  点「逐句」→ `onPatch({pace:'sentence'})`、点「盲跟」→ `onPatch({preset:'blind'})`。
- 既有 S5 冒烟仍过:`逐句下点三角 → 播完该句暂停、锚点不前移` 与
  `跟读 repeat 用完 → 才停`(`_smoke_views.mjs` 第 7 节,repeat 第 1/2 次越过未停,
  第 3 次越过才停)。
- vitest 112 passed;check.ps1 全绿。

---

## E(P1)背单词布局: 左栏无限长,中栏卡片被拉长

**现象**: 1424 词进队列 → 窗口出现整页滚动条,左栏 `.review-queue-list` 内部不滚动,
中栏卡片被拉长到内容高度。

**根因**(与文档一致):
- `app.css:46`(改前)是 `#app { min-height: 100vh }`(**不是 height**),`app.css:176`
  是 `.app-view { flex: 1 }` —— 没有任何祖先有确定高度。
- 于是 `.review-view { height: 100% }`(`app.css:553`)解析成"内容有多高就多高",
  `.review-queue-list { flex:1; overflow:auto }`(`app.css:575`)**永远不会滚动**,
  1424 行把整页撑开,中栏卡片跟着拉长。

**改法**:
- `#app { height:100vh; overflow:hidden }` + `.app-view { min-height:0; overflow-y:auto }`
  (`app.css:49/179`)。滚动归 `.app-view`,导航固定。
- **阅读器例外**:其滚动逻辑全部基于 window(`reader_view.js:100/540/555/699/735` 的
  scrollY/scrollTo/scrollIntoView),`.app-view` 内部滚动会让 `window.scrollY` 恒 0、
  锚点定位失灵 → `reader.css:14-16` 在 `body.reader-active` 时恢复 `#app` auto +
  `.app-view overflow:visible`,阅读器继续窗口滚动。逐个视图回归:书库/处理中/生词本/
  背单词/设置/向导都走 `.app-view` 内部滚动,阅读器走窗口滚动。
- 今日队列渲染上限 50 行 + 「还有 N 词已折叠 · 点此展开」(`review_view.js`,
  `_renderQueueList`;按钮样式 `.review-qmore`)。队列是"今天要背的",到期复习不封顶
  时可上千行,不该一次铺开。

**验证证据**:
- `_smoke_views.mjs` 新增 6c 节 4 项断言:1424 词 → 队列全量 1424、默认渲染 50 行、
  折叠按钮文案含 1374、点展开 → 渲染全量 1424 行且按钮消失。
- 测 stub 的 `innerHTML=''` 改为清空子节点以匹配真实 DOM(原 no-op 让重渲染重复叠加,
  是测试设施失真,不是产品 bug)。
- check.ps1 全绿;vitest 112 passed。

---

## D(P1)模型中心: 文件已在磁盘还显示"下载"

**现象**: 文件在磁盘但没登记(或 model_id 不同)→ 照样显示「下载」,点了重下 GB 级文件。

**根因**(与文档一致): `models_view.js:82` 判据只有注册表
(`models.find(m => m.family === item.family && m.model_id === item.name)`),不看磁盘。

**改法**:
- Rust 新增命令 `model_file_check(path, min_bytes)`(`commands/models.rs:123-132`),复用
  `services/components.rs:23 check_file` 的大小校验思路(present = 是文件,
  healthy = size >= min_bytes);注册进 `main.rs` + `ipc/registry.rs`。
- `reader/services/model_service.js` 加 `fileCheck()`。
- `models_view.js:73-99` 一键下载区改三态:
  已登记(注册表命中,不再探测磁盘)→ 按钮「已登记」禁用;
  **磁盘已有 · 点此登记**(`_probeDiskState`,`models_view.js:105` 调 fileCheck,
  present+healthy)→ 点它走 `_registerExisting`(`models_view.js:143`,登记磁盘现有路径,
  不进下载流);
  下载(其余)→ 原下载流。min_bytes 阈值 = 期望大小 50%(目标是"存在且大小合理",不是
  字节级校验)。探测失败一律落「下载」兜底,不阻塞;`_modelDir` 提取复用,探测与下载
  用同一来源目录。

**验证证据**:
- `_smoke_views.mjs` 新增第 9 节 5 项断言:已登记 → 按钮「已登记」;磁盘已有 → 按钮含
  「磁盘已有」;只探测未登记项(探测调用 1 次,只查 kokoro 路径);点登记 → register
  用磁盘路径 + model_id=Kokoro-82M;磁盘无文件 → 两行都显示「下载」。
- check.ps1 全绿(含 registry 一致性断言 `registry_matches_generate_handler`,
  新命令两端一致)。

---

## C(P1)颜色: 门禁量令牌原值,页面渲染稀释值

**现象**: 上轮改完令牌、门禁全绿,眼睛还是看不见。

**根因**(与文档一致): `scripts/check_contrast.mjs`(改前)的 CHANNELS 直接读
`tokens.css` 的**原色**,但 `reader.css` 渲染时用 `color-mix` 稀释了:
- 当前句 `color-mix(--rd-accent 7%)`(`reader.css:183`,改前 7%)→ 完全没查,深色下
  渲染色 ΔL 仅 ~0.012,眼睛看不见"正在读哪句";
- 摘录句 `inset 3px color-mix(--rd-hl 70%)`(`reader.css:169`)→ 完全没查;
- 摘录词 `color-mix(--rd-hl 28%)`(`reader.css:175`,改前 28%)→ 只查 AA,不查可见性;
- 文本选中 `::selection` 阅读器无独立通道。

**改法**(C1/C2/C3):
- `check_contrast.mjs` 改为从 `reader.css` 解析三个 color-mix 的**真实比例**(单一真相,
  解析不到直接失败 —— 渲染形态变了门禁必须跟着变,不许静默漂移),量**渲染后合成色**:
  - C-① `--rd-select` 5 色系 × 明暗 10 组必须全定义(缺一个直接失败);
  - C-② 每通道渲染色 vs 纸面 ΔL≥0.05 可见性下限(reading-bg / current-sentence /
    hl-sentence / hl-word,共 40 项);
  - C-③ 承载文字的底色(hl-word 30% / current-sentence 28%)ink 仍过 AA≥4.5;
  - 原有 ΔE≥10 两两判别纳入 `--rd-select`(通道数 5→6,共 15 对)。
- **C2** `tokens.css` 新增 `--rd-select`(#7a5fa8 浅 / #b3a0d8 深,10 组,候选值先离线
  用 ΔE 脚本枚举、门禁复验);`reader.css:18-22` 加 `body.reader-active ::selection`。
- **C3** 当前句 7%→**28%**,摘录词 28%→**30%** —— 由数字决定:枚举脚本最小满足
  ΔL≥0.05 的比例,深色当前句需要 26-28%(rose 深 28% 最紧),摘录词 sage/ocean 深色
  28% 只有 0.046 不够、要 30%。形态编码(标线/下划线粗细)一律未动。

**验证证据**:
- `check_contrast.mjs` 新增 70 项 C 系检查全部 PASS(C-① 10 + C-② 40 + C-③ 20),原 S6
  ΔE/AA 与全部对比度项全 PASS,退出码 0。
- 关键数字:当前句 28% 渲染色 ΔL 深色 clay 0.0504 / sage 0.0521 / ocean 0.0532 /
  rose 0.0504 / slate 0.0513(全 ≥0.05);hl-word 30% 渲染色 ΔL 深色 sage/ocean 0.05+
  (28% 时 0.0463 不达标,故提到 30%)。
- check.ps1 全绿;`css:no-raw-hex`(新增色全在 tokens.css,reader.css 只引用 var)与
  `css:no-blk-texture` 均过。

---

## 修正记录(以实测为准)

1. **A 的根因**:文档说的"sync_state 不记录服务端归属"成立,但写验收测试时实测出
   **第二个独立 bug**:拉取合并 `merge_remote_into_local` 在时间戳相等时把 snake_case
   最小集(解析成 0 的 SRS)写回本地,每次全量拉取都清一遍本地 updated_at 与
   interval/ease/next_review。文档没提到,不修的话 A 的"全量重推"验收测不出来。
   已在 A 提交内一并修复并补 2 个回归测试。
2. **C 的取值**:文档只说"当前句混合比例提到门禁过为止",实测枚举发现摘录词 28% 在
   sage/ocean 深色下 ΔL=0.0463 < 0.05,也必须提到 30% —— 不是只调当前句一处。
3. **B 的 ③**:句前按钮 title 随 pace 变,实测确认 S5 已实现(`atomic_block.js:293`),
   本阶段只验证未重复实现。
4. **测试设施修正**:`_smoke_views.mjs` 的 DOM stub 里 `innerHTML=''` 原本不清空子节点
   (真实 DOM 会),导致重渲染重复叠加;改为清空以匹配真实 DOM。这是测试失真,不是产品 bug。
