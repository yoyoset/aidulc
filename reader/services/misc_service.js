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
    openPath(path) { return AiduBridge.openPath(path); },
    // P1.2: 书库位置("...存放在哪"的产品化入口, 见 docs/ROADMAP.md P1)
    libraryDirGet() { return AiduBridge.invoke('library_dir_get'); },
    libraryDirPickAndSet() { return AiduBridge.invoke('library_dir_pick_and_set'); },
    // R3.4: 一键安装文档解析器 PyMuPDF
    docParserInstall() { return AiduBridge.invoke('doc_parser_install'); },
  };

  global.AiduMiscService = MiscService;
})(window);
