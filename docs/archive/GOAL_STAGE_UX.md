# GOAL:真机试用 5 处不可用 —— 按根因修,每类补门禁

aidulc = 本地精读工作站:Rust/Tauri (`src-tauri/`) + Python 侧车 (`prep/`) +
WebView (`reader/`) + 同步后端 (`cloud/worker/`) + 手机 PWA (`cloud/mobile/`)。
上轮门禁全绿,真机跑完整流程仍有 5 处不可用。**共同点是"内部状态对了,用户看到的
没对上"** —— 每修一处必须补一条门禁,否则下轮同样退化。

**纪律**:一条一提交;落地前 `.\scripts\check.ps1` 全绿;clippy 基线 8 只降不升;
Rust 测试 `--test-threads=1`;新 `.ps1` 用 UTF-8 BOM;`tokens.css` 是颜色唯一来源,
不写裸 hex;一张表只允许一个 repo 写;服务端只存 SRS 状态 + 词条最小集(含来源单句),
**永不存书文件和整章正文**;`user_id` 由服务端从 token 解析,客户端不得自报。
提交信息写**真实数字**(推了几条 / ΔL 实测 / 队列行数),不写"优化""修复"。

顺序 **A → B → E → D → C**(先修不可用,再修迷惑,最后修不好看)。

---

## 全业务流程(先对齐,5 个现象各自挂在这上面)

```
[备料流] 导入原书 → prep 侧车批处理 → edition 成品 → 书库
           ↑ D:模型中心的模型是这一步的前置

[阅读流] 打开译本 → 逐句/通篇播放 → 点词查词 → 加入生词本 / 摘录
           ↑ B:播放粒度        ↑ C:六个语义通道的颜色区隔

[学习流] 生词本 → 今日队列(SRS 配比: 到期不封顶 + 新词每天 6) → 四档评分 → 写回 vocab
           ↑ E:三栏容器高度

[同步流] 桌面 vocab --推--> worker (srs:{user}:{word} + deck:{user}:index) --拉--> 手机 PWA
           ↑ A:断在这里

[身份流] users(谁) × profiles(讲解策略) × token(服务端 user) —— 三者互相独立
         本地新建成员**天然没有 token**,必须单独用 6 位 invite-user 码配对;
         绝不复用当前 user 的 token(那会把两个人的词推进同一个服务端 user)
```

**五个现象的归位**:同步流断在最后一跳(A);阅读流缺一个开关(B)和一套可见的颜色(C);
学习流的容器高度失控(E);备料流的模型状态判断错源(D)。

数据流向的硬约束(不许违反):**词条的真相源永远是桌面 SQLite 的 `vocab` 表**,
服务端 KV 是镜像,手机 IndexedDB 是镜像的镜像。冲突一律 `updated_at` 新者胜。
镜像可以随时清空重建,真相源不可。

---

## A(P0)同步:显示"已同步"但服务端是空的

**现象**:桌面填 URL + ROOT_SECRET → 换 token → 立即同步 → 显示完成;手机扫码打开
正常,**一个单词都没有**。

**根因**:`store/sync_state_repo.rs` 每行只有 `user_id + last_push_at + last_pull_rev`,
**不记录这份进度属于哪个服务端**。全仓写它的只有 `application/sync_service.rs` 的
252/298/407 三处,全是同步成功后推进 —— 换 URL / 换 token 都不重置。于是
`sync_service.rs:191` 的 `e.updated_at > last_push_at` 选出空集 → 走
`to_push.is_empty()` 分支返回 `ok:true, wrote:0` → UI 显示"已同步",服务端仍是空的。
这是规约要优先排除的最差情况:**后台没做事,用户以为成功**。

- **A1** `sync_state` 加 `endpoint_key`(= worker_url + `auth_device` 返回的服务端
  `user_id`,该返回值现在被丢掉)。不匹配**或为 NULL** → 当作从未同步、全量重推
  (宁可多推,不可少推)。老行按 NULL 处理。
- **A2** `SyncStatus` 加 `last_wrote` / `last_pulled`,`views/settings_view.js` 显示
  「本次推 N 条 / 拉 M 条」。**N=0 且服务端 deck 为空 → 警示,不许显示"已同步"**。
- **A3** `cloud/mobile/app.js:444` 的 `.catch(() => {})` 吞掉全部同步错误(拉取失败 /
  token 失效 / IndexedDB 写失败一律表现为"没有单词")。去掉裸 catch,失败显示人话原因;
  设置面板加「同步诊断」:URL / 有无 token / 上次 rev / 本次拉回条数 /
  `cloud/mobile/core.js::buildQueue` 各分组计数。**"拉到 1424 词但今日只放 6 个新词"
  与"一个词都没拉到"必须一眼可分** —— `newWordQuota` 新词每天上限就是 6。
