/**
 * core/reader_state.js —— 阅读器状态机 (纯逻辑, 零 DOM, S5)
 *
 * 三显示模式 (不合并、不择一, 共用同一套正文 DOM):
 *   'guess'  先答后核 —— 当前句下方提示"先自己讲一遍"; 揭示后内联展开, 离开折叠成细痕
 *   'silent' 静默正文 —— 只有英文; T 浮卡片 (卡片由 view 层管, 本模块只记账)
 *   'bench'  对照台   —— 右栏常显当前句支撑; 左栏正文干净
 * 正交节奏轴 (与模式自由组合):
 *   'flow'     通篇连续朗读推进
 *   'sentence' 逐句跟读 —— 非当前句压暗 + 底部跟读条
 *
 * 揭示状态 (先答后核模式): 每句一个「已核对」位 (持久化, 宿主按章注入/回写)。
 *   - 首次揭示 → 标记已核对 (测试效应/提取练习: 收益来自「先说出自己的理解再核对」这个动作)
 *   - 离开已揭示句 → 折叠成 2px 细痕
 *   - 再次读到已核对句 → 默认折叠细痕, 提示变「已核对过」
 * 不在这里做 DOM/持久化, 只产出决策, 让宿主照做。可单测。
 */
(function (global) {
  'use strict';

  const DISPLAY_MODES = ['guess', 'silent', 'bench'];
  const PACES = ['flow', 'sentence'];

  // 支撑状态的视觉档位:
  //   'hidden'   无支撑内容, 只有提示行
  //   'revealed' 支撑内联展开 (带左标线)
  //   'scar'     折叠成 2px 细痕
  const SUPPORT_STATES = ['hidden', 'revealed', 'scar'];

  class ReaderState {
    constructor(opts = {}) {
      this.displayMode = DISPLAY_MODES.includes(opts.displayMode) ? opts.displayMode : 'guess';
      this.pace = PACES.includes(opts.pace) ? opts.pace : 'flow';
      this._verified = new Set();   // 已核对句 (持久化, 宿主 restore 注入)
      this._revealed = new Set();   // 本访连续揭示中的句 (离开/手动收起即移除)
      this._current = -1;           // 当前句 (锚点)
    }

    setMode(m) {
      if (!DISPLAY_MODES.includes(m)) return false;
      this.displayMode = m;
      return true;
    }

    setPace(p) {
      if (!PACES.includes(p)) return false;
      this.pace = p;
      return true;
    }

    togglePace() {
      this.pace = this.pace === 'flow' ? 'sentence' : 'flow';
      return this.pace;
    }

    /** 宿主在打开一章时注入该章已核对集合 (Set<number>) */
    restoreVerified(set) {
      this._verified = new Set(set || []);
    }

    /** 回写给宿主落盘用的数组 */
    verifiedArray() {
      return Array.from(this._verified).sort((a, b) => a - b);
    }

    verifiedCount() {
      return this._verified.size;
    }

    isVerified(i) {
      return this._verified.has(i);
    }

    isRevealed(i) {
      return this._revealed.has(i);
    }

    /**
     * 揭示某句。返回 { newlyVerified } —— 宿主发现 newlyVerified 时落盘。
     * 首次揭示即记「已核对」。
     */
    reveal(i) {
      const newlyVerified = !this._verified.has(i);
      this._verified.add(i);
      this._revealed.add(i);
      return { newlyVerified };
    }

    /** 手动收起 / 离开当前句 */
    collapse(i) {
      this._revealed.delete(i);
    }

    setCurrent(i) {
      this._current = i;
    }

    get current() {
      return this._current;
    }

    /**
     * 某句成为当前句时应呈现的支撑状态 (策略, 可单测)。
     *   guess: 本访正揭示 → revealed; 否则已核对 → scar; 否则 hidden
     *   silent/bench: 译文不内联出现 → hidden (silent 走卡片, bench 走右栏)
     */
    supportFor(mode, index) {
      const m = mode || this.displayMode;
      if (m === 'guess') {
        if (this._revealed.has(index)) return 'revealed';
        if (this._verified.has(index)) return 'scar';
        return 'hidden';
      }
      return 'hidden';
    }

    /** 当前句下方那行常在的小字提示 (本身即快捷键说明) */
    hintFor(mode, index) {
      const m = mode || this.displayMode;
      if (m === 'guess') {
        return this.isVerified(index) ? '已核对过 · Enter 再看' : '先自己讲一遍 · Enter 核对';
      }
      if (m === 'silent') return 'T 调出支撑卡片';
      return ''; // 对照台: 支撑在右栏, 正文下方不重复提示
    }

    /** 离开某句时宿主该把它折叠到什么状态 */
    onLeave(mode, index) {
      this.collapse(index);
      return mode === 'guess' ? 'scar' : 'hidden';
    }
  }

  ReaderState.DISPLAY_MODES = DISPLAY_MODES;
  ReaderState.PACES = PACES;
  ReaderState.SUPPORT_STATES = SUPPORT_STATES;

  global.AiduReaderState = ReaderState;
})(window);
