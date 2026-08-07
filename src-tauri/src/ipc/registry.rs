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
        path: "commands::library::load_bookpack",
        domain: "书库",
        desc: "加载书包(book_id)",
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
        path: "commands::library::book_export",
        domain: "书库",
        desc: "书包导出为 zip(成品资产, 跨设备迁移)",
    },
    CommandInfo {
        path: "commands::library::book_import",
        domain: "书库",
        desc: "导入 zip 书包(解到 out_dir 下新 id, 登记进 books 表)",
    },
    // ---- 阅读/生词/词典/同步/书签/日志 (commands/reader.rs) ----
    CommandInfo {
        path: "commands::reader::word_lookup",
        domain: "阅读",
        desc: "点词查词(本地优先, 侧车不可用/超时→占位兜底)",
    },
    CommandInfo {
        path: "commands::reader::add_vocab",
        domain: "阅读",
        desc: "显式加入生词本",
    },
    CommandInfo {
        path: "commands::reader::dict_list",
        domain: "词典",
        desc: "词典列表(某 profile)",
    },
    CommandInfo {
        path: "commands::reader::dict_search",
        domain: "词典",
        desc: "词典搜索",
    },
    CommandInfo {
        path: "commands::reader::dict_remove",
        domain: "词典",
        desc: "词典删除",
    },
    CommandInfo {
        path: "commands::reader::vocab_all",
        domain: "生词",
        desc: "生词列表",
    },
    CommandInfo {
        path: "commands::reader::vocab_search",
        domain: "生词",
        desc: "生词搜索",
    },
    CommandInfo {
        path: "commands::reader::vocab_remove",
        domain: "生词",
        desc: "删除生词",
    },
    CommandInfo {
        path: "commands::reader::vocab_stats",
        domain: "生词",
        desc: "生词统计",
    },
    CommandInfo {
        path: "commands::reader::sync_status",
        domain: "同步",
        desc: "同步状态",
    },
    CommandInfo {
        path: "commands::reader::sync_now",
        domain: "同步",
        desc: "立即同步(push)",
    },
    CommandInfo {
        path: "commands::reader::sync_pull_now",
        domain: "同步",
        desc: "拉取合并",
    },
    CommandInfo {
        path: "commands::reader::sync_config_set",
        domain: "同步",
        desc: "同步配置(URL+token; token 存 Credential Manager)",
    },
    CommandInfo {
        path: "commands::reader::bookmarks_list",
        domain: "阅读",
        desc: "书签列表(本书全部书签句子)",
    },
    CommandInfo {
        path: "commands::reader::log_from_frontend",
        domain: "日志",
        desc: "前端错误/警告落盘",
    },
    CommandInfo {
        path: "commands::reader::log_path",
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
        desc: "只重跑失败的部分",
    },
    CommandInfo {
        path: "commands::jobs::cancel_prep_job",
        domain: "任务",
        desc: "取消当前运行中的任务",
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
        desc: "下载模型(阻塞式, 大文件前端分步调用)",
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
    // ---- 运行时/健康检查 (commands/misc.rs) ----
    CommandInfo {
        path: "commands::misc::runtime_config",
        domain: "运行时",
        desc: "模型路径从 model_registry 解析(单一真相源)",
    },
    CommandInfo {
        path: "commands::misc::components_health",
        domain: "运行时",
        desc: "组件健康检查(prep/ffmpeg/模型是否可用)",
    },
    CommandInfo {
        path: "commands::misc::library_dir_get",
        domain: "设置",
        desc: "书库位置(当前生效的绝对路径)",
    },
    CommandInfo {
        path: "commands::misc::library_dir_pick_and_set",
        domain: "设置",
        desc: "更改书库位置(自动搬迁旧数据, 重启后生效)",
    },
    CommandInfo {
        path: "commands::misc::boot_ping",
        domain: "运行时",
        desc: "boot 探针(开发用: 验证进程活着)",
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
        desc: "导出 .aidu-data(与 AIDU v3 备份兼容)",
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
}