- **A4** worker 加 `GET /` 返回一行纯文本(服务名 + 版本 + "这是 API,手机请用桌面端
  生成的二维码链接")。现在返回 `未找到路由: /`,行为正确但对人零信息。

**验收**:单测断言 `endpoint_key` 变化后待推为全量(不依赖网络);真机换 URL → 同步 →
UI 报「推 1424 条」→ 手机词库非空;断网点同步 → 明确报错。

## B(P0)阅读:点句前三角还是一路读到章末

**代码已经对了,入口没有**。`views/reader_view.js:749` 只在 `rd.pace === 'sentence'`
时调 `_playOne`(单句停);而 `core/reader_state.js:33` 默认 `'flow'`,**切换只有一个
`S` 快捷键**(藏在提示行),`views/reader/settings_overlay.js` 只有字号/行距/栏宽/语速/
高亮粒度/深色/儿童取值 —— **没有任何播放控制**。用户找不到,是因为它确实不在。

加「播放」一节:① 通篇 ⇄ 逐句(调 `rd.setPace`,不新增状态);② 跟读预设(复用
`core/shadow.js` 的 repeat N,不新写);③ 句前按钮 title 随 pace 变。默认值不变。

**验收**:设置面板可见开关;逐句下点三角 → 播完该句暂停、锚点不前移;跟读预设下重复 N 次后才停。

## C(P1)颜色:门禁量令牌原值,页面渲染稀释值

`scripts/check_contrast.mjs:113` 的 `CHANNELS` 读 `tokens.css` 的**原色**,
但 `reader.css` 渲染时把它们稀释了:

| 通道 | 实际渲染 | 门禁现状 |
|---|---|---|
| 正在朗读的词 | `background: var(--rd-reading-bg)` 全强度 | ✅ ΔL≥0.05 |
| 当前句 | `color-mix(--rd-accent **7%**)` (`reader.css:164`) | ❌ 完全没查(ΔL≈0.02) |
| 摘录句 | `inset 3px color-mix(--rd-hl **70%**)` (`reader.css:155`) | ❌ 完全没查 |
| 摘录词 | `color-mix(--rd-hl **28%**)` (`reader.css:159`) | ⚠️ 只查 AA 可读性 |
| 已在生词本 | `inset 0 -1px var(--rd-saved)` | ✅ ΔE 两两判别 |
| 短语动词 | `inset 0 -2px var(--rd-mark)` | ✅ ΔE 两两判别 |
| 文本选中 | **`::selection` 全仓无规则** | ❌ 通道根本不存在 |

这就是"上轮改完令牌、门禁全绿、眼睛还是看不见"的机制:**量的是原色,看的是稀释色**。

- **C1** 门禁改成量**渲染后的合成色**(已有 `mix()` 函数,扩展它),每通道加 ΔL ≥ 0.05
  **可见性**下限,与 AA **可读性**并列,两条都要过。
- **C2** 新增 `--rd-select` 通道(5 色系 × 明暗 10 组),纳入 ΔE≥10 两两判别。
- **C3** 当前句混合比例**提到门禁过为止 —— 由数字决定,不靠肉眼调**。形态编码
  (标线/下划线粗细)一律不动:设计稿 §06 的结构是对的,一直错的是取值。

## D(P1)模型中心:文件已在磁盘还显示"下载"

`views/models_view.js:81` 判据只有注册表 (`family + model_id`),不看磁盘。文件在但
没登记(或 model_id 不同)→ 照样显示「下载」,点了重下 GB 级文件。
改三态:「已登记」/「磁盘已有 · 点此登记」/「下载」,第二态走 `register`;探测复用
`services/components.rs::check_file` 的大小校验思路。
**验收**:删注册表记录、保留文件 → 显示「磁盘已有 · 点此登记」。

## E(P1)背单词布局:左栏无限长,中栏卡片被拉长

`styles/app.css:46` 是 `#app { min-height: 100vh }`(**不是 `height`**),`app.css:176`
是 `.app-view { flex: 1 }` —— 没有祖先有确定高度。于是 `.review-view { height: 100% }`
(549 行)解析成"内容有多高就多高",`.review-queue-list { flex:1; overflow:auto }`
(572 行)**永远不会滚动**,1424 行把整页撑开,中栏卡片跟着拉长。

- `#app { height:100vh; overflow:hidden }` + `.app-view { min-height:0; overflow-y:auto }`。
- **全局改动,必须逐个视图回归**:书库/处理中/生词本/背单词/设置/阅读器/向导。
- 今日队列加长度上限 + 超出折叠(它本就该是"今天要背的",不是全词库)。

**验收**:1424 词进队列 → 窗口无整页滚动条,左栏内部滚动,中栏卡片高度恒定。

---

**不做**:虚拟滚动库(折叠即可)、账号体系、字号/间距令牌存量迁移、clippy 基线清零、
原生 apk/iOS、内置公版书。

**交付**:每条一个提交 + `docs/STAGE_REPORT_2026-08-11_UX.md`:现象 → 根因(带文件
行号)→ 改法 → **验证证据(真实数字 / 截图 / 门禁输出)**。不许写"应该可以了",
只写实测结果。根因与本文档矛盾时以实测为准,并如实记录"最初以为是 A,实测发现是 B"。
