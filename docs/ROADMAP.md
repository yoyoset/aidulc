# aidulc ROADMAP — 唯一活跃的待办来源

> `docs/archive/` 下 7 份文档是 2026-08-04~07 的历史执行记录(DeepSeek Flash 阶段性快照),
> 全部自称"已完成",仅供追溯"当时为什么这么做"、不代表现在仍然有效。
> **现在要看还有什么没做,只看这份文件** —— 不要去 archive/ 里挖"未完成项",
> 里面提到的开放项要么已被后续阶段解决,要么已经拣选进本文件(见下方逐条来源标注)。

## 使用方式

- 完成一项就从这里删掉,不要留"已完成"的勾选项发霉。
- 新发现的缺口按下面的分类加进来,附来源(审计/用户反馈/代码 TODO)。
- 涉及具体代码位置的项,附文件路径,方便直接跳转不用重新翻找。

> **漂移记录 (2026-08-14 发现)**: 本文件"已完成"日志停在 2026-08-10, 但 2026-08-11~14
> 实际发生的工作(UX5/UX6/UX7、文件规模治理、书库视图成熟化)都各开了独立的
> `docs/GOAL_2026-08-1X_*.md`, 没有汇总回这里——这份文件说自己是"唯一活跃的待办来源",
> 实际没做到。不逐条把那几份文档的内容倒回来(成本高、价值低, 那几份本身记录完整),
> 只在这里留指针: [UX5](GOAL_2026-08-13_UX5.md) [UX6](GOAL_2026-08-13_UX6.md)
> [UX7](GOAL_2026-08-13_UX7.md) [FILESIZE](GOAL_2026-08-13_FILESIZE.md)
> [LIBRARY](GOAL_2026-08-13_LIBRARY.md, 进行中)。下面新增的"成熟度审计"是新起的常设机制,
> 之后新发现的缺口继续按这份文件的方式汇总, 不再另开一次性 GOAL 文档收编零散缺口
> (单个大功能仍可以开 GOAL 文档, 但发现的"顺带缺口"记回这里)。

## 成熟度审计(2026-08-14 起, 系统性缺口发现)

**起因**: 用户实测书库封面功能后问"这个软件缺很多附加联想, 每次用到才发现缺口"。
这是判断力工作, 不能纯机械委派——用 CLAUDE.md 的"系统构成"五维框架
(配置管理/外部系统集成/依赖与交付/状态管理/错误处理与反馈)逐个功能域过一遍,
不是漫无目的地"想缺什么"。

**方法**: 每轮挑一个域, 先枚举现状(grep 代码, 机械, 可委派)、再判断(哪些是这个域
"做成熟"必然需要的配套, 机械委派不了), 缺口写回本节, 标优先级(P0-P3, 同上面任务卡
的口径), 不是空发现不落地。域列表按当前会话推进: 书库/封面(已审计) → 阅读器
(已审计) → 生词与词典(已审计) → 摘录笔记(已审计) → 同步(已审计) → 模型中心 →
备料流程 → 设置 → 多用户/账号。

### 书库/封面 (2026-08-14, 本轮新功能的顺带审计)

- **P2 封面尺寸不可调**: `reader/styles/library.css` 的 `.book-cover` 写死
  `aspect-ratio: 2/3`, 没有用户可调项。已处理书的"我的书"页目前是唯一形态(网格),
  没有"更大封面/更小封面"这类密度切换——这本该是 K2-3 视图模式切换的一部分,
  K2-3 当时只做了横滑区, 网格/列表切换本来就还没做(见 GOAL_2026-08-13_LIBRARY.md)。
- **P2 老书没有回填路径**: K2-2 封面管线只在新跑一次完整处理(到 pack 阶段)时生效。
  已经跑完的老 edition 不会自动补封面, 也没有"重新抓封面"这种轻量操作(要么重新
  跑一次完整备料——很贵, 要么永远没有封面)。缺一个只重跑 pack 阶段(不用重跑
  parse/nlp/translate/tts)的轻量入口, 或者一个独立的"补封面"命令(直接从原书
  EPUB 抽取+拷贝, 不碰其它已生成资产)。
- **P3 无封面手动上传**: 源书本身没有封面(纯文本 TXT、无封面的 EPUB)时, 占位块
  是唯一选项, 没有"用户自己传一张图当封面"的入口。低优先级(离线优先定位下,
  这类锦上添花的个性化不紧急)。
- **P3 封面与"原书 vs 译本"关系未理清**: 一本原书可以生成多个不同参数的译本
  (`docs/GOAL_2026-08-13_LIBRARY.md` K2-2 记录过: 原书借第一个译本的封面), 如果
  不同译本源自不同版本的 EPUB(理论上可能, 罕见), 封面可能不一致——目前没有
  "封面到底该跟原书走还是跟译本走"的明确设计决策, 只是实现细节(取第一个)带出的
  隐含行为。优先级低(概率低, 后果轻), 记录下来防止将来遇到时重新debug 一遍。

### 阅读器 (2026-08-14, reader_view.js + reader/*.js + components/*.js + 4 个 Rust 命令文件)

现状枚举(命令/UI入口/设置项/依赖/持久化)委派 flash 做的, 判断以下 4 条基于枚举结果。

- **P2 阅读器设置硬编码读 `'default'` 档案** (`reader_view.js:184-186`): `reader_settings`
  表本身按 `profile_id` 存(`settings_repo.rs:8-35`), 但前端固定只读/写 `'default'` 这一
  条, 不跟当前打开的书的 profile_id 走。项目本来就支持儿童/成人等多档案(`child_mode`
  字段就在这张表里), 一台设备给孩子和家长共用时, 字体大小/主题色/儿童模式这些阅读
  显示设置会互相覆盖——换个档案打开书, 字体不会跟着变, 上一个人调的会被带进来。
- **P2 词典发音与正文朗读是两套引擎, 音色不统一**: 整书朗读用备料阶段预生成的离线
  TTS(高质量, 音色可选), 但词典面板单词发音(`dictionary_panel.js:190-192`)走浏览器
  自带的 `SpeechSynthesisUtterance`——系统装了什么语音包就是什么音色, 跟正文朗读的
  音色完全对不上, 用户体验是"两个不同的人在读"。
- **P2 ✅ 已修复(2026-08-14)词典发音没有可用性检测/错误反馈** (`dictionary_panel.js:189-193`): 直接调
  `speechSynthesis.speak()`, 没有判断 `window.speechSynthesis` 是否存在, 也没监听
  `SpeechSynthesisUtterance` 的 `error` 事件。系统没装对应语音包或运行环境不支持时,
  点击"🔊 发音"静默无反应——用户分不清是没配置好还是点击没生效, 正是 CLAUDE.md 里
  明确要优先排除的"后台失败但用户以为成功"。
- **P2 备份导出边界不一致**: `.aidu-data` 备份(`transfer_service.rs`)只导出/导入
  `highlights`(摘录), 不含 `bookmarks`/`reading_state`(书签、阅读进度、已核对状态)——
  实测确认 `transfer_service.rs` 里没有任何 `bookmarks`/`reading_state` 字样。换设备
  或重装后, 摘录能找回, 书签和阅读进度会丢, 用户不会预期同一批"阅读留下的痕迹"备份
  范围不一样。

### 生词与词典 (2026-08-14, vocab_view.js + dictionary_service.js + 3 个 Rust 命令文件)

现状枚举委派 flash 做的, 判断以下 4 条基于枚举结果, 逐条 grep 复核过。

- **P2 无到期复习的全局提醒**: 到期数字只在生词本页内的"今日队列"卡片显示
  (`vocab_view.js:105-142`), 没有导航栏 badge 或系统通知。项目其实已经有 badge 机制
  ——`shell_view.js:153-154` 给备料任务数用了 nav-count badge, 但没复用到生词到期数
  这个更需要"习惯提醒"的场景(SRS 效果依赖按时复习, 用户不主动点进生词本就完全看
  不到"今天有 N 个词到期")。
- **P2 无 Anki/CSV 等外部格式导出**: 全仓 grep `anki|csv` 零命中, 现有导出只有
  `.aidu-data`(AIDU 自有备份格式)和一份纯前端 JSON(`vocab_view.js:454-465`)。
  项目自己实现了完整的 SM-2 变体 SRS(`domain/srs.rs`), 但生词本数据出不去这个
  软件——想用 Anki 桌面/手机 app 复习, 或者单纯想要一份人可读的表格, 都做不到。
- **P2 `vocab_stats` 命令已接线但零调用**: `commands/vocab.rs:112` 的 `vocab_stats`
  命令、前端 `dictionary_service.js:37` 的 `vocabStats` 包装都在, grep 确认没有任何
  view 调用它——不是 `#[allow(dead_code)]` 标注的已知未接线项(CLAUDE.md 那份清单里
  没有它), 是这次审计新发现的。生词本页现在的统计 pill(`vocab_view.js:177-190`)
  走的是另一条路径(`vocab_all` 返回全量再前端算), `vocab_stats` 这条后端聚合路径
  完全没被用上, 是重复实现还是准备给别处(比如仪表盘)用的, 需要人工确认再决定
  接上还是删掉。
- **P3 词典释义置信度数据存了但不给用户看**: `dictionary` 表的 `confidence` 字段
  区分本地词典命中(0.8)和 LLM 生成兜底(0.7)(`application/dictionary_service.rs`),
  但 `dictionary_panel.js`/`vocab_view.js` 两处 grep 都没有引用这个字段——用户看到
  一条释义时分不清"这是词典里查到的"还是"AI 现编的", 对英语学习场景这个区分不是
  锦上添花(AI 生成的释义偶尔会有错, 用户至少该知道该多留一个心眼)。

### 摘录笔记 (2026-08-14, reader/highlights.js + highlights_repo.rs + 3 个 highlights_* 命令)

现状枚举委派 flash 做的, 判断以下 4 条基于枚举结果, 逐条 grep 复核过。

