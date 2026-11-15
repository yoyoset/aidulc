# aidulc ROADMAP — 唯一活跃的待办来源

> 2026-11-15 重写: 旧版 1042 行(成熟度审计 37 条里 31 条已完成却没删、N1–N8 任务卡全是已完成项、
> 多处自己记录的"漂移")整份移到 [archive/ROADMAP_until_2026-11-15.md](archive/ROADMAP_until_2026-11-15.md),
> 这里只留**仍然开放**的条目。查"当时为什么这么做"去 archive, 查"现在还有什么没做"只看这份。

## 使用方式

- 完成一项就**从这里删掉**(历史在 git log 和 CHANGELOG), 不留"已完成"勾选项。目标: 本文件保持在 200 行内。
- 新发现的缺口按下面的分类加进来, 附来源(审计 / 用户反馈 / 代码 TODO)和文件路径。
- 已归档的 GOAL / STAGE_REPORT / WATCH 文档见 [archive/](archive/); 其它文档里写着 `docs/GOAL_*` 的
  路径, 现在都在 `docs/archive/` 下。

## 当前执行计划: 评估改进方案(来源 [EVALUATION_2026-11-15.md](EVALUATION_2026-11-15.md))

每项一个提交, 门禁全绿, 不调高任何基线。

- 阶段一(稳固) **已完成**: S1 推送 / S2 快照可恢复 / S3 同步失败不推进进度 / S4 锁中毒恢复 / S5 静默丢弃分类审查。
- 阶段二(可交付): D1 依赖锁 ✅ · D3 文档归档 ✅ · D4 检查更新 ✅ · D5 走查清单 ✅(**清单已写, 第一次走查还没人做**) · D2 发版脚本 ✅(`scripts/release.ps1`, `-Apply` 完整路径未端到端跑过)。
  **`v0.2.0` 还没打**: 脚本要求 `docs/SMOKE_NEW_USER.md` 里先有该版本的走查记录。下一步 = 真人走一遍清单 → 记录 → `.\scripts\release.ps1 -Version 0.2.0 -Apply`。
- 阶段三(开箱体验): E5 限流 ✅ · E7 小修 ✅(2026-11-15, 见下方 P2 残留), 其余未开始:
  - **E1** 带音频的公版成品样书 + 向导完成页改成"先读这本, 想处理自己的书再装模型"
    (现有文本样书见 `commands/library.rs::SAMPLE_BOOKPACK`, 无音频, 体验不到跟读)。
  - **E2** 阅读器内标出失败句(缺译文/缺音频)+ 就地「重试失败句」。
  - **E3** 备料完成/失败的系统通知(`tauri-plugin-notification`, 设置里可关)。
  - **E4** 备料前磁盘空间预检(按句数估体积, 不够时阻止并说差多少)。
  - **E6** 拆 `settings/system_tab.js::render`(436 行)和 `main.rs::main`(445 行)。

## P1 交付与环境

- **`prep/build_exe.spec` 依赖仓库外的路径**: CUDA DLL 从 `F:\my_ai\comic-gen\.venv\...\torch\lib` 取。
  换机器或 comic-gen 被清理, 打包会**静默少带 DLL**(spec 里 `os.path.exists` 过滤掉了缺失项, 不报错)。
  改法: 从本仓库 venv 的 torch 取, 缺失时让构建失败。(2026-11-15 D1 时发现)
- **`llama_cpp_python` 的 CUDA 构建来源无法从元数据确认**(见 `prep/requirements.lock` 头注释)。
  本机 venv 里 `import llama_cpp` 直接报 `llama.dll` 缺依赖(未先导入 torch / CUDA 目录不在 DLL 搜索路径时)。
  要确认真实运行路径(侧车入口是否先导入 torch)并记下装哪个 wheel。
- **便携版每阶段收尾必须重打**, 否则又会落后一个阶段(`dist/aidulc-portable/` 的 `config.toml` 仍是 08-08 的)。
  交付体积 6.3GB: torch 全量捆绑约 2.5GB、CUDA DLL 三份重复(cublasLt ×3 约 1.35GB 浪费)、ggml-cuda 903MB
  (优化方向见 ARCHITECTURE §9.5 F22)。
- 没有 CI、代码签名、自动更新; 单人项目暂不做, 有第二个贡献者或付费用户时再说。

## P2 功能缺口与待人工确认

- **真人在 exe 里确认**(代码侧已就位, 只差人点): 暂停→继续(checkpoint 续跑); 学习档案新建/编辑模态;
  儿童模式读 kid 书的字号; 单次拖拽只产生一个 batch; **快照恢复整条流程**(S2, 只有单测, 没有真实界面走过)。
- **写了测试但没接线**(`#[allow(dead_code)]` + `TODO(未接线)`): CF 同步断开 `credentials.rs::delete_cf_token`;
  旧单 token 读取 `credentials.rs::get_cf_token`(仅测试用); 首次下载 URL 构造
  `downloader/mod.rs::github_release_asset_url`; 阅读器「在线核对这一句」`online_client.rs`(K3 第二档授权, 无 UI);
  `profile_repo::get`(界面只走 list)。接线前先确认是复用还是删。
- **书籍资产模型收口**(详见 requirements.md): F43 历史 product 可能共享同一 `pack_dir`, v18 迁到 `editions`
  但没有物理复制出独占目录; F44 历史 jobs 无法全部可靠回填 `edition_id`, 无法匹配的由启动孤儿清理处理,
  缺"可追溯的人工处理策略"。
