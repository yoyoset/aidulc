/**
 * server.mjs —— 自建 VPS 后端的 Node HTTP 入口 (S3, 2026-08-10)
 *
 * 目的: CF Worker 的 fetch(request, env) 导出只能在 Workers 运行时直接跑。
 * 自建 VPS 时把这层 HTTP 入口接到同一份业务代码 (src/index.js) 上 —— 业务一行不改,
 * 同一份代码两端跑 (这正是 V5 做存储抽象的目的)。
 *
 * 用法 (直接运行):
 *   env.KV_DIR  词库数据目录 (文件存储, 即 createFileKv 的根; 纳入备份)
 *   env.ROOT_SECRET  "这个家的空间"的钥匙 (首台换 token 用)
 *   node src/server.mjs            # 默认 127.0.0.1:8080
 *   PORT=8080 BIND=0.0.0.0 node src/server.mjs
 *
 * 部署 (systemd 示例见 docs/SELFHOST_VPS.md):
 *   [Service]
 *   Environment=KV_DIR=/srv/aidulc/kv
 *   Environment=ROOT_SECRET=...
 *   Environment=PORT=8080
 *   ExecStart=/usr/bin/node /srv/aidulc/cloud/worker/src/server.mjs
 *
 * 安全边界:
 *   - 默认只监听 127.0.0.1; 对外必须经 nginx/caddy 反代 + TLS (CF 橙云代理也行),
 *     服务器自身不直接暴露公网 HTTP。
 *   - ROOT_SECRET 只用于首次换 token, 之后全靠 token; 丢了就重新 `secret put`。
 *   - 兑换限流按来源 IP 计 (E5): 直连不用设; nginx/caddy 之后设 TRUST_PROXY=1 (反代须追加 X-Forwarded-For);
 *     经 CF Tunnel (本项目文档的默认路径) 设 TRUST_PROXY=cf。不设 → 反代后所有人共用 127.0.0.1 一格。
 */
'use strict';

import http from 'node:http';
import worker from './index.js';

/**
 * 启动后端。返回 { server, stop }。
 * stop() 关闭服务器并等所有连接收尾 (测试用; 也接 SIGTERM/SIGINT 优雅退出)。
 */
export function startServer({ host = '127.0.0.1', port = 8080, kvDir, rootSecret, trustProxy = false, log = console.log } = {}) {
  if (!rootSecret) {
    throw new Error('缺 ROOT_SECRET —— 部署前必须设, 否则首台永远换不了 token (假成功)');
  }
  const env = {
    // 有 KV_DIR 无 DB → 走文件存储 (index.js 的存储选择逻辑, 业务不变)
    KV_DIR: kvDir || '/tmp/aidulc-kv',
    ROOT_SECRET: rootSecret,
  };

  function rawBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const body = await rawBody(req);
      // 适配成 Workers Request: 保留方法/URL/头/体; CF Worker 的 URL 来自 request.url
      const url = 'http://' + (req.headers.host || host + ':' + port) + (req.url || '/');
      // E5 (2026-11-15): 来源标识给兑换限流用 (index.js 的 clientId)。必须由这一层写, 不能信客户端:
      // 丢弃客户端自带的 cf-connecting-ip / x-aidulc-client-ip, 用 TCP 对端地址覆盖;
      // 只有部署在自己的反代之后 (trustProxy) 才改用代理追加的 X-Forwarded-For **最后一项**
      // (前面的项是客户端自己能写的)。不开 trustProxy 却放在反代后面 → 所有人共用 127.0.0.1 一格,
      // 是安全的误伤 (限流更严), 不会放行。
      const headers0 = { ...req.headers };
      delete headers0['cf-connecting-ip'];
      delete headers0['x-aidulc-client-ip'];
      let clientIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
      if (trustProxy === 'cf' && typeof req.headers['cf-connecting-ip'] === 'string' && req.headers['cf-connecting-ip']) {
        // CF Tunnel (cloudflared) 转发来的请求: CF 边缘写的 CF-Connecting-IP, 客户端伪造不了
        clientIp = req.headers['cf-connecting-ip'].trim();
      } else if (trustProxy && trustProxy !== 'cf' && typeof req.headers['x-forwarded-for'] === 'string') {
        const parts = req.headers['x-forwarded-for'].split(',').map((x) => x.trim()).filter(Boolean);
        if (parts.length) clientIp = parts[parts.length - 1];
      }
      headers0['x-aidulc-client-ip'] = clientIp;
      const request = new Request(url, {
        method: req.method,
        headers: headers0,
        body: req.method === 'GET' || req.method === 'HEAD' || body.length === 0 ? undefined : body,
      });
      const response = await worker.fetch(request, env);
      // Response.headers 是 Headers 对象 → 转成普通对象; end() 只收 Buffer/string/Uint8Array
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'server.mjs 处理异常: ' + (e && e.message) }));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log(`aidulc 同步后端监听 http://${host}:${port} (KV_DIR=${env.KV_DIR})`);
      const sockets = new Set();
      server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
      });
      const stop = () =>
        new Promise((r) => {
          // 主动断开 keep-alive 连接, 否则 server.close 永远等不完 (Windows 下还会
          // 在退出时触发 libuv 句柄断言)
          for (const s of sockets) s.destroy();
          server.close(() => r());
          const timer = setTimeout(r, 2000);
          timer.unref();
        });
      resolve({ server, stop, env });
    });
  });
}

// 直接运行 (node src/server.mjs) 才启动; 被测试 import 时不自动起
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('server.mjs')) {
  const host = process.env.BIND || '127.0.0.1';
  const port = Number(process.env.PORT || 8080);
  startServer({
    host,
    port,
    kvDir: process.env.KV_DIR,
    rootSecret: process.env.ROOT_SECRET,
    // 部署在 nginx/caddy 之后设 TRUST_PROXY=1; 经 CF Tunnel 设 TRUST_PROXY=cf —— 限流才按真实客户端 IP 计
    trustProxy: process.env.TRUST_PROXY === 'cf' ? 'cf' : process.env.TRUST_PROXY === '1',
    log: (m) => console.log('[server.mjs] ' + m),
  }).then(({ stop }) => {
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => { stop().then(() => process.exit(0)); });
    }
  });
}
