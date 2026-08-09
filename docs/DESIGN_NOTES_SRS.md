# 背单词阶段设计笔记 (V0 可行性 → V8 收尾)

> 对应 `docs/GOAL_STAGE_SRS.md`。本文件记录 V0 的实测结论与六处冲突的裁决,
> 以及后续阶段碰到的设计裁决。所有"实测"必须带命令输出/时间戳, 不写"应该没问题"。
> 与本文矛盾时以实测为准并回来改本文。

## V0① CF 部署冒烟(2026-08-09 实测)

- 环境: `wrangler 4.60.0`, 已 OAuth 登录 `yoyoset@gmail.com`, 账户 type=`standard`(免费),
  account_id `48b4b98607fc35c1a9cca79b698cd3c9`。已有 KV namespace `AIDU_DB`
  (`eed0445976d94ba4943cea222b208aaa`, 空)。
- 最小 worker 冒烟(临时目录, 不入仓, 仅证明部署链路):
  ```
  wrangler deploy → Uploaded aidulc-v0-smoke (2.22 sec)
    https://aidulc-v0-smoke.yoyoset.workers.dev
  ```
- 链接可打开实测:
  ```
  curl -s -w "HTTP %{http_code}" https://aidulc-v0-smoke.yoyoset.workers.dev
  → aidulc V0 smoke OK — 2026-08-09T12:49:53.640Z   HTTP 200
  ```
- 结论: 部署链路通, 免费账户可用 `*.workers.dev` 域名直出。

## V0② KV 免费额度实测(2026-08-09 实测)

借助上面冒烟 worker 的 `/kv-test` 端点对 `AIDU_DB` namespace 实测:

| 项 | 实测结果 | 依据 |
|---|---|---|
| **单值大小上限** | **25 MiB = 26,214,400 字节** | `put size=26214400` → ok; `put size=27262976`(26MiB) → `413 Value length of 27262976 exceeds limit of 26214400`; 28MiB 同样 413 |
| 整批写(5000 词最小集 1.43MB) | **成功**, 单次 PUT ≈ 3.9s(含 worker 冷启动) | `put-custom key=deck_test2` → `{"ok":true,"wrote_bytes":1429461}` |
| 读 1.43MB 整批值 | **成功**, 每次 ≈ 1.1-1.5s(热) | `GET key=deck_test2` 连读 3 次 1498/1449/1119ms |
| 25MiB 值读回 | 成功(`exists:true, size:26214400`) | `GET key=size25` |
| 删除 | 成功 | `op=delete` |

官方免费档(KV limits 页, 2026-08-09 抓取): **读 100,000 次/天; 写不同键 1,000 次/天;
写同一键 1 次/秒; 每 worker 调用可对外操作 1,000 次; 存储 1GB/account; 值 25MiB**。

**据此定的批量阈值(设计裁决)**:

1. **一次会话必须 O(1) 次写**: 写配额 1000/天 是硬约束。整批提交 = 一个 user 一个 `deck:{user}:index`
   键 + 变更词条各自 `srs:{user}:{word}`(词条级), 仍可能多键 → 实测单次写耗时说明 100 词以内
   单请求往返完全可行; 配额风险不在"一次写几个键", 而在"每天几次同步"。一次会话 ≤ 5 次同步请求
   (startup + 会话结束 + 切人各一次)即可安全压在 1000/天 内。
2. **词条最小集 5000 词 ≈ 2MB 整包能放**, 但实测**整包 GET 1.4MB 每次 ~1.1-1.5s**, 手机端
   PWA 每次拉全量不可接受 → 同步走增量 `?since={rev}`(V5/V6), 首拉才整包。KV 值上限 25MiB
   意味着 5000 词全量整包也放得下, 但这只是兜底, 不是常态路径。
3. **同键 1 次/秒**: 客户端推词条时同一个 `srs:{user}:{word}` 键若反复覆盖会撞, 但正常流
   每条只写一次, 不构成约束。
4. 免费 1GB 存储 ≈ 2000 万条词条最小集(500B/条), 完全够一个家 10 年; 不需要额外清理策略。

测试键已全部删除(`test:*` 列表为空)。

## V5 服务端已部署 (2026-08-09 实测)

- worker: `https://aidulc-sync.yoyoset.workers.dev` (部署在 V0 那个 CF 账户),
  KV namespace `AIDU_DB`(复用), `ROOT_SECRET` 已设 (`wrangler secret put`)。