- **P1 ✅ 已修复(2026-08-14, commit 4c2656b)多用户切人后摘录面板可能静默空白**:
  `reader/views/reader/highlights.js:29` 的 `load(bookKey)` 只传一个参数调
  `AiduBridge.highlights.list(bookKey)`; 而 `reader/ipc/bridge.js:126` 的封装是
  `list: (bookKey, userId) => invoke('highlights_list', { bookKey, userId })`——
  这条调用链里 `userId` 恒为 `undefined`。`JSON.stringify` 会丢掉值为 `undefined`
  的键, IPC payload 里根本不会有 `userId` 这个字段; 而后端
  `commands.rs:89-91` 的 `highlights_list(db, book_key, user_id: String)` 里
  `user_id` 是**必填 `String`**(没有 `Option`/`#[serde(default)]`), 按 serde
  标准语义, 缺这个字段应当在反序列化阶段直接报错。`highlights.js:31` 的
  `res.ok && Array.isArray(res.data)` 拿到失败结果后会静默把 `this.items` 置为
  空数组——即摘录面板可能一直打得开但看不到任何东西, 没有任何错误提示。
  **F29(命令参数门禁)catch 不住这个问题**: F29 校验的是 `bridge.js` 里那一条
  `invoke(...)` 字面量的键名(`bookKey`/`userId` 两个键名都在), 不检查调用方
  是否真的传了值——这正是静态门禁的盲区, 只有跑一次真实点击才能验证。**下一步
  行动: 优先手测确认这条是否成立**(比 P2 的一般性缺口更急, 一旦成立就是核心
  功能实质不可用)。
- **P2 无跨书搜索/标签分类**: 摘录面板只加载当前书(`highlights.js:29-34`), 后端
  `list_all()` 只在导出流程用, 没有暴露成可查询命令; `Highlight` 结构体
  (`highlights_repo.rs:14-31`)没有 tag/category 字段。读过多本书后, 想找"我在
  哪本书哪里记过这句话"做不到, 面板连按章筛选都没有。
- **P2 无 Markdown/纯文本导出**: 全仓搜 `markdown`/`export_md` 零命中, 唯一导出
  通道是 `.aidu-data`(`transfer_service.rs`, 自有 JSON 备份格式, 不是人可读笔记)。
  对"精读"这个产品定位, 摘录笔记恰恰是最该能导出复习/分享的产出物, 现在只能
  整本 JSON 搬家。
- **P3 摘录与生词本没有关联**: `Highlight` 无 lemma 引用字段, 摘录的 `.hl-span`
  渲染标记和生词的 `.saved` 标记是 `atomic_block.js` 里互不相干的两条通道——摘录
  一句包含生词的句子后, 看不出"这句里有我正在学的词"。

### 同步 (2026-08-14, sync_service.rs + sync_state_repo.rs + 15 个 sync_* 命令 + cloud/)

现状枚举委派 flash 做的, 判断以下 3 条基于枚举结果; 第一条自己独立复核过(不是转述
flash 的判断), 是确认级别不是推断。

- **P2 ✅ 已修复(2026-08-14)UI 文案与实际行为不符**: `reader/views/settings/sync_tab.js:146` 的
  "待推 N 条"提示文案称"自动推送只在启动时和任务完成后触发", 但独立 grep 全仓
  (Rust `sync_now` 调用点 + 前端 `AiduSyncService.now()` 调用点)确认: 除了命令
  注册本身, 唯一调用点是 `sync_tab.js:191` 手动点"立即同步"按钮——没有任何启动
  钩子或任务完成钩子真的触发过同步。用户读到这句文案会以为不用管、系统会自动
  同步, 实际上不点按钮永远不会推送。这条我独立验证过两遍(Rust 侧 + 前端侧
  分别 grep), 是确认级别的发现。
- **P2(跨域汇总, 与"阅读器"域发现叠加)同步范围与备份范围完全一致地缺同一批表**:
  `sync_service.rs:207-224` 显示实时同步**只覆盖 vocab 表**, 不含
  highlights/reading_state/bookmarks/reader_settings/books/editions(服务端明确
  拒收书文件/整章正文, `index.js:23`)。结合"阅读器"域已发现的
  `.aidu-data` 备份同样不含 bookmarks/reading_state——**两条独立机制(实时同步 +
  手动备份)对同一批阅读状态数据, 覆盖边界完全一致地缺同一批表**, 不像是巧合,
  更像是"目前只有生词/词典/摘录被当成需要跨设备的资产, 阅读进度和书签被当成
  设备本地状态"这个未被明说的设计决策。是否要扩大同步范围是产品判断, 但现状
  至少该让用户知道"换设备后哪些东西跟着走、哪些不会", 而不是隐含行为。
- **P3 手机端 token 存储强度弱于桌面端**: 桌面走 Windows Credential Manager
  (`services/credentials.rs:8-11`, 不落明文), 手机端 token 明文存 IndexedDB
  (`cloud/mobile/adapter.js:101-115`)。移动 Web 场景没有系统级密钥库可用是常见
  限制, 不算错误, 但同一套账号体系两种保密强度值得记录, 优先级低。

### 模型中心 (2026-08-14, models_view.js + model_service.rs + model_repo.rs + commands/models.rs + downloader/)

现状枚举委派 flash 做的, 判断以下 4 条基于枚举结果, 逐条 grep 复核过。

- **P2 移除/换版本模型不清理磁盘文件**: `models_remove`(`application/model_service.rs`
  调 `model_repo.rs::remove`)只删注册表那一行, 不碰磁盘上的模型文件; 换新版本时
  id 内含 version, 新版本是新的一行(`model_repo.rs` 的 `upsert` 按 id
  `ON CONFLICT` 各自独立), 旧版本文件原地不动。全仓 grep 确认模型文件路径下
  没有任何 `remove_file`/`remove_dir_all` 调用(现有的删除操作都是书/任务/迁移/
  备份场景, 不覆盖模型文件)。LLM/TTS 模型动辄几 GB, 用户换一次模型或升一次版本
  磁盘只涨不消, 界面上倒是有"模型目录"展示(`models_view.js:102-150`), 但没有
  从"移除这个模型"按钮联动到"顺便删磁盘文件"的选项。
- **P2 版本号对比是写死在前端代码里的目录, 不是真的在线检查**:
  `models_view.js:298-314` 的 `_versionStatus`(判定"已是最新/有新版/版本未知")
  比对的是同文件里硬编码的 `DOWNLOAD_CATALOG`(`models_view.js:18-31`, 目前只有
  Qwen3-4B 和 Kokoro-82M 两项固定版本号), 不是任何在线接口。上游模型发新版本后,
  只要这份代码没跟着改, 界面会一直显示"已是最新"——这不是"暂不支持在线检查"的
  中性缺失, 是**看起来像在检查、实际没有检查**的误导性 UI。
- **P2 完整性检测到文件丢失/损坏后没有直接修复入口**:
  `model_service.rs` 的 `preflight_check` 能准确报出"翻译引擎文件丢失"/"语音引擎
  文件丢失"(文字层面做得对), 但报错之后只指引用户"去模型中心换一个", 没有一个
  从错误提示直接跳转/触发重新下载同一模型的按钮——检测能力和修复动作是两件没有
  接上的事, 用户自己要记住是哪个模型、家族、语言, 重新走一遍下载流程。
- **P3 nlp 模型没有引导式下载入口**: `DOWNLOAD_CATALOG`(`models_view.js:18-31`)
  只覆盖 llm 和 tts 两个家族, nlp 家族没有目录项——`_renderGrouped`
  (`models_view.js:632`)里 nlp 段仅在已经通过"扫描"或"自定义模型"手动登记过
  才会显示。llm/tts 有"选磁盘已有 or 一键下载"的引导式弹窗, nlp 全靠用户自己
  知道去哪找模型文件再手动扫描登记, 三个模型家族里唯独这个没有新手友好路径。

### 备料流程 (2026-08-14, prep/pipeline/*.py 7 阶段 + job_orchestrator.rs + jobs/batches_repo.rs + prep_view.js)

现状枚举委派 flash 做的, 判断以下 4 条基于枚举结果, 逐条 grep 复核过。

- **P2"取消"语义不完整, 声明的状态值和已注册命令没有真正被用上**:
  `jobs_repo.rs:21` 声明 `Job.status` 可取 `canceled`, `batches_repo.rs:16` 同样
  声明 `Batch.status` 可取 `canceled`——但 grep 全部写入路径确认 Rust 代码从未把
  这两张表的状态写成 `canceled`(`job_orchestrator.rs:600` 的判断分支和
  `update_progress`(`batches_repo.rs:130-136`)都只在 done/failed/partial/running
  之间转移)。`commands/jobs.rs:253-263` 的 `cancel_prep_job` 命令本身注册了
  (`main.rs:540`), 但前端零调用点——这是这次审计第三次遇到"后端命令+数据结构都
  齐了但前端从没接上"的模式(此前"生词与词典"域的 `vocab_stats`、"模型中心"域
  隐含的类似情况), 值得作为一个跨域的通用观察: 项目在往前推进新功能时,
  经常后端先行一步却没有回头把前端接完。现有唯一能"停掉一个任务"的方式是
  "暂停"(`prep_view.js:233-238`, 可恢复)或"移除"(`prep_view.js:283-304`,
  运行中杀进程+丢进度+从列表删除, 二次确认)——没有真正"取消但保留记录可查"
  的中间语义。
- **P2 长任务无 ETA, 只有百分比**: `prep_view.js:325-331` 每行进度条只显示
  `job.progress`(7 阶段权重均分算出的百分比), 没有任何时间预估。翻译/讲解一本
  长篇小说可能要跑数小时, 用户只能看着百分比猜, 不知道是"还要 5 分钟"还是
  "还要 5 小时"——这类批处理任务本该是 ETA 最有价值的场景, 现在完全没有。
- **P3 并发数硬编码为 1, 无用户可调项**: `job_orchestrator.rs:757-759` 的
  `pump_queue` 开头检查 `running_job` 非空即返回, 队列严格顺序执行, 没有任何
  配置项能改。注释(`pipeline/runner.py:124-127`)说明这是刻意的显存安全设计
  (LLM+TTS 同驻会撑爆 12GB 显存, 见 R5), 所以这条不算"缺了并发"这么简单——
  但即便是刻意选择, 现在也没有任何界面文案告诉用户"为什么只能排队跑一本",
  用户体验上等同于一个没解释的限制。
