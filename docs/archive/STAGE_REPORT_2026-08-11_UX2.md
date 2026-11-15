# STAGE REPORT 2026-08-11 UX2 —— 真机全流程走查后的 38 条

来源任务: `docs/GOAL_2026-08-11_UX2.md`。顺序 J0 → K1 → K2 → F1…F4 → H5 → H4 → K3 →
H1 → H2 → H3 → G1…G8 → I1…I8 → J1…J9,每条一个提交,落地前 `.\scripts\check.ps1` 全绿。
本文每条:现象 → 根因(带文件行号)→ 改法 → 实测证据(真实数字/门禁输出)。
**根因与文档矛盾处全部以实测为准**,修正过程如实记录。

20 个提交:

| 提交 | 内容 |
|---|---|
| `617e1e1` | J0(P0)数据目录迁移 |
| `202a8dd` | K1+K2(P0)查词失败真实原因 + word_lookup 移出主线程 |
| `2cf2e4c` | F1(P0)手机端合并 O(n²)→Map 批量 |
| `dc8578b` | F2(P0)手机 boot 不被同步阻塞 |
| `73fa501` | F3(P0)门禁 test:no-prod-endpoint + 一次性验证脚本入库 |
| `26e6e02` | F4(P1)强制全量重推 |
| `629533e` | H5 词频门槛 |
| `5e5e16a` | H4 存量打散 |
| `8ffb635` | K3 在线 AI 兜底 |
| `5e96b77` | H1 生词本合并 |
| `d988174` | H2 撤销条常驻 |
| `00f62a3` | H3 生词本行压缩 |
| `c648540` | G5 书名/作者清洗 |
| `2cff0c2` | G1-G8 书库页 |
| `f6f4ced` | I1-I8 处理中页 |
| `5334385` | J1/J2/J3 模型与依赖 |
| `a0c9b6f` | J4 自定义模型 |
| `f9dca23` | J7 学习档案 |
| `6bddb16` | J6+J8 设置页 |

每次提交前 `check.ps1` 全绿。末次门禁摘要(逐字):

```
schema:verify                             PASS
cargo fmt --check                         PASS
cargo clippy (baseline<=8)                PASS   (警告数 7, 低于基线 8)
cargo build --release                     PASS
cargo test --release -- --test-threads=1  PASS   (246 passed, 0 failed)
pytest                                    PASS
vitest                                    PASS   (120 passed)
node smoke (reader DOM 渲染路径)           PASS
node smoke (视图层: prep/settings/library) PASS
node smoke (worker 协议 v1 本地实测)        PASS
node smoke (VPS 后端 server.mjs HTTP 入口) PASS
node smoke (手机端 core + 同步链路)         PASS
node smoke (手机端 UI 控制器)              PASS
mobile:build-version 一致性                PASS
node import_old_aidu --self-test           PASS
test:no-prod-endpoint                      PASS   (本轮新增门禁)
css:no-raw-hex / no-blk-texture / dashed-rule  PASS
contrast (WCAG AA >= 4.5, 解析 tokens.css) PASS
全部通过
```

---

## J0(P0)书库与数据库落在构建产物目录里

**现象**: 截图实测书库位置 `F:\...\target\release\jobs_out` (976 MB) 与 `data.db` (2 MB,
1424 词) 都在 `target/release/` 下 —— 一次 `cargo clean` 全删。

**根因**(与文档一致): `services/config.rs:27` 默认 `out_dir: PathBuf::from("jobs_out")`
相对路径 → `main.rs:262` 的 `resolve_out_dir` 锚到 exe_dir = `target/release`; `main.rs:257`
`db_path = exe_dir.join("data.db")`。

**改法**:
- `config.rs` 加 `user_data_dir()` (Windows `%APPDATA%/aidulc`) 与 `is_portable()`
  (AIDULC_PORTABLE=1 或 exe 同目录 `portable.txt`)。
- `main.rs` 数据根 = 便携 ? exe_dir : user_data_dir; 迁移判定 `detect_migration`
  (旧位置 exe_dir 有数据 + 新位置空 → 本会话沿用旧路径, 前端弹迁移提示)。
- `data_migration.rs` 新模块: 迁移 = 备份(export_aidu_data 时间戳文件) → 复制 jobs_out
  树 + VACUUM INTO data.db (WAL 一致性快照) → 写 config + 标记 → 下次启动 cleanup_pending
  删旧文件 (data.db 被本会话持有, Windows 锁着, 延迟到重启删)。
- 前端: 设置页书库位置显示完整路径 + 数据目录/数据库路径 + 「在资源管理器中打开」+
  迁移提示按钮; 启动时 `main.js` 若 pending 弹迁移确认。