- **F45 残余**: 重复导入的真实触发路径(文件选择双对话框 / 旧 exe 监听累积)没在 exe 里复现过。
- **查词与备料并发抢 GPU(反向)**: `spawn_prep` 会先停词典守护释放显存, 但备料进行中回阅读器**查词**,
  `dict_daemon::lookup` 会再拉起第二份 LLM, 小显存卡上可能 OOM。
- **E5 限流的残留**: ① KV 读-改-写不原子, CF KV 还是最终一致, 并发/跨区时计数会少记, 属尽力而为; ② `ipfail:<来源>` 键不过期, 会随来源数累积(文件存储/KV 里都是); ③ 全站窗口被刷满时配对停用 1 分钟(已配对设备同步不受影响); ④ 每次失败写 2 个 KV 键, 持续攻击仍可能消耗 CF 免费档 1000 次/天写配额(比旧实现每次失败写 1 个但无上限已好很多)。**已部署的 worker / VPS 要重新部署才生效**; 经 CF Tunnel 的 VPS 要加 `TRUST_PROXY=cf`。
- **E7 未覆盖**: 没有真人用读屏软件 / 开系统「减少动态效果」实际走过; 非按钮元素(只靠 `.title` 的)没审; `aria-label` 目前只加在图标按钮上, 表单控件/对话框焦点管理没查。
- **词典守护读响应是阻塞 `read_line`**: 侧车挂死会阻塞查词线程(进程退出时 EOF 转 Err, 属理论风险)。
  可选加固: 读超时线程。
- **成熟度审计里仍存的 P2**: `model_repo::list_all_with_bound` N+1; `sync_service::pending_count` 读错误吞成 "0 已同步";
  `reader_view` 模式切换丢滚动位置; `_onWordClick` O(N) 扫描取错上下文; `job_retry_failed` 的 `"partial"` 分支(job 无此状态, 死分支)。
- **S5 未审完**: `commands/misc.rs`、`services/components.rs`、`infrastructure/*_daemon.rs` 里各 7–9 处 `let _ =`
  多为进程清理类, 未逐条审(分类标准见 `memory/maturity.md` 2026-11-15 一节)。
- **本轮 UX 审计明确没做**(2026-08-09, 理由在 `memory/ux_audit_2026-08-09.md`): 用户可见「取消」按钮、下载切页状态恢复、
  阅读设置 undo/重设默认、大 zip 导出导入异步化、生词批量管理。

## P3 产品与设计(有定论的在末尾)

- 对照台「结构骨架」是降级实现: prep 没把讲解拆成「骨架一行 + 详解正文」两层, 右栏常显讲解全文;
  真落地要改 prep 讲解输出(会触发重跑或版本兼容)。
- 命令面板(Ctrl+K)只有搜索 + 书签入口, 条目与排序未设计。
- 原书插图在对照台右栏(330px)下是否需要跨栏, 未验证。
- prep 任务状态/进度条用色与设计 §03 三态语义不符(现用陶土 primary; 设计要求完成绿/进行中蓝灰/待办灰),
  需把状态映射到 success/info/neutral + 阶段条分色(`prep.css:50`、`prep.css:61`)。
- 设置页只有横 tab, 设计稿要的左纵列已做一半(<800px 折回横向); 生词本右栏统计抽屉未做; `prep → jobs` 路由改名未做。
- 书库封面尺寸不可调 —— 并入 K2-3「网格/列表视图切换」一起设计, 该切换本身还没做。
- **已决策, 不做**(避免日后重新讨论): 封面手动上传; 封面跟原书还是跟译本走(取第一个译本, 概率低后果轻);
  摘录与生词本关联(用户拍板不需要); 纯配置导入/导出(区别于数据备份, 用户拍板不需要);
  手机端 token 存储强度弱于桌面(接受现状); 应用本体「关于」整页(设置里一行版本号已够)。

## P3 架构收口(技术债)

- **clippy 基线 7**: 全是"参数过多/类型复杂", 分布在 `job_orchestrator.rs`/`library_service.rs`/`sync_service.rs`/
  `commands/library.rs`/`commands/models.rs`。清零要把多参数函数改成请求结构体, 同时改 Tauri 命令调用约定和前端 `invoke()`
  传参, 是独立大改动。**只能降不能加。**
- **超过 150 行的函数基线 17**(`scripts/file_size_baseline.json`): `store_mod.rs::migrate` 1201 行(顺序迁移链, 不拆)、
  `main.rs::main` 445、`system_tab.js::render` 436、`job_orchestrator.rs::pump_queue` 355、`atomic_block.js::create` 338、
  `sync_tab.js::render` 311 等。只能降不能加。
- Rust 测试必须 `--test-threads=1`(共享临时库); 改成每个测试独立临时目录只换来更快, 排最后。
- 存储所有权的两处刻意例外见 CLAUDE.md(`wizard_state`、`library_asset_service.rs` 级联删除)。

## P4 已知限制(低优先级)

- 字号/间距阶梯令牌已建(`tokens.css`), 存量 `rem`/`px` 未迁移, 没有对应 lint。
- `findSentenceIndex` 对缺 `audio` 的中间句二分会带偏(`reader/core/timeline.js`), 生产理论不触发。
- explain 逐句 LLM 调用可批量化(预估 2–4x 吞吐), 改 prompt 有回归风险。
- translate 阶段没有 explain 那样的完整性校验。
- 章节渲染只做了分帧, 没做虚拟滚动(`reader_renderer.js`); 5000+ 句大章理论上仍可能不流畅, 等实测证明不够再做。
- explain 失败句无失败次数上限(有意: 用户需要"补"), 要限资源时再加。
- M7 主题自定义的后续: 主题导入/导出; 自定义色也过 WCAG AA 门禁(现在只校验预设色系)。
