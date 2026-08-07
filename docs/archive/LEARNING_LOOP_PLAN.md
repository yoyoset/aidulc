# aidulc 用户学习闭环优化计划（I 系列）

## 0. 状态：全部完成（I-A ~ I-D + 遗留缺口补齐）

**最终门禁：Rust 84 / Python 122 / 前端 23 文件全绿; CDP 端到端实测通过**
（查词 LLM 补全→显式加入生词本→生词列表/统计→同步状态机→书签/搜索命令→失败摘要）。

遗留缺口补齐（第二轮）：
- I-A 真实 LLM 词义补全：`dict_lookup.py`（复用 LlmServer 单例, prompt 简短, 容忍 ```json 包裹）
  + `commands/reader.rs::llm_dict_lookup`（spawn 侧车, 8s 超时, 无模型/失败 → 占位兜底不阻断）。
- I-C 失败可读：`jobs.error` 列（迁移 v6）+ Runner 结束落盘 `quality_report.json`
  + `quality_summary()` 生成摘要（句数+阶段+原因前 3 条）+ 备料台失败详情区。

完成记录（第一轮）：
- I-A：dict_repo 扩展(list/search/remove) + application/dictionary_service(本地优先→LLM 补全→沉淀, 永不自动进生词本) + 5 命令 + 前端词典面板(滑出/词性/音标/释义/例句/发音/加入生词本按钮) + reader_view 点词接入。测试: dict_repo 3 + dictionary_service 5。
- I-B：vocab_repo 扩展(search/remove/stats) + 4 命令 + vocab_view(列表/搜索/阶段筛选/删除/导出 JSON/profile 隔离) + 导航入口。
- I-C：application/sync_service(状态机 unconfigured/offline/synced/failed + 上次结果) + sync 命令 4 个(状态/立即同步/拉取/配置) + AppServices 改 Mutex(配置即时生效) + 设置页同步区(token 存 Credential Manager 不落明文)。测试: sync_service 3。
- I-D：bookmarks_list 命令 + 书签面板(抽屉/跳转播放/删除) + 书库工具条(书名搜索/状态筛选)。
- 新增文件: services/dictionary_service.js, sync_service.js, views/vocab_view.js, components/dictionary_panel.js, application/dictionary_service.rs, sync_service.rs, commands/reader.rs。

---

## 1. 需求清单（按用户价值排序）

> 全部完成。以下为设计意图存档。

### I1 词典面板（学习闭环入口）
- 点击任意词 → 右侧滑出词典面板
- 展示：词 / 词性 / 音标 / 释义列表 / 例句 / 当前句上下文 / 发音按钮
- 本地词典命中 → 直接显示；未命中 → 调 LLM 补全（异步，防抖）
- 面板上有明确的"加入生词本"按钮（AI 补全不自动进生词本）

### I2 生词本页面
- 独立视图：列表 + 按时间/书本/字母筛选 + 搜索
- 每项：词 / 释义 / 状态（new）/ 加入时间 / 来源书
- 操作：删除 / 加入复习（预留）/ 导出 JSON
- 数据来自 vocab_repo（profile 隔离，default/kid 各自独立）

### I3 失败可读反馈
- 任务失败 → 结构化展示：失败阶段 / 失败句数 / 原因摘要 / 查看详情（run.log）
- 阅读器失败句：明确标记 + 单句重试入口
- 同步失败：状态徽标 + 重试按钮，不阻塞本地

### I4 同步配置与状态 UI
- 设置页"同步"区：Worker URL + token（Credential Manager，写入不显示明文）
- 同步状态：未配置 / 离线 / 已同步 / 失败(带原因)
- 手动"立即同步"按钮

### I5 书签面板
- 独立抽屉：本书所有书签列表（章节 + 句文本片段）
- 点击跳转对应句；删除书签
- 数据来自 reading_state（已有 bookmarks 字段）

### I6 书库搜索/筛选
- 书库顶部搜索框（书名/作者）
- 筛选：全部 / 进行中 / 已完成 / 有失败句
- 最近阅读排序（已有 last_opened_at）

## 2. 架构设计（专业分层）

### 2.1 新增/扩展模块

**Rust 侧**（遵循 commands → application → domain + ports → infrastructure）

```
commands/
  reader.rs           新建: word_lookup / add_vocab / bookmark_list / bookmark_toggle
  sync.rs             改造: sync_push/pull 返回结构化状态; 新增 sync_config_get/set
  library.rs          扩展: book_search / book_filter
application/
  dictionary_service.rs  新建: 查词(本地优先→LLM补全) / 词典沉淀 / 生词加入
  sync_service.rs        新建: 同步编排 + 状态机 (unconfigured/offline/synced/failed)
store/
  dict_repo.rs          扩展: list_by_profile / remove / search
  vocab_repo.rs         扩展: search / remove / stats
  reading_repo.rs       扩展: get_bookmarks(已有) / toggle_bookmark
```

**前端侧**（services 层扩展，视图不直接 invoke）

```
services/
  dictionary_service.js  新建: lookup(word, profile) / addToVocab(word, profile) / searchVocab
  sync_service.js        新建: getStatus / configure(url, token) / push / pull
  reading_service.js     新建: getBookmarks / toggleBookmark(已有底层)
services/library_service.js  扩展: searchBooks(q, filter)
views/
  dictionary_panel.js    新建(右侧滑出)
  vocab_view.js          新建(生词本页面)
  bookmarks_panel.js     新建
  sync_settings.js       新建(设置页内嵌)
core/
  search_index.js        复用(书库搜索可复用/或简单 filter)
