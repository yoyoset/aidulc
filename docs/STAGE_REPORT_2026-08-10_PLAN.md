# 阶段报告 08-10 计划 (S0-S7) — CF 侧重整 + 自建 VPS 后端 + 阅读器体验补齐

| 项 | 值 |
|---|---|
| 版本 | 应用 `0.1.0`;git 基线 `c371435` → `ff77e17`(S0-S7 一条一提交) |
| 日期 | 2026-08-10 |
| 状态 | 已提交,`scripts/check.ps1` 20 项全绿 |
| 计划源 | `08-10plan.md` |
| 便携版 | `dist/aidulc-portable/` 已重打(见 §6) |

## 0. 一句话

计划起点是"CF 这端还需处理什么"——实测盘点后确认服务端已就绪,但发现**首次全量同步
必然撞 CF 写配额**(worker 推送一词一个 KV 键,1424 词 > 1000/天)。据此定两条路:
CF 免费档 = 从零积累(新建空 KV),VPS 自建 = 承接存量。计划逐条落地:修掉设置页卡死、
CF 侧重整、写配额护栏、VPS 后端壳、顶栏下拉、逐句播放、语义通道配色,最后端到端验证。

## 1. 交付物 (S0-S7 验收)

| 卡 | 交付 | 验收(机械可核对) |
|---|---|---|
| S0 | 设置页不再假死 | `components_health` 改 async + spawn_blocking;探测带 5s/60s/120s 超时;设置页"检测中…"先出页;单测注入永不输出的假进程断言超时返回 |
| S1 | CF 侧重整 | 新建空 KV `aidulc-sync-kv`(9a9140…)填入 wrangler.toml;删除 `aidulc-v0-smoke`(无鉴权 /kv-test 裸奔公网,已确认);`docs/SELFHOST_CF.md` 完整自建流程 |
| S2 | 写配额护栏 | 桌面端推送前估算(待推+1>配额→拒绝并给人话);worker 前置拒绝 kv_write_quota + 中途失败部分结果(wrote/written_keys);两条回归测试(不把失败当成功、超配额不发请求) |
| S3 | 自建 VPS 后端 | `server.mjs` Node HTTP 入口适配 Request→既有 fetch(request,env),业务一行不改;进程内冒烟 5 项(真实 HTTP);`docs/SELFHOST_VPS.md` 部署流程 |
| S4 | 顶栏用户下拉 | "＋ 新建成员"(users_create 命令接线)、去硬拼 ▾、取消回滚;新成员无 token→同步未连接是正确行为;冒烟全过 |
| S5 | 句前按钮"只播这一句" | `player.playOne` 设 stopAtMs,_tick 越过即停(重复未用完不停);逐句/通篇按 pace 分流;按钮提示反映语义;shadow 单测 + DOM 冒烟 |
| S6 | 语义通道配色 | 5 色系×明暗 10 组全部给值;新增 `--rd-saved`/`--rd-hl` 独立通道;朗读底色提彩度;门禁扩展 3 组(ΔL/ΔE/ink-AA) |
| S6b | 设计语言审计 | `docs/DESIGN_CONFORMANCE.md` 每条原话→判据→实现→结论;深色去阴影、虚线补 40% 填充、新门禁 `css:dashed-rule` |
| S7 | 端到端验证 | check.ps1 20 项全绿;从零 20 词写次数 22≤25;便携版重打时间戳≥最后提交 |

## 2. 关键决策与实测依据

### 2.1 CF 免费档撞配额的根因(S2 起点)

`cloud/worker/src/index.js` 推送循环**一词一个 KV 键**(`srs:{user}:{word}`),桌面端不分批
推 1424 词 = 单请求约 1424 次 KV 写,而 CF 免费档**写不同键 1,000 次/天**(官方页+实测)。
`docs/DESIGN_NOTES_SRS.md` 当时推理"配额风险不在一次写几个键,而在每天几次同步"对**首次
全量**是错的——实测样本只到 100 词。据此定两条路:CF=从零积累(新建空 KV,词随使用增长),
VPS=承接存量(文件存储无配额)。

### 2.2 S0 卡死根因(与 P0-A 是两条独立路径)

点设置→`components_health`(同步命令跑主线程)→ spawn 6.3GB 侧车后**无超时**读 stdout 到
EOF。侧车冷启动慢或管道未关→主线程永久阻塞(实测 Responding=False,CPU 仅 0.6s)。
P0-A 修复有效但这条一直存在——之前把"点几个 tab 就卡"整体归因于 P0-A 是不完整的。
修法三层:命令改 async+spawn_blocking、探测加超时、UI 先出"检测中…"。

### 2.3 存储抽象的价值(S3)