- **P3 模型下载与备料任务无资源互斥, 只防重复下载同一文件**:
  `commands/models.rs:225-233` 显示模型下载(后台线程)和备料任务(`running_job`
  互斥锁)之间没有任何协调——用户可以一边跑着占满显存的备料任务一边点下载另一个
  模型(下载本身不占显存, 只占带宽/磁盘, 理论上不冲突), 但如果备料任务此时
  正要切到 TTS 阶段而 TTS 模型还没下完, 这条竞态路径枚举阶段没有找到专门处理——
  这是一个"理论上可能撞上但概率低"的边界情况, 记录下来而非现在动手验证。

### 设置 (2026-08-14, settings_view.js + 5 个 settings/*.js tab + settings_repo.rs + services/config.rs)

现状枚举委派 flash 做的, 判断以下 4 条基于枚举结果, 逐条 grep 复核过。

- **P2 删除学习档案后, 该档案的生词变成永久不可见的孤儿数据**:
  `profiles_tab.js:57-72` 的删除按钮删档案时只 `DELETE FROM profiles` 一行
  (`profile_repo.rs:103-108`), 不级联, 不碰 `vocab`/`dictionary` 表——这本身是
  对的(不该连带删用户学过的词)。但 grep 确认 `vocab_view.js:18`、
  `review_view.js:28` 的 profileId **固定写死 'default'**, 全应用没有任何
  "档案切换器"能让用户看到其它档案下的生词列表。也就是说: 给孩子建一个学习
  档案、攒了一堆生词后, 删掉这个档案(或者一开始就不是 default), 那些生词行
  会永久留在数据库里, 但从此没有任何界面能看到、复习或清理它们——不是数据
  丢失, 是变成用户看不见也删不掉的死数据, 会一直占着库。
- **P2 应用本体无版本号展示 / 无「关于」页面 / 无更新检查**: 全仓 grep「关于」
  零命中, `reader/app/router.js:7` 的路由表没有 about; `Cargo.toml` 里是有
  版本号(0.1.0)的, 但没有任何 UI 出口显示它。模型/依赖组件有各自的"检查更新"
  (`settings/models_tab.js:34-55`), 唯独应用本体没有——用户没法在界面上确认
  自己跑的是哪个版本, 报 bug 时说不清, 应用本体有没有新版本也无从得知(这是
  桌面软件的常见基线, 不是这个项目特有的需求)。
- **P3 无设置搜索, 无单项"恢复默认值"**: 5 个 tab 里塞了相当多控件(书库位置/
  在线引擎/主题/档案/同步后端/依赖组件…), 没有搜索框(书库和生词本页都有,
  设置页没有); `settings_repo.rs` 只有 `get`/`upsert`, 没有 reset 方法, 唯一
  "重置"入口是整个"重新运行首次向导"(`system_tab.js:48-54`), 粒度是全部设置
  一起走一遍向导, 没有"只把这一项改错的设置恢复默认"这种颗粒度。
- **P3 无纯配置导入/导出(区别于数据备份)**: 现有备份(`vocab_view.js:35-49`
  的备份/恢复按钮, 接 `.aidu-data`)导出的是生词/词典/摘录**数据**, 不含
  `config.toml` 里的同步后端列表、在线引擎 endpoint 这类**配置**(token 本来就
  在系统凭据管理器里带不走, 这部分合理)。换一台设备, 数据能带走, 但阅读器
  字体/主题、在线引擎配置这些要重新设一遍, 体验不连续。

### 多用户/账号 (2026-08-14, 最后一个域: users_repo.rs + shell_view.js"我"下拉 + 逐表 user_id 隔离系统性核对)

现状枚举委派 flash 做的, 判断以下 3 条基于枚举结果, 逐条 grep 复核过; vocab/dictionary/
reading_state/reading_daily/sync_state 五张表实测 WHERE 子句确认真按 user_id 过滤, 是
这次审计里唯一一次系统性验证"字段存在"和"查询真的用了这个字段"两件事都成立的域,
一并记在这里作为对照——不是所有表都这样干净, 见下面第一条。

- **P1 ✅ 已修复(2026-08-14, commit 4c2656b)`library_list` 硬编码
  `DEFAULT_USER_ID`, 切换用户不影响书架页的阅读进度/笔记数/书签数**:
  `commands/library.rs:155-156`(`let uid = crate::store::users_repo::
  DEFAULT_USER_ID;`)不接收任何 user 参数, 注释声称"前端会按 user 拉"但命令
  签名根本没有这个入参。**如实记录**: 本会话早前做 K2-4(书卡信息补全, 笔记数/
  书签数聚合)时新增的两个字段就是复用这同一行 `uid`写的, 继承了这个已经存在的
  限制, 不是这次审计才引入。影响面比"阅读器"域记录的 `reader_settings` 硬编码
  更广: 那条只影响字体/主题这些展示设置, 这条影响整个书架页(书库/我的书两个
  视图)的阅读进度显示——顶栏切到"孩子"这个用户, 书卡上看到的还是 default
  用户的阅读进度/笔记数, 不会跟着切换的用户变。
- **P2 ✅ 已修复(2026-08-14, commit 4c2656b, 与上面 P1 顺手一起改的)
  `highlights_remove` 命令不做 user_id 归属校验**: `highlights_repo.rs:
  121-123` 的 `remove` 只按 `id` 删(`DELETE FROM highlights WHERE id = ?1`),
  `ipc/commands.rs:111-114` 的 `highlights_remove` 命令签名也只传 `id`, 没有
  user 维度参与判断"这条摘录是不是当前用户的"。对照 `list_by_book` 是真按
  `user_id + book_key` 过滤的(能读到的东西都是自己的), 删除路径却没有对齐
  同样的隔离粒度——虽然是本地单机应用、不构成严格意义的安全边界, 但和"每张
  表读写都要按 user 隔离"这个项目自己声明的模型不一致。
- **P2 没有 `users_delete` 命令, 新建成员是单向操作**: `UsersRepo`
  (`users_repo.rs:28-89`)只有 `new`/`list`/`get`/`upsert`, 没有 `delete` 方法;
  顶栏"我"下拉(`shell_view.js:66-128`)也只有"切换"和"＋ 新建成员"两个选项。
  手滑点错新建、建了个不想要的临时成员, 没有任何路径能撤销——会一直留在顶栏
  下拉列表里。

**阶段性小结**(9 个域全部审完, 共 34 条记录缺口): 逐域看是一堆分散的具体问题,
但横着看有三个模式反复出现, 比单条缺口本身更值得优先处理:

1. **后端命令/数据结构齐了, 前端从没真正接上**——这次审计里出现了不止一次:
   "生词与词典"域的 `vocab_stats`、"备料流程"域的 `cancel_prep_job` 与
   `canceled` 状态值、"多用户"域的 `users_repo.rs::get`(文件里自己标注"仅测试用")。
   同一种模式出现三次以上不是巧合, 更像是这个项目推进新功能时的一个稳定
   习惯:后端先行一步, 前端接线经常被落下没有回头补。**建议**: 下次做完
   一个后端命令, 就地检查一遍是否已有前端调用点, 没有就要么当场接上要么
   明确标 `#[allow(dead_code)]` + `TODO(未接线)`(CLAUDE.md 已有这份清单,
   这次审计发现的几条都不在里面, 该补进去)。
2. **"阅读进度类"数据(书签/阅读位置/已读时长)不进任何备份或同步机制,
   且部分路径不跟着当前用户走**——"阅读器"域(`.aidu-data` 备份缺
   bookmarks/reading_state)、"同步"域(实时同步只覆盖 vocab, 同样缺这两张表)、
   本域(`library_list` 硬编码 user 导致进度显示不随切人变化)三个域从不同
   角度撞上同一批数据。这不再是"某个功能忘了做", 是这批数据本身在整个项目里
   的定位从没被明确过("要不要跨设备/跨用户跟着走"), 值得当作一个产品决策
   来专门讨论, 而不是继续零散地各补一个洞。
3. **检测能力和修复动作是两件没接上的事**——"模型中心"域(preflight 报错准确
   但没有联动重新下载按钮)、"生词与词典"域(词典置信度存了但不给用户看)都是
   这个形状:后端把"发生了什么"算得很清楚, 但前端只把这份信息当日志展示,
   没有转成用户能直接点的下一步动作。

---

## 下一阶段任务卡(STAGE-2026-08-10,按此顺序执行)

> 上一阶段(STAGE-2026-08-09)已验收:`scripts/check.ps1` 12 项全绿(154 Rust / 160 pytest /
> 91 vitest / clippy 8 未调高),工作树干净,报告与代码逐条核对无出入(核对记录见本节末)。
> 下面 N1-N7 是在此基础上排的下一阶段,**一条做完提交一条,不要攒成一个大提交**。

### N1(P0,数据正确性)F38:EPUB 正文必须按 spine 全遍历 ✅(2026-08-10 已修)

- 位置:`prep/aidulc_prep/pipeline/loader/epub.py:378` 的 `if toc_filtered:` 分支。
- 现状(2026-08-09 复核仍然如此):有 TOC 时只遍历 TOC 引用到的文件,同函数里算好的
  `files`(spine 全量)只在无 TOC 的兜底分支用。TOC 条目是**锚点**不是文件清单,长篇正文
  在后续 spine 文件里,从头到尾没被打开过 → 《银河系漫游指南》五部长篇各只剩 3-14 段。
- 改法:遍历基准换成 `files`(spine 全量);TOC 退化为 `phys → 标题` 的映射表,只用来给
  文件赋真实标题、划边界;`NON_BODY_TOC` 过滤只作用于**标题**不再用于筛文件;TOC 里出现
  但不在 spine 的文件补在末尾(保守,别丢);`_looks_like_index` 过滤保留。
- 验收(缺一不可):
  1. 新增 pytest:合成 EPUB2(toc.ncx,navPoint 只指前 2 个文件,spine 5 个文件)断言
     5 个文件的正文都进了章节,且章标题来自 TOC。
  2. nav.xhtml 的书(Wolf 21 形状)不回归——现有 `test_epub2_ncx.py` / `test_loader_nlp.py`
     全绿,章数与标题与改前一致。
  3. 真实书实测:用 `--preview-book` 跑《银河系漫游指南》,**把改前 331 段 / 改后实际段数
     写进提交信息**(写实际数字,不许写"约"/"大幅提升")。
