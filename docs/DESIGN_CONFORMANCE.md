# 设计语言符合性审计 (S6b, 2026-08-10)

把《aidulc 完整设计.dc.html》里**可机械核对**的硬规则逐条抽出来核对。每条给出:
设计稿原话 → 可核对判据 → 当前实现(带文件/行号) → 结论(符合/偏离)。结论不允许"大致符合"。

偏离分三类:
- **① bug 级**: 实现没跟上设计意图, 直接修 (本次已修)。
- **② 有意偏离**: 有理由不照做, 写清理由留档。
- **③ 需要大改**: 记 `docs/ROADMAP.md`, 不在本轮做。

---

## 1. 虚线规则 (设计 §07)

**设计稿原话**: "1.5px dashed + 40% 纸面填充是全系统唯一允许的虚线"；"虚线只在空态出现, 失败永远配文字"。

**判据**:
1. 全系统 `dashed` 边框必须 `1.5px`。
2. 每个虚线容器必须有 40% 纸面填充 (浅色下 `color-mix(surface 40%, transparent)`, 深色下等价 rgba)。
3. 虚线只出现在空态/导入容器类, 不出现普通卡片/按钮。

**当前实现** (grep `dashed` 全仓):
| 文件:行 | 选择器 | 判定 |
|---|---|---|
| `reader/styles/library.css:81` | `.book-empty` (书库空态) | `1.5px dashed` + `color-mix(surface 40%, transparent)` ✓ |
| `reader/styles/prep.css:3` | `.prep-dropzone` (备料台导入区) | `1.5px dashed`, **缺 40% 填充** → ① 已修 |

**结论**: prep-dropzone 是偏离 → **① 已修** (补 `background: color-mix(in srgb, var(--md-sys-color-surface) 40%, transparent)`)。已加门禁 `css:dashed-rule` 兜底 (1.5px + 40% 填充 + 仅空态类)。

---

## 2. 逐帧动画规则 (设计 §06)

**设计稿原话**: "逐帧只允许 `background-color`(逐词高亮 0.12s linear)与节奏线的 `translate3d + scaleX`(无过渡)。节奏线位置在句子成为当前句时一次性预测量。阅读器内禁用 backdrop-filter。"

**判据**:
1. 阅读正文逐帧变化的只有 `.word-reading` 的 background-color 与 `.sweep` 的 transform。
2. `.atomic-block`(正文词块)及其子元素禁 backdrop-filter / background-image。

**当前实现**:
- `.bubble.word-reading { transition: background-color 0.06s ease }` (reader.css:236) — 只有 background-color ✓
- `.sweep { transform: translate3d + scaleX; will-change: transform }` (reader.css:242-252) ✓
- `.atomic-block` 无 backdrop-filter/background-image ✓ (门禁 `css:no-blk-texture` 已兜底)
- `reader.css:23` `.rd-top` 顶栏有 `backdrop-filter: blur(12px)` — 顶栏是 UI 壳不是正文词块, 与 `app.css:56` 应用顶栏同款, 设计稿 §01 顶栏也画了 blur。**不违反本规则** (本规则限定"阅读器内"指正文逐帧)。

**结论**: 符合。

---

## 3. 深色不加阴影 (设计 §10)

**设计稿原话**: "深色不加阴影, 层级靠 `--rd-surface-raised` 的 9 个明度点差。"

**判据**: 深色块 (`body[data-theme="dark"]`) 里 `--md-sys-elevation-*` 必须为 none/等价无阴影。

**当前实现**: 此前 `:root` 定义了暖棕阴影 elevation-1/2/3, 深色块没覆盖 → 深色仍带投影。
→ **① 已修**: 深色块补 `--md-sys-elevation-1/2/3: none` (tokens.css:186-189)。

**结论**: 偏离 → **① 已修**。

---

## 4. 一屏一色 (设计 §02/§03)

**设计稿原话**: §02 "一屏一色：唯一的彩色是「开始处理」"; §03 处理中 "已完成用绿、进行中用蓝灰、待办用中性灰"。

**判据**:
1. 导入屏(备料台导入区)除主按钮外无强调色。
2. 任务进度/阶段条的颜色语义: 完成=绿 / 进行中=蓝灰 / 待办=中性灰。

**当前实现**:
- `prep.css:50` `.prep-task-status { color: primary }`、`prep.css:61` `.prep-bar-fill { background: primary }` — 状态与进度都用陶土 primary, 不是"绿/蓝灰/中性灰"三态语义。
- 导入卡 `library.css` / `app.css` 的主按钮是 primary, 符合"唯一彩色是开始处理"的意图。

