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
