# GOAL 2026-08-13: 书库视图成熟化 (K2)

## 起因

用户截图: 窄宽度下书库工具条(搜索框+状态分段)挤出视口错位。顺带提出更大的诉求——
现在的书卡是纯文字信息块,没有封面、没有多种展示样式,想要「苹果书架那种滑动展示」,
以及阅读进度/时长/章节数/是否有笔记这类元信息要对齐、显示完整、样式成熟专业。

## 现状审计 (实测, 不是猜)

- `reader/styles/app.css:539` `.library-toolbar { display:flex; gap:10px }` 无 `flex-wrap`
  —— 窄屏挤出视口。**K2-1 已修**(加 wrap + 分段自身 `overflow-x:auto` 兜底)。
- `reader/styles/library.css` 的 `.book-list` 已经是响应式网格
  (`repeat(auto-fill, minmax(280px,1fr))`), 断点本身没问题。
- `reader/views/library_view.js` 书卡数据现状: 有 `chapterCount`/`sentenceCount`/
  `audioSec`/`reading_chapter`/`time_spent_ms`(阅读时长), **没有**封面图字段、
  **没有**笔记数/书签数聚合到书卡上。
- 全仓(`src-tauri/`、`prep/`、`contracts/`)搜不到任何 `cover` 相关的抽取/存储/传输
  代码 —— 封面是从零建的管线, 不是"接个现成字段"那么简单。

## 分期(每期独立提交, check.ps1 全绿)

### K2-1 响应式治理 ✅ 已完成 (本次会话)
`.library-toolbar` 加 `flex-wrap` + 搜索框弹性下限 + 分段横滚兜底。

### K2-2 封面抽取管线
- `prep/aidulc_prep/pipeline/loader/epub.py`: EPUB manifest 里找 `cover-image` /
  OPF `<meta name="cover">` 引用的图片, 抽取存到书的处理目录下 (如 `cover.jpg`),
  抽不到就留空 (不是所有 EPUB 都带封面, 前端要有兜底展示, 不能假设有图)。
- `contracts/`: book/edition 的 schema 加 `cover_path`(可选字段), 跑
  `scripts/sync_schema.ps1` 同步 + `-Verify`。
- Rust: `books_repo.rs`/`editions_repo.rs` 落这个字段; 需要一个 IPC 命令把封面文件
  转成前端能显示的 URL/base64 (Tauri 本地文件在 webview 里不能直接 `<img src="C:\...">`,
  要走 `convertFileSrc` 或专门命令读字节转 data URI ——这一步先查 Tauri 现有约定怎么处理
  本地图片, 全仓搜一遍别重新发明)。
- 前端: 书卡加封面缩略图, 无封面时用"书名首字 + 按书名 hash 出的主题色系"占位块
  (不用灰色空块——那不是"成熟专业", 至少要看着像有意设计的占位)。

### K2-3 视图模式切换
- 现有列表视图保留(信息密度最高, 处理中的书需要看进度条/阶段文案, 不能丢)。
- 新增网格封面视图(书卡以封面为主, 元信息浮层/底部条)。
- 新增"最近阅读"横向滑动区(苹果书架语汇的克制版本——横向滚动 + 封面为主, 不做
  3D 书架透视那种拟物效果, 与本项目"暖纸克制"的设计语言冲突; 滑动本身是抓的点,
  透视效果不是)。放在书库页顶部, 只收「最近打开过」的书 (`last_opened_at` 已有)。
- 视图切换状态持久化到 `reader_settings`(不用每次进书库重选)。

### K2-4 卡片信息补全
- 阅读时长: `time_spent_ms` 已有, 现在只在有 `reading_chapter` 时才显示——需要独立于
  进度展示(哪怕没翻页也可能听了很久)。
- 笔记数/书签数: `highlights`/`reading_state.bookmarks` 现在没有聚合到书卡层级的查询,
  需要一个按 book_key 聚合计数的只读查询(遵守"跨表只读查询允许"的约定, 不新开写路径)。
- 信息对齐: 章节数/句数/时长/进度/笔记数按统一的图标+数值网格布局, 不是现在这种
  拼字符串堆一行(`metaBits.join(' · ')`) 的方式——数字对不齐, 弱视觉层级。

## 不做什么(明确排除)

- 不做真 3D 书架透视/物理翻页动画——这类拟物效果和本项目"暖纸克制"的设计基调冲突,
  维护成本也高(需要额外的手写 SVG/Canvas, 不是几行 CSS 能稳定实现)。取"横向滑动"
  这个交互内核,不取视觉拟物皮。
- 不做封面在线搜索/抓取(如接 Google Books API 找封面)——离线优先是项目定位
  (`memory/aidulc-monetization-model.md`), 没有封面就用设计过的占位块, 不引入网络依赖。

## 验收

每期结束跑 `.\scripts\check.ps1` 全绿 + 视觉走查(至少截图确认窄屏/宽屏/无封面/有封面
四种状态不错位)。
