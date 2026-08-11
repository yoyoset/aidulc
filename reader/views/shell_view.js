/**
 * views/shell_view.js —— 应用壳: 顶部导航 + 路由容器 + 全局错误条
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class ShellView {
    constructor(app) {
      this.app = app;       // #app 根元素
      this.router = null;   // 由 setRouter 补接 (main.js: render 后建 router)
      this.store = null;    // 由 setStore 补接 (P0-B: 顶栏同步 chip 点击直达设置同步区)
      this.navEl = null;
      this.errorEl = null;
    }

    /** 绑定路由 (main.js 先 render 后创建 router, 这里补接) */
    setRouter(router) {
      this.router = router;
    }

    /** 绑定 store (P0-B, 2026-08-10: 同步 chip 点击 → settingsTab=sync 意图) */
    setStore(store) {
      this.store = store;
    }

    render() {
      this.app.innerHTML = '';

      // 阶段6 设计交付 §01/§10 item 3: 三层导航 —— 左「我的书·生词本」右「导入·处理中(n)」
      // H1 (2026-08-11): 顶栏回到两个每日目的地「我的书 / 生词本」—— 背单词是生词本的
      // 模式 (入口在生词本页「今日队列」卡), 不是第三个 tab (更晚的设计交付确认里顶栏
      // 也只有两项)。
      this.navEl = el('nav', 'app-nav');
      const brand = el('span', 'app-brand', 'aidulc 精读工作站');
      const left = el('div', 'app-nav-links app-nav-left');
      const items = [
        ['library', '我的书'],
        ['vocab', '生词本'],
      ];
      items.forEach(([route, label]) => {
        const a = el('button', 'app-nav-link', label);
        a.dataset.route = route;
        a.onclick = () => this.router.navigate(route);
        left.appendChild(a);
      });
      const right = el('div', 'app-nav-links app-nav-right');
      // 导入: 入口指向书库的导入卡片 (原书导入在 library_view)
      const importBtn = el('button', 'app-nav-link', '导入');
      importBtn.dataset.route = 'library';
      importBtn.onclick = () => {
        this.router.navigate('library');
        // 焦点落到导入卡, 让用户下一步明确
        const card = document.querySelector('.import-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      right.appendChild(importBtn);
      // 处理中(n): 徽章常驻, 无任务显示 0 (设计: 入口不消失, 只去徽章 → 常驻 0)
      const prepBtn = el('button', 'app-nav-link', '处理中');
      prepBtn.dataset.route = 'prep';
      prepBtn.onclick = () => this.router.navigate('prep');
      const badge = el('span', 'nav-count', '0');
      prepBtn.appendChild(badge);
      right.appendChild(prepBtn);
      if (global.AiduJobService) {
        const refresh = () => global.AiduJobService.list().then((res) => {
          if (!res.ok) return;
          const count = (res.data || []).filter((job) => ['queued', 'running', 'paused'].includes(job.status)).length;
          badge.textContent = String(count);
        });
        refresh();
        setInterval(refresh, 5000).unref?.();
      }
      // V1 (2026-08-09): 顶栏切人 —— user ≠ profile, 切人 = 换当前 user (生词/进度各看各的)
      // S4 (2026-08-10): 单用户时下拉不是死控件 —— 加"＋ 新建成员"; 选项文字不硬拼 ▾
      // (原生 select 自带箭头); 取消新建时 value 回滚 (不悬停在空选项上)。
      if (global.AiduUserService) {
        const userSel = el('select', 'app-nav-link nav-user-select');
        userSel.title = '切换用户';
        const NEW_USER_VALUE = '__new__';
        const renderUsers = (users) => {
          userSel.innerHTML = '';
          users.forEach((u) => {
            const opt = el('option', null, u.name || u.id);
            opt.value = u.id;
            userSel.appendChild(opt);
          });
          // S4: 新建成员项 (任何用户数下都放, 不只是单用户 —— 双成员也能加第三个)
          const newOpt = el('option', null, '＋ 新建成员');
          newOpt.value = NEW_USER_VALUE;
          userSel.appendChild(newOpt);
          userSel.value = AiduUserService.currentId();
        };
        const usersRefresh = () => {
          AiduUserService.list().then((res) => {
            if (!res.ok) return;
            renderUsers(res.data || []);
          });
        };
        usersRefresh();
        userSel.onchange = () => {
          if (userSel.value === NEW_USER_VALUE) {
            // S4: 新建成员 —— 弹名字, 取消则回滚到当前 user
            const name = (global.window.prompt ? window.prompt('新成员名字 (如"孩子"):', '') : null) || '';
            if (!name.trim()) {
              userSel.value = AiduUserService.currentId(); // 回滚, 不悬停空选项
              return;
            }
            AiduUserService.create(name.trim()).then((r) => {
              if (!r.ok) {
                userSel.value = AiduUserService.currentId();
                // 后台失败必须可见
                if (typeof AiduToast !== 'undefined') AiduToast.show('新建成员失败: ' + r.error, 'error');
                return;
              }
              const nu = r.data;
              AiduUserService.setCurrent(nu.id);
              usersRefresh(); // 重新 list, 顶栏出现新成员
              // S4: 新成员没有 token → 同步未连接是正确行为, 明示下一步
              if (typeof AiduToast !== 'undefined') {
                AiduToast.show('已新建「' + nu.name + '」。这位成员还没连同步, 去设置页邀请。', 'info');
              }
              if (this.router) {
                const hash = (window.location.hash || '#/library').replace('#/', '');
                this.router.navigate(hash);
              }
            });
            return;
          }
          AiduUserService.setCurrent(userSel.value);
          usersRefresh();
          // 同路由强制刷新当前视图, 让新 user 的数据立即上屏
          if (this.router) {
            const hash = (window.location.hash || '#/library').replace('#/', '');
            this.router.navigate(hash);
          }
        };
        right.appendChild(userSel);
        // 切人广播 → 刷新顶栏选中值
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('aidulc:user-changed', () => {
            if (global.AiduUserService) userSel.value = AiduUserService.currentId();
          });
        }
      }
      // V6 (2026-08-09): 顶栏同步状态四态 (已同步 / N 条待推 / 离线 / 失败), 只改数字不转圈
      if (global.AiduSyncService && global.AiduUserService) {
        const syncChip = el('span', 'nav-sync-chip', '');
        // P0-B (2026-08-10): 文案从"未配置"改成"同步未连接" (未配置对用户零信息),
        // 点击直达设置页"同步与数据"tab, 让未连接的用户知道去哪配。
        syncChip.title = '背单词同步状态 · 点击进入同步设置';
        right.appendChild(syncChip);
        syncChip.onclick = () => {
          if (this.store) this.store.set({ settingsTab: 'sync' });
          if (this.router) this.router.navigate('settings');
        };
        const refreshSync = () => {
          AiduSyncService.status().then((res) => {
            if (!res.ok || !res.data) return;
            const d = res.data;
            const cls = 'nav-sync-' + (d.status || 'unconfigured');
            syncChip.className = 'nav-sync-chip ' + cls;
            if (d.status === 'synced') syncChip.textContent = '已同步';
            else if (d.status === 'pending') syncChip.textContent = d.pending_count + ' 条待推';
            else if (d.status === 'offline') syncChip.textContent = '离线';
            else if (d.status === 'failed') syncChip.textContent = '同步失败';
            else syncChip.textContent = '同步未连接';
          });
        };
        refreshSync();
        setInterval(refreshSync, 30000).unref?.();
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('aidulc:user-changed', () => setTimeout(refreshSync, 50));
        }
      }
      const settingsBtn = el('button', 'app-nav-link app-nav-settings', '设置');
      settingsBtn.dataset.route = 'settings';
      settingsBtn.setAttribute('aria-label', '打开设置');
      settingsBtn.onclick = () => this.router.navigate('settings');
      right.appendChild(settingsBtn);
      this.navEl.append(brand, left, right);

      // 全局错误条 (3.5: 后台失败必须可见)
      this.errorEl = el('div', 'global-error');
      this.errorEl.style.display = 'none';

      // 路由容器
      this.viewContainer = el('div', 'app-view');

      this.app.append(this.navEl, this.errorEl, this.viewContainer);
    }

    showError(msg) {
      this.errorEl.textContent = msg;
      this.errorEl.style.display = 'block';
    }

    clearError() {
      this.errorEl.style.display = 'none';
    }

    getViewContainer() {
      return this.viewContainer;
    }

    /** H1: 顶栏元素 (专注模式隐藏用) */
    getNavEl() {
      return this.navEl;
    }

    setActiveNav(route) {
      this.navEl.querySelectorAll('.app-nav-link').forEach(b => {
        b.classList.toggle('active', b.dataset.route === route);
      });
    }
  }

  global.ShellView = ShellView;
})(window);
