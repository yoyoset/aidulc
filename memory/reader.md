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

---

# 附:摘录标注与自定义标签域 (M7 R16-R17, 2026-09-05 重做)

按全局 CLAUDE.md 框架记录摘录(highlights)/自定义标签维度的现状、权衡、坑。这个域
2026-09-05 一天内经历了两轮真机反馈驱动的返工, 记下来避免下次重蹈——**上线当天的
真实反馈比设计阶段的自我推演准得多, 这个域是最直接的例子**。

## 系统构成

- **表**: `highlights`(唯一写者 `highlights_repo.rs`, 每条摘录一行, `kind` 列是
  自由文本——空串=未打标签, 非空=某个 `highlight_tags.id`) + `highlight_tags`
  (唯一写者 `highlight_tags_repo.rs`, 只存标签定义 id/label, 不存"谁打了谁")。
  两张表分属两个 repo, 但删标签需要级联清空 `highlights.kind`——这是唯一一处
  `highlight_tags_repo` 之外的调用方(`ipc::commands::highlight_tag_delete`)依次
  调两个 repo 各自方法完成级联, 不是数据库事务, 见 `highlight_tags_repo.rs` 头注释
  的理由(两步都幂等, 谁先谁后不留脏数据)。
- **前端三文件分工**(2026-09-05 因单文件逼近 600 行硬上限拆分):
  `views/reader/highlights.js`(交互本体: 划句/按钮/面板/搜索/筛选)、
  `views/reader/highlight_tags_store.js`(标签 CRUD + 独立的"管理标签"小面板 UI)、
  `views/reader/highlights_export.js`(纯函数: 按章分组 → Markdown/HTML/打印, 三种
  格式共用同一份分组逻辑)。

## 关键决策与权衡

1. **标签从"我设计的固定三分类"改成"用户自定义"**: v36 当天上线的"默认/待复习/
   生词相关"固定三分类, 用户当场反馈"不够用, 而且不知道去哪加标签"。改用户自己
   建标签(比如"好句子"/"谚语"), 一天内加了一轮迁移(v37 建 `highlight_tags` 表)。
   **教训**: 分类体系这种"给用户用的词汇表", 设计阶段自己拍的三个值大概率不对,
   应该一开始就做成用户自定义, 不要预设"三个够用"这种没有实证的假设。
2. **摘录动作本身仍然零摩擦, 分类是可选的追加动作**: 划句选中 → 点"摘录"→ 立即
   存(`kind` 空串), 不强制选分类。保存成功后**原地**弹出一个"✓ 已摘录"+ 标签
   下拉(复用同一个浮层元素、同一套显示/隐藏机制), 想顺手分类可以选, 不想理
   点别处自动收起。这是对"划句时停下来分类是额外摩擦"和"用户想在摘录那一刻
   就选标签"两个诉求的折中, 不是先做了一个再改的。
3. **"导出 PDF"不引入 PDF 生成库, 借系统打印对话框**: 没有找 PDF 库(会撞 Tauri
   CSP `script-src 'self'` 限制, 且多一个依赖没必要), 而是把导出内容喂进隐藏
   iframe 调 `print()`, 用户在系统对话框选"另存为 PDF"。按钮文案和提示都写明
   "打印"而不是"导出 PDF", 避免用户以为点一下直接落地一个 PDF 文件
   (CLAUDE.md 错误反馈原则同样适用于"这功能到底做了什么")。
4. **标签配色降级为"打没打标签"二值, 不逐标签配色**: 标签数量不定、名字用户自
   起, 没法像固定枚举那样每个值配一种颜色(会撞 S6/C 那套全色系×明暗×ΔE≥10
   的对比度门禁, 每加一个自定义标签就要过一遍全量对比度测试, 不现实)。改成
   "未分类=中性底色, 打了任意标签=统一 info 底色", 具体是哪个标签靠下拉文字看。

## 已踩坑 (实测, 不是读代码看出来的)