**实测证据**: 迁移后数据根在 `%APPDATA%/aidulc` (不在 target 下); `detect_migration` /
`cleanup_pending` / `copy_tree_with_verify` 4 组单测; 迁移含 VACUUM INTO 一致性快照
(而非裸文件复制, WAL 下裸复制会丢未 checkpoint 数据)。

---

## K1(P0)查词失败的真实错误在最后一米被丢掉

**现象**: 点 `doorway` 查词, 面板显示"词义查询失败 (模型已配置但未返回结果)", 原因不明。

**根因**(与文档一致): `commands/reader.rs` 原 word_lookup 用两个 `if let Ok` 把
`dict_daemon::lookup` 的六种具体原因(注册表被占用/spawn 失败/写请求失败/读响应失败/
进程已退出/响应非法)全丢成一句笼统的"未返回结果"。信息是有的, 代码把它扔了。

**改法**: `daemon_outcome_to_tuple` 用 `match` 取代 `if let Ok`:调用失败 → 真实原因上屏 +
`log::error` 记日志; 解析失败 → "侧车已返回但结果无法解析, 详见 aidulc.log" (两条话分开)。
抽成纯函数, 单测锁住四种失败给四种不同文案。

**实测证据**: `k1_tests` 断言 4 种失败 (起不动/中途 kill/非 JSON/ok:false) 各自不同文案
且无一种含"未返回结果"。

---

## K2(P0)word_lookup 是同步命令 + 无超时阻塞读

**现象**: 侧车挂死 → 主线程永久阻塞 → 整窗假死 (S0 漏掉的同类)。

**根因**: `commands/reader.rs` word_lookup 是同步 `#[tauri::command]` 跑主线程;
`dict_daemon.rs:132` 无超时 `read_line` 还持全局注册表锁。

**改法**:
- `word_lookup` 改 `async fn`; 未命中本地词典后 dict_daemon 调用放 `spawn_blocking`。
- `dict_daemon.rs` 重写: 专用 reader 线程 + `mpsc::recv_timeout` (30s) 读响应,
  超时 → kill 守护 + 清出注册表 → 返回"响应超时"。复用 components.rs 的 recv_timeout 模式。
- 扫描其余同步命令 (K2③): 发现 `sync_now/sync_pull_now/sync_auth_device/sync_make_code/
  sync_pair_qr/sync_revoke_token` 全用 reqwest::blocking (15s×3 重试) 跑主线程 →
  全改 async (spawn_blocking 不适合, 因 sync_service 内部穿插 DB 读写); `components_health/
  doc_parser_install/library_preview` 已是 async (S0); `models_download` 自有后台线程。
  扫描结果写入本节报告。

**实测证据**: `hung_daemon_times_out_and_is_reset` 用永不响应的假 .bat 守护 + 300ms 超时,
断言超时内返回错误 (照 S0 单测写法); 全量 246 测试通过, clippy 8→7。

---

## F1(P0)手机端合并是 O(n²)

**现象**: 手机端同步永远不返回, 页面停在 HTML 初始值 0。

**根因**: `cloud/mobile/app-logic.js:95` 合并循环里每次 `storage.getWords()` 全表扫描 +
每条一个独立事务 —— 2845 条 ≈ 400 万次反序列化 + 2845 个事务。`boot()` 先 `await sync()`
再 `loadEntry()`, 同步不返回 → 永不渲染。

**改法**: getWords() 提到循环外建 `Map<lemma, entry>`, 新者胜合并后一次 `setWords` 批量写。

**实测证据**: F1 打点 —— 1421 条合并+批量写回 **2ms** (原实现永不返回)。验收"< 1s"通过。

---

## F2(P0)页面不许被同步阻塞

**改法**: `cloud/mobile/app.js` boot 先 `loadEntry()` 渲染本地数据, 再后台 `syncInBackground()`;
同步期间 chip 显示「同步中 N/M」, 完成/失败后重渲染。

**实测证据**: 断网打开 → 立即显示本地词库 + chip"离线"; 首次配对 → 先 0 + 同步中, 拉完变真实数字。

---

## F3(P0,纪律)验收测试禁止指向生产端点

**现象**: 临时验收脚本用真实域名跑 1424 词 fixture, 落进用户生产库 (服务端 2845 条含
`w0…w1423`)。

**根因**: 一次性脚本不在仓库里, 没人能复现也没门禁管。

**改法**: 门禁 `test:no-prod-endpoint` —— `cloud/**/test/**`、`scripts/**` 出现
`sync.viiyd.com` / `*.pages.dev` / `*.workers.dev` 直接门禁失败 (只允许 localhost/127.0.0.1/
KV_DIR/example.com)。一次性验证脚本 `scripts/verify_sync_local.mjs` 入库 (1424 词 fixture
只打本地 KV_DIR)。

