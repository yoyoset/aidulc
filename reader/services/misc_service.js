/**
 * services/misc_service.js —— 杂项用例层 (M 系列: 诊断/运行时配置)
 * 承载 settings_view 曾直接裸 invoke 的 log_path / components_health / runtime_config
 */
(function (global) {
  'use strict';

  const MiscService = {
    logPath() { return AiduBridge.invoke('log_path'); },
    componentsHealth() { return AiduBridge.invoke('components_health'); },
    runtimeConfig() { return AiduBridge.invoke('runtime_config'); },
    // K11 (2026-08-14): 应用本体版本号——之前界面完全没有出口显示
    appVersion() { return AiduBridge.invoke('app_version'); },
    openPath(path) { return AiduBridge.openPath(path); },
    // P1.2: 书库位置("...存放在哪"的产品化入口, 见 docs/ROADMAP.md P1)
    libraryDirGet() { return AiduBridge.invoke('library_dir_get'); },
    // UX5 #4 (2026-08-13): 书库位置 = 数据根 —— 健康状态 (存在/可写/原因, 绿/红徽章)
    libraryRootStatus() { return AiduBridge.invoke('library_root_status'); },
    // UX5 修正: 书库(jobs_out)不在数据根下 → 收拢进数据根
    libraryOutConsolidate() { return AiduBridge.invoke('library_out_consolidate'); },
    // UX5 #4: 首次向导推荐的数据根 (我的文档/aidulc)
    dataRootRecommended() { return AiduBridge.invoke('data_root_recommended'); },
    libraryDirPick() { return AiduBridge.invoke('library_dir_pick'); },
    libraryDirPickAndSet(newDir) { return AiduBridge.invoke('library_dir_pick_and_set', { newDir: newDir || null }); },
    // L7 (2026-08-11): 扫描/登记外部书库目录 (不复制不移动文件)
    libraryDirScan(dir) { return AiduBridge.invoke('library_dir_scan', { dir }); },
    libraryDirImport(packs) { return AiduBridge.invoke('library_dir_import', { packs }); },
    // J0 (2026-08-11): 数据目录现状 / 迁移 dry-run / 执行迁移
    dataMigrationStatus() { return AiduBridge.invoke('data_migration_status'); },
    dataMigrationDryRun() { return AiduBridge.invoke('data_migration_dry_run'); },
    dataMigrationRun() { return AiduBridge.invoke('data_migration_run'); },
    // K3 (2026-08-11): 在线 AI 引擎配置 (endpoint + model; key 存 Credential Manager)
    onlineConfigGet() { return AiduBridge.invoke('online_config_get'); },
    onlineConfigSet(endpoint, model, apiKey, lookupEnabled, wholeBookEnabled) {
      return AiduBridge.invoke('online_config_set', {
        endpoint, model, apiKey: apiKey || null,
        lookupEnabled: lookupEnabled == null ? null : !!lookupEnabled,
        wholeBookEnabled: wholeBookEnabled == null ? null : !!wholeBookEnabled,
      });
    },
    onlineConfigTest(endpoint, model, apiKey) { return AiduBridge.invoke('online_config_test', { endpoint, model, apiKey: apiKey || null }); },
    // UX5 #6 (2026-08-13): 清除在线引擎 key (删 Credential Manager 里的 key)
    onlineConfigClearKey() { return AiduBridge.invoke('online_config_clear_key'); },
    // R3.4: 一键安装文档解析器 PyMuPDF
    docParserInstall() { return AiduBridge.invoke('doc_parser_install'); },
    // 2026-08-20: 打开书时探测显卡占用 (用户本地查词被外部 llama-server 挤占显存排查出的功能)
    gpuStatus() { return AiduBridge.invoke('gpu_status'); },
    gpuKillProcess(pid) { return AiduBridge.invoke('gpu_kill_process', { pid }); },
    // 2026-08-21 (查词三层重构, 用户: "设置里增加字典文件的选择"): 导入自定义
    // 词典文件到全局基底 + 查基底统计(种子/自己积累各多少词)。
    // 2026-09-04: dictBaseImportFile 加 label(默认前端传文件名)——每次导入记成
    // 一个可列出/可单独删除的"词典源"(用户: "可以加多个词典")。
    dictBaseImportFile(path, label) { return AiduBridge.invoke('dict_base_import_file', { path, label: label || null }); },
    dictBaseStats() { return AiduBridge.invoke('dict_base_stats'); },
    dictBaseSourcesList() { return AiduBridge.invoke('dict_base_sources_list'); },
    dictBaseSourceDelete(sourceId) { return AiduBridge.invoke('dict_base_source_delete', { sourceId }); },
  };

  global.AiduMiscService = MiscService;
})(window);