- 禁止:为了让某本书好看去调 `NON_BODY_TOC` 或 `_looks_like_index` 的启发式阈值。
- **验收结果 (2026-08-10)**: 331 → 11894 句 (commit 6b4721e)。新增 F38 合成回归测试;
  Wolf 21 / Alice / EPUB2 全绿。

### N2(P0,防线)F39:体检要能拦住 N1 这类问题 ✅(2026-08-10 已修)

- 位置:`prep/aidulc_prep/cli.py:93-102` 的 `anomalies` 检测。
- 现状:只判 0 句 / 正好 1 句 / >1000 句。一部长篇只剩 3 段三条一条都不撞,F38 那次体检
  报的是 `anomalies: []`——**这道防线本来就是为了在烧几小时 GPU 之前拦住这种事**。
- 改法:抽成可单测的纯函数,至少加两条:① **spine 覆盖率**——有文件没被任何章节覆盖时
  显式报出来(判定确定,直接针对 F38 类问题);② 章节句数**远低于全书中位数**的离群检测。
- 验收:用 N1 那份合成 EPUB 的"修复前"章节结构喂检测函数,断言两条都能报;正常书(全覆盖、
  句数分布正常)不误报。**与 N1 同一批做,只修 N1 是修了这一本,加上 N2 才是以后能自动拦下。**
- **验收结果 (2026-08-10)**: `core/health.py::detect_anomalies` 6 项测试, F38 修前形状两条
  都报、正常书不误报 (commit bccac73)。

### N3(P1,一行 bug)批次状态中文映射漏 `completed` ✅(2026-08-10 已修)

- 位置:`reader/views/prep_view.js:353` 的 `statusText` 映射写的是 `done: '完成'`,
  而 `store/batches_repo.rs:114` 实际写入的是 `'completed'` → 批次行显示英文。
- 改法:补 `completed` 键;顺手核对 jobs 与 batches 两套状态词集合,映射表与 DB 实际写入值
  逐个对上(两者状态词不同,别互相抄)。
- 验收:`reader/tests/_smoke_views.mjs` 加一条断言(completed 批次显示"完成")。
- **验收结果 (2026-08-10)**: 已修 + 顺带补 job `paused` 映射;冒烟加 1c 节断言 (commit 5474ff9)。

### N4(P1,幻觉治理第二轮)ROADMAP 主体自身的过期开放项(2026-08-10 本项就是产出)

上一阶段只对账了 `CLAUDE.md` / `ARCHITECTURE.md` 的"未接线"清单,**本文件主体没对账**。
以下几条挂在开放区但代码里已经落地(2026-08-09 逐条 grep 确认):

| 本文开放条目 | 代码现状 |
|---|---|
| 「词典查询性能 F21,每次点词 5-7s」 | `infrastructure/dict_daemon.rs` 常驻守护已落地(M6) |
| F26 CSP 未放行 `data:`「登记为技术债,本轮不修」 | `tauri.conf.json:20` 已含 `img-src 'self' data: blob:`,renderer 已按扩展名给真实 MIME |
| F36/F37 便携版整体过期 / config.toml 残留 | 2026-08-08 已重打包(见 N5,现在是**新的**滞后问题,不是原问题) |
| R3-1 模型下载最小闭环未做(两处) | 下载闭环已落地(后台线程 + 断点续传 + sha256 + 动态超时) |
| F34 拖拽监听累积 | `library_view.js` 已改 `AiduListenerSlot`,注册前先 clear |
| F46 每切一章 419ms 整文件重解析 | `BookpackCache`(LRU cap=6)已接进 `load_bookpack_chapter`;**残余见 N7** |

- 改法:逐条**先 grep 代码确认、再改文档**——不许照抄本文件"已完成"区的文字对账
  (那正是上一轮幻觉的来源)。已落地的从开放区删掉,只在"已完成"区留一行;
  部分落地的(F46)改写成剩余部分。
- 验收:改完后随机抽 3 条开放项,能在代码里找到对应的未落地证据。

### N5(P2,交付)便携版又落后一个阶段

- 现状:`dist/aidulc-portable/aidulc.exe` 时间戳 2026-08-08 16:37,**不含 08-09 三个提交**
  (UX 审计落地 / LRU 缓存 / 启动清孤儿目录)。用户拿便携版复测会测到旧行为,上一轮 F36 的
  教训会原样重演。
- 改法:重打包(先 `cargo build --release` 嵌前端,再打侧车,整包替换),并把
  **"阶段收尾必须重打便携版"写成固定动作**(加进 `docs/BOOK_WORKFLOW.md` 或 check 清单),
  否则每个阶段都要再发现一次。
- 注意:`aidulc.exe` 运行中会锁文件,构建前先结束进程(上一阶段踩过)。
- **复核结果 (2026-08-10, 未通过)**:`BOOK_WORKFLOW.md §6` 固定动作已写(a6899da,这部分成立),
  但**打出来的包本身不满足它自己的第 3 条**:`aidulc.exe` 08-09 18:44 / 侧车 18:53,
  而本阶段最后一个**代码**提交是 `2746399`(N6,08-09 19:00,改了 `batches_repo.rs` + `main.rs`)
  → 便携版 exe 早于它 16 分钟,**不含 N6 的 Rust 改动**,"便携版已是最新可分发"不成立。
  (`821d5c4` 纯文档、`e0d684d` 纯 gitignore,不影响二进制。)
  **待办 N5b**:重打一次并复核时间戳 ≥ 最后一个代码提交;以后顺序固定为"代码全部提交完 → 再打包"。
- **N5b 结果 (2026-08-10, 见本阶段 N5b 提交 + 复测)**: 已重打 —— 顺序改为"代码全部提交完
  (N8/N6b 之后) → 再打包", `BOOK_WORKFLOW.md §6` 加了硬顺序第 2 条。重打后 `aidulc.exe` /
  `aidulc-prep.exe` 时间戳 ≥ 最后一个代码提交 (897bc65 N6b), 便携版含全部 N1-N8 改动。

### N6(P2)`batches`/`jobs` 表行无限累积 ⚠️(2026-08-10 只做了一半)

- 现状:上一阶段只收口了磁盘侧(`out_dir/jobs/` 目录),表行仍每导入/每备料一行不清理;
  `store/batches_repo.rs:82` 的 `list()` 无 LIMIT(UI 侧 `.slice(0,5)` 只是遮住了)。
- 改法:`list()` 加 LIMIT + 完成 N 天后的批次可删。行很小,优先级不高,但别再往后拖成
  "反正一直没事"。
- **复核结果 (2026-08-10)**:batches 侧成立 —— `BATCH_LIST_LIMIT=50`、`cleanup_old(30)` 且
  确在 `main.rs:343` 启动期调用,2 项测试跑绿。**jobs 侧没动**:`store/jobs_repo.rs:108`
  的 `list()` 仍是 `ORDER BY created_at DESC` 无 LIMIT,也没有对应的过期清理 —— 而 jobs
  是**每本书一行**,比 batches 涨得快,是这条里更值钱的一半。
  **待办 N6b**:`jobs_repo::list()` 加 LIMIT + 终态 job 行超保留期清理(与 batches 同款,
  注意别删掉仍被 edition 引用的 job 行,`cleanup_orphan_job_dirs` 依赖 job 行判断孤儿)。
- **N6b 结果 (2026-08-10, 见本阶段 N6b 提交)**: 已做 —— `jobs_repo::list()` 加 `LIMIT 100`
  (`JOBS_LIST_LIMIT`);新增 `jobs_repo::cleanup_old(30)` 启动期调用:只删 `done/failed/
  canceled` 且超保留期、且 `edition_id` 不存在或指向不存在的 edition 的任务行 (不删
  running/queued、不删仍被 edition 引用的行, 防止 `cleanup_orphan_job_dirs` 误清共享目录)。
  2 项新测试 (list 封顶 / edition 引用保留)。

### N8(P3,一致性)F38 实测数字在仓库里有两个版本 ✅(2026-08-10 已统一)

- `prep/aidulc_prep/pipeline/loader/epub.py:387` 的注释写 `331→11918 句`,而同一提交的
  提交信息、`docs/ROADMAP.md`(3 处)、`prep/tests/test_epub2_ncx.py:313` 都写 `11894`。
- 项目规约要求"写实际数字",同一个实测出现两个数就等于没有可信数字。
  **改法**:重跑一次 `--preview-book` 确认到底是哪个(很可能 11918 是加
  `_is_real_sentence` 拒绝 `[[IMG:...]]` 之前的中间值),然后全仓统一,不要凭印象改。
- **结论 (2026-08-10, 实测重跑当前提交代码)**:权威值是 **11894 句 / 35 章**。
  11918 确实是加 `[[IMG:...]]` 记号拒绝 + 前页边界之前的中间值。已把 `epub.py:387`
  注释改为 11894 并注明中间值作废原因;提交信息里的 11894 维持不变 (提交信息不可改)。

### N7(P3)F46 残余:meta 响应仍含全部 `original_text` ✅(2026-08-10 已确认消费方并注明)

- 现状:`commands/library.rs` 的 meta 已 strip 重字段但**保留 original_text**
  (测试 `strips_heavy_fields_keeps_original_text` 锁的就是这个行为),Wolf 21 实测 1.3MB
  随每次打开走 IPC。
- 改法:确认前端首屏是否真需要全书 original_text(章节尺/搜索?),不需要就改成按需拉取,
  需要就在文档里写清"这 1.3MB 是有意保留的"并注明消费方——**别留成没人知道为什么的现状**。
- **结论 (2026-08-10)**: **有意保留**。消费方 = 全书搜索的跨章索引
  (`reader/views/reader/search.js` 打开书时一次 `build(chapters)` → `core/search_index.js`);
  去掉它就得把搜索改成按章惰性建索引, 会失去跨章搜索。已在 `commands/library.rs`
  `strip_chapters_to_meta` 注释里写清原因 + 何时才能删。代码不改, 文档对账完毕。

### 真人在 exe 里最终确认(代码侧已就位,只差人点)

暂停→继续(checkpoint 续跑)、档案新建/编辑模态表单、儿童模式读 kid 书的字号、
单次拖拽只产生一个 batch(F45 的剩余复现路径)。

