# GOAL · 背单词 + 身份模型 + 同步重建

设计源:`生词本和背单词完整设计交付确认/aidulc 背单词.dc.html`(手机端/桌面端/KV 同步)。
目标:生词本从"只能看的列表"变成**多人多设备的背单词系统**——桌面三栏键盘驱动、手机一次一卡、
复习状态跨设备同步、同一台设备不同人看到各自内容。

## 约束

`CLAUDE.md` 全部有效(存储所有权表/`sync_schema.ps1 -Verify`/Rust 测试 `--test-threads=1`/
`.ps1` UTF-8 BOM/颜色只走 tokens.css)。一卡一提交,落地前 `check.ps1` 全绿,clippy 基线只降不升。
**验收必须是能机械核对的事实**(测试名、命令输出、时间戳),不是"已完成"。
外部行为(Android 构建/KV/SQLite 语义)一律实测拿输出,与本文矛盾时**以实测为准**并回来改本文。

## 现状(已 grep 确认,别重猜)

- SRS 字段已在 `vocab` 表(stage/interval_days/ease_factor/next_review/reviews),但**无调度器无复习 UI**。
- 来源句已存(`vocab.context`),但**无来源定位**(无 book/chapter/sentence 字段)。
- 同步链路在(`sync_service.rs`+`aidu_worker_client.rs`,url/token 可配),只是 CF 服务端被删;
  且 `sync_now` **硬编码 profile "default"**。合并逻辑 `domain/sync.rs` 已有,复用别重写。
- `vocab`/`dictionary` 按 profile 隔离;`reading_state`/`highlights` **无人维度**(多人会互相覆盖)。
- Tauri v2(移动端可行);Python 侧车 6.3GB,永不上手机。

## 设计稿与现实的六处冲突(先解决再画)

1. **§03"词条不上传"与手机端矛盾**:手机没书包没词典模型,不传卡就是空的。
   改为同步词条最小集(词/音标/释义/来源句,约 300-600B/条,5000 词≈2MB),不传书正文。§03 该句作废。
2. **1 分钟/10 分钟存不下**:`interval_days` 是 INTEGER 天且按 `as i64` 截断 → 分钟级变 0。加毫秒级字段,
   `interval_days` 只留作 AIDU 导出兼容。
3. **按钮上的四个时间不许前端写死**:必须由调度器对当前词算出后返回,否则算法一改按钮不跟着变,
   显示与实际排期不符。
4. **user ≠ profile**:现状拿 profile(讲解策略)当人用。引入独立 `user` 维度,profile 退回策略语义,
   user 持有默认 profile。迁移映射:每个现有 profile → 一个 user(default→我、kid→孩子),事务内完成、可回滚。
5. **user 必须由服务端从 token 解析**,客户端不许自报,否则改个参数就能读别人词库。接口带 `/v1/` 前缀,
   为将来账号体系留位。
6. **手机端"跳到原文"做不到**(无书包):改不可用态"在电脑上打开";桌面端保留完整跳转。

## 任务卡(一卡一提交)

**V0 可行性**:① Tauri v2 Android **不带侧车**能否打出可安装 apk —— 贴命令/产物/大小,失败贴输出;
② CF KV 免费额度实测记录(定推送频率上限);③ 六处冲突写进 `docs/DESIGN_NOTES_SRS.md`(哪句作废、为什么)。
iOS 需 macOS+开发者账号,不做。

**V1 身份模型(迁移 v20)**:建 `users` 表 + `store/users_repo.rs`(唯一写者,同步改 CLAUDE.md 所有权表);
`vocab`/`dictionary`/`reading_state`/`highlights`/`reading_daily` 加 `user_id` 并回填;顶栏切人(最小可用)。
验收:迁移测试(仿 `v18_migrates_legacy_product_without_loss`)断言词条/进度/摘录零丢失 + 切人后各自数据的测试。

**V2 调度器**:`domain/srs.rs` 纯函数(词条状态,评分1-4,now)→(新 stage/interval/ease/到期),零 I/O;
命令层只做取→算→写(唯一写者 `vocab_repo`);同函数供 UI 预览四档间隔。
验收:新词/学习中/复习/已掌握 × 四档覆盖 + **"按钮预览值 == 评分后实际到期"一致性测试**(第 3 条的机械保证)。

**V3 桌面三栏(1180×740)**:队列/卡片/原文;SPACE 翻面、1-4 评分、S 跳过、E 编辑;
翻面单向不可逆、评分区翻面后 250ms 才可点、3 秒可撤销(设计稿 01b 规则桌面同样适用)。
纯逻辑(队列推进/撤销栈/键盘映射)进 `reader/core/*.js` 保持零 DOM。验收:core 单测 + `_smoke_views.mjs` 加一节。

**V4 来源定位**:`vocab` 加 `edition_id`/`chapter_index`/`sentence_index`(旧数据留空,UI 降级);
加词时写入;桌面右栏"《书名》·第 N 章·M 处出现"+"在阅读器中打开"接线。验收:加词→重开→跳转定位的端到端测试。

**V5 Worker 入仓**:`cloud/worker/` 放脚本 + `wrangler.toml` 模板 + KV 绑定说明。
接口 `POST /v1/auth/device`、`GET /v1/sync?since={rev}`、`POST /v1/sync`。
KV:`auth:{token}→{user_id,device_id}`、`srs:{user}:{word_key}`、`deck:{user}:index`、`meta:{user}:device:{id}`。
多设备:首台生成邀请码,第二台换 token 绑同一 user。验收:本地跑(miniflare/wrangler dev)覆盖
鉴权失败/越权读他人 user/正常 push-pull 三种,贴真实请求响应。

**V6 客户端接线**:去掉硬编码 "default",按当前 user 分账,合并复用 `domain/sync.rs`;
推送时机=复习结束/切后台/攒够 20 条;离线可完整复习并自动补推;四态 UI(已同步/N 条待推/离线/失败),
顶栏不转圈只改数字。验收:离线评分→重连→回"已同步"且远端条数对上 + 两个 token 数据不串。

**V7 手机端(Android)**:只做 今日队列/一次一卡/生词本浏览/同步,不处理书不开阅读器。
交互按 01b:整卡热区翻面、左右滑评分、下滑退出保留进度、长按弹操作、评分区底部 120px 内、按钮 56px 高。
验收:真机或模拟器截图 + 一次完整会话(含离线→恢复)实测记录。

**V8 收尾**:按 `BOOK_WORKFLOW.md §6`——代码全提交完→重打便携版→时间戳 ≥ 最后一个代码提交;
阶段报告 + `memory/` 更新(写新踩的坑,不只写做了什么)。

## 不做

iOS;账号体系本身(只留协议形状);手机端处理书或生成释义;重画 §03 之外的设计稿(七屏已落地)。

## 遇到再问,别拍板

家庭成员邀请/加入流程长什么样;每日新词与复习配比规则(设计稿只给了样例数字);
迁移把 `kid` 的词归给"孩子"是否符合实际用法。
