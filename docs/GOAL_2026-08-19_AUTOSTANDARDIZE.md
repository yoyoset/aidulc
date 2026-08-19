# GOAL 2026-08-19 —— 导入自动标准化转换

用户拍板(原话): "导入时候做标准化判定, 不符合的按照设置进行标准化转换。不可以设置。
可以观察进度和结果。直接在卡片上展示即可。"

翻译成工程语言: 导入时的 S1-S6 体检不再是"block 就拒绝导入", 而是"block 就导入 +
后台自动尝试用另一种手段重新解析, 过程和结果显示在书的卡片上"。不做成用户可调的
设置项(没有策略选择、没有开关)——系统自己决定怎么转换。

核心算法层已经做完并测过 (commit `9f059ab`): `prep/aidulc_prep/pipeline/loader/
epub_fallback.py::load_epub_fallback` 用 pymupdf 把 EPUB 当分页文档打开, 拿它自带的
TOC(标题+页码)划章节边界, 从页面纯文本里抠句子——和原生的 spine/XHTML 解析
(`loader/epub.py`)是两条完全独立的路。已用真实撞过 block 的书(Ferris)验证过:
`evaluate_book_fallback` 判定 33 章 2793 句 verdict=ok。

这份文档定的是**把这条算法接进真实导入/备料流程**需要的四块拼图, 分给不同人做,
编排方(当前会话)整合 + 测试 + 提交。

## 不做的事(明确列出, 避免范围膨胀)

- **不做用户可调设置** —— 用户原话"不可以设置", 没有策略下拉/开关, 这条不用问。
- **不做转换失败后的二次重试策略** —— 兜底解析只跑一次, 失败(仍然 block)就是
  standardize_status='failed', 不设"重试第 N 次"这类东西, 用户手动删了重新导入即可。
- **不扩展到 PDF/MOBI/AZW3** —— 那些格式已经走 pymupdf(`doc.py`)做主解析, 不存在
  "原生解析 vs 兜底解析"这个二选一, 本次只解决 EPUB。
- **不改动 S1-S6 判据本身**(`core/standard.py`)——判据不变, 变的是"判 block 之后
  多给一次机会", 判定逻辑复用现有的 `_judge_book`。

## 数据模型: books 表加三个字段 (迁移 v32)

- `standardize_status TEXT NOT NULL DEFAULT 'none'` —— `none | pending | running | done | failed`
  - `none`: 导入时体检就是 ok/warn, 不需要转换(绝大多数书)
  - `pending`: 导入时体检是 block, 排队等后台任务处理
  - `running`: 后台任务正在处理这一本(同一时刻只处理一本, 串行)
  - `done`: 兜底解析后达标(ok/warn), 这本书现在可以正常走"创建译本"
  - `failed`: 兜底解析后仍然 block, 这本书目前没法处理, 卡片上说明原因
- `standardize_note TEXT` —— 人话结果, 例如 `"33 章 2793 句, 已可正常处理"` 或
  `"仍然不达标: 解析结果过少(1 章/15 句)"`。done/failed 都要填, pending/running/none 为 NULL。
- `standardize_cache_path TEXT` —— done 时非空, 兜底解析产出的章节/句子 JSON 绝对路径
  (备料 parse 阶段直接读它, 不重新解析一遍)。none/pending/running/failed 为 NULL。

参照 `store_mod.rs` 里 v30/v31 的写法(幂等判断列是否已存在、`schema_migrations`
记账、`WHERE version >= N` 撤版本重跑的测试写法——v31 那次踩过逐个列版本号的坑,
新测试直接抄 v31 test 的模式)。

## 拼图 1(Rust, 派给 progate): 数据模型 + 导入接线 + 后台队列

**文件**: `src-tauri/src/store/store_mod.rs`(migration v32)、
`src-tauri/src/store/books_repo.rs`(Book 结构体加三个字段)、
`src-tauri/src/application/job_orchestrator.rs`(`register_import_batch` 签名变化)、
`src-tauri/src/application/standardize_task.rs`(新文件, 后台队列)、
`src-tauri/src/jobs/spawn.rs`(`build_job_request` 注入 cache path)、
`src-tauri/src/commands/library.rs`(`library_list` 输出带上三个新字段)、
`src-tauri/src/commands/jobs.rs`(`batch_import` 命令签名)、`ipc/registry.rs`、`main.rs`。

### 1a. `register_import_batch` 接受"需要转换"的路径清单

