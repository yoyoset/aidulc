# aidulc 项目记忆 — 阅读器 (S5 三模式, 2026-08-08)

按全局 CLAUDE.md 框架记录阅读器维度现状、权衡、坑。以实测为准。

## 系统构成

- 阅读器前端模块 (reader/): `core/*.js` 纯逻辑(零 DOM, vitest 直测) +
  `components/*.js`(atomic_block / reader_renderer, DOM) +
  `views/reader/*.js`(单一职责模块: ruler/support_panel/settings_overlay/follow_bar/
  silent_card/command_palette/player/chapter_loader/bookmarks/search) +
  `views/reader_view.js`(组合根)。
- 状态机: `core/reader_state.js` 三显示模式 × 双节奏 + 逐句揭示/已核对。纯逻辑可单测。
- 持久化: `reader_settings`(display_mode/pace/preset/speed, 迁移 v10) +
  `reading_state.verified`(每章已核对句, JSON {章: [句,...]}, 按章隔离)。

## 关键决策与权衡

1. **三模式不合并**: 先答后核(guess) / 静默正文(silent) / 对照台(bench)。共用同一套
   正文 DOM(atomic_block), 模式切换 = 复用 renderer 重渲染, 保持滚动位置(win.scrollY
   保存/恢复)。切换走 1/2/3 键。
2. **揭示机制**: 取消高斯模糊(filter: blur() 非合成友好)。改用开关式揭示(Enter/句内 ↧),
   首次揭示即记「已核对」; 离开已揭示句 → 折叠 2px 细痕。**坑**: 渲染器自动折叠必须同时
   摘掉 ReaderState 的 `_revealed`, 否则再回来时 supportFor 判定仍是 revealed, 会错误
   重新展开 —— 这个 bug 是 DOM 冒烟测试(离开→回来断言 scar)抓到的, 不是读代码看出来的。
3. **词四态四通道**(设计 §2.5): 颜色只给「正在朗读」(--rd-reading-bg); 生词 1px 下划线;
   短语动词 2px 强调线; hover 才出现可点浅底。
4. **对照台节奏线**: 预测量(句成为当前句时读 offsetLeft/Width 一次) + 播放期只写
   `transform: translate3d + scaleX(width)`, 基宽 1px。逐帧只动 transform, 不读布局。
5. **盲跟预设**: 只亮当前词, 其余 `.tok:not(.word-reading)` 降 12% 透明度 —— 纯 CSS
   data-blind 门控, 且只在词级粒度生效(句级粒度没有词高亮, 全暗了没法看)。
6. **对照台「结构骨架」降级**: prep 未拆分讲解两层, 按设计 §7 降级为右栏常显讲解全文。
   未重跑任何书。右栏只承载当前句四类内容(代码层写死, 防熵增约束)。
7. **搜索/书签入口**: 顶栏撤销后走 Ctrl+K 命令面板(轻量: 搜索 + 书签按钮)。命令面板的
   条目设计本轮没做, 保持最小。

## 已踩坑 (实测/静态确认)

- **撤销条被 renderCurrent 清掉 (V3/V7 同类 bug, 2026-08-10 实测抓到)**: 手机 app.js
  `grade()` 先 `showUndo` 再 `renderCard`, 而 renderCard 内部 `hideUndo` 把刚显示的撤销条
  清掉 → 用户评分后看不到撤销入口。桌面 review_view.js 同样先 `_armUndo` 再
  `_renderCurrent`(cardCol.innerHTML='' 清空)。**修法: 先渲染下一张, 再挂撤销条。**
  这类"挂完又被重渲染清掉"的顺序 bug 只有真实驱动控制器才能暴露 —— 新增
  `cloud/mobile/test/ui_smoke.mjs`(最小 DOM stub + 内存 adapter 驱动真实 app.js,
  19 项断言)在无浏览器环境下机械验证设计稿 01b 交互(翻面单向/250ms 锁/评分/
  撤销/下滑退出)。桌面侧补"评分后撤销条可见"断言到 _smoke_views 第 6 节。
