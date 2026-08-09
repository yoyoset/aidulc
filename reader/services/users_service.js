/**
 * services/users_service.js —— 用户维度用例层 (V1 身份模型, 2026-08-09)
 * user = "谁", profile = "讲解策略"。顶栏切人 = 换当前 user, 生词/词典/进度按 user 隔离。
 * 当前 user 存 localStorage (会话持久, 重启保持); 默认 'me' (迁移归集的默认用户)。
 */
(function (global) {
  'use strict';

  const KEY = 'aidulc.current_user';

  const UsersService = {
    list() { return AiduBridge.users.list(); },
    currentId() {
      try {
        return localStorage.getItem(KEY) || 'me';
      } catch (e) {
        return 'me';
      }
    },
    setCurrent(id) {
      try {
        localStorage.setItem(KEY, id);
      } catch (e) { /* 存储不可用时降级为会话内 */ }
      // 广播切人事件: shell 顶栏刷新 + 各视图重渲染 (router 同路由强制刷新)
      try {
        window.dispatchEvent(new CustomEvent('aidulc:user-changed', { detail: { id } }));
      } catch (e) { /* 无事件总线环境 (测试) 时跳过 */ }
    },
    currentName(users) {
      const id = this.currentId();
      const u = (users || []).find((x) => x.id === id);
      return u ? u.name : (id === 'me' ? '我' : id);
    },
  };

  global.AiduUserService = UsersService;
})(window);