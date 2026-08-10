# 自建 VPS 同步后端 (承接存量词库)

## 定位与配额

CF 免费档**写不同键 1,000 次/天**, 而 worker 推送一词一个 KV 键 —— 存量 1424 词首次
全量同步必撞配额 (S2 已加前置护栏会拦下)。**VPS 文件存储 (`createFileKv`) 没有写配额**,
这是承接存量词库的路径。同一份 worker 代码 (src/index.js) 两端跑, 只是存储实现不同
(CF KV vs 文件), 业务逻辑一行不改 (V5 存储抽象的目的)。

## 架构

```
桌面端/手机端 → https://sync.aidulc.example.com (CF 橙云代理, TLS 自动)
                    ↓ (nginx 反代 http://127.0.0.1:8080)
              香港服务器: node src/server.mjs (监听本机, 不直接暴露公网)
                    ↓ env.KV_DIR (文件存储 = 词库真相源, 纳入备份)
```

- 服务器只跑 http (127.0.0.1), TLS 交给 CF 橙云代理。**不要**让 node 直接监听公网 80/443。
- 端口: CF 代理支持 HTTP/HTTPS 落 80/443, 也支持自定义端口 (非 80/443 需用 nginx/caddy
  转发或直接让 server.mjs 监听对应端口)。推荐 nginx 反代 80 → 127.0.0.1:8080。

## 前提 (这台机器上做一次)

- Node ≥ 18 (server.mjs 用全局 Request/Response/fetch)。
- 一台香港 VPS, 已配好子域名 A 记录指向其公网 IP (DNS 解析, 无需开服务器端口)。
- `cloud/worker` 目录已同步到服务器 (git clone 本仓库)。

## 部署步骤 (照抄可跑)

### 1. 盘点现有服务 (先出清单再动手, 未经确认不删任何东西)

SSH 登录后执行, 产出清单发回确认:

```bash
# systemd 服务
systemctl list-units --type=service --state=running

# docker 容器 (如果有 docker)
docker ps -a

# 监听端口
ss -tlnp

# 定时任务
crontab -l; ls /etc/cron.d 2>/dev/null
```

> 纪律: 香港服务器**最后只保留"电视中转"与 aidulc 两项**, 其余拿掉 —— 但**每一项删除
> 都要先经过确认**。电视中转保留。不擅自停用任何服务。

### 2. 装 Node (若没有)

```bash
# Debian/Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # ≥ 18
```

### 3. 放置代码 + 初始化数据目录

```bash
sudo mkdir -p /srv/aidulc
sudo chown -R "$USER" /srv/aidulc
cp -r cloud/worker /srv/aidulc/cloud-worker
mkdir -p /srv/aidulc/kv          # env.KV_DIR —— 这就是词库真相源
```

### 4. 设 ROOT_SECRET + systemd 守护

写 `/etc/systemd/system/aidulc-sync.service`:

```ini
[Unit]
Description=aidulc sync backend (VPS file storage)
After=network.target

[Service]
User=aidulc
WorkingDirectory=/srv/aidulc/cloud-worker
Environment=KV_DIR=/srv/aidulc/kv
Environment=ROOT_SECRET=你的随机钥匙
Environment=PORT=8080
Environment=BIND=127.0.0.1
ExecStart=/usr/bin/node /srv/aidulc/cloud-worker/src/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aidulc-sync
sudo systemctl status aidulc-sync     # active (running)
```

### 5. nginx 反代 (拿 CF 橙云的 TLS)

```bash
sudo apt-get install -y nginx
```

`/etc/nginx/sites-available/aidulc-sync`:

```nginx
server {
    listen 80;
    server_name sync.aidulc.example.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/aidulc-sync /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 6. CF 橙云代理 (TLS)

1. Cloudflare DNS 里给子域名建 A 记录, 指向香港机公网 IP。
2. 记录上开**橙云代理** (Proxied) —— CF 自动签 TLS, 服务器端始终只有 http。
3. 等几十秒生效, `https://sync.aidulc.example.com/v1/capabilities` 应返回
   `{"ok":true,"storage":"file","max_writes_per_day":null}`。

### 7. 桌面端指向新地址

设置 → 同步与数据 → Worker URL 填 `https://sync.aidulc.example.com` → 换 token
(首台 ROOT_SECRET, 和 CF 路径一样的流程) → 立即同步。1424 词一次推完, 无配额限制。

### 8. KV_DIR 纳入备份 (它就是你的词库真相源)

```bash
# 例: 每天打包一份, 保留 7 天
0 3 * * * tar czf /srv/backup/aidulc-kv-$(date +\%F).tar.gz -C /srv/aidulc kv
```

## 验证

```bash
# 服务端自测
curl -s http://127.0.0.1:8080/v1/capabilities
# → {"ok":true,"storage":"file","max_writes_per_day":null}

# 端到端: 桌面端推 1424 词后, 数据目录里键数 = 1425 (1424 词 + deck index)
ls /srv/aidulc/kv | wc -l
```

## 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `/v1/capabilities` 504/超时 | nginx 没起 / 端口不对 / node 挂了 | `systemctl status aidulc-sync` + `ss -tlnp` |
| 从外网访问到的是 nginx 默认页 | A 记录没开橙云 / nginx server 块没生效 | 检查 CF DNS + `nginx -t` |
| 首台换 token 403 "ROOT_SECRET 不正确" | systemd 里 ROOT_SECRET 没配或配错 | `systemctl cat aidulc-sync` 核对 |
| 桌面端状态"未配置" | worker_url 填错 / 忘了换 token | 设置页重新填 URL + 换 token |