- **设置浮层拿到 render 时的旧 settings 引用**: render() 早于 open() 完成, 构造
  SettingsOverlay 时 `_settings` 是 null; 修复为 open() 时宿主先 `setSettings()` 再开。
- **词底色跨句清理**: 旧实现用 `_activeSentence`(已被 highlightAt 先更新成新句)去清
  上一句的残留底色会漏清; S5 改为按词自己记的 `_activeWordSentence` 清。
- **PowerShell 5.1 门禁脚本必须 UTF-8 BOM**: check.ps1 编辑后用字节校验 BOM 仍在。
- **首帧插图丢失**: 模式重渲染 `_renderSentences` 从 `renderer.images` 取图, 首次调用
  时还是空; 修复为从 `_chapterImages`(ch.images 快照)取。
- **词典面板 UX6 #4 (2026-08-13)**: 点正文(面板外)自动收起的 document 级 click 监听必须
  排除 `dict-panel` 内与正文 `.bubble`(查词入口, 由 _onWordClick 刷新面板)——否则点词收起、
  点面板按钮也收起, 交互全错。smoke 2d3 锁 8 项断言, test stub 补了 closest/contains
  (此前缺失, 真实 DOM 有但 stub 没有)。

## 待实测验证 (设计 §8 风险清单, 连续使用两周才判)

- 「已核对」被记账是助力还是压力(可关掉记录回滚)。
- 折叠细痕的二次相遇是恰当难度还是烦人。
- 对照台节奏线 vs 逐词底色(对孩子, 若跟不上立刻退回底色)。
- 非颜色通道(生词 1px / 短语 2px 下划线)深色小字号下可辨识度。
- 盲跟可能只是焦虑。
- 逐句模式自动滚动时机(当前滚到 42% 视口, 需实调)。

## 已知遗留 (未做/未接线)

- F25 儿童模式对 kid 书无效仍未修: settings_get 读不到行时返回 DB 默认, 无法区分
  「行不存在」与「行就是默认值」; 修法要 Rust get 改 Option + 前端回退 'default', 独立任务。
- 对照台结构骨架需要 prep 讲解两层拆分(否则永远降级)。
- 命令面板(Ctrl+K)具体条目与排序未设计。
- 原书插图在对照台模式的跨栏排版未验证。

---

# 附:背单词复习域 (STAGE-SRS V0-V7, 2026-08-10)

按全局 CLAUDE.md 框架记录背单词/身份/同步维度的现状、权衡、坑。

## 系统构成

- **调度器**: `domain/srs.rs`(Rust 纯函数, 零 I/O)。SM-2 变体: 新词/学习中按评分定
  分钟/天步长(1分/10分/3天/8天); 复习按 ease 增长, 忘了打回学习。毫秒字段 `interval_ms`
  承载分钟级步长(`interval_days` 只留 AIDU 导出兼容)。**一致性测试**: 按钮预览值 ==
  评分后实际到期(改算法按钮自动跟, 前端不写死)。
- **每日配比**(三项已定 ②): `newWordQuota = clamp(6 - max(0, 到期-20)/2, 0, 6)`; 学习中
  (分钟级未毕业)不占配额到点插队; 顺序 到期复习→学习中→新词。桌面与手机两端 JS/Rust
  各实现一份, 算法一致(core/review.js 与 domain/srs.rs 对齐)。
- **身份**: `users` 表 = "谁", `profiles` = "讲解策略", 互不替代。一台设备可持多 token
  (顶栏切人 = 切 token)。
- **同步**: 协议 v1(cloud/worker), 词条最小集(词/音标/释义/来源单句, 无书正文)。
  桌面 `sync_v1_client` / 手机 `adapter.js` 各一套, 同一协议。`sync_state` 表记
  last_push_at(算待推数) + last_pull_rev(增量拉)。

## 关键决策与权衡

1. **先推后拉是硬规则**: 任何同步先推本地未推(updated_at > last_push_at), 再拉增量
   (since=last_pull_rev), 不许先拉覆盖未推本地。冲突按 updated_at 新者胜(复用
   domain/sync.rs merge_envelopes)。
