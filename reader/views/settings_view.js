/**
 * views/settings_view.js —— 设置: 字体/行距/宽度/主题/儿童模式 (P2 数据已就绪)
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class SettingsView {
    constructor(store) {
      this.store = store;
    }

    render(container) {
      container.innerHTML = '';
      const wrap = el('div', 'settings-view');
      wrap.appendChild(el('h1', null, '设置'));
      const tabbar = el('div', 'settings-tabs');
      const panes = el('div', 'settings-panes');
      const paneMap = {};
      const addTab = (id, label) => {
        const pane = el('div', 'settings-pane');
        pane.dataset.tab = id;
        paneMap[id] = pane;
        panes.appendChild(pane);
        const tab = el('button', 'settings-tab', label);
        tab.type = 'button';
        tab.dataset.tab = id;
        tab.onclick = () => {
          tabbar.querySelectorAll('.settings-tab').forEach((x) => x.classList.remove('active'));
          panes.querySelectorAll('.settings-pane').forEach((x) => x.classList.remove('active'));
          tab.classList.add('active');
          pane.classList.add('active');
        };
        tabbar.appendChild(tab);
        return pane;
      };
      const systemPane = addTab('system', '系统与书库');
      const readingPane = addTab('reading', '阅读显示');
      const learningPane = addTab('learning', '学习档案');
      const syncPane = addTab('sync', '同步与数据');
      // J9 (2026-08-11): 五个 tab 定名 —— 模型中心并入依赖成为「模型与依赖」
      const modelsPane = addTab('models', '模型与依赖');
      if (global.ModelsView) {
        new global.ModelsView(this.store).render(modelsPane);
      }
      tabbar.querySelector('.settings-tab').classList.add('active');
      paneMap.system.classList.add('active');
      // UX 审计 (2026-08-09): 支持外部直达指定 tab (如"去模型中心"按钮) —— 一次性意图,
      // 用掉后清除, 下次进设置回到默认 tab。
      const wantedTab = this.store.state.settingsTab;
      if (wantedTab && paneMap[wantedTab]) {
        this.store.set({ settingsTab: null });
        tabbar.querySelectorAll('.settings-tab').forEach((x) => x.classList.remove('active'));
        panes.querySelectorAll('.settings-pane').forEach((x) => x.classList.remove('active'));
        const wantedTabBtn = tabbar.querySelector(`.settings-tab[data-tab="${wantedTab}"]`);
        if (wantedTabBtn) wantedTabBtn.classList.add('active');
        paneMap[wantedTab].classList.add('active');
      }
      const settingsLayout = el('div', 'settings-layout');
      settingsLayout.append(tabbar, panes);
      wrap.appendChild(settingsLayout);

      // 治理 (2026-08-13, docs/GOAL_2026-08-13_FILESIZE.md): 5 个 tab 的渲染逻辑已拆到
      // reader/views/settings/*.js (system_tab.js/models_tab.js/sync_tab.js/
      // profiles_tab.js/reading_tab.js), 原来 889 行的巨型 render() 现在只做 tab 骨架 + 分发。
      new global.SettingsSystemTab().render(systemPane, this.store);
      new global.SettingsModelsCompSec().render(modelsPane);
      new global.SettingsProfilesTab().render(learningPane);
      new global.SettingsSyncTab().render(syncPane);
      new global.SettingsReadingTab().render(readingPane);

      container.appendChild(wrap);
    }

    // 治理: _saveReadingSettings/_applyCss 已挪进 reader/views/settings/reading_tab.js
    // (SettingsReadingTab), 只有阅读显示 tab 用到。PALETTES/VOICES 仍留在这里——是跨
    // tab(阅读显示 + 学习档案)共用的静态数据, 运行时按 SettingsView.PALETTES/VOICES 全局引用。

    /** 主题色系表 (key, 中文标签, 色块 var) —— M7 色块选择器共用 */
    static get PALETTES() {
      return [
        ['clay', '陶土 · 暖', 'var(--swatch-clay)'],
        ['sage', '青苔 · 自然', 'var(--swatch-sage)'],
        ['ocean', '海蓝 · 专注', 'var(--swatch-ocean)'],
        ['rose', '蔷薇 · 温柔', 'var(--swatch-rose)'],
        ['slate', '灰蓝 · 克制', 'var(--swatch-slate)'],
      ];
    }

    /** 音色候选 (可用性取决于已装模型, 保留提示; 单一真相源 core/builtin_profiles) */
    static get VOICES() {
      return AiduBuiltinProfiles.VOICES;
    }
  }

  global.SettingsView = SettingsView;
})(window);