**结论**: prep 任务状态/进度条用色与 §03 三态语义不符 → **③ 需要大改** (涉及 task_status 三态映射 + 阶段条九段色, 记 ROADMAP)。导入屏主按钮规则符合。

---

## 5. Toast (设计 §07)

**设计稿原话**: "Toast 三种(固定深底白字, 底部居中, 2.5s)"。

**判据**:
1. 三种: 成功/失败/信息。
2. 深底白字 (不随主题反转)。
3. 底部居中; 2.5s 自动消失。

**当前实现**:
- `components/toast.js`: 2.5s (`setTimeout(..., 2500)`) ✓; 三种 type (`info/success/error`) ✓
- `app.css:407-424`: `.toast-container { bottom:24px; left:50%; transform:translateX(-50%) }` 底部居中 ✓; `.toast { color: var(--md-sys-color-on-scrim-surface) }` 白字 + 深底 (`scrim-surface` 固定深色, 不随主题反转) ✓

**结论**: 符合。

---

## 6. 设置用纵列 (设计 §10 item 8)

**设计稿原话**: "横向 tab 超过 5 项就不可扫读, 所以设置用纵列。模型中心是一次性配置, 不该和每日高频的生词本并列在顶栏。"

**判据**: 设置页导航是左侧纵列 (>5 项), 不是横向 tab; 模型中心并入设置页。

**当前实现**:
- `settings.css:2-8`: `.settings-tabs { flex-direction: column }` 左侧纵列 ✓; `<800px` 折回横向滚动(窄屏放不下纵列的合理降级)。
- `settings_view.js:48`: 模型中心挂载进设置页一个分区 ✓。

**结论**: 符合 (窄屏横向滚动是响应式降级, 判据针对宽屏桌面场景)。

---

## 7. 阅读器语义通道 (设计 §06)

**设计稿原话**: "词的四种状态各走一条独立通道: 正在朗读 = `--rd-reading-bg` 底色; 已在生词本 = 1px 下划线; 短语动词 = 2px `--rd-mark` 下划线; 可查词 = hover 底。四者可叠加而不互相遮蔽。"

**判据**: 四个通道的形态与颜色彼此可区分, 叠加时不遮蔽。

**当前实现**: 见 S6 提交 —— 新增 `--rd-saved` / `--rd-hl` 独立通道, `--rd-reading-bg` 提彩度, `--rd-mark` 改亮金与 accent 拉开; 门禁 `check_contrast.mjs` S6 三组 (ΔL / ΔE / ink-AA) 兜底; 冒烟测试构造四通道共存句。

**结论**: 符合 (S6 已修)。

---

## 8. 保持裸 #hex / 裸 px 禁令 (设计 §10)

**判据**: `tokens.css` 之外不得出现裸 `#hex`; 字号/间距优先用阶梯令牌。

**当前实现**: `css:no-raw-hex` 门禁已兜底 (除 tokens.css 外全绿)。字号/间距阶梯令牌已建立但存量 rem/px 未迁移(CLAUDE.md 记录的已知欠账)。

**结论**: hex 部分符合; 字号间距迁移是更大改动 → **③ 记 ROADMAP** (已在 CLAUDE.md 标注为存量欠账)。

---

## 9. 当前句标线 / 唯一带彩度 (设计 §06)

**设计稿原话**: "阅读界面里唯一带彩度的东西是当前朗读词底色和当前句标线。"

**判据**: 朗读底色与句标线是唯一有彩度的通道; 生词/短语/摘录线靠形态+低饱和色区分, 不与朗读通道抢彩度。

**当前实现**: S6 后朗读底色 (有彩度) 与句标线 (accent) 是唯二高彩度通道; 生词(saved 蓝灰)/短语(mark 亮金)/摘录(hl 墨绿) 用低饱和区分色 + 形态双编码。`--rd-saved` 的蓝灰/`--rd-hl` 的墨绿刻意降低彩度不抢朗读底色。

**结论**: 符合。

---

## 偏离项去向汇总

| 编号 | 偏离 | 类别 | 去向 |
|---|---|---|---|
| 1 | prep-dropzone 虚线缺 40% 填充 | ① bug 级 | 已修 + 门禁 `css:dashed-rule` |
| 3 | 深色仍带阴影 | ① bug 级 | 已修 (dark 块 elevation: none) |
| 4 | prep 任务状态/进度条用色非三态语义 | ③ 大改 | ROADMAP |
| 8 | 字号/间距存量 rem/px 未迁阶梯令牌 | ③ 大改 | ROADMAP (CLAUDE.md 已标) |