### 收尾加固(2026-08-10):`jobs_repo::cleanup_old` 的 `NOT IN` 换 `NOT EXISTS`

`editions.id` 是 `TEXT PRIMARY KEY`,SQLite 里**不隐含 NOT NULL**。editions 出现 NULL id 时
旧写法对**悬空 edition_id** 求值为 NULL → 那类终态任务行永远清不掉且不报错。已改
`NOT EXISTS` + 回归测试 `cleanup_old_still_works_when_editions_has_null_id`(旧 SQL 实跑为红、
新 SQL 为绿,两遍都跑过)。**过程修正**:最初判断是"整条清理静默失效",实测发现
`edition_id IS NULL` 的行走 OR 第一分支照删不误,受影响的只有悬空那一类;第一版测试用
NULL edition_id 构造,拿旧 SQL 跑照样绿(空测试),改成悬空 id 才测得出来。

---

## 下一阶段(STAGE-SRS):背单词 + 身份模型 + 同步重建

任务卡与全部约束在 **`docs/GOAL_STAGE_SRS.md`**(V0-V8),本文件只留指针,避免两份待办。
设计来源:`生词本和背单词完整设计交付确认/aidulc 背单词.dc.html`。
三个已定的方向:① 重建 Cloudflare Worker + KV(个人免费友好),协议形状预留账号体系;
② 引入独立 `user` 维度(同机多人 + 同人多设备),`profile` 退回"讲解策略"语义;
③ 桌面端三栏 + 手机端(Tauri v2 Android)都做,iOS 不做。

## 下一阶段(STAGE-UX):真机试用暴露的 5 处不可用

任务卡与全部约束在 **`docs/GOAL_STAGE_UX.md`**(A-E),本文件只留指针,避免两份待办。
来源:2026-08-11 用户真机走完整流程后的实测反馈。五个现象归为三类系统性缺陷:
① 状态没绑定它依赖的外部身份(同步 `sync_state` 缺 `endpoint_key`);
② 能力做了但没有入口(逐句播放只有 `S` 快捷键);
③ 门禁量的东西和用户看到的东西不是一个东西(颜色量原色/看稀释色、模型只查注册表不看
磁盘、布局 `#app` 是 `min-height` 导致 `overflow:auto` 永不触发)。

## 内置公版样书(2026-08-10 新增, 独立于 STAGE-SRS)

新用户现在必须先装 6GB 模型、跑几小时 GPU 才能看到成品长什么样 —— 门槛挡在体验之前。
内置一本**公版短篇的成品书包**让它开箱即读;后续公版目录小额收费(见个人记忆 aidulc-monetization-model)。

- **内置的必须是成品书包(bookpack), 不是源 EPUB**。内置源文件用户还得跑管线, "开箱即读"不成立,
  这条是整件事的意义所在。
- **选 CC0 来源的 EPUB3**(如 Standard Ebooks, 排版/元数据干净且带 nav.xhtml)。**先实测确认目录里
  有哪本短篇**再定书名, 不要凭印象写。避开 EPUB2/toc.ncx 那条刚修的路(F38), 减少变量。
  Gutenberg 文本本身也是公版, 但要去掉它的 license header 才是纯 PD。
- **书库要能认出"内置书"**:不被 `cleanup_orphans`/`cleanup_orphan_job_dirs` 误清, 用户删掉后能恢复。
- **首次运行向导改造**:没装模型也能直接读这本, 装模型改成"想处理自己的书时再说"。
- 应用内标注来源与许可。
- 体积实测(音频是大头, 参照 Wolf 21 书包 23.88MB/8007 句), 决定进不进便携包。
- 后续付费公版目录复用现成的 `book_import`(zip) 链路, 不另造轮子。

### 上一阶段核对记录(2026-08-09,本次逐条 grep/运行确认)

`scripts/check.ps1` 全绿(12/12);`BookpackCache` `DEFAULT_CAP=6` 属实;
`cleanup_orphan_job_dirs` 确在 `main.rs:338` 启动期调用;`books` 表裸 SQL 只剩迁移与测试
(符合所有权表);`builtin_profiles.js` 三处消费方确已收敛;报告自陈的两个未修项
(`completed` 映射、表行无界)属实未修——**报告没有夸大**,已分别立为 N3 / N6。

---

## P0(阻断可用性)——空,已清

~~书库路径未锚定 exe_dir~~ 已修(2026-08-07)。`main.rs` 新增 `resolve_out_dir` 纯函数
(比照 `resolve_prep_path` 的既有模式),裸相对路径统一 `exe_dir.join()`,`AIDULC_OUT`
环境变量显式指定时不做加工;启动日志新增 `out_dir=... (存在: true/false)` 一行,不用再靠猜。

**修复过程中发现并顺带解决的架构债**:项目里曾经有两个不同步的"书目录"概念——
`library_dir`(仅两处遗留兜底逻辑引用, **没有一本书真正存在这里**)和 `PrepConfig.out_dir`
(真正的书包存放位置)。用户反馈"不知道书包在哪"的真正根因其实是 out_dir 此前没有
`config.toml` 持久化入口(只能靠 `AIDULC_OUT` 环境变量), 不是 library_dir 本身。已合并成一个:
`Config.out_dir` 是唯一配置来源, `LibraryState` 整个结构体已删除, `load_bookpack`/
`components_health` 两处消费方改读 `PrepConfig.out_dir`。副作用修复: `components_health`
的磁盘空间检查此前查的是 library_dir 所在盘, 和书实际写入的 out_dir 可能不是同一块盘,
结果具有误导性——合并后这个问题自动消失。

**历史遗留、这次没解决的**:`docs/BASELINE.md` 里 Wolf 21/Breath/Hitchhikers 三本书当时具体
落在哪个目录仍然未知(修 bug 只保证以后的运行可预测,不能倒推过去的运行落在了哪)——如果这三本书
的数据还在意义重大,需要用户提供当时的实际路径或干脆重新处理。

---

## P1(产品需求,用户已明确提出)——已完成

### 书库位置可见可改 + 书包导出导入

用户原话:书库路径"应该可以在设置里修正";处理过的书包"也是资产,是可以导出导入的,这样跨端也可以了"。

产品决策(已与用户确认):改位置时自动搜旧目录并搬迁(与 subgen 一致的策略);导出格式为 zip。

- [x] **P1.1 后端**(2026-08-07):`library_dir_get`/`library_dir_pick_and_set` 命令。
  搬迁逻辑 `infrastructure/dir_migration.rs`——同盘 rename 瞬间完成, 跨盘复制到临时名→
  核对文件数+总字节数→原子改名→删源, 单条目失败不中断整体(5 个测试覆盖)。
  **重启后生效, 不是热切换**:`PrepConfig` 是 Tauri 启动时一次性 `.manage()` 的不可变状态,
  运行时可变需要包 Mutex 并改遍全部直接字段访问点, 风险和收益不成比例, 这是明确的范围
  取舍不是遗漏, 命令返回值里带 `restart_required: true` 供前端提示。任务处理中禁止更改
  (参照 subgen"处理任务进行中不能改模型目录"的既有纪律)。
- [x] **P1.2 前端**(2026-08-07):设置页"书库位置"区块,当前路径 + "更改..."按钮,
  迁移中/成功(含失败明细)/取消/被拒绝(任务处理中)四种场景都有对应文案。
  用真实 `SettingsView` 类(mock 其余依赖服务, 不是复制一份渲染逻辑)在浏览器里
  过了成功/部分失败/被拒绝三种场景, 确认渲染和交互与设计一致。
- [x] **P1.3 后端**(2026-08-07):`commands::library::book_export` 命令, 用 `zip` crate
  (新增依赖)把某本书的 pack_dir 打包成 zip, 压缩方式选 Stored(不压缩)——音频已是
  Opus 编码, 再走 Deflate 只白费 CPU。实现在 `application/book_transfer_service.rs`
  (4 个测试: 往返/源目录缺失/zip 里没 bookpack.json 拒绝/目标已存在拒绝覆盖)。
- [x] **P1.4 后端**(2026-08-07):`commands::library::book_import` 命令, 解压 zip 到
  `out_dir/<new_id>/`(id 冲突自动加序号), 校验 `enclosed_name()` 防路径穿越, 校验含
  `bookpack.json` 才登记(否则清理残留目录返回错误), 复用 `library_service::register_book`
  完成入库。`application/transfer_service.rs` 现在只做 `.aidu-data`(词典/生词)的导入
  导出, 不覆盖书包这个更大的资产类型, 是独立实现不是复用它。
- [x] **P1.5 前端**(2026-08-07):"我的书"卡片新增"导出"按钮(product kind), 书库/我的书
  两个视图头部都加"导入书包(.zip)"入口。用真实 `LibraryView` 类(mock 其余依赖服务)
  在浏览器里验证了两个按钮存在且点击后正确调用后端命令、正确处理成功响应。

来源:用户在审计 S0.4 阶段的明确反馈 + 2026-08-07 后续实现中的架构发现。

---

## P2(功能缺口 —— 写了测试但未接入应用)

2026-08-07 清 clippy 死代码警告时发现:7 个 `pub fn` 只被自己的单元测试调用,从未被任何
`#[tauri::command]` 或前端真正使用。源码里已标 `#[allow(dead_code)]` + `TODO(未接线)` 注释,
这里是产品视角的清单:

| 功能 | 代码位置 | 说明 |
|---|---|---|
| CF 同步断开连接 | `services/credentials.rs::delete_cf_token` | 界面上没有"登出/断开同步"的入口 |
| 首次下载 URL 构造 | `infrastructure/downloader/mod.rs::github_release_asset_url` / `hf_resolve_url` | 下载链路本身已通(`models_download` → `download_with_progress`); 这两个 URL 构造函数无调用方, 接线前先确认是否复用或直接删 |
| profile 单条查询 | `store/profile_repo.rs::get` | 界面只走 list, 无 command 调用单条查询 |

来源:2026-08-07 lint 清理时代码实测发现(不是猜测,已逐个 grep 全仓库确认零调用方,仅测试引用)。
2026-08-09 复核:剔除已按 R2-2 删除的两项(model bundle 完整性检查、wizard_service::is_done, 见 memory/maturity.md);补入 profile_repo::get。

---

## P3(架构收口)

