# 阶段 0 取证报告 — 导入重复(F45) + 阅读卡死(F46)

> 2026-08-09 会话, 真实 exe + 真实 DB + 真实用户书籍(Number the Stars, 187KB EPUB)取证。
> 纪律: 先实测, 再下结论; 证据不足处明确标注"未复现/待复现", 不猜根因。

---

## 1. 取证环境与流程

1. 确认无 aidulc.exe 在跑(旧 exe 已关闭)。
2. `cargo build --release`(成功, 嵌入当前工作树前端)。
3. 启动真实 release exe(`src-tauri\target\release\aidulc.exe`)。
4. exe 冷启动成功; **启动时经 `pump_queue` 自动恢复了用户遗留的真实 job**:
   - 观察前后 job 从 `translate 504/2708` 推进到 `explain 617/2708`(进度 31%→46%),
     证明真实 exe + 真实侧车 + 真实 LLM 在跑, 不是空壳。
5. 取证后关闭 exe(释放 DB/文件锁, 以便后续构建与测试)。

## 2. 真实 DB 状态(数据快照)

- **books**: 1 行 —— Number the Stars, `kind=original`, `status=processing`。
- **editions**: 0 行(v18 迁移已建表, 但迁移把 legacy product 迁出后无新版 edition)。
- **batches**: 4 行(3 个历史 completed + 1 个当前 running)。
- **jobs**: 1 行(running, 当前书)。
- **reading_state / highlights / reading_daily**: 0 行。
- **schema_migrations**: v1-v18 全绿。

结论: **当前 DB 无重复 source**(books 表该路径仅 1 行)。用户"疑似被导入两次"的症状
在当前数据里**没有对应证据**, 需在 exe 里对同一导入动作做注入/重复触发取证(见 §3)。

## 3. 取证 A: 导入重复(F45)

### 3.1 前端导入触发路径(library_view.js, 工作树)

```
render() ── 每次路由进入书库
  ├─ _buildImportCard()  (line 70)
  │    └─ 注册 tauri://drag-drop listener (line 538) → 存 this._offDrag
  ├─ line 90-92: store.on('change') 存 this._off, 前一个 _off() 注销
  └─ line 93-94: if (this._offDrag) { this._offDrag(); this._offDrag = null; }
  └─ 文件选择: dropZone.onclick → fileInput.click()(原生对话框)
       fileInput.onchange → AiduBridge.pickFiles(rfd 对话框) → _startBatchImport
```

**已确认的代码缺陷(F34 fix 顺序颠倒)**: `_buildImportCard()` 在 line 70 **先**注册了新
drag-drop listener 并把 unlisten 存进 `this._offDrag`, 然后 line 94 立刻调用
`this._offDrag()` —— **注销的是刚注册的 listener 本身**, 不是上一轮的旧 listener。
净效果: 每次 render 后 drag-drop listener 都被立即杀死, **拖拽导入在当前代码里根本不工作**
(与 F34 原本想解决的"累积"相反 —— 现在的 bug 是"每次都被杀掉", 不是"累积")。
这个顺序问题在提交 786ca83 里就存在, 属于 F34 fix 落地时的实现缺陷, 不是本次新引入。

**为何用户仍看到"导入两次"?** 拖拽路径既然已死, 重复导入只可能来自:
- 文件选择路径触发两次(原生 dialog + rfd dialog 各一次 → 用户可能在同一动作里选了两次);
- 或用户实测用的 exe 早于 F34 fix(旧版 listener 累积 → 一次拖拽触发 N 次 `_startBatchImport`);
- 或 store 刷新把 import 重放(见 §3.3)。

**取证限定**: 无法用脚本驱动 GUI 点按/拖拽, 上述为代码路径 + 工作树与提交历史核对结论。
"单次动作实际 invoke 几次 batch_import"需在 exe 内注入 drag-drop 事件或连续点按复现,
列入阶段 2 验收步骤(阶段 2 会加对应的自动化测试)。

### 3.2 后端 batch_import 幂等性(job_orchestrator.rs:103-172)

- 每次调用**无条件新建一个 batch**(`batch-{uuid}`)。
- 每本书用 `book_id_from_path(path, profile)` 做 key, `books_repo.get().is_none()` 才登记。
- 因此**同一路径 + 同一 profile 重复导入 → source 仍只有 1 行, 但 batch 会多一条**。
  这与当前 DB 的 4 个 batch(3 历史 completed + 1 当前)吻合 —— 历史上确实多次导入过书,
  但 source 层面始终去重。