```

### 2.2 契约定义（先定,后实现）

**词查询响应**（统一 DTO，三端共用）

```json
{
  "word": "break",
  "pos": "VERB",
  "phonetic": "/breɪk/",
  "meanings": ["打破; 弄碎; 违背"],
  "examples": ["He broke the news to her."],
  "source": "local | llm",        // 本地命中 or AI 补全
  "confidence": 0.9,
  "inVocab": false                // 是否已在生词本(前端可据此显示按钮状态)
}
```

**同步状态响应**

```json
{
  "status": "unconfigured | offline | synced | failed",
  "lastSyncAt": 1700000000000,
  "lastError": null | "网络错误: ...",
  "pendingCount": 0
}
```

### 2.3 数据流（查词闭环）

```
点击词 → bridge → dictionary_service.lookup(word, profile)
  → Rust dictionary_service: dict_repo.get(word)
  → 命中? → 返回 DTO(source=local)
  → 未命中 → 调 Python LLM 补全(带防抖/去重) → dict_repo.upsert(沉淀) → 返回 DTO(source=llm)
  → 前端面板渲染 + "加入生词本"按钮
  → 用户点击加入 → vocab_add(entry, profile) → vocab_repo.upsert_content
  → 面板状态变 inVocab=true
```

### 2.4 LLM 补全的防重复机制

- 前端：面板打开时防抖 300ms；同词 10 分钟内不重复请求（内存缓存）
- 后端：dict_repo 命中即不调 LLM
- 补全结果必含 `source: "llm"` 标记，永不自动进生词本（沿用 aidu 纪律）

## 3. 分阶段执行

### I-A：词典闭环（I1 + I2 的词汇部分）
1. Rust：dict_repo 扩展（list_by_profile / search / remove）
2. Rust：application/dictionary_service.rs（lookup 本地优先 + LLM 补全）
3. Rust：commands/reader.rs（word_lookup / add_vocab）
4. 前端：dictionary_service.js + dictionary_panel.js（滑出面板）
5. 前端：reader_view 点击词 → 面板（替换现状态栏文本）
6. 测试：dict_repo 扩展、lookup 逻辑（fake LLM）、DTO 序列化

**DoD**：点击词弹出完整面板；未收录词 LLM 补全后沉淀；"加入生词本"不自动触发。

### I-B：生词本页面（I2）
1. Rust：vocab_repo 扩展（search / remove / stats）
2. 前端：vocab_view.js（列表 + 筛选 + 搜索 + 删除 + 导出）
3. 导航加入口
4. 测试：vocab 搜索/删除/统计

**DoD**：能看全部生词、按书筛选、搜索、删除、导出 JSON；default/kid 隔离。

### I-C：失败可读 + 同步可见（I3 + I4）
1. Rust：application/sync_service.rs（状态机 + 结构化错误）
2. Rust：commands/sync.rs 改造（返回 status DTO; sync_config_get/set）
3. Rust：job 错误结构化（failed stage/count/reason 进 jobs 表）
4. 前端：sync_settings.js + 同步状态徽标；备料台失败详情区
5. 测试：sync 状态机（fake http）、配置读写（Credential Manager mock）

**DoD**：失败任务显示阶段+句数+原因；同步状态可见可重试；token 不落明文。

### I-D：书签面板 + 书库搜索（I5 + I6）
1. Rust：reading_repo 扩展（bookmarks 列表已有）+ commands
2. 前端：bookmarks_panel.js（跳转/删除）
3. 前端：library_view 搜索框 + 筛选
4. 测试：书签 toggle/list；书库搜索（纯前端 filter + Rust 搜索）

**DoD**：书签面板可跳转；书库可按书名搜、按状态筛。

## 4. 专业度保障措施

### 4.1 分层纪律（强制）
- `commands` 只做参数转换，不写 SQL/HTTP（已有约定，扩展时守住）
- `application` 用例层持有业务规则（防重复、状态机、本地优先）
- `domain` 纯数据（DTO 定义、校验）
- 前端 `services` 是唯一 invoke 出口；`views` 不直接调 bridge

### 4.2 契约先行
- 每个 DTO 先在 `contracts/` 定义 schema + Rust struct + 前端 JSDoc 注释
- 新增跨端字段先改契约，三端 conformance 测试同步变红

### 4.3 可测试性
- dict/vocab/reading repo 扩展全部单测（temp_db）
- dictionary_service 的 lookup 逻辑用 fake LLM（Protocol）
- sync 状态机用 fake HTTP client
- 前端纯逻辑（面板状态、筛选）抽 core 纯函数 + node 测试

### 4.4 失败可读（贯穿）
- 所有新命令返回结构化错误：`{ code, human, detail }`
- 前端统一错误渲染（error_banner / 面板内联）
- 不出现"后台失败但用户以为成功"

### 4.5 回归保障
- 每阶段跑 `cargo test` + `pytest` + `node --check` 全量
- 每阶段做一次 CDP 端到端验证（点击词→面板→加词→生词本可见）

## 5. 不做什么（范围控制）

- 不做 SRS 复习算法（留扩展/移动端）
- 不做录音回放对比
- 不做词义编辑 UI（本地词典优先 + LLM 补全足够）
- 不做多语言 UI 切换（界面保持中文）
- 不重构已有 reader_view 的播放/跟读（只替换查词入口）

## 6. 验收底线

1. 用户点击任意英文词 → 完整词典面板（释义/音标/例句/发音）→ 一键加入生词本
2. 生词本可看/搜/筛/删/导出，default 与 kid 隔离
3. 任务失败时用户能看到"哪阶段失败/哪几句/为什么"，有重试入口
4. 同步状态始终可见（未配置/离线/失败），token 永不落明文
5. 书签面板可跳转；书库可搜索筛选
6. 每阶段门禁全绿 + CDP 端到端实测