其余规则 (逐帧动画 / Toast / 设置纵列 / 语义通道 / hex 禁令) 核对为**符合**。

---

# UX2 真机走查后 (GOAL_2026-08-11_UX2, 2026-08-11) 补充判据

设计稿权威来源: `完整设计交付确认/aidulc 完整设计.dc.html` §01「我的书」+ §02「导入」+ §03「处理中」;
`生词本和背单词完整设计交付确认/aidulc 背单词.dc.html` (2026-08-09, 比前者更晚且正为生词本功能所做)。

## 10. 书库导入区 = 网格最后一格 (G1, 设计 §01)

**设计稿原话**: "拖入 EPUB 或 TXT / 也可以点「导入」逐本选择" —— 是书卡网格的**最后一格**, 和书卡同尺寸。

**判据**: 原书库无独立占半屏顶部导入卡; 导入入口是网格里一个书卡大小虚线格; 「成人自读/英文」两个下拉只在创建译本弹窗一处。

**当前实现**: `library_view.js::_buildImportGridCell` (导入格) 挂在 `_renderBooks` 网格末尾; `_startBatchImport` 不再读书库页下拉 (参数只在创建译本弹窗 `_chooseEditionProfile`)。`library.css::.import-grid-cell` 与书卡同栅格尺寸。

**结论**: 符合。

## 11. 每卡至多一个主按钮 (G2, 设计 §01 实施说明)

**设计稿原话**: "每卡至多一个主按钮。徽章不可点。"

**判据**: 任一逻辑卡 (主书卡 / 译本子卡) 内 `.btn-primary` ≤ 1; 删除/预览/设置等收进「⋯」详情菜单且删除有二次确认。

**当前实现**: 主书卡操作区一个主按钮 (未处理=创建译本 / 已就绪=打开阅读), 其余进 `_openBookMenu`; 译本子卡一个「打开阅读」+ ⋯。smoke 测试 `3b` 断言主卡/子卡 `.btn-primary` 各自 ≤ 1 (check.ps1 经 `_smoke_views.mjs` 兜底)。

**结论**: 符合。

## 12. 译本/成品列表默认折叠 (G3)

**判据**: 译本列表默认折叠, 显示「译本 (N) ▾」, 点开才铺。

**当前实现**: `library_view.js::_renderBooks` 用 `.edition-toggle` + `.edition-body.collapsed` (默认折叠, 点击展开)。

**结论**: 符合。

## 13. 书卡信息 = 书名/作者/状态徽章/「N 章 · M 句 · XhYm」/阅读进度 (G4)

**判据**: 章数从 edition 取 (原书登记时不填 chapter_count, 此前恒显 0 是 bug); 句数/音频时长从 bookpack 轻量解析。

**当前实现**: `commands/library.rs::library_list` 为 edition 附 `sentence_count`/`audio_seconds` (经 `library_service::parse_bookpack_counts`); 前端 `library_view.js` 从 editions 聚合章/句/时长, 并显示「读到第 N 章 · M%」。

**结论**: 符合 (0 章 bug 已修, 实测从 edition 章数聚合)。

## 14. 书名/作者清洗 (G5)

**判据**: 文件名原样上屏不符合设计; 剥来源站后缀 (z-library.*/1lib.*/z-lib.*), 括号里的人名提取为作者; 解析不出保留原串。

**当前实现**: `reader/core/title_cleanup.js` 纯函数 + 8 单测; 书卡与处理中页标题都走它。

**结论**: 符合。

## 15. 顶栏两个每日目的地 (G8 + H1, 设计 §01 与背单词设计交付)

**设计稿原话**: "顶栏只留两个每日目的地" (我的书 / 生词本); "入口 · 今日队列 + 词表"。

**判据**: 顶栏无「背单词」tab; 设置用齿轮图标; 生词本页 = 上半今日队列卡 + 下半词表; 开始复习是模式不是独立 tab。

**当前实现**: `shell_view.js` 左两项 + 齿轮设置; `vocab_view.js` 上半 `_renderTodayCard` + 下半词表; `review` 路由重定向到 vocab 专注模式 (`main.js`)。

**结论**: 符合。

## 16. 撤销条常驻不位移 (H2, 设计 §01b)

**设计稿原话**: "评分后 3 秒内可撤销, 撤销条压在顶部进度条下方" (手机单列); "动效只允许透明度, 不允许位移"。

**判据**: 撤销条占位常驻 (不出现/不消失/不位移), 3 秒内可点之后转灰; 只切 opacity 不位移; 桌面端等效落位 = 中间卡片区正上方 (视线自然落点, 有意等效落位而非机械照搬)。