- **选区工具条"点了没反应"——同一个 bug 一天内改出两个版本, 第二版更差**:
  根因是"显示"(判定选区变化)和"隐藏"(点别处收起)共用同一个全局 `document`
  `mouseup` 监听, 点"摘录"按钮自己产生的 `mouseup` 会冒泡触发"重新判定选区"
  逻辑, 把刚点的按钮在 `click` 事件派发**之前**就地摧毁重建, 浏览器不会对已从
  DOM 摘掉的元素派发 `click`。**第一次修**(把 `mouseup` 绑到 `getContainer()`
  返回的正文容器节点上)看似合理, 实际更差: `attach()` 是在 `render()` 里、
  正文容器 `appendChild` 进真实 DOM **之前**调用的, 那一刻 `getElementById`
  查不到节点、静默 fallback 回 `document`——等于完全没生效, 而且第一版里"忽略
  按钮自身"的判断也被顺手删掉了, 回归到最初的 bug, 只是我以为修好了。
  **真正修法**: 不要在 `attach()` 那一刻把监听器绑死在某个具体节点引用上(节点
  是否已经在活文档树里是运行时状态, 不是构造时状态)——两个监听器都留在
  `document` 上, 但在事件触发那一刻**现查** `_container()` 判断 `e.target`
  是否落在正文范围内。**教训**: 这类 DOM 事件时序 bug, 光靠读代码推理会两次
  都推错——第二次改完之后没有再实测就汇报"修好了", 用户点了发现还是没反应。
  之后这类改动一律搭一个独立 HTML 页面, 用真实浏览器(Claude Browser 工具)
  实际选中文字、真实点击、看真实的保存回调触发, 不再只读代码判断。
- **删标签的级联清空只做了后端, 前端缓存没跟着同步**: 后端 `highlight_tag_delete`
  正确地把 `highlights.kind` 清成 `''`, 但前端 `ReaderHighlights.items` 这份
  内存缓存没人告诉它"这个标签没了"——`_tagStore.labelFor()` 对"找不到的 id"
  兜底返回字符串 `'未分类'`(给行内下拉展示用是合理的), 结果导出逻辑把这个
  兜底文案误当成"真的打了一个叫'未分类'的标签", Markdown 里印出
  `**[未分类]**` 这种荒谬的方括号。**修法**: 标签管理面板任何增删改之后,
  主动跑一遍 `_reconcileOrphanedTags()`——凡是 `kind` 不为空但在当前标签列表
  里找不到的, 清成 `''`, 让前端缓存跟后端已经做的级联清空保持一致。这个 bug
  也是真实点击"删除标签"再导出才看到的, 光看 `clear_kind_for_tag` 这个后端
  方法的代码不会想到前端还有一份没同步的缓存。
- **测试用的假后端如果直接返回内存数组引用而不深拷贝, 会制造真实环境不存在的
  假 bug**: 排查上面那个 orphan 问题之前, 曾经先看到一个"新建标签变成两条"
  的假象——原因是测试页面的 `highlightTags.list` mock 直接 `return {data: tagRows}`
  (同一个数组引用), 前端 `this.tags = res.data` 之后 `this.tags` 和"假后端"的
  存储数组变成同一个对象, 后续 `push` 会互相污染。真实 Tauri IPC 走 JSON 序列化,
  前后端不可能共享引用, 这个假象只会在偷懒的 mock 里出现。**教训**: 写测试用的
  假后端时, `list`/`get` 类返回必须深拷贝(`JSON.parse(JSON.stringify(...))`),
  否则会在测试里看到生产环境不可能发生的现象, 浪费时间排查一个不存在的 bug
  (也可能反过来: 掩盖一个真实存在但被"引用共享"意外规避掉的 bug)。

## 已知遗留

- 标签目前是单选(一条摘录只能打一个标签), 用户如果要"好句子 + 情感强烈"两个
  维度同时标, 现在做不到——多标签(改 `kind` 单值为标签 id 数组)是后续工作,
  这次没做是因为单选能覆盖当前反馈的场景, 多选会牵动 UI(行内下拉要换成多选
  控件)和存储(单列 TEXT 不够, 要么 JSON 数组要么关联表)两处改动, 优先级上
  先满足"能自定义"这个更紧迫的诉求。
- 标签删除没有二次确认——点了就真删(级联清引用), 跟项目里其它"删除"按钮
  风格一致(摘录本身的删除也没有二次确认), 不是这个功能特有的欠账。