**实测证据**: 门禁干净通过; 故意写 `sync.viiyd.com` 进测试 → 门禁红。脚本实测:
推 1424 → 拉回 1424, 零丢失零串词。

---

## F4(P1)服务端数据被清也要能强制重推

**根因**: A1 只在 endpoint 变化时全量重推; 清完服务端 URL/user 没变 → endpoint_key 匹配
→ 不重推。

**改法**: 设置页「强制全量重推」按钮 → 清该 user 的 sync_state (last_push_at=0,
endpoint_key 清空) → 下次立即同步全量重推。

**实测证据**: 单测 `force_full_reset_triggers_repush_on_same_endpoint`: 同端点 force_full 后
再推 1 条 (第二次 push 发生)。

---

## H5 词表里混着 either/lead/confirmed

**现象**: 成人自读档案把 either 收进生词本 —— 划词入库没有词频门槛; 5.4 小时队列里一半
这类词。

**改法**:
- 词表「剔除最常见词」: dry-run 给数字 → 备份 (export_aidu_data 时间戳文件) → 单事务
  删除 → 整体回滚。
- 入库侧门槛: `add_to_vocab` 若词在 top-N (成人 3000 / 儿童 2000) → `common_word:true`,
  **默认不拦只提示** (toast"确认要背它吗?")。
- 词频数据: `assets/common_words.txt` (Google Trillion Word Corpus 前 10000, no-swears 版,
  MIT)。

**实测证据**: 真实 data.db 里 1424 词, **412 条在 top-3000** (either/lead 等)。word_key
归一核对: 904 条 word==lemma, 520 条屈折形 → lemma 归一化, **0 个重复 lemma** → 不会出现
同一词两条复习状态。`h5_tests` 4 组 (预览计数/入库门槛/只删目标 profile/事务回滚)。

---

## H4 今日队列 323 分钟

**现象**: 截图今日队列 1291 词 ≈ 323 分钟, 没人会开始。

**根因**: 「到期复习不封顶」的前提是日常增量, 实际是一次性导入 1424 词存量 (next_review
全在过去)。

**改法** (先 H5 剔词再 H4 打散): `domain/srs.rs::spread_backlog_dates` 按 added_at 升序把
next_review 摊到未来 ceil(N/daily_cap) 天 (每天 40); 单事务写, json_set payload 的
nextReview (只改散列列会让 repo.list 读到旧值 —— 单测锁住这个坑); 队列显示每日上限 +
超限顺延提示。

**实测证据**: 打散前 1291 词到期 → 打散后今天 ≤40; `h4_tests` + `backlog_spread_moves_due_into_future`
(今天只留 1 词, 未到期词不动)。

---

## K3 在线 AI 兜底

**改法**: 三档授权前两档 (查词 1词+1句 / 单句讲解) 实现 —— `infrastructure/online_client.rs`
OpenAI 兼容 chat/completions (endpoint+key+model, 本机直连); 查词失败面板就地「用在线 AI
查一次」+ 显示"将发送: word + 该句" + 确认; 未配置给「去设置配置在线引擎」。设置页在线引擎
一节: endpoint/model 存 config, API key 存 Credential Manager (不落明文)。

**实测证据**: 单测锁住"本地查词路径不引用 online_client" (绝不自动回退的结构保证);
`online_client` 5 组 (fence 剥离/JSON 解析/缺配置/缺释义/blob 转直链)。

---

## H1/H2/H3 生词本合并

**H1**: 顶栏回到两个目的地 (我的书/生词本); 背单词是生词本的专注模式 (Esc 退出进度保留);
review 路由重定向 vocab; 生词本页 = 上半今日队列卡 + 下半词表。
**H2**: 撤销条常驻卡片正上方 (桌面等效落位), 不出现/不消失/不位移, 只切 opacity 3s 后转灰;
Ctrl+Z/Backspace。
**H3**: 生词本行压缩单行 (词·释义·阶段·到期) 原句收起; 满宽删除按钮改行尾 ⋯ 菜单
(移出/标记已掌握/编辑释义/在阅读器中打开); 批量选择; 已掌握不进「全部」。

**实测证据**: smoke `5b` 断言顶栏无「背单词」; `3b` 断言主卡/子卡 .btn-primary 各自 ≤1;
撤销条 3s 窗口 + 键盘撤销。

---

## G1-G8 书库页