- 不同 profile 导入同一路径 → `book_id` 不同 → 会生成第二条 source(资产模型如此设计)。

### 3.3 store 刷新是否重放导入

- `_startBatchImport` 成功后: `store.emit('change')` + `AiduLibraryService.list()` → `store.set({books})`。
- store 'change' handler 只调 `_renderBooks`(重渲染列表), **不会重放 import**。
- `library-changed` 事件由 prep_view 监听 → 只 `_refreshLibrary`(重拉列表), 不重放导入。

## 4. 取证 B: 阅读卡死(F46)

### 4.1 卡死的已知修复(916534b)与当前代码对照

`load_bookpack` 已改为"只回元信息(每句 original_text) + `load_bookpack_chapter` 按需单章",
前端 renderer 已是渐进渲染(首屏 50 句 + 300/批)。**92MB 整包 IPC 卡死的主因已消除**。

### 4.2 仍然存在的真实结构问题(本次实测)

**`load_bookpack` / `load_bookpack_chapter` 每次请求都整文件读 + 全量 JSON 解析**:

- `load_bookpack`(library.rs:235-242): `std::fs::read_to_string` 读**整个** bookpack.json,
  `serde_json::from_str` 全量解析, 再 strip 成元信息。对已交付的 Wolf 21(23.88MB,
  8007 句, 46 章)实测: 读 211ms + 解析 258ms(单次 open 的 Rust 侧成本)。
- `load_bookpack_chapter`(library.rs:293-296): 每请求一章,**都重新读 + 重新解析整个**
  bookpack.json, 再取一章返回。对 Wolf 21 实测: **每切一章 ≈ 419ms 整文件读+解析**
  (46 章逐个切 = 46 次 24MB 全量解析)。
- meta 响应仍含全部句子的 original_text(Wolf 21 = 1.3MB JSON), 前端 open 时
  `search.build` 同步遍历所有章节句子。

**与用户 ~100KB EPUB 的对应**: 该规模书 bookpack ≈ 1.5MB(合成实测 parse 26ms),
单次读+解析不是卡死级别。因此**不能把"~100KB EPUB 卡死"归因于文件大小** —— 更可能是:
1. 用户打开的是**历史已完成的大书**(如 Wolf 21 24MB, 每切一章 419ms 全量解析, 首屏
   open 也是全量读+解析 → 在多章切换/搜索跨章跳转时明显卡顿甚至像死掉);
2. 或打开时侧车 job 仍在写 checkpoint 导致文件锁/IO 竞争;
3. 或旧版 exe(916534b 之前)。

**取证限定**: 当前用户的这本书还在 processing(无 bookpack.json), 无法在 exe 里直接打开
它复现卡死。用 .spikes 里真实的 Wolf 21 bookpack(上一轮交付物)做负载测量作为量级证据。
"在 exe 里打开用户这本书复现卡死"需等该书处理完成, 列入阶段 3 验收。

### 4.3 前端搜索/渲染路径检查

- `reader_view.open()` → `search.build(this.bookpack.chapters)`(meta 只有 original_text,
  全遍历可控); `_loadChapter` → `chapterLoader.load` → `load_bookpack_chapter`(单章)。
- `reader_renderer` 渐进渲染(50 + 300/批), `ensureRendered` 是唯一补渲染入口。
- 音频 `read_audio_range` 2MB/块。以上均无"整章一次性建 DOM"或"同步整包 parse"。

## 5. 结论与下一步

| 项 | 结论 | 证据强度 |
|---|---|---|
| F45 重复导入 | 当前代码拖拽 listener 被 F34 fix 顺序 bug 杀掉(拖拽失效, 不重复); 重复来源需 exe 注入复现; 后端 source 幂等, batch 不幂等 | 代码 + DB 快照; 待 exe 注入复现 |
| F46 阅读卡死 | 整包 IPC 已修; 剩余真实问题 = load_bookpack/_chapter 每次全文件读+全量解析(大书 419ms/章); ~100KB EPUB 不构成大小卡死 | 代码 + Wolf 21 真实负载实测; 待用户书完成后 exe 复现 |

阶段 2 修复导入流程(source identity 幂等 / listener 生命周期正确 / 单次动作单次导入 /
刷新不重放)。阶段 3 修复阅读卡死(load_bookpack_chapter 改为只读所需章节或加缓存 / 失败可见 /
loading-error-retry 态)。

## 6. 更新说明

本文档同步更新 `docs/ROADMAP.md` 的 F45/F46 条目(用本报告证据替换原"待取证"描述)。
