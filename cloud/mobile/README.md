# aidulc 手机背单词 (V7) —— Cloudflare 托管 Web 应用

发链接即用 (PWA), 不打包原生; 代码为将来套壳 apk/iOS 留路 (adapter 层)。

## 部署 (CF Pages)

```powershell
# 首次
wrangler pages project create aidulc-mobile --production-branch main
# 每次改完
wrangler pages deploy . --project-name aidulc-mobile --branch main
# → https://aidulc-mobile.pages.dev
```

同步指向自己的 worker (`cloud/worker/` 部署出来的链接):
打开应用 → 设置 → 输入 Worker URL + ROOT_SECRET (首台) 或 6 位邀请码换 token。

## 结构

```
core.js       纯逻辑 (SRS 调度器 JS 移植 = domain/srs.rs 同算法; 每日配比; 撤销/翻面锁)
adapter.js    平台适配层 (storage: IndexedDB; net: fetch 带 3 次退避重试)
app-logic.js  应用逻辑 (本地先写 → 待推队列 → 先推后拉 → 合并)
app.js        浏览器 UI (整卡翻面 / 左右滑评分 / 下滑退出 / 长按操作)
sw.js         Service Worker 缓存壳 (离线打开)
index.html    PWA 壳
styles.css    手机 390×844 布局 (评分区底部 120px, 按钮 56px)
```

## 关键规则 (与桌面端一致)

- **本地先写**: 评分先落 IndexedDB + 待推队列, UI 不等网络
- **先推后拉**: 每次同步先推待推队列, 再拉增量
- **离线可完整复习**: 断网照常评分; 恢复网络自动补推 (app.js boot 时 + 手动点 chip)
- **冲突按 updated_at 新者胜**
- **不依赖 `window.__TAURI__`**: 存储/网络全走 adapter, 套壳只换 adapter

## 测试

```powershell
node test\app_test.mjs   # 27 项: core 纯逻辑 + 离线复习→重连自动补推、条数对上
```

已接入 `scripts/check.ps1` (7.8)。

## 实测记录 (2026-08-09)

真实 worker (https://aidulc-sync.yoyoset.workers.dev) e2e:
```
invite code: {"ok":true,"code":"589416"}
auth: {"ok":true,"user_id":"f3221dae9e1141a8","user_name":"e2e新成员","hasToken":true}
local pending: 2
sync: {"ok":true,"merged":0,"rev":2}
pending cleared: true
remote count: 2 matched(2): true
root 看不到新成员词: false   (越权隔离成立)
```