### clippy 基线(8)的真正清零需要函数签名重设计, 不只是挪文件

S2.1(2026-08-07)已把 `commands/jobs.rs`(原 947 行)的业务编排拆到
`application/job_orchestrator.rs`,命令层现在是薄壳(`pump_queue`/`batch_start`/
`start_prep_job`/`batch_start_prep` 等移走, `jobs.rs` 降到 228 行)。

但 clippy 基线**仍是 8,没有降**——这是诚实的结果,不是漏做:挪文件不会减少函数的参数
个数,`start_prep_job`(10 参数)等 3 个"参数过多"警告只是换了文件,原样跟过去了(挪的时候
特意验证过没有被静默压掉,`ipc/registry.rs` 的一致性测试也确认了这次拆分没有改变任何
command 的名称/路径)。真正清零基线需要把这些参数打包成请求结构体(如
`StartPrepJobRequest { book_path, profile, models, ... }`),这是比"挪文件"更大的改动
(要动 Tauri command 的调用约定, 前端 `invoke()` 传参方式也要跟着改), 留作独立任务,
不要和"分层"这件事混在一起做。

来源:2026-08-07 审计 + S2.1 完成后的复核。

---

## P4(已知限制,低优先级)

### 字号/间距阶梯已建, 存量替换未做

S3.1(2026-08-07)在 `reader/styles/tokens.css` 建了 `--md-sys-font-size-*`(15 档)和
`--md-sys-space-*`(7 档)阶梯令牌,颜色已强制走 `css:no-raw-hex` 门禁校验,但字号/间距
**没有对应约束**——现有代码里几十处 `0.9rem`/`1.4rem`/`12px` 这类裸值原样保留, 只是新代码
应该优先用阶梯令牌。存量迁移是独立工作量(要核对每处改动后的视觉效果, 风险和收益需要单独
评估), 不在这次令牌层地基搭建范围。

来源:2026-08-07 S3.1。

- **`findSentenceIndex` 对缺 `audio` 的中间句二分会带偏**(`reader/core/timeline.js`):中间句
  `audio` 字段为 null 时,二分查找可能锁定到错误的更早句子。生产环境理论上不会触发(`pack.py` 的
  B3 修复保证失败句也写静音占位 audio),但旧版书包/手工编辑可能撞到。测试已锁定现状行为,见
  `reader/tests/timeline.test.js`。
- **explain 逐句 LLM 调用可批量化**(吞吐预估 2-4x),改 prompt 有回归风险,暂缓
  (来源:`docs/archive/PACK_RELIABILITY_PHASE.md` §6)。
- **translate 阶段无完整性校验**(explain 阶段已有的 skipped_fatal 校验,translate 阶段还没有),
  优先级低(来源:同上)。
- **章节渲染只做了分帧, 没做虚拟滚动**(`reader/components/reader_renderer.js`):
  5000+ 句的超大章节分帧建 DOM 后不再冻结界面, 但 DOM 节点总数仍然很大, 滚动这类
  章节理论上仍可能不够流畅。真正的虚拟滚动需要重写 `highlightAt`/书签/搜索跳转依赖
  "所有句子 DOM 都已存在"的假设, 是更大的改动, 留到实测证明分帧不够用时再做
  (来源: `docs/BASELINE.md` 2026-08-07"新发现"一节)。
- **explain 失败句无限重试,没有失败次数上限**:重试时 `failedStages` 里的句子每次都会再试,
  LLM 持续失败则永远失败,靠 quality 报告兜底可见但不会停止重试。当前是有意为之(用户需要"补"),
  但如果要限制资源消耗,后续可加一个失败次数上限(来源:`docs/archive/PACK_RELIABILITY_PHASE.md`
  §6,归档时唯一没有被 `memory/pipeline.md` 覆盖到的一条,单独拣选进本文件)。

---

## 需求精化产出(2026-08-08 会话, 详细见 docs/requirements.md)

> 需求精化 + 架构记录会话的产出, 摘进这里作为活跃待办。完整任务卡/证据/验收在
> `docs/requirements.md`(可执行任务卡 + 优先级清单)和 `docs/ARCHITECTURE.md`(§9.5)。

### 书籍资产模型后续收口

- **F43** legacy product 可能共享同一 `pack_dir`。v18 已迁移到 `editions`，但尚未物理复制
  历史共享目录；必须校验并为每个 edition 建立独占目录后才能完成资产模型验收。
- **F44** 历史 jobs 无法全部可靠回填 `edition_id`。当前按 `output_dir=pack_dir` 回填，无法匹配
  的记录由启动孤儿清理处理；需要保留可追溯人工处理策略，不能静默猜测。
- **F45** 用户复测发现一次导入疑似登记两次。**阶段0取证(2026-08-09, docs/FORENSIC_P0.md §3)**:
  当前代码(工作树+786ca83)的 F34 fix 顺序颠倒 —— `_buildImportCard()` 先注册新 drag-drop
  listener 并把 unlisten 存进 `this._offDrag`, 随后 render() line 94 立刻 `this._offDrag()`
  注销的是**刚注册的 listener**, 不是旧 listener → 每次 render 后拖拽 listener 被立即杀死,
  拖拽导入在当前代码实际不工作(与"累积"相反)。后端 `batch_import` source 幂等
  (book_id_from_path 去重), 但每次调用必新建 batch。真实 DB: 1 source / 4 batch / 1 job,
  无重复 source。重复导入的真实触发路径(文件选择双对话框 / 旧 exe listener 累积)待阶段2
  在 exe 里注入 drag-drop 事件 + 连续点按复现, 并配自动化测试(同路径二次导入仍 1 source、
  单次拖拽单 batch、re-render 不累积 listener)。
- **F46** 用户复测发现约 100KB EPUB 阅读时卡死。**阶段0取证(2026-08-09, docs/FORENSIC_P0.md
  §4)**: 92MB 整包 IPC 卡死已由 916534b 修复(load_bookpack 只回元信息 + 按需单章 + 渐进渲染)。
  **已修部分 (2026-08-09)**: `BookpackCache`(LRU cap=6)已接进 `load_bookpack`/
  `load_bookpack_chapter`, 每切一章 ≈419ms 整文件重读重解析已消除。
  **残余 (任务卡 N7)**: meta 响应仍含全部 original_text(Wolf 21 实测 1.3MB 随每次打开走 IPC),
  待确认前端首屏是否真需要后按需拉取。
- **阶段1 细化落地(2026-08-09)**: BOOK_WORKFLOW §2.3 要求"job 显式关联 source_id" ——
  迁移 v19 给 jobs 加 source_id 列并回填(book_path 精确匹配 books.source_path),
  `batch_start_prep`/`start_prep_job`/`batch_start` 建 job 时写 source_id;
  `delete_source` 按 source_id 级联清 job(`delete_source_cleans_jobs_by_source_id` 测试),
  `cleanup_orphans` 也认 source_id 锚。真实 DB 已迁移到 v19 且 job source_id 回填正确。

- **候选缺陷(静态取证, 先 exe 复现再立项)**:
  - R4-1 书签跨章串位: `reader_view.js` 书签 Set 跨章不重置, 旧章下标套新章且覆写 reading_state。
    复现: ≥2 章书 ch1 打 2 书签 → 切 ch2 → 同序号句被高亮/面板列出错句。
  - R5-1 重试失败句丢 profile: `job_retry_failed`(job_orchestrator.rs:515-521)用硬编码默认
    profile, kid 用户重试后音色/策略/速度变默认。正确来源 = 原 job_request.json 快照。
  - R6-1 重启后"开始阅读准备"报批次不存在: `_startPrepForBook` 的 batch_id 依赖会话内存
    `_lastBatchId`, 重启后伪造 id 被 `batch_repo.get` 拒绝。复现: 导入不处理→重启→点按钮。
    若复现成立应 P0/P1(阻断"导入→稍后处理")。
  - F25 儿童模式对 kid 书无效: 设置页只写 'default', 阅读器按书 profile('kid')读且缺失不回退
    'default' → kid 书恒 18px/句级。复现: 开儿童模式 → 读 kid 书 → 字号没变。修法: reader_view
    改读 'default' 或缺失回退。
  - ~~F26 CSP 未放行 `data:` → R4 插图 100% 显示不出来~~ **已修 (M7, 2026-08-08)**:
    `tauri.conf.json:20` CSP 已含 `img-src 'self' data: blob:`, `reader_renderer._loadFigure`
    已按扩展名给真实 MIME(`image/jpeg`/`image/png`), R4 插图在真实 app 里正常显示。
  - F27 .aidu-data 备份/恢复命令零 UI: transfer_export/transfer_import 注册但无任何前端调用,
    而 USER_NEEDS item 9("生词备份")因此未兑现。接 UI(如生词本/设置加"备份/恢复")即兑现。
    同类: bookmarks_list 死命令、boot_ping 开发探针。
  - F30 library_open 未接线 → "最近阅读"无数据源: 打开书不调 library_open, last_opened_at 恒
    None。USER_NEEDS item 12 明确要"最近阅读排序"。修法: 打开书时调 library_open。
  - ~~F34 拖拽导入监听累积(高置信, 待 exe 实测)~~ **已修 (M6 + UX 审计, 2026-08-08/09)**:
    library_view 已改 `AiduListenerSlot`(注册前先 clear), 导入卡去重复文件选择(单对话框),
    `core/import_guard.js` 去重单次拖拽; 剩余"单次拖拽单 batch"的 exe 复现路径见
    "真人在 exe 里最终确认"。
- ~~F38 EPUB2(toc.ncx)书丢掉绝大部分正文~~ **已修 (N1, 2026-08-10)**:
  `epub.py` 改为**始终按 spine 遍历全部正文**, TOC 只用来给文件赋标题/定边界(前页边界 +
  仅非正文 TOC 引用跳过)。《银河系漫游指南》实测 331 → **11894 段**; Wolf 21 (nav.xhtml)
  不回归。详见 commit `6b4721e` 与上方 N1 卡。

- ~~F39 处理前体检对 F38 这类问题完全无效~~ **已修 (N2, 2026-08-10)**:
  `core/health.py::detect_anomalies` 纯函数, 在既有 0/1/>1000 句之上加 **spine 覆盖率** +
  **句数离群** 两条防线; `load_epub_with_spine_health` 提供未覆盖文件。详见 commit
  `bccac73` 与上方 N2 卡。

