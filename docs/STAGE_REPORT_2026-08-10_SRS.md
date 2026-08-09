# 阶段报告 STAGE-SRS (V0-V8) — 背单词 + 身份模型 + 同步重建

| 项 | 值 |
|---|---|
| 版本 | 应用 `0.1.0`(tauri.conf.json);git 基线 `a259ac1` → `c1f653d`(V0-V7 一条一提交) |
| 日期 | 2026-08-10 |
| 状态 | 已提交,`scripts/check.ps1` 14 项全绿 |
| 设计源 | `生词本和背单词完整设计交付确认/aidulc 背单词.dc.html` |
| 便携版 | `dist/aidulc-portable/` 已重打(见 §6) |

## 0. 一句话

把被删掉的 aidu 复习端重建成了 aidulc 自己的两端:桌面三栏键盘驱动(背单词页)+
手机 Web 端一次一卡(CF 托管 PWA),复习状态跨设备同步,同一台设备不同人各看各的。
同步链路从"整包信封 ?profile=" 换代到协议 v1(增量 `since={rev}`,user 由服务端从
token 解析)。

## 1. 交付物(V0-V8 验收)

| 卡 | 交付 | 验收(机械可核对) |
|---|---|---|
| V0 | 可行性三件套 | CF 冒烟链接 `https://aidulc-v0-smoke.yoyoset.workers.dev`(HTTP 200);KV 额度实测:值上限 **25MiB**(26MiB 写 413)、读 100k/天、写 1000/天(官方页抓取);六处冲突裁决 → `docs/DESIGN_NOTES_SRS.md` |
| V1 | 身份模型(迁移 v20) | `users` 表 + `users_repo`;vocab/dictionary/reading_state/highlights/reading_daily 加 `user_id`;迁移测试 `v20_migrates_legacy_to_users_without_loss`(词条/进度/摘录零丢失)+ 各 repo user 隔离测试;顶栏切人 |
| V2 | 调度器 | `domain/srs.rs` 纯函数;新词/学习中/复习/已掌握 × 四档 + **"按钮预览值 == 评分后实际到期"一致性测试**;`interval_ms` 毫秒字段(V2 冲突裁决) |
| V3 | 桌面三栏 | `core/review.js`(队列/配比/撤销栈/键盘映射/翻面锁,17 单测)+ `review_view.js` 三栏;`_smoke_views.mjs` 第 6 节 |
| V4 | 来源定位(迁移 v21) | vocab 加 edition_id/chapter_index/sentence_index;阅读器加词带定位;右栏《书名》·第 N 章 + "在阅读器中打开"跳转;`_smoke_views.mjs` 6b 节 |
| V5 | 服务端入仓(协议 v1) | `cloud/worker/` + 存储抽象接口(CF KV / 文件存储两个实现);`node test/local_test.mjs` 30 项(鉴权失败/越权/正常推拉/新者胜/一次性码/限速);已部署 `https://aidulc-sync.yoyoset.workers.dev` 真实请求验证 |
| V6 | 桌面端接线 | `sync_v1_client` 替换 aidu_worker_client;`sync_state` 表(迁移 v22)算待推数;先推后拉;四态 chip;sync_service 集成测试(先推后拉顺序/两 token 不串/离线→重连→synced 且远端条数对上) |
| V7 | 手机 Web 端 | `cloud/mobile/` PWA(IndexedDB + SW + adapter 层,不依赖 `__TAURI__`);`node test/app_test.mjs` 27 项;已部署 `https://aidulc-mobile.pages.dev`;真实 worker e2e(离线复习 2 词→重连→远端 2 条对上 + 越权隔离) |
| V8 | 收尾 | 本报告 + 便携版重打 + memory 更新 |

## 2. 关键决策与实测依据

### 2.1 六处冲突裁决(V0,详见 DESIGN_NOTES_SRS.md)

1. §03"词条不上传"作废 → 同步词条最小集(词/音标/释义/来源单句,300-600B/条)。
2. 分钟级步长 → `interval_ms` 毫秒字段,`interval_days` 只留 AIDU 导出兼容。
3. 按钮时间由调度器对当前词算出后返回,前端不写死(一致性测试锁定)。
4. user ≠ profile:users 表独立,profile 退回讲解策略语义。
5. user 由服务端从 token 解析,接口带 `/v1/`,客户端不自报(公网安全边界)。
6. 手机端"跳到原文"不可用 → 提示"在电脑上打开",桌面保留。

### 2.2 三项已定落地

- **邀请**:worker 实例 = 一个家;`ROOT_SECRET` 首台换 token,6 位码(10 分钟一次性,
  错 5 次锁 15 分钟)add-device/invite-user;一台设备可持多 token(顶栏切人=切 token)。
- **每日配比**:到期复习不封顶;新词 `clamp(6 - max(0,到期-20)/2, 0, 6)`;学习中插队不占
  配额;顺序 到期→学习→新词;预计用时无实测 15s/张。