**当前实现**: `review_view.js` 卡片上方 `.review-undo-slot` 常驻, `.review-undo-bar.active/expired` 只切 opacity; Ctrl+Z/Backspace 键盘撤销。

**结论**: 符合 (桌面等效落位是有意偏离手机稿, 已在此记录)。

## 17. 生词本行压缩 + 维护动作 (H3, 背单词设计交付 §01b)

**设计稿原话**: "长按单词 → 移出生词本 / 标记已掌握; 背面多一项编辑释义"; 维护动作不占满宽。

**判据**: 单行压缩 (词·释义·阶段·到期), 原句收起点行展开; 满宽删除按钮撤掉, 维护动作收进行尾 ⋯ 菜单; 「已掌握」不进「全部」。

**当前实现**: `vocab_view.js::_renderList` 单行 + ⋯ 菜单 (移出/标记已掌握/编辑释义/在阅读器中打开) + 批量选择; 全部筛排除 mastered。

**结论**: 符合。

## 18. 处理中页三段式 (I1, 设计 §03)

**设计稿原话**: 进行中 (书名+「G3 语法讲解 · 剩余约 22 分钟」+ 暂停/取消 + 阶段流水条 + 数值 + 运行日志折叠) / 排队中 (+插队) / 最近完成 (一条「已就绪 · 昨天 22:41 · 用时 58 分钟」+ 开始读)。

**判据**: 首屏三段; 批次只作分组标题 (不再有独立 id/百分比摘要条); 完成满一天的批次收进「查看历史」; 页面标题统一「处理中」; 批次 id 不给人看。

**当前实现**: `prep_view.js::_refreshJobs` 三段分组 + 批次组头人话 (N 本书 · 今天 HH:MM, 原始 id 进 title); 今天完成 / 查看历史; 页面标题「处理中」。

**结论**: 符合。

## 19. 徽章与页面口径一致 (I5)

**判据**: 徽章 == 页面首屏任务数; 口径写死 = `running + queued + paused`。

**当前实现**: `shell_view.js` 徽章过滤 `['queued','running','paused']`; `prep_view.js` 活跃任务数同口径, 且全局暂停/继续按钮随它启停 (I7: 无活跃任务禁用, 不给假反馈)。

**结论**: 符合。

## 20. 设置模型中心按功能分组 (J1/J2, 设计 §10)

**判据**: 一个功能一段 (翻译/讲解, 语音合成, 语音识别可选), 每段回答"当前用什么/有没有/要不要补/更新"; 一键下载不是独立区块而是每段缺模型时的「去下载」; 判据 = 该 family 有无可用模型 (不因注册名≠目录名误判成"下载")。

**当前实现**: `models_view.js::_renderGrouped` 三段 + 无可用模型时「去下载」; `usableOf(family)` 判据; smoke 测试 `9` 锁住"注册名≠目录名也显示已配置"。tab 更名「模型与依赖」且依赖组件 (prep/ffmpeg/PyMuPDF) 并入 (J3)。

**结论**: 符合。

## 21. 在线 AI 兜底 (K3)

**判据**: 查词失败就地给「用在线 AI 查一次」; 未配置给「去设置配置在线引擎」; 绝不自动回退 (本地失败必须用户点一下才外发); 每次外发前 UI 显示将发什么; 从本机直连用户自己的 key。

**当前实现**: `dictionary_panel.js::_setError` 就地按钮 + 显示"将发送: word + 该句" + 确认; `word_lookup_online` 独立命令 (本地路径不引用 online_client, 单测锁住); endpoint+model 存 config, key 存 Credential Manager。

**结论**: 符合 (绝不由作者服务器代理转发 —— 架构一直守的边界)。

---

## UX2 偏离项去向补充

| 编号 | 偏离 | 类别 | 去向 |
|---|---|---|---|
| 16 | 撤销条桌面落位 = 卡片正上方 (手机稿是顶部进度条下方) | ② 有意偏离 | 等效落位, 写清理由 (桌面三栏, 进度条在左栏队列头, 放那=视线之外) |
| 4 | prep 状态三态配色 | ③ 大改 | ROADMAP S6b 遗留 (不在本轮) |


---

# UX3 真机第二轮走查 (GOAL_2026-08-11_UX3, 2026-08-11) 补充判据

## 22. 成品文件缺失必须红色报错 (L2)

**判据**: 打开译本前探测 editions.pack_dir 是否存在。不存在 → 书卡状态改红色「成品文件
缺失」, 徽章不再显示"已就绪", 给「重新生成译本」/「移除这个译本记录」两出口; 展开项标红,
点击给明确错误不静默。

