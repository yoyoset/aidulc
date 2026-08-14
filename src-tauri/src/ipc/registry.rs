//! ipc/registry.rs —— 全部 tauri command 的集中清单(路径 + 所属域 + 一行说明)。
//!
//! 唯一目的: 让 main.rs 的 `generate_handler!` 列表可审计。56+ 个命令散落在
//! commands/*.rs 5 个文件 + ipc/commands.rs 里, 光看 main.rs 那一长串路径看不出
//! "这个命令是干什么的、漏没漏登记"。新增/删除 command 时, 这里的清单和
//! `generate_handler!` 实际注册的集合必须保持一致 —— 下面的测试断言这件事,
//! 不是靠人肉核对两份列表。
//!
//! `path` 字段必须和 main.rs `generate_handler!` 里出现的写法逐字节一致(如
//! `"commands::library::library_list"`), 测试直接从 main.rs 源码里抠出该宏调用的
//! 参数列表文本做字符串比对, 不依赖 tauri 宏展开后的运行时反射(它不可反射)。

// 这份清单只被下面的 #[cfg(test)] 使用, release 构建里天生"未使用"——这是设计如此,
// 不是"忘了接线"(不同于本次审计标注过的另外 7 处 TODO(未接线))。它不打算在运行时
// 被读取, 存在的唯一目的就是给测试比对, 所以 #[allow(dead_code)] 是准确的而不是遮掩。
#[allow(dead_code)]
pub struct CommandInfo {
    pub path: &'static str,
    pub domain: &'static str,
    pub desc: &'static str,
}