- **迁移不拆人**:全部现有数据归 user "me",profile 保持语义;新建成员是后续可逆动作。

### 2.3 协议 v1 实测边界(以实测为准,非文档假设)

- **curl 直连 worker 会假象"JSON 解析失败"**:Windows curl/PowerShell 引号处理问题,
  用 Node fetch / 文件 body 正常。排查记录见 DESIGN_NOTES(V0②)。
- **整包 GET 1.4MB 每次 ~1.1-1.5s**:手机端不整包拉,走增量 `since={rev}`。
- **25MiB 单值上限**:词条最小集 5000 词 ≈2MB 放得下但非常态路径(增量拉)。

## 3. 结构变化

- 新表:`users`(v20)、`sync_state`(v22);`vocab` 加 user_id(v20)+来源定位三列(v21);
  reading_state/reading_daily 重建为含 user_id 复合主键(v20)。
- Rust:`domain/srs.rs`(调度器)、`store/users_repo.rs`、`store/sync_state_repo.rs`、
  `infrastructure/sync_v1_client.rs`(协议 v1,替代 aidu_worker_client.rs)。
- 前端:顶栏加用户下拉 + 同步四态 chip;新增 `背单词` 路由(三栏复习)。
- 云:`cloud/worker/`(同步服务端)、`cloud/mobile/`(手机 PWA)。

## 4. 踩过的坑(写进 memory,详见 §5)

1. **PS 5.1 Set-Content -Encoding UTF8 会破坏 .rs 中文字符串**:两次把 `dictionary_service.rs`
   写乱(中文注释变 mojibake),只能 `git checkout` 后用 edit 工具重做。**教训:编辑含中文的
   Rust 源码用 edit 工具,不用 PowerShell 整文件写回。**
2. **clippy 基线"只降不升"逼出请求结构体**:V4 给 `add_vocab` 加 3 个来源定位参数 → 参数
   过多警告 +1。为守住基线 8,把参数打包成 `AddVocabRequest`,`SourceLocation` 结构体。
3. **PowerShell Set-Content 中文 JSON 也坏**:V7 e2e 脚本中文词义被写坏 → 改用 edit 工具
   写测试文件。
4. **Windows 上 node fetch keep-alive + server.close 触发 libuv 断言**:V7 手机测试最初用
   真实 TCP 服务,退出时 `uv async.c:76` 断言退出码 -1073740791。**修法:测试不走真实 TCP,
   fetchImpl 直接调 worker.fetch(Request 对象),process.exit 干净退出。**
5. **迁移测试 fixture 要跟着新版本 rollback**:加 v21/v22 后,v18/v20 fixture 忘了删对应
   migration 行 → 重开库 MAX(version) 已是最新,旧迁移不重跑,`DROP TABLE editions` 后再
   打开报 "no such table"。每个新迁移都要同步更新历史 fixture 的 rollback。
6. **同毫秒时间戳竞态**:V6 离线→重连测试里 `upsert_content` 的 updated_at 是 now,
   `last_push_at` 也是 now,同一毫秒内 pending 算成 0。加 `sleep(30ms)` 保证严格递增。
7. **Windows curl 对 `-d '{"x":1}'` 假故障**:V5 部署后 curl 全挂但 Node fetch 正常,一度
   怀疑 worker 代码。**实测是客户端工具差异,不是服务端 bug** —— 用 Node fetch 复验。

## 5. memory 更新

- `memory/reader.md`:补 SRS 复习域(调度器/三栏/撤销/翻面锁)记录。
- `memory/pipeline.md`:补 V5-V7 云端踩坑(curl 假象/undici 断言)。
- `docs/DESIGN_NOTES_SRS.md`:V0② KV 实测、V5 部署记录、V7 e2e 记录。

## 6. 便携版重打(BOOK_WORKFLOW §6)

- 顺序:代码全部提交完(c1f653d, 00:26:12)→ `cargo build --release` → 拷贝 exe → 核对时间戳。
- `dist/aidulc-portable/aidulc.exe` 时间戳 **2026-08-10 00:28:27** ≥ 最后一个代码提交 00:26:12 ✓。
- prep 侧车源码自 c8839bc(08-09 19:29)未变,portable 侧车(19:39)≥ 源码 ✓,无需重打。
- config.toml 无开发机绝对路径(ffmpeg_path/cf_worker_url 均空)✓。

## 7. 已知遗留(诚实清单)

- **手机端真机截图未做**:本环境无手机浏览器,已用 node 测试(26 项 UI 冒烟 + 27 项同步链)
  + 真实 worker e2e 验证逻辑,真机交互(滑动手势手感)需人工确认。
- **V6 拉取合并写回 default profile**:远端词条合并写回本地默认 profile(跨 profile 的
  同 lemma 共用一条远端状态),这是简化,后续可按需细化。
- **桌面端 settings 同步区仍叫 "同步 (背单词状态跨设备)"**:文案与协议 v1 一致,但
  生成邀请码只有 add-device(绑当前 user),invite-user(新建成员)入口未在 UI 暴露。