- 协议 v1 真实请求验证 (Node fetch 直连, 非本地模拟):
  ```
  1a 无token拉取: 401 {"ok":false,"error":"未授权: token 无效或缺失"}
  1b 错ROOT_SECRET: 403 {"ok":false,"error":"ROOT_SECRET 不正确"}
  2a 首台兑换: 200 {"ok":true,"user_id":"me",...,"token":"0610758..."}
  3a 推送: 200 {"ok":true,"rev":1,"wrote":1}
  3b 全量拉取 rev=1 changed=1 首词=bank
  3c 增量拉取 changed=0
  4a 生成邀请码: 200 {"ok":true,"code":"647052",...}
  4b 孩子兑换: 200 user_id=38312fe72bd04255
  4c me拉取含kids? false   (越权隔离成立)
  ```
- 注意: 用 curl `-d '{"x":1}'` 直连该 worker 会出现 "JSON 解析失败" 假象 ——
  实测是 Windows curl/PowerShell 引号处理问题, 用 Node fetch / 文件 body 正常。
  排查记录: 先怀疑 worker 代码, 后定位为客户端工具差异 (以实测为准)。

## V0③ 六处冲突的裁决(设计稿 vs 现状)

> 对应 GOAL_STAGE_SRS.md"设计稿与现实的六处冲突"。每条给"设计稿原话/现状 → 裁决 → 落点"。

### 冲突 1: §03"词条不上传"与手机端矛盾

- **设计稿 §03**: "词条本身(释义、原句)不上传——它们由书重新生成,KV 里只放复习状态"。
- **现实**: 手机 Web 端没书包没词典模型, 服务端不存词条最小集, 手机上就是空卡。
- **裁决**: 改同步词条最小集(词/音标/释义/来源单句, 实测约 300-600B/条, 5000 词 ≈ 2MB),
  不传书正文。**服务端仍绝不接收书文件/整章正文**——最小集里只有当前词那一条来源句。
  §03 该句作废, 本裁决写进同步契约(V5)。

### 冲突 2: 1 分钟/10 分钟步长存不下

- **设计稿**: 评分按钮显示"忘了 1 分钟/模糊 10 分钟"。
- **现实**: `vocab.interval_days` 是 INTEGER 天, 且 `upsert_content` 里
  `payload["interval"].as_f64().unwrap_or(0.0) as i64` 直接截断 → 分钟级变 0。
- **裁决**: 加毫秒级字段(`interval_ms` 或沿用 payload 内的浮点 interval, 见 V2 落点);
  `interval_days` 只留作 AIDU 导出兼容(不改列语义, 迁移不拆列)。

### 冲突 3: 按钮时间不许前端写死

- **设计稿**: 四档评分按钮各自写死"1 分钟/10 分钟/3 天/8 天"。
- **裁决**: 按钮时间必须由调度器对**当前词**算出后返回(算法改了按钮自动跟), 前端只渲染。
  落点: V2 的 `domain/srs.rs` 纯函数输出四档间隔, 命令层返回给 UI 预览。

### 冲突 4: user ≠ profile

- **现状**: 拿 profile(讲解策略)当人用, `vocab`/`dictionary` 按 profile_id 隔离, 同步也按
  profile 走。设计稿要"同一台设备不同人看到各自内容"。
- **裁决**: 引入独立 `user` 维度, profile 退回策略语义(不影响讲解)。V1 迁移把所有现有
  profile 数据归到一个 user("我")——**不许猜 kid profile 的词属于孩子**(任务卡"三项已定 ③")。
  profile 与 user 是两套表, 互不替代。

### 冲突 5: user 由服务端从 token 解析

- **现实**: 同步 `?profile=<id>` 客户端自报; 手机 Web 端公网可达, 自报 user = 谁都能读
  别人的词库。
- **裁决**: 接口带 `/v1/` 前缀, user_id 由服务端从 `Authorization: Bearer <token>` 解析签发,
  客户端不自报。将来加账号只换发 token, 不动数据(V5)。

### 冲突 6: 手机端"跳到原文"做不到

- **现状**: 手机 Web 端没书包, 没有原文上下文。
- **裁决**: 手机端该入口改不可用态, 提示"在电脑上打开"; 桌面端保留跳转(V4 来源定位接线后)。
