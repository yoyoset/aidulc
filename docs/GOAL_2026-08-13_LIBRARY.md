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

### K2-2 封面抽取管线 ✅ 已完成
实测比预想的简单——全仓已有 `read_image` 命令(R4 2026-08-08 为原书插图建的,
读字节转 base64, 路径 canonicalize + 越界校验都现成)和 `pack_dir` 字段(编辑
listing 里本来就带), 不需要新 Tauri 命令/DB 迁移, 纯粹是"多解析一个字段"。

- `prep/aidulc_prep/core/models.py`: `Book.cover: str | None`。
- `prep/aidulc_prep/pipeline/loader/epub.py`: 从 OPF 识别封面, EPUB2
  `<meta name="cover" content="id"/>` 查 manifest, EPUB3
  `properties="cover-image"` 直接读 item href, 都没有留 `None`。
- `prep/aidulc_prep/pipeline/pack.py`: `_copy_cover()` 镜像已有的
  `_copy_chapter_images()` 套路, 把封面字节从源 EPUB 拷进书包根 (`cover.<ext>`),
  `bookpack.json` 顶层加 `"cover"` 字段。
- `contracts/bookpack.schema.json`(**权威源**, 不是 `prep/aidulc_prep/schemas/`
  那份拷贝——本期踩过一次坑, 见下)加 `cover` 可选字段, 未升 `schemaVersion`
  (对齐 R4 images 字段的先例: 纯新增可选字段不算破坏性变更)。
- Rust: `library_service.rs::parse_bookpack_cover()` 镜像
  `parse_bookpack_counts()`; `commands/library.rs::library_list` 的
  `product`/`original` 两个分支都往 edition JSON 里塞 `cover_file`(`product`
  分支此前完全没有 bookpack.json 读取, 这次一并补上)。
- 前端: `library_view.js` 新增 `_buildCover()`, 书卡走 `AiduLibraryService.readImage
  (pack_dir, cover_file)`, 拿到 base64 就渲染 `<img>`, 无封面/加载失败时回落到书名
  首字 + 按书名哈希出的色系占位块(复用 `tokens.css` 已有的 5 色 swatch, 不用灰块)。

**本期踩的坑**: 一开始把 `prep/aidulc_prep/schemas/bookpack.schema.json`(**拷贝**)
当成权威源改了, 跑 `sync_schema.ps1`(方向是 `contracts/` → `prep/schemas/`)后被
静默覆盖回旧内容, `-Verify` 通过只是因为两边"一致地都没有这个字段", 不是改动生效
——这正是 CLAUDE.md 里那条契约规约想防的漂移, 这次是自己踩了一遍。改回 `contracts/`
后重新同步验证, 补记在这里。

### K2-3 视图模式切换 ⚠ 部分完成(横滑区已做; 网格/列表切换未做)
- ✅ "最近阅读"横向滑动区: 苹果书架语汇的克制版本(横向滚动+封面为主, 不做 3D
  书架透视那种拟物效果——与"暖纸克制"设计语言冲突, 维护成本也高; 滑动本身是抓
  的点, 透视效果不是)。放在"我的书"(product) 页顶部, 只收 `last_opened_at`
  非空的书, 按时间降序取前 12 本, 空态整个区块隐藏(不留空标题)。实现在
  `views/library/cover.js` 的 `renderShelf()`。
- ⬜ 未做: 现有网格视图与更紧凑的列表视图之间的切换开关(原计划 §K2-3 的一部分)。
  现状是网格视图(带封面)已经是唯一形态; 列表视图/切换控件留到下一次迭代,
  优先级低于 K2-4(信息本身的完整度/对齐, 比"再加一种排列方式"更贴用户原话
  "格式是否对齐/阅读了多少/有没有笔记")。

**本期拆分附带产出**: 加入封面+横滑逻辑后 `library_view.js` 从 1063 行(已登记基线)
涨到 1082 行, 触发文件规模门禁。审计确认封面渲染 (`_buildCover`/`renderShelf`) 和
状态徽章/分段筛选 (`_bookStatus`/`_inStatusBucket`/`_updateSegCounts`/`STAGE_LABEL`)
都是真正独立于"书 CRUD/导入/处理队列"的子域, 拆成 `views/library/cover.js`
(`AiduLibraryCover`) 和 `views/library/status.js`(`AiduLibraryStatus`), 主文件回落到
1030 行, 门禁基线数字不变(1063, 只降不加的约定没被打破)。

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
