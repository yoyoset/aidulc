/**
 * views/reader/support_panel.js —— 对照台右栏 (S5, 设计 §2.1/§3/§7)
 * 330px 固定右栏, 仅对照台模式存在:
 *   - 结构骨架常显 (prep 尚未拆分讲解两层, 按设计 §7 降级为只显示详解全文)
 *   - 译文按需 (一次点击 / Enter 展开)
 *   - 底部「本章已核对 n / N 句」
 * 右栏只允许承载当前句的四类内容 (设计 §8 防熵增约束的代码层体现)。
 */
(function (global) {
  'use strict';

  class SupportPanel {
    constructor(deps) {
      this.deps = deps; // { onRevealTranslation(), getVerified: () => {n,total} }
      this._translationOpen = false;
      this.el = document.createElement('aside');
      this.el.className = 'rd-bench';
      this.el.id = 'rd-bench';

      const head = document.createElement('div');
      head.className = 'rd-bench-head';
      const title = document.createElement('span');
      title.textContent = '对照';
      head.appendChild(title);
      this.el.appendChild(head);

      // 原文
      this.origEl = document.createElement('div');
      this.origEl.className = 'rd-bench-orig';
      this.el.appendChild(this.origEl);

      // 结构骨架 (降级: 讲解全文)
      const skel = document.createElement('div');
      skel.className = 'rd-bench-section';
      const skelLabel = document.createElement('div');
      skelLabel.className = 'rd-bench-label';
      skelLabel.textContent = '结构骨架';
      this.skelEl = document.createElement('div');
      this.skelEl.className = 'rd-bench-skel';
      skel.append(skelLabel, this.skelEl);
      this.el.appendChild(skel);

      // 译文 (按需)
      const tr = document.createElement('div');
      tr.className = 'rd-bench-section';
      const trLabel = document.createElement('div');
      trLabel.className = 'rd-bench-label rd-bench-tr-label';
      this.trLabelText = document.createElement('span');
      this.trLabelText.textContent = '译文';
      this.trToggle = document.createElement('span');
      this.trToggle.className = 'rd-bench-tr-toggle';
      trLabel.append(this.trLabelText, this.trToggle);
      trLabel.onclick = () => this._toggleTranslation();
      this.trEl = document.createElement('div');
      this.trEl.className = 'rd-bench-tr';
      tr.append(trLabel, this.trEl);
      this.el.appendChild(tr);

      // 已核对计数
      this.countEl = document.createElement('div');
      this.countEl.className = 'rd-bench-count';
      this.el.appendChild(this.countEl);
    }

    _toggleTranslation() {
      this._translationOpen = !this._translationOpen;
      this.el.classList.toggle('tr-open', this._translationOpen);
      this.trToggle.textContent = this._translationOpen ? '收起' : '展开';
      if (!this._translationOpen) {
        // 外部需要知道译文被收起 (view 落盘不必, 但可做状态提示)
      }
    }

    /** 打开 (Enter 键等) */
    openTranslation() {
      if (!this._translationOpen) this._toggleTranslation();
    }

    isTranslationOpen() {
      return this._translationOpen;
    }

    reset() {
      this._translationOpen = false;
      this.el.classList.remove('tr-open');
      this.trToggle.textContent = '展开';
      this.origEl.textContent = '';
      this.skelEl.textContent = '';
      this.trEl.textContent = '';
      this.countEl.textContent = '';
    }

    /**
     * 切到新当前句时刷新。
     * @param {object|null} sentence 当前句; null = 无
     */
    setSentence(sentence) {
      if (!sentence) {
        this.reset();
        return;
      }
      const orig = document.createElement('div');
      orig.textContent = sentence.original_text || '';
      this.origEl.innerHTML = '';
      this.origEl.appendChild(orig);

      this.skelEl.textContent = sentence.explanation || '（本章讲解缺失）';

      const trText = document.createElement('div');
      trText.textContent = sentence.translation || '（译文缺失）';
      this.trEl.innerHTML = '';
      this.trEl.appendChild(trText);

      const v = this.deps.getVerified && this.deps.getVerified();
      if (v) this.countEl.textContent = `本章已核对 ${v.n} / ${v.total} 句`;
      else this.countEl.textContent = '';
    }
  }

  global.SupportPanel = SupportPanel;
})(window);