现状(`job_orchestrator.rs:112` 起): 签名是
`(db, book_paths: Vec<String>, profile, source_language, target_language)`。
前端在调它之前已经跑过 `book_audit_sources` 拿到每本书的 verdict——不要在 Rust 侧
重新审计一遍(重复计算), 加一个新参数把前端已经算好的结果传进来:

```rust
pub fn register_import_batch(
    db: &store::Db,
    book_paths: Vec<String>,
    needs_standardize: Vec<String>,  // 新增: verdict=block 的路径子集(前端算好的)
    profile: serde_json::Value,
    source_language: Option<String>,
    target_language: Option<String>,
) -> Result<ImportOutcome, String>
```

组装 `Book` 结构体时: `standardize_status: if needs_standardize.contains(path) { "pending" } else { "none" }.into()`,
`standardize_note: None`, `standardize_cache_path: None`。

`batch_import`(同文件 112 行上面一层, Tauri command 包装)、`commands/jobs.rs::batch_import`
同步加这个参数并透传。**登记完之后, 如果有新的 pending 行, 调
`standardize_task::pump_standardize_queue(app, cfg, state, db)` 踢一下队列**(不阻塞
`batch_import` 自身返回, 参照 `pump_queue` 现有调用方式——fire and forget)。

### 1b. `standardize_task.rs`(新文件)—— 单例串行队列, 镜像 `pump_queue` 的写法

```rust
pub struct StandardizeState {
    pub running: std::sync::Mutex<bool>,
}
```

在 `main.rs` 里 `.manage(StandardizeState::default())` 注册(参照 `VocabAudioState`
的注册方式)。

`pump_standardize_queue(app, cfg, state: &StandardizeState, db)`:
1. `running` 已经是 true → 直接返回(同一时刻只处理一本, 不是"每本书一个线程"——
   兜底解析要开 pymupdf 进程, 别让导入 10 本 block 书就并发起 10 个)。
2. 从 `books` 表查一条 `standardize_status='pending'` 的行(按 `created_at` 升序取最早
   一条, SQL 层面 `ORDER BY created_at LIMIT 1`, 新增 `books_repo.rs` 方法
   `next_pending_standardize() -> Option<Book>`)。没有就返回。
3. 置 `running=true`, 把这本书的 `standardize_status` 改成 `'running'`, upsert 写库,
   `app.emit("library-changed", {})`(卡片立刻显示"转换中")。
4. 在后台线程(`std::thread::spawn`, 参照 `vocab_audio_task.rs` 起线程的写法, 不要
   `tauri::async_runtime::spawn_blocking`——这个任务本身不占 GPU/模型, 用普通线程即可)
   里:
   - `cache_dir = <data_dir>/standardize_cache/`(目录不存在就建, `std::fs::create_dir_all`)
   - `report_path = cache_dir.join(format!("{book_id}.json"))`
   - spawn 侧车 sidecar 子进程: `<prep_exe> --standardize-book <source_path> --out <report_path>`
     (用项目里 spawn 子进程已有的写法, 参照 `application/book_audit.rs::book_audit_sources`
     里 spawn 侧车 `--audit-book` 那段的 `std::process::Command` 用法, **同步等待退出**
     即可, 这条线程本身已经是后台线程了不需要再嵌套异步)。
   - 子进程退出后读 `report_path`(JSON, 见拼图 3 的输出格式约定), 取
     `verdict`/`issues`/`chapters`/`sentences` 字段:
     - `verdict` 是 `ok`/`warn` → `standardize_status='done'`,
       `standardize_note = format!("{}章{}句, 已可正常处理", chapters, sentences)`,
       `standardize_cache_path = Some(report_path 里 "book" 字段所在的同一个文件路径)`
       (拼图 3 定的输出格式里 `book` 就在同一个 json 文件里, 不是单独文件——
       `standardize_cache_path` 直接存 `report_path` 本身)。
     - 否则 → `standardize_status='failed'`,
       `standardize_note = 取 issues[0].message, 没有就写"兜底解析仍不达标"`。
     - 子进程本身跑失败(非 0 退出/报告文件读不出来)→ 同样按 `failed` 处理,
       note 写 `"转换尝试失败: <错误摘要>"`(不要让这种情况卡在 running 状态出不来——
       这是最容易被漏掉的分支, 务必测)。
   - upsert 写库, `app.emit("library-changed", {})`。
   - `running=false`, **递归/循环调用一次 `pump_standardize_queue`**, 处理下一条 pending
     (参照 `pump_queue` 递归跳过已删除任务那段的写法)。

