/**
 * atomic_block.js —— 从 aidu/src/sidepanel/features/reader/components/atomic_block.js 剥离适配
 *
 * 剥离点(R9 实测记录):
 * 1. import { t } from locales → 换成内置 t() 极简映射(仅 2 个 key)
 * 2. import styles from *.module.css → 换成全局 reader.css 类名(字符串类名)
 * 3. import { DebugModal } → 剥离(原型不渲染调试按钮)
 * 4. handlers.onPlay/onBubbleClick/onSelect/onBookmark 接口不变(将来接 Rust invoke)
 *
 * 新增(aidulc):
 * - words[] 时间轴: setWordReading(segIdx) / setSentenceReading(index) 高亮方法
 * - status ∈ {ok, partial, failed} → 失败态视觉标记 + 重试按钮槽位
 */
(function (global) {
  'use strict';

  const t = (key) => ({ 'reader.play': '播放', 'deep.phrasalVerb': '短语动词' }[key] || '');

  class AtomicBlock {
    static create(sentence, index, handlers, options = {}) {
      const { onPlay, onBubbleClick } = handlers;
      const { showTranslations = false, savedSet = new Set(), bookmarkIndices = new Set() } = options;

      if (!sentence || typeof sentence.original_text === 'undefined') {
        const err = document.createElement('div');
        err.className = 'atomic-block';
        err.innerHTML = `<b style="color:var(--md-sys-color-error)">[Data Error: Block ${index} is missing content]</b>`;
        return err;
      }

      const block = document.createElement('div');
      block.className = 'atomic-block';
      block.dataset.index = index;

      if (bookmarkIndices.has(index)) block.classList.add('bookmark-active');

      // 失败态 (3.5): status 字段驱动
      if (sentence.status && sentence.status !== 'ok') {
        block.classList.add('status-failed');
      }

      // 单击选中(不触发播放),双击书签 —— 原样继承 aidu 语义
      block.onclick = (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
        if (e.target.closest('.bubble')) return;
        if (handlers.onSelect) handlers.onSelect(index);
      };
      block.ondblclick = (e) => {
        if (handlers.onBookmark) { e.preventDefault(); handlers.onBookmark(index); }
      };

      // --- 左侧 spine 工具条 ---
      const toolsBar = document.createElement('div');
      toolsBar.className = 'ablock-tools';

      const playBtn = document.createElement('button');
      playBtn.className = 'atool js-play-btn';
      playBtn.title = t('reader.play') || 'Play';
      playBtn.textContent = '▶';
      playBtn.onclick = (e) => { e.stopPropagation(); onPlay(index); };
      toolsBar.appendChild(playBtn);
      block.appendChild(toolsBar);

      // --- 1. 原文行 ---
      const originalDiv = document.createElement('div');
      originalDiv.className = 'sentence';

      const textContainer = document.createElement('div');
      textContainer.style.flex = '1';

      const indexToPv = new Map();
      if (sentence.phrasal_verbs) {
        sentence.phrasal_verbs.forEach(pv => {
          (pv.indices || []).forEach(idx => indexToPv.set(idx, pv));
          pv.correctedIndices = pv.indices;
        });
      }

      if (sentence.segments && Array.isArray(sentence.segments) && sentence.segments.length > 0) {
        const STICKY_PRE = ['(', '[', '{', '“', '‘'];
        const STICKY_POST = ['.', ',', '!', '?', ':', ';', ')', ']', '}', '”', '’', "'", '’'];

        sentence.segments.forEach((seg, segIdx) => {
          const [word, pos, lemma] = Array.isArray(seg) ? seg : [seg.word || seg.w, seg.pos || seg.p, seg.lemma || seg.l];

          const bubble = document.createElement('span');
          bubble.textContent = word || '';
          bubble.className = 'bubble';
          bubble.dataset.segIdx = segIdx;

          const linkedPv = indexToPv.get(segIdx);
          const isInteractive = linkedPv || !['STOP', 'NUM', 'PUNCT'].includes(pos);

          if (isInteractive) {
            bubble.classList.add('interactive');
            if (lemma) bubble.dataset.lemma = lemma.toLowerCase();

            if (savedSet.has(lemma?.toLowerCase())) bubble.classList.add('saved-bubble');

            if (linkedPv) {
              bubble.classList.add('phrasal-member');
              bubble.title = `${t('deep.phrasalVerb')}: ${linkedPv.lemma}`;
            }

            // 短语连体 hover
            bubble.onmouseenter = () => {
              const pv = indexToPv.get(segIdx);
              if (pv) {
                block.querySelectorAll('.bubble').forEach(b => {
                  if (b.dataset.pvId === pv.lemma) b.classList.add('linked-hover');
                });
              }
            };
            bubble.onmouseleave = () => {
              block.querySelectorAll('.linked-hover').forEach(b => b.classList.remove('linked-hover'));
            };

            bubble.onclick = (e) => {
              e.stopPropagation();
              const pv = indexToPv.get(segIdx);
              let finalSeg = seg;
              block.querySelectorAll('.linked-highlight').forEach(b => b.classList.remove('linked-highlight'));
              if (pv) {
                block.querySelectorAll('.bubble').forEach(b => {
                  const targetIdx = parseInt(b.dataset.segIdx);
                  if (pv.correctedIndices.includes(targetIdx)) b.classList.add('linked-highlight');
                });
                finalSeg = [pv.text, 'VERB', pv.lemma];
              }
              onBubbleClick(bubble, finalSeg, sentence.original_text);
            };
          }
          textContainer.appendChild(bubble);

          // 智能空格(同 aidu)
          if (segIdx < sentence.segments.length - 1) {
            const nextSeg = sentence.segments[segIdx + 1];
            const nextWord = Array.isArray(nextSeg) ? nextSeg[0] : (nextSeg.word || nextSeg.w || '');
            const isStickyPre = STICKY_PRE.includes(word);
            const isStickyPost = STICKY_POST.includes(nextWord);
            if (!isStickyPre && !isStickyPost) {
              const spaceSpan = document.createElement('span');
              spaceSpan.textContent = ' ';
              const nextLinkedPv = indexToPv.get(segIdx + 1);
              if (linkedPv && nextLinkedPv && linkedPv.lemma === nextLinkedPv.lemma) {
                spaceSpan.className = 'phrasal-space';
                spaceSpan.dataset.pvId = linkedPv.lemma;
                bubble.dataset.pvId = linkedPv.lemma;
              }
              textContainer.appendChild(spaceSpan);
            }
          }
        });
      } else {
        textContainer.textContent = sentence.original_text;
      }

      originalDiv.appendChild(textContainer);
      block.appendChild(originalDiv);

      // --- 2/3. 译文与讲解行(模糊揭示) ---
      AtomicBlock._addObscurableRow(block, sentence.translation, 'translation-row', showTranslations);
      if (sentence.explanation) {
        AtomicBlock._addObscurableRow(block, sentence.explanation, 'explanation-row', showTranslations);
      }

      // 失败态: 标记 + 重试槽(Phase 5 接真命令)
      if (sentence.status && sentence.status !== 'ok') {
        const badge = document.createElement('span');
        badge.className = 'failed-badge';
        badge.textContent = sentence.status === 'partial' ? '部分失败' : '失败';
        badge.title = (sentence.failedStages || []).join(', ');
        block.appendChild(badge);
      }

      return block;
    }

    static _addObscurableRow(block, text, rowClass, isVisible) {
      const row = document.createElement('div');
      const jsClass = rowClass === 'translation-row' ? 'js-trans-text' : 'js-exp-text';
      row.className = rowClass;
      row.style.marginTop = '7px';

      const textEl = document.createElement('span');
      textEl.className = jsClass + ' text';
      textEl.style.flex = '1';
      textEl.textContent = text;

      if (!isVisible) textEl.classList.add('obscured');

      textEl.addEventListener('click', (e) => {
        e.stopPropagation();
        textEl.classList.toggle('obscured');
      });

      row.appendChild(textEl);
      block.appendChild(row);
    }
  }

  global.AtomicBlock = AtomicBlock;
})(window);