- ~~词典查询性能(实测)~~ **已修 (M6, 2026-08-08)**: F21 —— 每次点词 spawn 新侧车加载 2.4GB
  模型, 实测冷 7.4s / 热 5.7s, 用户每次查词等 5-7 秒。改为 `infrastructure/dict_daemon.rs`
  常驻词典服务(加载一次, stdin/stdout 多次查词, 120s 空闲回收), 消灭每次 5-8s 冷启动。
- **便携版整体过期(实测, 高)**: F36 —— 已在 M7 (2026-08-08) 用 R0-R4 代码重打过一次
  (`dist/aidulc-portable/` 新侧车含 dict_server/PyMuPDF 1.28.2 + 新 exe + 干净 config.toml)。
  **但每阶段收尾不重打就会再过期**: 当前便携版是 08-08 的, 不含 08-09/08-10 提交 ——
  见任务卡 **N5** (重打 + 把"阶段收尾必重打便携版"写成固定动作)。
- ~~便携版 config.toml 是开发机残留(实测, 高)~~ **已修 (M7, 2026-08-08)**: F37 —— 打包改用
  干净默认 config.toml, 不再残留 `F:/hf_cache` 等开发机绝对路径。
- ~~R3-1 模型下载接线前必修(实测确认)~~ **已修 (M7, 2026-08-08)**: ① reqwest 补
  `native-tls`(https 下载链路打通, F19); ② `models_download` 改动态超时(F4)。下载闭环
  (后台线程 + 轮询 + 断点续传 + sha256)已落地, `models_view` 有一键下载区。
- **交付体积债(实测)**: 侧车/便携版 6.3GB(F22)—— torch 全量捆绑(约 2.5GB) + CUDA DLL 三重复制
  (cublasLt ×3 ≈ 1.35GB 浪费) + ggml-cuda 903MB。优化方向(去重/排除 cudnn engines/权衡 CPU build)
  见 ARCHITECTURE §9.5 F22。
- **死表面审计(P4 清理包)**: F5(job_id 死字段)/F17(无调用方命令)/F23(死配置字段)同根, 合并审计
  一次定去留。**F14 已随 M6 消失**(profiles 表已有完整 UI: 设置页档案管理 + 导入卡/书卡消费),
  不再列入。

---

## 阶段6: 完整设计交付确认(2026-08-09, 七屏高保真 `完整设计交付确认/`)

> 设计稿 §10「落地清单」11 项。本次按"令牌先行 → 壳与导航 → 逐视图"顺序落地, 已做:
> 令牌层(纸纹/动效/废弃 radius-xl)、纸纹单一实例、.atomic-block 禁滤镜/纹理 lint、
> 导航三层结构、models 并入设置、书库状态分段筛选、跟读第四个预设「孩子」、
> 生词本来源句上下文(后端持久化+前端展示)、每日图表当天强调色、失败详情复制日志。
> 剩余为后端契约依赖较大的项(处理中九段: 后端仅 emit 7 段; 设置左纵列: 横 tab 未改竖列),
> 列在下方说明。

- [x] **§10 item 1 令牌**: tokens.css 新增 `--rd-grain-1/2`、`--rd-grain-opacity`(深色换暖灰)、
  `--md-sys-motion-fast/base/slow`; `--md-sys-radius-xl` 标废弃(禁新用)。
- [x] **§10 item 2 纸纹**: app.css `body::before` 单一实例(固定定位、pointer-events:none、
  不参与动画), 深色块内 grain 换暖灰。禁止加在 .blk/卡片上。
- [x] **§10 item 11 lint**: check.ps1 新增 `css:no-blk-texture` —— `.atomic-block`(JS 里
  `.blk` 别名)禁止 backdrop-filter 与 background-image。现有 .rd-top 的 blur 不在其内, 门禁绿。
- [x] **§10 item 3 导航三层结构**: shell_view 重构 —— 左「我的书·生词本」右「导入·处理中(n)」
  最右齿轮。「处理中(n)」徽章常驻(无任务显示 0), 当前项 = primary + 600 + 底部 2px 圆角线。
- [x] **§10 item 4 路由合并**: `models → settings` 重定向(模型中心并入设置, 旧路由保留一版);
  library/products 已合一。`prep → jobs` 改名未做(处理中导航已落地, 路由名保持 prep)。
- [x] **§10 item 5 书库**: 顶部状态分段筛选(全部/已就绪/处理中/未处理)带计数, 替换原下拉;
  桶映射有单测(library_status_bucket.test.js); 空态虚线容器已有。
- [x] **§10 item 6 导入单屏**: 设计的"导入"屏映射到现有 library_view 的导入卡(已是单屏:
  拖拽/文件选择 + 档案 + 语言 + 提示, 无多步向导)。首次运行向导是 onboarding, 与导入
  是两回事, 保持分开。
- [x] **§10 item 7 处理中**: 任务卡 + 阶段流水条(后端契约 emit 7 阶段 parse/nlp/translate/
  explain/tts/align/pack, 设计稿"九段"含前端拆分, 后端不额外 emit → 维持 7 段与契约一致);
  日志在详情模态折叠区(非 tab); 失败三动作: 重试失败句 + 查看详情 + **复制日志**(新增)。
- [x] **§10 item 8 设置左纵列**: 模型中心并入设置成为一个分区(tab「模型中心」挂载
  ModelsView, 模块本身不改只换挂载点); 左侧纵向分区列表 —— 当前项 = 左 2px 陶土竖线 +
  primary-container 底(本轮补齐), <800px 折回横向滚动。
- [x] **§10 item 9 生词本**: 词条卡加来源句上下文(原句, 左 2px 强调竖线)—— 后端
  `add_vocab` 接受 context 并持久化(add_to_vocab_stores_source_context 测试), 阅读器加词
  传来源句, vocab_view 渲染; 右栏统计当日强调色/<800px 抽屉未做。
- [x] **§10 item 10 阅读器**: 跟读预设新增第四个「孩子」(repeat 3 / 留白 1500ms / 0.7x),
  follow_bar 已是四预设 pill + 微调进浮层。零层导航(Esc 返回)已具备。

---

## S5/M6 遗留(2026-08-08 三模式 + 成熟度工程落地后的开放项)

- ~~F25 儿童模式对 kid 书无效~~ **已修 (M6, 2026-08-08)**: 阅读器设置一律读 'default'。
- ~~F13 重试失败句丢 profile~~ **已修 (M6)**: `job_retry_failed` 读 job_request.json 快照。
- **M7 主题自定义的级联候选 (2026-08-08, 来源 = 需求扩展引擎)**: ① 主题选择色块可视化
  (文字下拉 → 色块 chips + 即时预览, 对标 VS Code 主题选择); ② 自定义主题色(自由选色 →
  色盘 UI + 持久化自定义值覆盖); ③ 主题导入/导出(跨设备迁移自己的配色); ④ 深浅色对比度
  校验(每 palette 都要过 WCAG AA, 现状是人工挑的近似值, 未用工具算过)。
- **对照台「结构骨架」是降级实现**: prep 未把讲解拆成「骨架一行 + 详解正文」两层, 右栏
  当前常显讲解全文。要真正落地骨架需 prep 侧拆分讲解输出(改 prompt/结构, 会触发重跑或
  版本兼容, 本轮明确不做)。
- **命令面板(Ctrl+K)具体条目与排序未设计**: 当前只有搜索 + 书签入口, 面板内部设计留待后续。
- **原书插图在对照台模式的排版**: 插图按原位插入正文流, 对照台右栏(330px)下是否需要跨栏
  未验证。
- **F21 词典守护的残余风险 (M6 已主体修复, 留痕)**: 守护进程读响应是阻塞 `read_line`, 侧车
  若挂死会阻塞查词线程(理论风险, 侧车单次查询 ~1s, 进程异常退出时 EOF 转 Err)。可选加固:
  读响应包超时线程/异步。另: 档案音色下拉是人工精选的 kokoro 常用音色, 具体可用性取决于
  已装语音模型, 处理时若报错会给出具体原因。
- **R3-1 模型下载最小闭环**: 已落地 (M7, 2026-08-08) —— `models_view` 一键下载区 +
  后台线程下载不冻结 UI + 轮询 + 断点续传 + sha256 + 动态超时, 完成自动登记。

---

## S6b 设计语言符合性审计遗留 (2026-08-10, 详见 docs/DESIGN_CONFORMANCE.md)

偏离项分类里"需要大改"的两条, 记这里, 不在 S6b 本轮做:

- **prep 任务状态/进度条用色与设计 §03 三态语义不符**: 设计稿说处理中"已完成用绿、
  进行中用蓝灰、待办用中性灰"; 现状 `prep.css:50 .prep-task-status` 与
  `prep.css:61 .prep-bar-fill` 都用陶土 primary。要落地需把 task 状态映射到
  success/info/neutral 三态 + 阶段条九段分色, 涉及 prep_view 状态文案与后端 stage 映射,
  是比配色更大的改动, 记这里。
- **字号/间距存量 rem/px 未迁阶梯令牌**: 已在 P4 记录 (CLAUDE.md 同步标注为存量欠账),
  不重复。

其余规则 (逐帧动画 / 深色阴影 / 虚线 / Toast / 设置纵列 / 语义通道 / hex 禁令) 已在
S6b 核对为符合或已修。

---

## 已完成(仅作为近期变更记录,超过一个 Phase 周期后清理)

- 2026-08-10:**N1-N4 (STAGE-2026-08-10 前四项)**。N1 F38 EPUB spine 全遍历
  (银河系 331→11894 句, Wolf 21 不回归); N2 F39 体检加 spine 覆盖率 + 句数离群
  (`core/health.py::detect_anomalies`); N3 批次 `completed`/job `paused` 中文映射;
  N4 本文件主体幻觉对账(本条即产出)。各一条一提交, 见上方任务卡标注。