**触发时机**: (a) `register_import_batch` 登记完新 pending 行之后; (b) `main.rs` 的
app 启动 setup 钩子里也调一次(处理上次会话没跑完就退出、留在库里的 pending 行——
不这样做的话, 用户关闭 app 时如果正好有本书在排队, 这本书永远停在 pending, 没有
任何东西会再唤醒这条队列)。

**测试**(必须写, 参照 `vocab_audio_task.rs`/`batches_repo.rs` 现有测试写法):
- `apply_report`(把上面第 4 步"读 report → 决定 status/note/cache_path"这段逻辑
  抽成一个纯函数单独测, 不要把判断埋在 spawn 子进程那段里测不到): 输入
  `{"verdict":"ok","chapters":10,"sentences":200}` → 断言 status=done, note 含"10章200句";
  输入 `{"verdict":"block","issues":[{"message":"解析结果过少"}]}` → 断言 status=failed,
  note="解析结果过少"; 输入畸形/空 JSON → 断言 status=failed 且不 panic。
- `next_pending_standardize` 空表返回 None、多条按 created_at 取最早一条。
- `pump_standardize_queue` 在 `running=true` 时立即返回不重复处理(用一个假设的
  已经在跑的场景断言, 不需要真的起线程等待)。

### 1c. `build_job_request` 注入 cache path

`jobs/spawn.rs::build_job_request` 加一个可选参数
`standardize_cache_path: Option<&str>`, 非空时写进返回的 JSON:
`job_req["standardize_cache_path"] = cache_path`。三个调用点
(`job_orchestrator.rs` 里 79/339/556/678 行附近, 已在文件里搜 `build_job_request(`
能找全)在调用前先 `books_repo.get(&book_id)` 查一下这本原书当前的
`standardize_status`/`standardize_cache_path`, `== "done"` 时把 `cache_path` 传进去,
否则传 `None`。

### 1d. `library_list` 输出补三个字段

`commands/library.rs::library_list` 现有的书对象组装逻辑(搜 `"status"` 附近)加上
`"standardize_status"`, `"standardize_note"`(`standardize_cache_path` 不需要给前端,
只是内部路径)。

### 验收(progate 自己先跑一遍, 全绿再汇报)

```powershell
cargo test --release -p aidulc -- --test-threads=1
cargo fmt --all && cargo clippy --release -p aidulc
```
文件规模门禁: 新文件 `standardize_task.rs` 预计 150-200 行, 不会碰线; 改动的
`job_orchestrator.rs`/`library.rs` 如果因为改动跳出各自基线, 先看是否真的因为这条
改动"新增了内容"(是的话去 `scripts/file_size_baseline.json` 按现有惯例登记新数字,
写明原因), 不要为了避免登记而把代码硬塞。

---

## 拼图 2(Python, 编排方自己做): CLI 入口 + runner.py 接线 + contracts

- `prep/aidulc_prep/cli.py`(或现有 `--audit-book`/`--preview-book` 所在的分发文件):
  新增 `--standardize-book <path> --out <report_path>` 模式。调用
  `load_epub_fallback` + 复用 `application/book_audit.py::_judge_book` 拿到判定,
  把 Book 对象序列化成 `{"title":..., "chapters":[{"title":..., "sentences":[...]}]}` ,
  和判定结果(`verdict`/`issues`/`chapters`/`sentences`)合并写进同一个 `--out` JSON:
  ```json
  {
    "verdict": "ok",
    "issues": [],
    "chapters": 33,
    "sentences": 2793,
    "book": {"title": "...", "chapters": [{"title": "...", "sentences": ["...", ...]}]}
  }
  ```
  `verdict` 是 block 时 `book` 写 `null`(没有可用结果, 不要塞一份"反正也不达标"的
  半成品结构进去误导下游)。
- `runner.py::_parse()`: `self.job.get("standardize_cache_path")` 非空且文件存在时,
  读它的 `book` 字段直接构造 `Book`/`Chapter`/`Sentence`(跳过
  `load_epub_with_spine_health` 和 `_check_epub_health`——这条路径的书已经在标准化
  阶段判过 ok/warn, 不需要再体检一遍; 也没有 spine/uncovered 概念可体检)。
  字段缺失/JSON 解析失败按现有的 `InputError` 处理方式抛错, 不要静默退回原生解析——
  那样会掩盖"缓存明明该在却读不出来"这类真实故障。
