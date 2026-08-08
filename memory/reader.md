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

- **设置浮层拿到 render 时的旧 settings 引用**: render() 早于 open() 完成, 构造
  SettingsOverlay 时 `_settings` 是 null; 修复为 open() 时宿主先 `setSettings()` 再开。
- **词底色跨句清理**: 旧实现用 `_activeSentence`(已被 highlightAt 先更新成新句)去清
  上一句的残留底色会漏清; S5 改为按词自己记的 `_activeWordSentence` 清。
- **PowerShell 5.1 门禁脚本必须 UTF-8 BOM**: check.ps1 编辑后用字节校验 BOM 仍在。
- **首帧插图丢失**: 模式重渲染 `_renderSentences` 从 `renderer.images` 取图, 首次调用
  时还是空; 修复为从 `_chapterImages`(ch.images 快照)取。

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