2. **user 由服务端从 token 解析**: 客户端不自报(手机端公网可达, 自报 = 能读别人词库)。
3. **存储抽象**: 服务端 storage.js 定义 get/put/list/delete, CF KV 与文件存储(VPS)两个
   实现 —— 免费(自建 CF)/付费(VPS 托管)同一份 worker 代码。
4. **迁移不拆人**: 全部现有数据归 user "me"; 不许猜 kid profile 的词属于孩子(自动不可逆,
   猜错要重做)。建成员是用户主动可逆动作, 走 invite-user 码。

## 已踩坑 (实测)

- **PS 5.1 Set-Content 破坏 .rs/JS 中文**: 整文件写回会把 UTF-8 中文变 mojibake。
  改含中文源码必须用 edit 工具。**两处踩到**(dictionary_service.rs、V7 e2e 脚本)。
- **clippy 基线 8 只降不升**: V4 给 add_vocab 加 3 参数触发"参数过多" → 打包成
  AddVocabRequest/SourceLocation 结构体守住基线。新增命令带可选参数先想结构体。
- **迁移 fixture 要随版本 rollback**: 加 v21/v22 后, v18/v20 fixture 必须同步删对应
  migration 行 + drop 新表/列, 否则重开库 MAX(version) 已是最新, 旧迁移不重跑。
- **同毫秒时间戳竞态**: pending 计数比较 updated_at > last_push_at, 同 ms 内会算成 0。
  测试里加 sleep(30ms) 保证严格递增。
- **Windows node fetch keep-alive + server.close 触发 libuv 断言**: 手机测试最初走真实
  TCP 服务, 退出时 `uv async.c:76` 断言(-1073740791)。**修法: 测试 fetchImpl 直接调
  worker.fetch(Request 对象), 不走真实 TCP。**
- **curl `-d '{"x":1}'` 直连 worker 假"JSON 解析失败"**: Windows curl/PowerShell 引号
  处理问题, Node fetch / 文件 body 正常。**用 Node fetch 复验, 别信 curl 的假故障。**
- **手机端"跳到原文"不可用**(冲突 6): 手机没书包, 该入口不可用态提示"在电脑上打开",
  桌面保留跳转(V4 接线)。

## P0 修复 (2026-08-10): 同步拉取写回硬编码 default → 词分裂

- **坑**: `merge_remote_into_local` 远端赢时写 `upsert_sync(entry, user_id, "default")`,
  而 vocab 主键是 `user:profile:lemma`。本地 `me:kid:reticent` 的远端更新会新建
  `me:default:reticent` —— 同一词分裂成两行两套复习状态。推送侧按 lemma 打包,
  同 lemma 多 profile 行会互相覆盖, 顺序不确定。
- **修法**: `get_any_profile` 改成返回 `(profile_id, entry)`, 写回原 profile; 只有真
  新词落 default。推送侧每 lemma 取 updated_at 最新一条(确定性)。
- **回归测试**: `pull_writes_back_to_original_profile_not_default_duplicate` +
  `pull_new_word_lands_on_default`。**教训**: 写回语义必须携带"这条记录本来在哪个
  分区", 不能靠一个独立查询"查一下"就当作原分区 —— 查了不用 = 白查。

## P0 修复 (2026-08-10): PWA 无版本更新机制

- **坑**: sw.js 的 CACHE 写死 `'aidulc-mobile-v1'` + cache-first, install 只在 sw.js
  自身字节变化时触发 → 修了 app.js 不 bump sw.js, 已装用户永远拿第一次缓存的旧壳,
  发链接分发的产品没有自愈路径。
- **修法**: BUILD_VERSION 字面量嵌入 sw.js(字节变 → SW 更新触发)+ build-info.js
  (app.js 读它做"有更新,点此刷新"提示); 导航 network-first、资源 stale-while-revalidate;
  `scripts/deploy_mobile.ps1` 强制版本递增(与 .last-deployed-version 相同则拒绝部署)。
- **教训**: SW 更新检查只看 sw.js 自身字节 —— 版本必须长在 sw.js 里, 单独一个
  build-info.js 文件不会触发更新。