- `contracts/job_request.schema.json` 加可选字段 `standardize_cache_path`(string,
  非 required), 跑 `scripts/sync_schema.ps1` + `-Verify`。

---

## 拼图 3(前端, 派给 flashgate): 导入流程 + 卡片展示

**文件**: `reader/core/import_gate.js`、`reader/services/import_service.js`、
`reader/views/library_view.js`(`_startBatchImport`)、`reader/ipc/bridge.js`、
`reader/views/library/status.js`(或现有卡片状态徽章逻辑所在文件, 找 `book.status`
渲染徽章那段, 参照它的样式加一个新徽章类型)。

### 3a. `import_gate.js::evaluate` 不再拒绝 block

现状: `verdict==='block'` 的书进 `blocked` 数组, 不进 `accepted`(彻底不导入)。

改成: `verdict==='block'` 的书**进 `accepted`**, 同时额外进一个新数组
`pendingStandardize`(存路径)。`blocked` 数组整个删掉(不再有"完全拒绝"这个状态)。
`messages` 里原来 error 级别的"已跳过"文案, 改成 info 级别的
`"有 N 本书格式不标准, 已导入并在后台尝试自动转换: <书名>(<原因>)"`。

对应 `reader/tests/import_gate.test.js`(已有测试文件, 照抄现有用例结构改)——
断言 block 书出现在 `accepted` 而不是被排除, 且出现在 `pendingStandardize`。

### 3b. `importBooks` 透传 `pendingStandardize`

`import_service.js::importBooks(paths, profileId, languages)` 加第 4 个参数
`pendingStandardize`, 透传给 `AiduBridge.invoke('batch_import', { bookPaths, profile,
sourceLanguage, targetLanguage, needsStandardize: pendingStandardize })`
(camelCase `needsStandardize` 对应 Rust 命令参数, 参照现有其它命令的参数命名风格)。

`library_view.js::_startBatchImport` 里调用链:
```js
AiduImportService.auditSources(paths)
  .then((audits) => {
    const gate = global.AiduImportGate.evaluate(paths, audits);
    ...
    return AiduImportService.importBooks(gate.accepted, profileId, languages, gate.pendingStandardize);
  })
```

### 3c. 卡片徽章

书库卡片现在的状态徽章逻辑(找 `book.status` 渲染那段, 大概率在
`reader/views/library/status.js` 或 `library_view.js` 内部, 先读一遍现有徽章是怎么
根据 `status` 出文案/颜色的, 照着同一套视觉语言加, 不要另起一套样式)加一个独立于
`status` 的第二档展示——`standardize_status`:

- `'pending'` / `'running'`: 小徽章"自动转换中…"(可以用现有的处理中样式, 比如
  `.badge-processing` 之类已有的 class, 不新造颜色)。
- `'done'`: 一个不打扰的小标记(比如 title 属性悬浮显示 `standardize_note`, 不需要
  常驻可见的徽章文字——这本书现在跟正常书没区别, 只是加一个可查证的痕迹)。
- `'failed'`: 醒目一点的徽章(参照现有"失败"类状态的样式), 文案用
  `standardize_note`(如"仍然不达标: 解析结果过少"), 点击/悬浮能看到完整原因。
- `'none'`: 不显示任何东西(绝大多数书, 零视觉噪音)。

刷新机制**不需要新代码**——`library-changed` 事件已经会触发 `loadBooks()` 重取
(8/18 那次改动确认过这条路径工作正常), 后台任务每次状态变化都会发这个事件,
卡片自然跟着刷新, 不需要轮询或新的 IPC 订阅。

### 验收(flashgate 自己先跑一遍)

```powershell
cd reader
npx vitest run
node tests/_smoke_views.mjs
```

---

## 收尾(编排方做)

1. 三块拼图分别复核(不能只信各自的"跑过了", 要独立重跑一遍验收命令)。
2. 端到端联调: 用 `Ferris` 或构造一本真正 block 的书(_tmp_ 临时 EPUB, 让它连
   pymupdf 兜底也救不回来, 验证 `failed` 分支不会卡死在 running)手动过一遍完整
   导入 → 后台转换 → 卡片状态变化 → (如果 done)创建译本走完整备料流程读到
   `standardize_cache_path` 缓存内容而不是重新原生解析。
3. `scripts/check.ps1` 全绿。
4. `docs/WATCH_2026-08-18.md` 或新开一份, 记录实测结果(哪本书走了这条路, 转换前后
   verdict 变化, 有没有卡在 running 的情况)。
5. 重新打包侧车 + 构建主程序。
