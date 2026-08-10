# 自建 VPS 同步后端 (承接存量词库)

## 定位与配额

CF 免费档**写不同键 1,000 次/天**, 而 worker 推送一词一个 KV 键 —— 存量 1424 词首次
全量同步必撞配额 (S2 已加前置护栏会拦下)。**VPS 文件存储 (`createFileKv`) 没有写配额**,
这是承接存量词库的路径。同一份 worker 代码 (src/index.js) 两端跑, 只是存储实现不同
(CF KV vs 文件), 业务逻辑一行不改 (V5 存储抽象的目的)。

## 架构 (2026-08-10 实测部署, CF Tunnel 方案)

```
桌面端/手机端 → https://sync.viiyd.com (CF 边缘, TLS 由 CF 提供)
                    ↓ Cloudflare Tunnel (服务器主动出站连接, 不暴露任何入站端口)
              香港服务器: cloudflared → 127.0.0.1:8080 → node server.mjs
                    ↓ env.KV_DIR (文件存储 = 词库真相源, 纳入备份)
```

- **为什么用 Tunnel 而不是 A 记录 + 橙云**: 实测发现香港机面板有**独立入站防火墙**,
  公网访问 80 端口被重定向到 provider 的 Cloudflare lander (实测 `server: cloudflare`),
  A 记录橙云方案不可行。Tunnel 是服务器主动出站, 完全绕过面板。
- **子域名必须是 2-label**: CF Universal SSL 只覆盖 `*.viiyd.com` 这类 2-label 主机名。
  实测 `sync.aidulc.viiyd.com` (3-label) HTTPS 握手失败 (alert 40), 改用 `sync.viiyd.com`
  立即正常。**别用 3-label 子域名**。
- 服务器只跑 http (127.0.0.1:8080), **不直接暴露公网**。node 不监听公网。

## 前提

- Node ≥ 18 (server.mjs 用全局 Request/Response/fetch)。
- 香港 VPS (本计划实测: `149.104.29.84`, Debian 12, SSH port 28922)。
- 一个 Cloudflare 账号 + 一个 2-label 域名 (实测: `viiyd.com`), 有该域的 API token
  (权限: Zone DNS Edit + Cloudflare Tunnel Edit)。
- `cloud/worker` 代码已同步到服务器。

## 部署步骤 (照抄可跑)

### 1. 盘点现有服务 (先出清单再动手, 未经确认不删任何东西)

SSH 登录后执行, 产出清单发回确认:

```bash
systemctl list-units --type=service --state=running   # systemd 服务
docker ps -a                                           # docker 容器
ss -tlnp                                               # 监听端口
crontab -l; ls /etc/cron.d 2>/dev/null                 # 定时任务
```

实测清单 (2026-08-10, `149.104.29.84`): `sing-box`(电视中转, 保留)、`threadfin`(IPTV)、
`ssh`、系统基础服务; 无 docker, 无 crontab。**未动电视中转。**

### 2. 建目录 + 传代码

```bash
mkdir -p /srv/aidulc/kv /srv/aidulc/cloud-worker
scp -P 28922 cloud/worker/src/{index.js,storage.js,server.mjs} root@149.104.29.84:/srv/aidulc/cloud-worker/
```

### 3. 设 ROOT_SECRET + systemd 守护

`/etc/systemd/system/aidulc-sync.service`:

```ini
[Unit]
Description=aidulc sync backend (VPS file storage)
After=network.target
[Service]
User=root
WorkingDirectory=/srv/aidulc/cloud-worker
Environment=KV_DIR=/srv/aidulc/kv
Environment=ROOT_SECRET=你的随机钥匙
Environment=PORT=8080
Environment=BIND=127.0.0.1
ExecStart=/usr/bin/node /srv/aidulc/cloud-worker/server.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now aidulc-sync
curl -s http://127.0.0.1:8080/v1/capabilities
# → {"ok":true,"storage":"file","max_writes_per_day":null,...}
```

### 4. CF Tunnel (实测可行路径)

```bash
# 装 cloudflared (Debian 12)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-archive-keyring.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-archive-keyring.gpg] https://pkg.cloudflare.com/cloudflared bookworm main' > /etc/apt/sources.list.d/cloudflared.list
apt-get update && apt-get install -y cloudflared
```

在 CF 控制台或 API 建 tunnel, 拿 tunnel token, 写 `/etc/cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: sync.viiyd.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

systemd `/etc/systemd/system/cloudflared-aidulc.service`:

```ini
[Unit]
Description=Cloudflare Tunnel for aidulc-sync
After=network.target
[Service]
User=root
ExecStart=/usr/local/bin/cloudflared tunnel --config /etc/cloudflared/config.yml run --token <token>
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
```

DNS: 建 `sync.viiyd.com` CNAME → `<tunnel-id>.cfargotunnel.com`, 橙云 (proxied)。

### 5. 验证

```bash
curl -s https://sync.viiyd.com/v1/capabilities
# → {"ok":true,"storage":"file","max_writes_per_day":null,...}
```

### 6. KV_DIR 纳入备份 (它就是你的词库真相源)

```bash
# 例: 每天打包一份, 保留 7 天
0 3 * * * tar czf /srv/backup/aidulc-kv-$(date +\%F).tar.gz -C /srv/aidulc kv
```

## 端到端实测 (2026-08-10)

- 推 1424 词: `POST https://sync.viiyd.com/v1/sync` → `{"ok":true,"wrote":1424,"rev":1424}`。
- KV_DIR 键数: `ls /srv/aidulc/kv | wc -l` = 1431 (1424 srs + 1 deck + 6 auth/meta/code,
  去测试 device 后即 1425)。
- 拉取: `GET /v1/sync?since=0` → `{"ok":true,"changed":1424,"rev":1424}`。

## 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| HTTPS 握手失败 (alert 40) | 用了 3-label 子域名, Universal SSL 不覆盖 | 换 2-label 子域名 |
| 公网 80 被重定向到 lander | 机房面板 L7 拦截 HTTP | 用 CF Tunnel, 不依赖入站端口 |
| 首台换 token 403 | ROOT_SECRET 配错 | 核对 systemd 里 Environment=ROOT_SECRET |
| 桌面端状态"未配置" | worker_url 填错 / 没换 token | 设置页重填 URL + 换 token |
| node 起不来 | ROOT_SECRET 为空 (server.mjs 拒绝启动) | 设 Environment=ROOT_SECRET |