`createFileKv` 已就位,`index.js` 无 `env.DB` 时自动用它。缺的只有 Node HTTP 入口:
`server.mjs` 把 `node:http` 请求适配成 `Request` 交给既有 `fetch(request,env)`,
**业务一行不改,同一份代码两端跑**——这正是 V5 做存储抽象的目的。

## 3. 门禁数字(当前真实)

| 检查 | 结果 |
|---|---|
| cargo test (单线程) | 198 passed(含 S0 探测超时、S2 两条配额测试) |
| vitest | 112 passed(含 S5 shadow 单句停止 4 条) |
| worker local_test | 52 passed(含 S2 配额护栏 8 节 + S7 从零积累) |
| server_test (VPS 壳) | 5 passed |
| clippy baseline | 8(未升) |
| 对比度门禁 | S6 三组 + WCAG 全部 PASS |

## 4. 踩过的坑(写进 memory)

- **`res.end(await response.arrayBuffer())` 在 Node 下崩溃**:`Response.end` 只收
  Buffer/string/Uint8Array,收 ArrayBuffer 会抛 `ERR_HTTP_HEADERS_SENT`;且 `Response.headers`
  是 Headers 对象要转普通对象。修在 `server.mjs`。
- **Windows 下 kill 子进程触发 libuv 断言**:server_test 起初用子进程跑 server.mjs,退出时
  `uv_close` 对已 closing 句柄断言(exit -1073740791)。改进程内 `startServer/stop` + stop 时
  destroy keep-alive 连接 + 不强制 `process.exit`,exit 0。
- **F29 参数解析器撞 `State<'_, T>`**:async 命令带生命周期注解后,`rust_fn_params` 的
  naive `split(',')` 把泛型内逗号切断成假参数(`crate`/`store`)。改 bracket 深度感知 + 回归单测。
- **PowerShell 5.1 提交信息多行**:commit 信息里的换行被拆成 pathspec,改用多个 `-m`。
- **S6 门禁先写太严**(ΔL 卡通道):通道是线条不承载文字,③ 只查会承载文字的底色
  (reading-bg + hl 28% 叠色),② 用 ΔE 而非 ΔL 判可判别差。

## 5. S7 端到端实测 (2026-08-10, 真机)

用户提供了香港机 SSH (`F:\my_ai\openwrt\VPS_Info\key_hk`, 149.104.29.84) 与 CF API token, 完成了
计划 §3 的 VPS 部署 + S7.1/S7.2 实测:

- **VPS 后端**: `aidulc-sync.service` systemd 守护 node server.mjs, KV_DIR=/srv/aidulc/kv,
  127.0.0.1:8080。
- **公网入口**: 实测面板 L7 拦截公网 80 (返回 provider 的 CF lander), A 记录+橙云不可行 →
  改用 **CF Tunnel** (`cloudflared-aidulc.service`, 出站连接, 绕过面板)。
- **子域名**: 3-label `sync.aidulc.viiyd.com` HTTPS 握手失败 (Universal SSL 只覆盖 2-label);
  换 `sync.viiyd.com` (2-label) 立即正常。
- **S7.1 验收**: 推 1424 词 → `{"ok":true,"wrote":1424,"rev":1424}`; KV_DIR `srs_` 键 1424 +
  `deck_me_index` 1 (核心数据键 = 1425; 总键数含测试 auth/meta); 拉取 changed=1424。
- **S7.2 验收**: CF 免费路径用空 namespace (aidulc-sync-kv), worker 测试 8d 验证 20 词 = 22 次
  写 ≤ 25; 线上 aidulc-sync 已 deploy 指向新空 KV。
- **未做**: "今日队列 1291" 是手机端本地 SRS 状态计算, 不属同步服务端验收; 手机扫码配对
  需用户在桌面端操作。

## 6. 未做

- **CF 免费路径真实 20 词冒烟**: 线上 aidulc-sync 已切新空 KV, 但真实推送需桌面端指向
  `aidulc-sync.yoyoset.workers.dev` 后由用户操作 (本地 worker 测试已验证 22 次写)。
- **ROADMAP**: prep 任务状态三态语义、字号间距存量迁移两条已记入。

## 7. 便携版重打(BOOK_WORKFLOW §6)

1. `scripts/check.ps1` 全绿 ✓
2. 代码全部提交完(最后提交 `ff77e17`)✓
3. 重打:`cargo build --release`(aidulc.exe 19:22:08) + `build_prep.ps1`(aidulc-prep.exe 19:32:32)
4. 时间戳核对:两个二进制 ≥ 最后代码提交 ✓;`config.toml` 干净默认(相对路径,无开发机残留)✓