## P0-C (2026-08-10): 手机扫码配对 (token 走 URL, 收藏成书签免登录)

- **根因**: `cloud/mobile/` 从来没有配对入口 —— `authDevice()` 逻辑在 app-logic 里、
  测试也调它, 但 index.html 无输入框、app.js 从不调用 → 手机永远"未配置"。
  与 CLAUDE.md"已知未接线的功能"同一类问题。
- **实现**: 桌面设置页"手机扫码连接" (sync_pair_qr 复用 auth/code + auth/device 换**独立**
  device token, 不覆盖本机 token; qrcode crate 出 SVG); 二维码内容
  `https://aidulc-mobile.pages.dev/#t=<token>&u=<encodeURIComponent(worker_url)>`;
  手机 app.js 解析 fragment → applyPairing 存 IndexedDB → `history.replaceState` 立即
  剥掉 token。兜底: 设置页手动 Worker URL + ROOT_SECRET/6 位码。踢设备: worker 新增
  `POST /v1/auth/revoke` (同 user 才能踢), 删 `auth:{token}` 即失效。
- **坑**: worker_url 嵌 URL 必须 `encodeURIComponent`(Rust 侧 `url_encode_component`,
  手机端 `URLSearchParams` 自动 decode); 二维码内容里如果 url 带 `&` 不编码会截断参数。

## P1-D (2026-08-10): 旧 AIDU 生词迁回 —— 数据不在 CF KV, 在 Chrome 扩展本地

- **探测推翻计划前提**: `wrangler kv namespace list` 只有 `AIDU_DB`, 且 0 键;
  `aidu-sync` worker 在本账户已不存在。旧生词实际在旧 AIDU Chrome 扩展
  (`hoomcgkcbkhgknmknelfonccbajiggmk`) 的 `chrome.storage.local` → `vocab_default`
  1424 条 + `dictionary_default` 332 条 (leveldb, snappy 压缩, 用 classic-level 提取)。
- **导入**: `scripts/import_old_aidu.mjs` 转 `.aidu-data` v3, 走现成
  `transfer_import` → `import_aidu_data` (updatedAt 新者胜), 不另造一套。
  唯一规范化: 旧 `interval`(天) → `intervalMs` = 天×86400000 (否则评分后下一次间隔
  被当成 0/1 分钟重置), lemma 小写 (DB 主键成分), 丢 `_key`。
- **真实数字**: 导入前 vocab=0 → 后 1424 (= 源 1424); 全量 1424 条逐字段比对
  stage/easeFactor/nextReview/reviews/meaning/interval/intervalMs **0 不一致**。
- **坑**: Node 24 全局 `navigator` 是只读 getter, 测试里覆盖要用
  `Object.defineProperty`; 只读覆盖后 `delete` 还原。

## P1-E (2026-08-10): 更新提示改 SW 生命周期驱动

- **根因**: 旧 `checkUpdate()` 拿 localStorage 存的版本和**已加载进来**的 BUILD_VERSION
  比对 —— 能读到常量时新版本早已生效, 点击只是写 localStorage + reload, 视觉无变化;
  首次访问 seen===null 还误报"有更新"。结构性错误。
- **修法**: 注册 SW (此前 app.js **从未 register**, 更新检测根本不触发); 监听
  `updatefound` → 新 worker installing 且 `navigator.serviceWorker.controller` 存在
  (= 真更新, 首次安装 controller 为空) → 才显示提示条; 点击 →
  `reg.waiting.postMessage(SKIP_WAITING)` → sw.js message 监听调 `self.skipWaiting()`
  → controllerchange → reload。sw.js 只首次安装 (active 为空) 自动 skipWaiting,
  更新时等页面指令 (不能自动 skip, 否则没有 waiting 态可 postMessage)。

## 已知遗留

- 手机真机截图未做(本环境无浏览器); 逻辑经 node 测试 + 真实 worker e2e + 真实部署验证。
- 远端合并写回本地 default profile(跨 profile 同 lemma 共用一条远端状态)。
- 桌面设置页 invite-user(新建成员)入口已暴露 (2026-08-09 05450b1), 不在此列。