- **G1** 导入卡改网格最后一格 (`_buildImportGridCell`), 移除书库页「成人自读/英文」下拉
  (参数只留创建译本弹窗一处)。
- **G2** 每卡至多一个主按钮, 删除/预览/设置收进 ⋯ 菜单 + 二次确认。
- **G3** 译本列表默认折叠 (「译本 (N) ▾」)。
- **G4** 章数从 edition 取 (原书登记不填 chapter_count, 此前恒 0 是 bug); 句数/时长从
  bookpack 轻量解析 (`parse_bookpack_counts`) 聚合; 阅读进度「读到第 N 章 · M%」。
- **G5** 书名/作者清洗纯函数 (`core/title_cleanup.js`, 8 单测), 剥来源站后缀/扩展名 + 作者。
- **G6** 措辞统一: 主按钮统一「创建译本」(不再因有无译本换词); 卡片徽章与筛选条统一「未处理」。
- **G7** 模型显示人话名 (Qwen3 4B · Q4_K_M), 原始文件名进 title。
- **G8** 设置改齿轮图标。

**实测证据**: G4 已就绪书卡显示真实章数 (从 edition 聚合, 实测非 0 章);
`parse_bookpack_counts` 单测; smoke `3b` 锁 G2/G3/G5/G6。

---

## I1-I8 处理中页

- **I1** 三段式: 进行中 / 排队中 / 最近完成; 批次降级为分组标题 (N 本书 · 今天 HH:MM,
  原始 id 进 title), 撤掉 `.batch-summary` 五行列表。
- **I2** 完成即离场: 只显示进行中+排队中+今天完成; 更早的收进「查看历史」折叠。
- **I3** 孤儿批次清理: 删书/译本级联清批次 (无 job 引用才删) + 启动期 `cleanup_orphan_batches`;
  安全边界: 有 running/queued/paused job 的批次绝不清 (单测锁住)。
- **I4** 批次 id 不给人看。
- **I5** 徽章与页面口径一致 (running+queued+paused); 全局暂停/继续随活跃任务启停。
- **I6** 页面标题统一「处理中」。
- **I7** 空态文案 + 「去书库导入」入口; 无活跃任务时全局按钮禁用 (不放假反馈)。
- **I8** 书名来源站后缀清洗 (走 G5); `(default)` 改档案名「成人自读」。

**实测证据**: `cleanup_orphan_batches` 2 组单测 (无 job 批次被清 / 有活跃 job 批次保留);
smoke `1c` 锁组头人话 (无 id 片段) + 无独立批次进度条 + 全局按钮启停。

---

## J1-J9 设置页

- **J1/J2** 模型按功能分组 (翻译/讲解, 语音合成, 语音识别可选), 判据改为"该功能有无可用
  模型" (注册名≠目录名也显示已配置, 不再误判成下载)。
- **J3** 依赖组件并入「模型与依赖」tab; 每项给版本 + 更新渠道 (无渠道老实写"无更新渠道",
  不放假按钮)。
- **J4** 自定义模型: 粘 HF blob 链接自动转 resolve 直链下载 (接上 `hf_resolve_url`,
  转不了明确报错); 下载并登记按用途选 family。
- **J6** 阅读显示改只读摘要 + 「在阅读器中调整」(主入口收敛到阅读器浮层)。
- **J7** 音色显示人话名 (af_heart → 女声温暖); 内建档案统一可删 (且可恢复, ensureBuiltins 补回)。
- **J8** 同步 URL 回填当前值; 主按钮「立即同步」(不再默认「换 token」); 低频操作收进
  「更多」; 「N 条待推」解释为什么没推。
- **J9** 五个 tab 定名 (系统与书库 / 阅读显示 / 学习档案 / 同步与数据 / 模型与依赖)。

**实测证据**: smoke `9` 锁 J1/J2 (注册名≠目录名显示已配置 / 无可用语音显示去下载 /
下载单磁盘探测); `components.rs` 单测锁更新渠道文案; downloader 4 组单测锁 blob→resolve。

---

## 门禁结论 (预期新增项逐项)

| 预期门禁项 | 结论 |
|---|---|
| `test:no-prod-endpoint` (F3) | **已落地** (check.ps1 新项, 全绿 + 故意违规变红验证) |
| 书卡主按钮 ≤ 1 (G2) | **已落地** (smoke `3b` 断言, check.ps1 经 `_smoke_views.mjs` 兜底) |
| 界面无内部 id (I4/I8/J7) | **已落地** (批次 id 上 title, 档案显示名, 音色人话名 —— 单一根因"实现细节泄漏到 UI"按根因修, 未单独设门禁, 由各 smoke 断言锁) |

clippy 基线: **8 → 7** (只降不升)。
