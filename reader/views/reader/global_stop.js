/**
 * views/reader/global_stop.js —— 浮动全局播放/停止按钮 (UX7 #2)
 * 只订阅 player.playing 状态、点击调 player.toggle(); 不持有任何播放编排逻辑
 * (stop 后再点 = 从当前句重读, 这个语义 player.toggle()/playFrom() 已经具备,
 * 见 docs/GOAL_2026-08-13_UX7.md 二、#2 复核)。仅当前章有音频时可见。
 */
(function (global) {
  'use strict';

  class GlobalStopButton {
    /** @param {object} deps { onToggle() } */
    constructor(deps) {
      this.deps = deps;
      this.el = document.createElement('button');
      this.el.className = 'rd-global-stop';
      this.el.type = 'button';
      this.el.hidden = true;
      this.el.onclick = () => this.deps.onToggle && this.deps.onToggle();
      this._render(false);
    }

    _render(playing) {
      this.el.textContent = playing ? '⏹' : '▶';
      this.el.title = playing ? '停止 (回到本句开头)' : '播放 (从当前句)';
      this.el.classList.toggle('playing', playing);
    }

    /** 音频 play/pause 事件驱动, 由 reader_view 的 onPlayingChange 转发 */
    setPlaying(playing) {
      this._render(playing);
    }

    /** 当前章有没有音频 (无音频章节不显示) */
    setVisible(visible) {
      this.el.hidden = !visible;
    }
  }

  global.GlobalStopButton = GlobalStopButton;
})(window);