#[allow(dead_code)]
pub const COMMANDS: &[CommandInfo] = &[
    // ---- 书库 (commands/library.rs) ----
    CommandInfo {
        path: "commands::library::library_list",
        domain: "书库",
        desc: "书库列表(kind: original=原版管理 | product=AI 成品 | 空=全部)",
    },
    CommandInfo {
        path: "commands::library::library_register",
        domain: "书库",
        desc: "登记一本书",
    },
    CommandInfo {
        path: "commands::library::library_remove",
        domain: "书库",
        desc: "删除一本书",
    },
    CommandInfo {
        path: "commands::library::library_open",
        domain: "书库",
        desc: "打开一本书(登记打开时间)",
    },
    CommandInfo {
        path: "commands::library::library_book_set_profile",
        domain: "书库",
        desc: "L10: 改书的学习档案(下次生成默认, 不影响已生成译本)",
    },
    CommandInfo {
        path: "commands::library::sample_book_import",
        domain: "书库",
        desc: "R1 (UX5 #7): 导入内置样书 (幂等, 登记为译本, 向导完成页②入口)",
    },
    CommandInfo {
        path: "commands::library::edition_lookup",
        domain: "书库",
        desc: "按 edition_id 查译本元信息 (背单词右栏书名/章节 + 跳转, V4)",
    },
    CommandInfo {
        path: "commands::library::load_bookpack",
        domain: "书库",
        desc: "加载书包元信息(每章只带 original_text, 不含译文/讲解/时间轴; 修复大书 IPC 卡死)",
    },
    CommandInfo {
        path: "commands::library::load_bookpack_chapter",
        domain: "书库",
        desc: "按需加载单章完整内容(译文/讲解/segments/时间轴)",
    },
    CommandInfo {
        path: "commands::library::read_audio",
        domain: "书库",
        desc: "读音频文件(兼容单次整读)",
    },
    CommandInfo {
        path: "commands::library::read_audio_range",
        domain: "书库",
        desc: "分块读音频(长章避免整文件跨 IPC)",
    },
    CommandInfo {
        path: "commands::library::read_image",
        domain: "书库",
        desc: "读原书插图(R4, 复用 read_audio 的路径校验)",
    },
    CommandInfo {
        path: "commands::library::pick_files",
        domain: "书库",
        desc: "原生文件选择对话框",
    },
    CommandInfo {
        path: "commands::library::library_preview",
        domain: "书库",
        desc: "预览原书章节/句子(不需要已处理书包)",
    },
    CommandInfo {
        path: "commands::library::backfill_cover",
        domain: "书库",
        desc: "K12: 老 edition 补封面(只重跑封面抽取, 不碰其它已生成资产)",
    },
    CommandInfo {
        path: "commands::library::book_export",
        domain: "书库",
        desc: "书包导出为 zip(成品资产, 跨设备迁移)",
    },
    CommandInfo {
        path: "commands::library::book_import",
        domain: "书库",
        desc: "导入 zip 书包(解到 out_dir 下新 id, 登记进 books 表)",
    },
    // ---- 阅读会话 (commands/reader.rs); 生词/词典/背单词 (commands/vocab.rs);
    //      同步后端 (commands/sync_backend.rs); 日志 (commands/log.rs)
    //      治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 原来全挤在 reader.rs 一个文件,
    //      path 字段驱动 F29 去对应 .rs 文件里找函数签名, 拆分后必须跟着改, 不只是改注释。
    CommandInfo {
        path: "commands::dictionary::word_lookup",
        domain: "生词",
        desc: "查词(本地优先 → LLM 补全, 异步)",
    },
    CommandInfo {
        path: "commands::dictionary::word_lookup_online",
        domain: "在线引擎",
        desc: "K3: 用在线 AI 查一次(本地失败后用户显式点击, 绝不自动回退)",
    },
    CommandInfo {
        path: "commands::reader::book_online_translate",
        domain: "在线引擎",
        desc: "L8② (UX5): 整本在线翻译/讲解 —— 书卡入口确认外发量后逐句调用在线引擎, 生成无音频在线版译本",
    },
    CommandInfo {
        path: "commands::vocab::add_vocab",
        domain: "阅读",
        desc: "显式加入生词本",
    },
    CommandInfo {
        path: "commands::dictionary::dict_list",
        domain: "词典",
        desc: "词典列表(某 profile)",
    },
    CommandInfo {
        path: "commands::dictionary::dict_search",
        domain: "词典",
        desc: "词典搜索",
    },
    CommandInfo {
        path: "commands::dictionary::dict_remove",
        domain: "词典",
        desc: "词典删除",
    },
    CommandInfo {
        path: "commands::dictionary::tts_synth_word",
        domain: "词典",
        desc: "K29: 生词发音, 走本地 TTS 常驻守护(与正文朗读同一引擎), 返回 base64 WAV",
    },
    CommandInfo {
        path: "commands::dictionary::tts_prewarm",
        domain: "词典",
        desc: "K29: 进入阅读器时预热语音守护, 减少生词本首次发音的等待",
    },
    CommandInfo {
        path: "commands::vocab::vocab_all",
        domain: "生词",
        desc: "生词列表",
    },
    CommandInfo {
        path: "commands::vocab::vocab_search",
        domain: "生词",
        desc: "生词搜索",
    },
    CommandInfo {
        path: "commands::vocab::vocab_remove",
        domain: "生词",
        desc: "删除生词",
    },
    CommandInfo {
        path: "commands::vocab::vocab_common_preview",
        domain: "生词",
        desc: "H5: 词频批量剔除 dry-run (最常见 top_n 词将影响多少条)",
    },
    CommandInfo {
        path: "commands::vocab::vocab_remove_common",
        domain: "生词",
        desc: "H5: 词频批量剔除 (备份+单事务删除, 确认后执行)",
    },
    CommandInfo {
        path: "commands::vocab::vocab_backlog_preview",
        domain: "生词",
        desc: "H4: 存量打散 dry-run (到期存量有多少/摊到几天/今天剩几词)",
    },
    CommandInfo {
        path: "commands::vocab::vocab_backlog_spread",
        domain: "生词",
        desc: "H4: 存量打散 (备份+单事务把 next_review 摊到未来 N 天)",
    },
    CommandInfo {
        path: "commands::srs::srs_preview",
        domain: "复习",
        desc: "四档间隔预览 (调度器对当前词算出按钮时间, V2)",
    },
    CommandInfo {
        path: "commands::srs::srs_grade",
        domain: "复习",
        desc: "评分 1-4: 取→算→写 (唯一写者 vocab_repo), V2",
    },
    CommandInfo {
        path: "commands::srs::vocab_restore",
        domain: "复习",
        desc: "撤销评分: 恢复词条评分前完整快照 (V3 三秒撤销后端支撑)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_status",
        domain: "同步",
        desc: "同步状态 (V6 起按 user)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_now",
        domain: "同步",
        desc: "立即同步(某 user, 先推后拉, V6)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_pull_now",
        domain: "同步",
        desc: "拉取合并(某 user)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_force_full",
        domain: "同步",
        desc: "F4: 强制全量重推(清 sync_state, 服务端数据被清后用)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_backends_list",
        domain: "同步",
        desc: "L11: 后端列表(名称+URL+是否当前生效/已连接)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_backend_add",
        domain: "同步",
        desc: "L11: 新增后端(只加列表不切换)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_backend_switch",
        domain: "同步",
        desc: "切换后端(改当前生效 URL; endpoint_key 不匹配时下次同步全量重推)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_backend_toggle",
        domain: "同步",
        desc: "M3 (UX5 #3): 勾选/取消某后端的「同步此后端」(当前主体×该后端一格)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_backend_remove",
        domain: "同步",
        desc: "L11: 删除后端(不能删当前生效的)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_auth_device",
        domain: "同步",
        desc: "V6: ROOT_SECRET/6 位码 换该 user 的 token (协议 v1)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_make_code",
        domain: "同步",
        desc: "V6: 已登录 user 生成 6 位一次性码 (add-device/invite-user)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_pair_qr",
        domain: "同步",
        desc: "P0-C: 手机扫码配对 —— 生成二维码 (独立 device token + worker url)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_revoke_token",
        domain: "同步",
        desc: "P0-C: 踢掉配对设备 token (worker /v1/auth/revoke, 删后即失效)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_disconnect",
        domain: "同步",
        desc: "V6: 断开该 user 的同步 (删该 user 的 token)",
    },
    CommandInfo {
        path: "commands::sync_backend::sync_config_set",
        domain: "同步",
        desc: "配置 CF Worker 同步 (URL + token 存凭据库; 旧兼容面)",
    },
    CommandInfo {
        path: "commands::reader::bookmarks_list",
        domain: "阅读",
        desc: "书签列表(本书全部书签句子)",
    },
    CommandInfo {
        path: "commands::log::log_from_frontend",
        domain: "日志",
        desc: "前端错误/警告落盘",
    },
    CommandInfo {
        path: "commands::log::log_path",
        domain: "日志",
        desc: "当前日志文件路径",
    },
    // ---- 备料任务 (commands/jobs.rs) ----
    CommandInfo {
        path: "commands::jobs::start_prep_job",
        domain: "任务",
        desc: "启动单本任务(支持 batch_id/多语言)",
    },
    CommandInfo {
        path: "commands::jobs::batch_start",
        domain: "任务",
        desc: "批量任务(兼容旧前端, 语义=导入+立即开始)",
    },
    CommandInfo {
        path: "commands::jobs::batch_import",
        domain: "任务",
        desc: "导入批次(只登记书, 不开始处理)",
    },
    CommandInfo {
        path: "commands::jobs::batch_start_prep",
        domain: "任务",
        desc: "开始阅读准备(前置检查→通过的书入队)",
    },
    CommandInfo {
        path: "commands::jobs::batch_list",
        domain: "任务",
        desc: "批次列表",
    },
    CommandInfo {
        path: "commands::jobs::batch_detail",
        domain: "任务",
        desc: "批次详情",
    },
    CommandInfo {
        path: "commands::jobs::job_list",
        domain: "任务",
        desc: "任务列表",
    },
    CommandInfo {
        path: "commands::jobs::job_remove",
        domain: "任务",
        desc: "移除任务",
    },
    CommandInfo {
        path: "commands::jobs::job_retry_failed",
        domain: "任务",
        desc: "重试失败句",
    },
    CommandInfo {
        path: "commands::jobs::job_retry_custom",
        domain: "任务",
        desc: "自定义重跑 (重选模型 + 指定重跑阶段)",
    },
    CommandInfo {
        path: "commands::jobs::job_detail",
        domain: "任务",
        desc: "任务详情 (quality_report.json, 失败原因可读)",
    },
    CommandInfo {
        path: "commands::jobs::cancel_prep_job",
        domain: "任务",
        desc: "K14: 按 id 取消(落 failed, error=用户取消), 不再是无参杀进程不写库",
    },
    CommandInfo {
        path: "commands::jobs::job_pause",
        domain: "任务",
        desc: "暂停任务(运行中→kill子进程保留checkpoint; 排队中→移出队列)",
    },
    CommandInfo {
        path: "commands::jobs::job_resume",
        domain: "任务",
        desc: "继续任务(paused→重新入队, checkpoint 续跑)",
    },
    CommandInfo {
        path: "commands::jobs::pause_all",
        domain: "任务",
        desc: "全部暂停(运行中+排队中)",
    },
    CommandInfo {
        path: "commands::jobs::resume_all",
        domain: "任务",
        desc: "全部继续",
    },
    // ---- 模型/向导 (commands/models.rs) ----
    CommandInfo {
        path: "commands::models::models_list",
        domain: "模型",
        desc: "已安装模型列表",
    },
    CommandInfo {
        path: "commands::models::models_by",
        domain: "模型",
        desc: "某语言某家族的模型(供书级选择)",
    },
    CommandInfo {
        path: "commands::models::models_recommend",
        domain: "模型",
        desc: "推荐组合(导入书时自动带出)",
    },
    CommandInfo {
        path: "commands::models::models_register",
        domain: "模型",
        desc: "登记一个模型(复用扫描后/下载后)",
    },
    CommandInfo {
        path: "commands::models::models_set_recommended",
        domain: "模型",
        desc: "设置推荐",
    },
    CommandInfo {
        path: "commands::models::models_set_family",
        domain: "模型",
        desc: "M4: 存量误登记改家族 (移除旧 id, 按新家族重建, active 保持)",
    },
    CommandInfo {
        path: "commands::models::models_remove",
        domain: "模型",
        desc: "移除模型登记",
    },
    CommandInfo {
        path: "commands::models::models_scan",
        domain: "模型",
        desc: "扫描模型目录→可复用候选",
    },
    CommandInfo {
        path: "commands::models::model_file_check",
        domain: "模型",
        desc: "D (UX 2026-08-11): 探测磁盘上是否已有模型文件 (模型中心三态判据)",
    },
    CommandInfo {
        path: "commands::models::models_bind_book",
        domain: "模型",
        desc: "书级模型绑定",
    },
    CommandInfo {
        path: "commands::models::models_book_binding",
        domain: "模型",
        desc: "读书级绑定(书设置弹窗回显用)",
    },
    CommandInfo {
        path: "commands::models::models_download",
        domain: "模型",
        desc: "下载模型(后台线程, 返回 token 前端轮询状态)",
    },
    CommandInfo {
        path: "commands::models::models_download_status",
        domain: "模型",
        desc: "查询下载任务状态 (done/ok/path/error)",
    },
    CommandInfo {
        path: "commands::models::models_hf_normalize",
        domain: "模型",
        desc: "J4: 自定义模型 —— HF 链接规范成 resolve 直链 + 文件名 (blob 自动转)",
    },
    CommandInfo {
        path: "commands::models::hardware_detect",
        domain: "向导",
        desc: "硬件检测(向导第2步)",
    },
    CommandInfo {
        path: "commands::models::wizard_state",
        domain: "向导",
        desc: "向导状态",
    },
    CommandInfo {
        path: "commands::models::wizard_submit",
        domain: "向导",
        desc: "提交向导步骤",
    },
    CommandInfo {
        path: "commands::models::wizard_finish",
        domain: "向导",
        desc: "向导完成",
    },
    CommandInfo {
        path: "commands::models::wizard_reset",
        domain: "向导",
        desc: "N1: 重新运行首次向导 (重置向导状态到第一步)",
    },
    // ---- 运行时/健康检查 (commands/misc.rs) ----
    CommandInfo {
        path: "commands::misc::runtime_config",
        domain: "运行时",
        desc: "模型路径从 model_registry 解析(单一真相源)",
    },
    CommandInfo {
        path: "commands::misc::app_version",
        domain: "运行时",
        desc: "应用本体版本号(K11: 之前界面完全没有出口显示)",
    },
    CommandInfo {
        path: "commands::misc::components_health",
        domain: "运行时",
        desc: "组件健康检查(prep/ffmpeg/模型是否可用)",
    },
    CommandInfo {
        path: "commands::data_root::library_dir_get",
        domain: "设置",
        desc: "书库位置(数据根)当前生效的绝对路径",
    },
    CommandInfo {
        path: "commands::data_root::library_root_status",
        domain: "设置",
        desc: "UX5 #4: 书库位置健康状态(存在/可写/原因/书库是否在根下) —— 设置页绿色/红色徽章数据源",
    },
    CommandInfo {
        path: "commands::data_root::library_out_consolidate",
        domain: "设置",
        desc: "UX5 修正: 书库(jobs_out)不在数据根下时收拢进数据根(备份+清单校验+重写DB路径+重启清旧)",
    },
    CommandInfo {
        path: "commands::data_root::data_root_recommended",
        domain: "设置",
        desc: "UX5 #4: 首次向导推荐的数据根 (我的文档/aidulc, 含 OneDrive Documents)",
    },
    CommandInfo {
        path: "commands::data_root::library_dir_pick_and_set",
        domain: "设置",
        desc: "UX5 #4: 更改书库位置 = 整根迁移 (config+db+jobs_out+models, 备份+L1清单校验, 重启生效)",
    },
    CommandInfo {
        path: "commands::data_root::library_dir_pick",
        domain: "设置",
        desc: "L7: 仅选择书库目录并返回路径(不改配置)",
    },
    CommandInfo {
        path: "commands::data_root::library_dir_scan",
        domain: "设置",
        desc: "L7: 扫描目录里的成品书包(可导入 N / 已存在 M, 不复制文件)",
    },
    CommandInfo {
        path: "commands::data_root::library_dir_import",
        domain: "设置",
        desc: "L7: 登记扫描到的成品书包到书库(只登记路径, 不移动文件)",
    },
    CommandInfo {
        path: "commands::data_root::data_migration_status",
        domain: "数据",
        desc: "J0: 数据目录现状(数据根/数据库/书库路径 + 是否待迁移)",
    },
    CommandInfo {
        path: "commands::data_root::data_migration_dry_run",
        domain: "数据",
        desc: "J0: 迁移 dry-run(将影响多少项, 用户确认前不改动)",
    },
    CommandInfo {
        path: "commands::data_root::data_migration_run",
        domain: "数据",
        desc: "J0: 执行迁移(备份→复制→校验→写标记, 完成后需重启)",
    },
    CommandInfo {
        path: "commands::online_config::online_config_get",
        domain: "在线引擎",
        desc: "K3: 读在线 AI 配置 (endpoint+model, key 只报是否配置)",
    },
    CommandInfo {
        path: "commands::online_config::online_config_set",
        domain: "在线引擎",
        desc: "K3: 写在线 AI 配置 (key 存 Credential Manager 不落明文)",
    },
    CommandInfo {
        path: "commands::online_config::online_config_test",
        domain: "在线引擎",
        desc: "K3: 在线引擎连通性测试",
    },
    CommandInfo {
        path: "commands::online_config::online_config_clear_key",
        domain: "在线引擎",
        desc: "UX5 #6: 清除在线引擎 API key (删 Credential Manager 里的 key, 清除后两档开关置灰)",
    },
    CommandInfo {
        path: "commands::misc::boot_ping",
        domain: "运行时",
        desc: "boot 探针(开发用: 验证进程活着)",
    },
    CommandInfo {
        path: "commands::misc::doc_parser_install",
        domain: "运行时",
        desc: "一键安装文档解析器 PyMuPDF(开发环境 venv)",
    },
    // ---- 设置/Profile/阅读状态/传输 (ipc/commands.rs) ----
    CommandInfo {
        path: "ipc::commands::profile_upsert",
        domain: "Profile",
        desc: "写入/更新 profile",
    },
    CommandInfo {
        path: "ipc::commands::profile_list",
        domain: "Profile",
        desc: "profile 列表",
    },
    CommandInfo {
        path: "ipc::commands::profile_delete",
        domain: "Profile",
        desc: "删除自建档案 (内建 default 不允许删)",
    },
    CommandInfo {
        path: "ipc::commands::users_list",
        domain: "身份",
        desc: "用户列表 (V1: 顶栏切人数据源)",
    },
    CommandInfo {
        path: "ipc::commands::users_create",
        domain: "身份",
        desc: "新建本地成员 (S4: 顶栏下拉'＋ 新建成员'; 新成员无 token, 同步显示未连接)",
    },
    CommandInfo {
        path: "ipc::commands::users_delete",
        domain: "身份",
        desc: "删除当前用户 (仅空用户可删: 名下 7 张数据表无行, 且至少保留一个)",
    },
    CommandInfo {
        path: "ipc::commands::highlights_list",
        domain: "摘录",
        desc: "某本书的全部摘录 (按 章/句序 排)",
    },
    CommandInfo {
        path: "ipc::commands::highlights_save",
        domain: "摘录",
        desc: "保存摘录 (同 id 覆盖)",
    },
    CommandInfo {
        path: "ipc::commands::highlights_remove",
        domain: "摘录",
        desc: "删除摘录",
    },
    CommandInfo {
        path: "ipc::commands::reading_save",
        domain: "阅读状态",
        desc: "保存阅读进度/书签/播放位置",
    },
    CommandInfo {
        path: "ipc::commands::reading_get",
        domain: "阅读状态",
        desc: "读取阅读进度",
    },
    CommandInfo {
        path: "ipc::commands::reading_stats",
        domain: "阅读状态",
        desc: "某书近 N 天每日阅读时长 (今日已读 X 分钟)",
    },
    CommandInfo {
        path: "ipc::commands::settings_upsert",
        domain: "设置",
        desc: "写入阅读器设置",
    },
    CommandInfo {
        path: "ipc::commands::settings_get",
        domain: "设置",
        desc: "读取阅读器设置",
    },
    CommandInfo {
        path: "ipc::commands::transfer_export",
        domain: "数据迁移",
        desc: "导出 .aidu-data(与 AIDU v3 备份兼容; scope 可选, 只导出勾选的类别)",
    },
    CommandInfo {
        path: "ipc::commands::transfer_import",
        domain: "数据迁移",
        desc: "导入 .aidu-data",
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    /// 从 main.rs 源码里把 generate_handler![...] 的参数列表文本抠出来,
    /// 和 COMMANDS 逐条比对(排序后按集合比较)。这样新增/删除/改名 command 时,
    /// 忘了同步这份清单会直接测试失败, 不依赖人肉核对。
    #[test]
    fn registry_matches_generate_handler() {
        let main_src = include_str!("../main.rs");
        let marker = "tauri::generate_handler![";
        let start = main_src.find(marker).expect(
            "main.rs 里找不到 tauri::generate_handler![ 调用, registry.rs 的比对逻辑需要同步更新",
        );
        let after = &main_src[start + marker.len()..];
        let end = after
            .find(']')
            .expect("找不到 generate_handler! 参数列表的结束 ]");
        let block = &after[..end];

        let mut registered: Vec<&str> = block
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        registered.sort_unstable();

        let mut listed: Vec<&str> = COMMANDS.iter().map(|c| c.path).collect();
        listed.sort_unstable();

        assert_eq!(
            registered, listed,
            "ipc/registry.rs 的 COMMANDS 清单与 main.rs 的 generate_handler! 实际注册集合不一致 \
             —— 新增/删除/改名 command 时两边都要改"
        );
    }

    #[test]
    fn no_duplicate_paths() {
        let mut paths: Vec<&str> = COMMANDS.iter().map(|c| c.path).collect();
        let before = paths.len();
        paths.sort_unstable();
        paths.dedup();
        assert_eq!(paths.len(), before, "COMMANDS 里有重复登记的命令路径");
    }

    #[test]
    fn every_entry_has_non_empty_desc() {
        for c in COMMANDS {
            assert!(!c.desc.trim().is_empty(), "{} 缺少说明", c.path);
            assert!(!c.domain.trim().is_empty(), "{} 缺少所属域", c.path);
        }
    }

    /// R0(2026-08-07): 前端调用了不存在的 command 是这次回归的根因之一——
    /// 旧的 reader_view.js 直接读 `bookpack.chapters[i].sentences`, 根本不知道
    /// load_bookpack_chapter 这个新命令存在, 而 Rust 端两个命令都注册着, 所以
    /// `registry_matches_generate_handler` 完全抓不到这个问题(它只管 Rust 内部两份
    /// 名单一致, 管不到前端)。
    ///
    /// 这里扫描 reader/ 下所有 .js 里的 `invoke('command_name')` 字面量, 断言每个
    /// 都能在 COMMANDS 里找到 —— 前端调一个不存在/改名了的命令会直接测试失败。
    /// 排除 `plugin:*`(Tauri 插件命令不在本仓库 COMMANDS 清单里)。
    #[test]
    fn every_frontend_invoke_is_registered() {
        use std::path::Path;

        let reader_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../reader");
        assert!(
            reader_root.is_dir(),
            "reader/ 目录不存在: {}",
            reader_root.display()
        );

        let mut js_files: Vec<std::path::PathBuf> = Vec::new();
        let mut stack = vec![reader_root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for e in entries.flatten() {
                let p = e.path();
                // M7 R38: 跳过 node_modules —— 校验只针对应用代码, 不扫第三方库
                if p.is_dir() {
                    if p.file_name().and_then(|n| n.to_str()) == Some("node_modules") {
                        continue;
                    }
                    stack.push(p);
                } else if p.extension().and_then(|e| e.to_str()) == Some("js") {
                    js_files.push(p);
                }
            }
        }

        let mut invoked: Vec<String> = Vec::new();
        for f in &js_files {
            let Ok(src) = std::fs::read_to_string(f) else {
                continue;
            };
            // invoke('cmd', ...) 或 invoke("cmd", ...) 字面量第一参数
            for m in regex_like_invoke(&src) {
                if m.starts_with("plugin:") {
                    continue;
                }
                invoked.push(m);
            }
        }

        let listed: Vec<&str> = COMMANDS.iter().map(|c| c.path).collect();
        // COMMANDS.path 形如 "commands::library::load_bookpack", 前端 invoke 名是最后一段
        let registered: std::collections::HashSet<&str> = listed
            .iter()
            .map(|p| p.rsplit("::").next().unwrap_or(p))
            .collect();

        let missing: Vec<&str> = invoked
            .iter()
            .map(|c| c.as_str())
            .filter(|c| !registered.contains(c))
            .collect();
        assert!(
            missing.is_empty(),
            "前端 invoke 了未登记的命令: {:?} ({} 个)\n\
             —— 新增/改名 command 时, 要么同步 ipc/registry.rs 的 COMMANDS,\n\
             要么前端调用已登记的另一个命令",
            missing,
            missing.len()
        );

        // F29 (2026-08-08): 补参数名校验 —— 前端 invoke 的 arg 键 (camelCase) 经 camel→snake
        // 后必须覆盖 Rust 命令函数的每个非 State 参数。拼错键会静默传 undefined, 命令名测试
        // 照常绿, 运行时行为错。
        let arg_mismatches = check_arg_keys(&js_files, &listed);
        assert!(
            arg_mismatches.is_empty(),
            "前端 invoke 参数与 Rust 函数签名不一致:\n{}\n—— 检查前端 invoke 的 arg 键拼写",
            arg_mismatches.join("\n")
        );
    }

    /// F29: 解析 Rust fn 的参数名 (跳过 State/AppHandle 注入参数)。
    /// 按顶层逗号拆分 —— 跟踪 `< >` 深度, 泛型内的逗号 (如 `State<'_, T>`) 不切断参数
    /// (S0 2026-08-10: async 命令带生命周期注解 `State<'_, T>` 后 naive split 会误把
    /// `crate`/`store` 当参数名, 让门禁假失败)。
    fn rust_fn_params(src: &str, fn_name: &str) -> Vec<String> {
        let needle = format!("fn {fn_name}(");
        let Some(pos) = src.find(&needle) else {
            return vec![];
        };
        let after = &src[pos + needle.len()..];
        let Some(end) = after.find(')') else {
            return vec![];
        };
        let mut params: Vec<&str> = Vec::new();
        let mut depth = 0usize;
        let mut start = 0usize;
        for (i, ch) in after[..end].char_indices() {
            match ch {
                '<' | '[' | '(' => depth += 1,
                '>' | ']' | ')' => depth = depth.saturating_sub(1),
                ',' if depth == 0 => {
                    params.push(&after[start..i]);
                    start = i + 1;
                }
                _ => {}
            }
        }
        params.push(&after[start..end]);
        params
            .into_iter()
            .filter_map(|p| {
                let p = p.trim();
                if p.is_empty() {
                    return None;
                }
                let Some(colon) = p.find(':') else {
                    return None;
                };
                let ty = p[colon + 1..].trim();
                let name = p[..colon].trim().trim_start_matches("mut ").trim();
                // Tauri 注入的 State/AppHandle 参数不来自前端; Option 参数可省略
                if ty.contains("State")
                    || name == "app"
                    || ty.contains("AppHandle")
                    || ty.contains("Option")
                {
                    return None;
                }
                if name.is_empty() {
                    return None;
                }
                Some(name.to_string())
            })
            .collect()
    }

    /// F29: 前端 camelCase 键 → Rust snake_case
    fn camel_to_snake(s: &str) -> String {
        let mut out = String::new();
        for (i, c) in s.chars().enumerate() {
            if c.is_uppercase() {
                if i > 0 {
                    out.push('_');
                }
                out.push(c.to_ascii_lowercase());
            } else {
                out.push(c);
            }
        }
        out
    }

    /// F29: 对所有 invoke 调用, 校验其字面量参数对象键覆盖 Rust fn 的非 State 参数。
    /// 返回不一致清单 (空 = 一致)。
    fn check_arg_keys(js_files: &[std::path::PathBuf], listed: &[&str]) -> Vec<String> {
        let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut problems: Vec<String> = Vec::new();
        for f in js_files {
            let Ok(src) = std::fs::read_to_string(f) else {
                continue;
            };
            for (cmd, keys) in invoke_with_args(&src) {
                if cmd.starts_with("plugin:") {
                    continue;
                }
                // 找 COMMANDS 里的 path
                let Some(path) = listed
                    .iter()
                    .find(|p| p.rsplit("::").next().map(|n| n == &cmd).unwrap_or(false))
                else {
                    continue; // 命令名本身已在上一个测试校验
                };
                let Some((rel, fn_name)) = command_path_to_file(path) else {
                    continue;
                };
                let rs_path = src_root.join(rel);
                let Ok(rs) = std::fs::read_to_string(&rs_path) else {
                    continue;
                };
                let params = rust_fn_params(&rs, &fn_name);
                let js_snake: std::collections::HashSet<String> =
                    keys.iter().map(|k| camel_to_snake(k)).collect();
                for p in &params {
                    if !js_snake.contains(p) {
                        problems.push(format!(
                            "  {}: 前端 invoke('{cmd}') 缺参数 '{p}' (JS 键: {:?})",
                            f.file_name().unwrap_or_default().to_string_lossy(),
                            keys
                        ));
                    }
                }
            }
        }
        problems
    }

    /// F29: COMMANDS.path → (相对 src 的 .rs 文件, fn 名)
    fn command_path_to_file(path: &str) -> Option<(String, String)> {
        let mut parts: Vec<&str> = path.split("::").collect();
        let fn_name = parts.pop()?.to_string();
        let rel = format!("{}.rs", parts.join("/"));
        Some((rel, fn_name))
    }

    /// F29: 从 JS 源码抠 `invoke('cmd', { key1, key2: v, ... })` 的命令名 + 参数对象键。
    fn invoke_with_args(src: &str) -> Vec<(String, Vec<String>)> {
        let mut out = Vec::new();
        let bytes = src.as_bytes();
        let mut i = 0;
        // 实测坑 (M7 R38): b"invoke(" 是 7 字节, 原切片 [i..i+6] 恒不相等 → 空转
        while i + 7 <= bytes.len() {
            if &bytes[i..i + 7] == b"invoke(" {
                let mut j = i + 7;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                let mut cmd = String::new();
                if j < bytes.len() && (bytes[j] == b'\'' || bytes[j] == b'"') {
                    let quote = bytes[j];
                    let mut k = j + 1;
                    while k < bytes.len() && bytes[k] != quote {
                        cmd.push(bytes[k] as char);
                        k += 1;
                    }
                    j = k + 1;
                }
                // 跳过到逗号, 找参数对象
                while j < bytes.len() && bytes[j] != b',' {
                    j += 1;
                }
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                let mut keys = Vec::new();
                if j < bytes.len() && bytes[j] == b'{' {
                    // 解析顶层对象键: 标识符 (后跟 ':' 则跳过其值, 或 ',' 或 '}')
                    let mut k = j + 1;
                    loop {
                        if k >= bytes.len() {
                            break;
                        }
                        let c = bytes[k];
                        if c == b'}' {
                            break;
                        }
                        if c.is_ascii_whitespace() || c == b',' {
                            k += 1;
                            continue;
                        }
                        // 键标识符
                        let start = k;
                        while k < bytes.len()
                            && (bytes[k].is_ascii_alphanumeric()
                                || bytes[k] == b'_'
                                || bytes[k] == b'$')
                        {
                            k += 1;
                        }
                        if k > start {
                            keys.push(String::from_utf8_lossy(&bytes[start..k]).to_string());
                        } else {
                            k += 1; // 跳过非标识符 (如字符串键, 跳过)
                            continue;
                        }
                        // 跳过 ':' 后的值 (到下一个顶层 ',' 或 '}', 兼容嵌套/字符串)
                        while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                            k += 1;
                        }
                        if k < bytes.len() && bytes[k] == b':' {
                            k += 1;
                            let mut depth = 0usize;
                            let mut in_str = false;
                            let mut quote = 0u8;
                            while k < bytes.len() {
                                let cc = bytes[k];
                                if in_str {
                                    if cc == quote && bytes.get(k.wrapping_sub(1)) != Some(&b'\\') {
                                        in_str = false;
                                    }
                                    k += 1;
                                    continue;
                                }
                                match cc {
                                    b'\'' | b'"' => {
                                        in_str = true;
                                        quote = cc;
                                    }
                                    b'{' | b'[' | b'(' => depth += 1,
                                    b'}' | b']' | b')' => {
                                        if depth == 0 {
                                            break; // 对象结束
                                        }
                                        depth -= 1;
                                    }
                                    b',' => {
                                        if depth == 0 {
                                            break;
                                        }
                                    }
                                    _ => {}
                                }
                                k += 1;
                            }
                        }
                    }
                }
                if !cmd.is_empty() {
                    out.push((cmd, keys));
                }
                i = j;
            } else {
                i += 1;
            }
        }
        out
    }

    /// 从 JS 源码里抠 `invoke('xxx'` / `invoke("xxx"` 的字面量命令名 (极简状态机,
    /// 不引入 regex 依赖)。返回命令名列表。
    fn regex_like_invoke(src: &str) -> Vec<String> {
        let mut out = Vec::new();
        let bytes = src.as_bytes();
        let mut i = 0;
        // 实测坑 (M7 R38): b"invoke(" 是 7 字节, 原代码切片 [i..i+6] 是 6 字节,
        // 恒不相等 → 校验一直空转。必须 [i..i+7] + i+7<=len。
        while i + 7 <= bytes.len() {
            // 找 "invoke(" 字样
            if &bytes[i..i + 7] == b"invoke(" {
                let mut j = i + 7;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && (bytes[j] == b'\'' || bytes[j] == b'"') {
                    let quote = bytes[j];
                    let mut k = j + 1;
                    let mut name = String::new();
                    while k < bytes.len() && bytes[k] != quote {
                        name.push(bytes[k] as char);
                        k += 1;
                    }
                    out.push(name);
                }
                i = j;
            } else {
                i += 1;
            }
        }
        out
    }

    #[test]
    fn f29_parser_extracts_args_and_params() {
        // F29: 解析器不是空转 —— 必须真能抠出参数键和 Rust 参数
        let calls = invoke_with_args(
            "AiduBridge.invoke('settings_get', { profileId }); invoke('batch_import', { bookPaths: p, profile, sourceLanguage: 'en' });",
        );
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "settings_get");
        assert_eq!(calls[0].1, vec!["profileId"]);
        assert_eq!(calls[1].0, "batch_import");
        assert_eq!(calls[1].1, vec!["bookPaths", "profile", "sourceLanguage"]);
        assert_eq!(camel_to_snake("profileId"), "profile_id");
        assert_eq!(camel_to_snake("bookPaths"), "book_paths");

        let rs = "pub fn settings_get(db: State<Db>, profile_id: String) -> Result<ReaderSettings, String> { }";
        assert_eq!(rust_fn_params(rs, "settings_get"), vec!["profile_id"]);
    }

    /// S0 (2026-08-10): async 命令带生命周期注解 `State<'_, T>` 时, naive split(',')
    /// 会把泛型内逗号切断成假参数 (`crate`/`store`), 让门禁误报缺参数。bracket 深度
    /// 感知的拆分必须能正确只取 book_id。
    #[test]
    fn f29_parser_handles_lifetime_state_generics() {
        let rs = "pub async fn library_preview(\n    cfg: State<'_, crate::PrepConfig>,\n    db: State<'_, store::Db>,\n    book_id: String,\n) -> Result<serde_json::Value, String> { }";
        assert_eq!(rust_fn_params(rs, "library_preview"), vec!["book_id"]);

        let rs2 = "pub async fn components_health(\n    cfg: State<'_, PrepConfig>,\n    db: State<'_, crate::store::Db>,\n) -> Result<serde_json::Value, String> { }";
        let params2 = rust_fn_params(rs2, "components_health");
        assert!(params2.is_empty(), "State 参数都应跳过, 实测: {params2:?}");
    }
}
