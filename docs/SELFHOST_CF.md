# 自建 CF 同步服务 (免费路径完整流程)

跟着这份文档, 从零在自己的 Cloudflare 账户上部署一个 aidulc 同步服务。
写配额实测: **读 100,000 次/天 · 写不同键 1,000 次/天 · 值 25 MiB**
(官方 KV limits 页 + 实测, 见 `docs/DESIGN_NOTES_SRS.md` V0②)。

> **配额红线 (2026-08-10 实测修正)**: worker 的推送循环**一词一个 KV 键**
> (`srs:{user}:{word}`), 首次全量同步的写次数 = 待推词条数 + 1。词条数超过
> ~900 时必撞 1000/天的写配额, **不要**把存量词库推进 CF 免费档 —— 存量走
> 自建 VPS (`docs/SELFHOST_VPS.md`)。CF 免费档的定位是**从零积累**: 词随使用
> 一点点增长, 天然撞不上配额。

## 前置

- 一个 Cloudflare 账户 (免费)。
- 本地装 Node.js (≥18) 与 wrangler。
- 到本仓库的 `cloud/worker` 目录操作:

```powershell
cd cloud/worker
npx wrangler whoami   # 确认已登录 (显示你的邮箱)
```

未登录先执行 `npx wrangler login` (浏览器授权一次)。

## 步骤

### 1. 新建空 KV namespace (名字能看出用途)

```powershell
npx wrangler kv namespace create aidulc-sync-kv
```

预期输出 (记下 id):

```
🌀 Creating namespace with title "aidulc-sync-kv"
✅ Success!
[[kv_namespaces]]
binding = "aidulc_sync_kv"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

> 每次自建都建**新的空 namespace**, 不要复用别人/旧的 namespace —— 免费档
> 靠"从零积累"避开写配额。

### 2. 生成并填写 wrangler.toml

`wrangler.toml` 已被 gitignore (含 namespace id 与部署名, 不进 git)。
从模板复制:

```powershell
Copy-Item wrangler.toml.template wrangler.toml
```

编辑 `wrangler.toml`, 把两处占位/示例值改掉:

```toml
name = "aidulc-sync"              # 部署名 (你自己起, 全账户唯一)
[[kv_namespaces]]
binding = "DB"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"   # ← 第 1 步返回的 id
```

**`binding` 必须叫 `DB`** —— worker 代码 `env.DB` 判断用 CF KV 还是文件存储,
改名会静默切到文件存储。

### 3. 设 ROOT_SECRET (这个家的钥匙)

```powershell
npx wrangler secret put ROOT_SECRET
```

输入一串只有你知道的随机字符串 (首台桌面端用它换第一个 user; 换一次就够,
之后加设备用 6 位邀请码)。预期输出:

```
🌀 Creating the secret for the Worker "aidulc-sync"
✨ Success! Uploaded secret ROOT_SECRET
```

### 4. 部署

```powershell
npx wrangler deploy
```

预期输出 (记下 workers.dev 地址):

```
Uploaded aidulc-sync (x.xx KiB)
Current Deployment ID: ...
https://aidulc-sync.<你的子域>.workers.dev
```

### 5. 冒烟验证 (可选但推荐)

```powershell
npx wrangler tail --name aidulc-sync
# 另开终端:
curl -X POST https://aidulc-sync.<你的子域>.workers.dev/v1/auth/device ^
  -H "Content-Type: application/json" ^
  -d '{"root_secret":"你的密钥","device_name":"smoke"}'
```

预期: 200 + `{"ok":true,"user_id":"me","token":"..."}`。
错误 ROOT_SECRET → 403; 无 token 访问 `/v1/sync` → 401; 未知路由 → 404。

### 6. 桌面端连接

1. 打开设置 → "同步与数据"。
2. Worker URL 填: `https://aidulc-sync.<你的子域>.workers.dev`
   (不含尾部斜杠)。
3. 密钥框填 `ROOT_SECRET` 或 6 位邀请码 → 点"换 token"。
   - 首台: 填 ROOT_SECRET。
   - 后续设备: 首台点"生成邀请码"(add-device), 输入 6 位码。
4. 点"立即同步"。

### 7. 手机扫码连接 (可选)

首台桌面端设置页 → "手机扫码连接" → 手机微信/相机扫二维码。
二维码内容带 token, 只在信任的手机上使用; 用完可点"踢掉这台设备"。

## 常见的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 同步一直 401 | worker_url 填错 / token 被踢 / 换过 ROOT_SECRET | 重填 URL + 重新换 token |
| 首次同步推到一半失败, 写次数超限 | 存量词太多走 CF 免费档 | 换自建 VPS (`docs/SELFHOST_VPS.md`) |
| 部署后 `/v1/sync` 404 | 部署的不是最新代码 | 在 `cloud/worker` 目录 `npx wrangler deploy` |
| 数据全空/串了 | 复用了旧的 KV namespace | 建新的空 namespace, 从零积累 |

## 升级 / 删除

- 更新 worker 代码: 在 `cloud/worker` 目录 `git pull` 后 `npx wrangler deploy`。
- 删除 worker: `npx wrangler delete --name aidulc-sync` (会连带把绑定的 KV 也删? —
  **不会**, KV namespace 独立存在, 需单独 `npx wrangler kv namespace delete --namespace-id <id>`)。
