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

  /** L6 (2026-08-11): Material Symbols Rounded 图标 (本地打包字体, 不引 CDN)。
   *  统一顶栏右侧形态: 定宽图标 + tooltip/角标, 不再混用文字按钮与图标按钮。 */
  function icon(name, cls) {
    const i = el('span', 'icon-msr' + (cls ? ' ' + cls : ''), name);
    i.setAttribute('aria-hidden', 'true');
    return i;
  }
  // 顶栏定宽图标按钮: 图标 + 可选数字角标 + tooltip
  function iconBtn(name, tooltip, badgeText) {
    const b = el('button', 'app-nav-icon');
    b.title = tooltip || '';
    b.appendChild(icon(name));
    if (badgeText != null) {
      const badge = el('span', 'nav-count', String(badgeText));
      b.appendChild(badge);
    }
    return b;
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

      // 阶段6 设计交付 §01/§10 item 3: 三层导航 —— 左「我的书·生词本」右「处理中(n)·同步·设置」
      // H1 (2026-08-11): 顶栏回到两个每日目的地「我的书 / 生词本」—— 背单词是生词本的
      // 模式 (入口在生词本页「今日队列」卡), 不是第三个 tab。
      // L6 (2026-08-11): 去掉「导入」(书库页已有导入格, 顶栏再放是重复入口); 右侧统一为
      // 定宽图标形态 (处理中带角标 / 同步状态 / 设置齿轮), 用户选择器「我」放最左紧邻品牌
      // (不定长文字, 放右侧会撑乱图标对齐)。
      this.navEl = el('nav', 'app-nav');
      const brand = el('span', 'app-brand', 'aidulc 精读工作站');
      this.navEl.appendChild(brand);

      // 用户选择器「我」: 紧邻品牌区 (L6 —— 不定长文字不放右侧图标区)
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
            const name = (global.window.prompt ? window.prompt('新成员名字 (如"孩子"):', '') : null) || '';
            if (!name.trim()) {
              userSel.value = AiduUserService.currentId();
              return;
            }
            AiduUserService.create(name.trim()).then((r) => {
              if (!r.ok) {
                userSel.value = AiduUserService.currentId();
                if (typeof AiduToast !== 'undefined') AiduToast.show('新建成员失败: ' + r.error, 'error');
                return;
              }
              const nu = r.data;
              AiduUserService.setCurrent(nu.id);
              usersRefresh();
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
          if (this.router) {
            const hash = (window.location.hash || '#/library').replace('#/', '');
            this.router.navigate(hash);
          }
        };
        this.navEl.appendChild(userSel);
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('aidulc:user-changed', () => {
            if (global.AiduUserService) userSel.value = AiduUserService.currentId();
          });
        }
      }

      // 两个每日目的地 (文字按钮, 与右侧图标按钮区分: 左侧导航是"去哪儿", 右侧是"状态/工具")
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
      // 右侧: 统一定宽图标 (处理中带角标 / 同步状态 / 设置齿轮)
      const right = el('div', 'app-nav-links app-nav-right');
      // 处理中(n): 图标 + 角标常驻 (无任务显示 0)
      const prepBtn = iconBtn('progress_activity', '处理中', '0');
      prepBtn.dataset.route = 'prep';
      prepBtn.onclick = () => this.router.navigate('prep');
      right.appendChild(prepBtn);
      if (global.AiduJobService) {
        const refresh = () => global.AiduJobService.list().then((res) => {
          if (!res.ok) return;
          const count = (res.data || []).filter((job) => ['queued', 'running', 'paused'].includes(job.status)).length;
          const badge = prepBtn.querySelector && prepBtn.querySelector('.nav-count');
          if (badge) badge.textContent = String(count);
        });
        refresh();
        setInterval(refresh, 5000).unref?.();
      }
      // V6 (2026-08-09): 同步状态 —— L6 改成图标 + tooltip, 不用文字块 (离线↔已同步切换
      // 时右侧不因文字长度位移)。
      if (global.AiduSyncService && global.AiduUserService) {
        const syncBtn = iconBtn('cloud_done', '背单词同步状态 · 点击进入同步设置');
        syncBtn.dataset.route = 'settings';
        syncBtn.classList.add('nav-sync');
        right.appendChild(syncBtn);
        syncBtn.onclick = () => {
          if (this.store) this.store.set({ settingsTab: 'sync' });
          if (this.router) this.router.navigate('settings');
        };
        const refreshSync = () => {
          AiduSyncService.status().then((res) => {
            if (!res.ok || !res.data) return;
            const d = res.data;
            const iconEl = syncBtn.querySelector && syncBtn.querySelector('.icon-msr');
            const syncIcon = (name, cls, tip) => {
              if (iconEl) iconEl.textContent = name;
              syncBtn.className = 'app-nav-icon nav-sync nav-sync-' + cls;
              syncBtn.title = tip;
            };
            if (d.status === 'synced') syncIcon('cloud_done', 'synced', '已同步');
            else if (d.status === 'pending') syncIcon('cloud_upload', 'pending', d.pending_count + ' 条待推');
            else if (d.status === 'offline') syncIcon('cloud_off', 'offline', '离线');
            else if (d.status === 'failed') syncIcon('cloud_off', 'failed', '同步失败');
            else syncIcon('cloud_queue', 'unconfigured', '同步未连接');
          });
        };
        refreshSync();
        setInterval(refreshSync, 30000).unref?.();
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('aidulc:user-changed', () => setTimeout(refreshSync, 50));
        }
      }
      // 设置齿轮
      const settingsBtn = iconBtn('settings', '设置');
      settingsBtn.dataset.route = 'settings';
      settingsBtn.setAttribute('aria-label', '设置');
      settingsBtn.onclick = () => this.router.navigate('settings');
        right.appendChild(settingsBtn);
        this.navEl.append(left, right);

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
      this.navEl.querySelectorAll('.app-nav-link, .app-nav-icon').forEach(b => {
        b.classList.toggle('active', b.dataset.route === route);
      });
    }
  }

  global.ShellView = ShellView;
})(window);