- 2026-08-08:**M7 Round 5-11**: 生词本掌握度概览(四阶段 pill);
  **对比度门禁** `scripts/check_contrast.mjs`(解析 tokens.css, 46 项, 修 3 处不达标);
  **R2-1 同步断开**(删 token + 清 URL + 内存态, 断开按钮) + **同步状态显示 Worker URL**
  (SyncStatus 加 configured/worker_url, 顺带修 R4 的潜伏 bug: configured 字段当时不存在 → 按钮永禁);
  **R3-1 模型下载最小闭环**(后台线程下载不冻结 UI + 轮询状态 + 断点续传 + sha256, 一键下载区
  Qwen3-4B/Kokoro 两个实测可用 URL, 完成自动登记; F4 动态超时);
  **R1-1 阅读位置恢复(P0)**(audioReady Promise + 恢复锚点 + F11 切章锚点归零 + F8 关窗口落盘);
  **R2-2 删死代码**(is_done/bundle_complete/book_bundle_complete 三处仅测试引用, 已删);
  **README 刷新**(功能亮点/结构/启动/测试)。
- 2026-08-08:**M7 Round 39**: 本周阅读条形图(命令面板入口, 近 7 天分钟图 + 周总分钟)。
- 2026-08-08:**M7 Round 38**: 修空转契约测试(F29) —— `b"invoke("` 7 字节 vs `[i..i+6]` 6 字节恒不相等,
  命令名校验一直空转; 修长度 + 排 node_modules + 新增参数名校验(非 State/Option 参数必须覆盖),
  现在命令名与 arg 键都真实校验(全仓零不一致)。
- 2026-08-08:**M7 Round 37**: 阅读时长按日记录(迁移 v17 reading_daily, save_with_daily 增量分账,
  reading_stats 命令, 顶栏"今日 X 分钟")。
- 2026-08-08:**M7 Round 35**: 批次组头完成率(done/N 完成)。
- 2026-08-08:**M7 Round 34**: 生词本每日积累条形图(core/vocab_stats.js 纯函数 + 14 天 CSS 图)。
- 2026-08-08:**M7 Round 33**: 词典守护主动空闲回收(gen 代际 + watchdog 线程, 空闲 120s 自动杀)。
- 2026-08-08:**M7 Round 32**: 备料台按批次分组(batch_id 组头 + _buildTaskRow 抽方法)。
- 2026-08-08:**M7 Round 31**: 摘录跨设备同步(.aidu-data v3 加 data.highlights 纯增量键,
  按书分组导出/按 id upsert 导入, aidu 兼容不破; 恢复 toast 计数)。
- 2026-08-08:**M7 Round 29-30**: 词典守护应用退出主动停止(RunEvent::Exit → dict_daemon::stop);
  便携版重打(R13 轮功能后, 新 aidulc.exe + 侧车含 run.log/dict_server)。
- 2026-08-08:**M7 Round 27-28**: 通篇自动跟随滚动(当前句掉出视口才滚回 40%); 工作树一致性
  审计(清 3 处死引用: setForChapter/_showTranslations/.prep-task-log)。
- 2026-08-08:**M7 Round 26**: 侧车 run.log 兑现(`runner.py` 配 FileHandler 写 out_dir/run.log,
  aidulc logger 下, 失败路径落堆栈; `job_detail` 返回 run_log_tail, prep_view 详情模态展示)。
- 2026-08-08:**M7 Round 24-25**: 任务失败日志可读(`job_detail` 读 quality_report, prep_view
  failed+partial 显示 error + 详情模态); F32 加词即时高亮(onVocabAdded 接线, 正文立即下划线)。
- 2026-08-08:**M7 Round 22-23**: 摘录备注(面板加备注编辑); 主题自定义色(迁移 v16
  custom_color, 纯函数 `deriveCustomPalette` 从单色推导整套强调色, WCAG on-primary 自动黑/白,
  设置页 + 阅读器浮层自定义色 chip + 色盘)。
- 2026-08-08:**M7 Round 19-21**: 打开书并行化(4 个 IPC 改 Promise.all); 下载任务硬化
  (防重复同 dest + 完成 >1h 自动清理); 摘录精确 span 高亮(迁移 v15 start_seg/end_seg,
  选中的词在正文直接标黄 + 句级琥珀标)。
- 2026-08-08:**M7 Round 16-18**: 摘录标注(迁移 v13 `highlights` 表 + repo + 3 命令;
  前端选中文字→浮动"摘录"→句块琥珀标 + Ctrl+K 摘录面板跨章跳转/删除);
  阅读进度+时长上架(迁移 v14 `time_spent_ms`, player 播放计时, library_list 逐书附
  reading_chapter/time_spent, 书架卡显示"已读至第 X 章 · 已读 Y 分钟")。
- 2026-08-08:**M7 Round 12-15**: 模型下载进度(手动 Read 循环 + Arc<AtomicU64> 共享,
  status 返回 bytes_read/total, 前端百分比+MB); F26 CSP 放行 `data:` 修 R4 插图 + 真实 MIME;
  R1-2 生词高亮 lemma+word 双键(变位词修复, DOM 冒烟锁定);
  **F36/F37 便携版重打包**(新侧车含 dict_server/PyMuPDF 1.28.2 + 新 aidulc.exe + 干净
  config.toml)。
- 2026-08-08:**M7 Round 3/4**: 设置页字号/行距/栏宽改图形化档位(与阅读器浮层一致,消灭裸数字
  输入框); R2-1 CF 同步断开出口(`sync_disconnect` 删 token + 清 config.toml URL + 清内存态 +
  清 LAST_SYNC, 设置页"断开同步"按钮, 未配置时禁用)。同步配置从此可彻底撤销。
- 2026-08-08:**M7 主题自定义**(你给的级联示例的第一条落地)。`ReaderSettings` 加 `palette`
  (clay/sage/ocean/rose/slate 五色系, 迁移 v12, serde 默认函数引用); `tokens.css` 按
  `body[data-palette]` + `[data-theme=dark][data-palette]` 覆盖强调色家族(primary/state/阅读器
  accent, 纸面墨色中性色全色系共享); 设置页 + 阅读器页面设置浮层都能换色系, 与明暗正交,
  重启保持。**踩坑**: serde 裸 `#[serde(default)]` 对 String 落空串而非语义默认, 导致 deserialize
  测试失败 + 死函数告警 —— 必须 `default = "fn"` 引用默认函数。
- 2026-08-08:**M6 成熟度工程**(设计语言 + Profile 系统 + 平台修复 + F21 词典守护)。
  ① **设计语言重建**: tokens 从 MD3 紫色 → 暖纸陶土低饱和体系(浅色暖米纸面/陶土强调/暖墨文字,
  深色暖炭纸; elevation 暖调阴影; state 与强调色同源), 全应用视觉统一, 阅读器 `--rd-*` 同步协调;
  导航改文字页签+下划线, 按钮/卡片/输入/空态/向导/生词本打磨。② **Profile 系统**: 设置页
  "学习档案"管理(新建/编辑/删除, 内建 default 不可删), 导入卡/书卡用真实档案名, 修 F13(重试失败句
  读 job_request.json 快照保留 kid 参数, 抽 `profile_from_snapshot` 纯函数+测试)、F25(阅读器设置
  一律读 'default'), 迁移 v11 seed default+kid 档案。③ **平台修复**: F30(打开书调 library_open +
  最近阅读排序)、F34(拖拽监听注销)、F33(prep_view cleanup)、F16(向导第 4/5 步真实状态+自动登记)、
  F18(书设置弹窗死代码分支)、F27(生词本 .aidu-data 备份/恢复 UI)、F42(装 tauri-plugin-opener,
  "打开日志文件"恢复)、F19(reqwest 补 native-tls, https 下载链路打通)、F41(落盘失败提示)。
  ④ **F21 词典查询常驻守护**: 侧车 `--lookup-server` 模式(加载 2.4GB 模型一次, stdin/stdout 服务
  多次查词, 消灭每次 5-8s 冷启动), Rust `infrastructure/dict_daemon.rs` 全局注册表懒启动/120s
  空闲回收/任务启动时 `spawn_prep` 释放显存, `word_lookup` 改走守护。Python 4 个协议测试 + Rust
  128 全绿。详见 `memory/maturity.md`。
  ⑤ **候选缺陷防修 (未 exe 复现, 按静态取证直接修, 低风险)**: R4-1 书签跨章串位(切章/搜索跨章
  清空书签集)、R6-1 单书"开始阅读准备"依赖会话内存 batch_id(批次不存在时自动建, "导入→稍后
  处理"重启不断流)、F40(词典查询失败不再误导成"未配置")。
- 2026-08-08:**S5 阅读器三模式重写**(先答后核/静默正文/对照台 × 通篇/逐句跟读)。落地:
  `core/reader_state.js`(模式/节奏/揭示/已核对状态机,纯逻辑)、`core/follow_presets.js`
  (初听/跟读/盲跟三预设)、atomic_block 重写(三开关句内控件 + 开关式揭示 + 2px 折叠细痕
  + 词四通道,去掉高斯模糊)、renderer 模式感知(对照台节奏线 = 预测量 + transform,盲跟
  只亮当前词)、六个新 view 模块(章节尺/对照台右栏/页面设置浮层/跟读条/静默卡片/命令面板)、
  reader_view 重写(键盘 1/2/3、J/K、Space、Enter、T/Esc、S、Ctrl+K;顶栏撤销)、
  数据库迁移 v10(reader_settings 加 display_mode/pace/preset/speed, reading_state 加
  verified)、`--rd-*` 阅读器令牌层 + `[data-kid]` 覆盖、DOM 冒烟测试接入门禁
  (`node tests\_smoke_dom.mjs`,30 项)。详见 `memory/reader.md`。
- 2026-08-07:建立版本控制(此前零历史)、聚合门禁 `scripts/check.ps1`、CLAUDE.md 强制规约、
  前端测试基建(0→32 测试)、清 Rust lint 债务(clippy 41→8 警告)、schema 同步改为可校验、
  文档收口(本文件)。
- 2026-08-07:书库位置可见可改 + 书包导出导入 zip(P1 全部完成)。
- 2026-08-07:修复大书打开阅读器卡死——用户实测撞见"点开始阅读没反应", 根因是
  `load_bookpack` 整本书(92MB, Hitchhiker's Guide)一次性 IPC 传给前端 + 章节渲染无分帧,
  改为按需拉取单章内容 + 分帧建 DOM, 详见 `docs/BASELINE.md`"新发现"一节。
