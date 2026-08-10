# aidulc 同步 Worker (协议 v1)

手机端/桌面端的复习状态同步服务端。部署在 Cloudflare Workers + KV。

## 这是什么

一个"家的空间" = 一个 worker 实例。所有设备同步到同一个空间, 内部按 user 隔离。
服务端**只存 SRS 状态 + 词条最小集(含来源单句)**, 绝不接收/存储书文件或整章正文
(硬边界, 见 `docs/GOAL_STAGE_SRS.md`)。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/device` | 首台用 `ROOT_SECRET` 换第一个 user + token; 或用 6 位码换 token |
| POST | `/v1/auth/code` | 已登录设备生成 6 位一次性码 (`add-device` / `invite-user`) |
| GET | `/v1/sync?since={rev}` | 拉取该版本后变更的 SRS 状态 (增量) |
| POST | `/v1/sync` | 整批推送本地队列, 返回新 rev |

鉴权:`Authorization: Bearer <token>`。user_id 由服务端从 token 解析, 客户端不自报。

## KV 键结构

```
auth:{token}            → {user_id, device_id, created_at}
srs:{user}:{word_key}   → { ...SRS 最小集, updated_at, rev }
deck:{user}:index       → { rev, updated_at, words: {word_key: {rev, updated_at}} }
meta:{user}:device:{id} → { name, last_pull_rev, last_push_at }
code:{6位码}            → { type, user_id, name, expires_at, used }
codefail:{6位码}        → { count, lock_until }
```

## 部署 (照文档一条命令跑通)

前置:`wrangler` 已登录 (`wrangler whoami`)。完整分步说明见 `docs/SELFHOST_CF.md`。

```powershell
# 1. 建一个全新的空 KV namespace (名字能看出用途即可, 如 aidulc-sync-kv)
wrangler kv namespace create aidulc-sync-kv
#  → 记下返回的 id

# 2. 复制模板 → 填 namespace id
Copy-Item wrangler.toml.template wrangler.toml
#    编辑 wrangler.toml: 把 PASTE_YOUR_KV_NAMESPACE_ID 换成上一步返回的 id

# 3. 设"家的钥匙" ROOT_SECRET (首台桌面端用它换第一个 user)
wrangler secret put ROOT_SECRET

# 4. 部署
wrangler deploy
#  → 得到 https://<name>.<your-subdomain>.workers.dev
```

免费额度实测 (2026-08-09, 见 `docs/DESIGN_NOTES_SRS.md` V0②):
读 100,000/天 · **写不同键 1,000/天** · 值 25 MiB。

**配额硬约束 (2026-08-10 修正, 别再踩)**: worker 的推送循环是**一词一个 KV 键**
(`srs:{user}:{word}`), 所以**首次全量同步的写次数 = 待推词条数 + 1 (deck index)**。
1424 词 = 约 1425 次写, 必然撞爆每天 1000 次写不同键的上限 —— 推到一半失败。
因此:

- **CF 免费路径 = 从零积累**: 新建空 KV, 词随使用一点点增长, 天然撞不上 1000/天。
  每次都建**新的空 namespace**, 不要把存量词库推进来。
- 存量词条数 > ~900 时, 别走 CF 免费档 —— 用自建 VPS 后端 (`docs/SELFHOST_VPS.md`),
  文件存储没有写配额, 承载全量推送。

## 本地测试 / 自建 VPS

存储层抽象成 `get/put/list/delete` 接口 (`src/storage.js`):
- **CF KV** (`createCloudflareKv`):worker 绑定 `env.DB` 时自动用。
- **文件存储** (`createFileKv`):`env.KV_DIR` 存在且无 `env.DB` 时用, 供本地测试和
  自建 VPS 后端 —— 付费托管跑同一份代码, 只换存储实现。

```powershell
node test/local_test.mjs   # 30 项: 鉴权失败/越权/正常推拉/新者胜/一次性码/限速
```

## 设计裁决 (与设计稿冲突的落地)

- 六处冲突裁决见 `docs/DESIGN_NOTES_SRS.md` V0③。
- 词条最小集随同步上传 (冲突 1 的修正): 手机端没有书包, 不传词条就是空的。
- 增量 `?since={rev}`:rev 是 per-user 单调递增, 每推一批 +1; 拉取按词条 rev 过滤。
- 多设备: 首台 `ROOT_SECRET` 换 user "me"; 已登录设备生成 6 位码 (10 分钟、一次性),
  `add-device` 绑现有 user / `invite-user` 服务端新建 user。错 5 次锁 15 分钟。