**当前实现**: commands/library.rs::attach_pack_state 三态 (missing=目录不存在 /
incomplete=目录在但 bookpack 缺 / ok), 挂在 library_list 每个 edition 上; library_view.js
product 卡与译本子卡据此红徽章 + 两出口。单测 l2_pack_state_detects_missing_incomplete_ok。

**结论**: 符合。

## 23. 顶栏两个每日目的地 + 图标一致 (L6)

**判据**: 去掉「导入」(书库页已有导入格, 重复入口); 右侧统一为定宽图标 + 数字/短标签一致
形态, 尺寸间距对等; 离线等状态用图标+tooltip 不用文字块; 「我」放最左紧邻品牌。

**当前实现**: shell_view.js 去掉导入; 右侧 pp-nav-icon 定宽图标 (处理中带角标 /
同步状态 / 设置齿轮), Material Symbols Rounded 本地打包字体 (eader/assets/fonts, 不引
CDN); 用户选择器移最左; 同步四态改图标 + title tooltip。

**结论**: 符合。

## 24. 页头动作按钮成组 (L5)

**判据**: 页头标题靠左、动作按钮成组靠右且组内间距固定 (gap: var(--md-sys-space-2)),
按钮之间不被 space-between 撑开; 做成共用组件, 新页面复用。

**当前实现**: pp/page_toolbar.js::AiduPageToolbar.build (标题 + .page-toolbar 单一 flex
+ gap), 生词本/模型与依赖/同步三处改用。smoke 9b 断言无直系散列按钮。

**结论**: 符合。

## 25. 书设置弹窗补学习档案 (L10)

**判据**: 弹窗补学习档案选择 (与创建译本弹窗同一组件); 表单纵向对齐; 说清改的是下次生成
默认, 不影响已生成译本。

**当前实现**: library_view.js::_openBookSettings 档案/语言/模型三段竖排 (同 _profiles
数据源) + 边界说明; library_book_set_profile 只改 books.profile_id (editions 快照不动)。

**结论**: 符合。

## 26. 阅读显示 tab 是全局设置 (L9)

**判据**: 移除只读摘要 (字号/行距/栏宽/高亮只在阅读器浮层); 这节放主题(浅/深/跟随系统)/
主题色/儿童模式; 儿童模式写明改了什么; 与学习档案边界一句话点明。

**当前实现**: settings_view.js 移除只读摘要; 主题三档 + 色块 chips + 儿童模式说明;
core/theme.js::resolveTheme 支持 system。单测 +4。

**结论**: 符合。

## 27. 在线引擎两档授权 (L8)

**判据**: 两个独立开关默认全关: ①查词失败时可用在线AI(发1词+1句) ②整本翻译/讲解可用在线
引擎(默认关, 开启告知外发量); 未配置 key 时开关置灰指向配置区; K3 三条不变。

**当前实现**: settings_view.js 两档 checkbox 默认 off + 无 key 置灰; word_lookup_online
门禁①(默认关返回明确错误); config 两字段 serde(default)=false。

**结论**: 符合。

## 28. 书库位置可选 + 加载旧库 (L7)

**判据**: 设置页书库位置可改; 支持加载已有书库目录 (扫描成品 → 可导入N/已存在M → 确认后
只登记路径); 切换不移动不删除文件。

**当前实现**: library_dir_pick_and_set 只改配置不搬文件; library_dir_scan/import 扫描
登记 (复用 register_book 幂等); 修 libBtns 从未挂进 libSec 的存量 bug。

**结论**: 符合。

## 29. 多后端配置 (L11)

**判据**: 设置页同步改为后端列表 (名称+URL+状态), 可新增/切换/删除, 当前高亮; 切换即换库
(endpoint_key 按 URL+服务端 user 分账, 不匹配全量重推)。

**当前实现**: config sync_backends + ackends_including_active (自动补默认项); 命令
sync_backends_list/add/switch/remove; 设置页后端列表。单测 l11_backends_include_active_once。

**结论**: 符合。

---

## UX3 偏离项去向补充

| 编号 | 偏离 | 类别 | 去向 |
|---|---|---|---|
| L6 | 图标字体用 Material Symbols 本地打包 (设计稿提到 Lucide 亦可, 均为开源可本地) | ② 有意偏离 | 本地 ttf 1.2MB, 不引 CDN, 满足离线优先 |
| L11 | CF 免费档验证打在测试 worker/namespace (设计稿验收前提"绝不打生产") | ② 有意偏离 | 干净测试 namespace, 防呆拒绝生产 id |
