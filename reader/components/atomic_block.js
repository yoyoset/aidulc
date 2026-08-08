/**
 * atomic_block.js —— 单句块构建 (S5 三模式阅读器重写, 2026-08-08)
 *
 * 保留 (aidu 语义原样继承): 分词 / 短语动词联动 / 智能空格 / 点词查词 / 双击书签。
 * 替换 (设计文档 §2.5 §2.6 §7):
 *   - .obscured 高斯模糊揭示 → 开关式揭示 (Enter/句内 ↧ 核对, ↥ 收起) + 折叠 2px 细痕。
 *     设计理由: 模糊只是遮挡不构成提取, 记忆收益来自「先说出自己的理解再核对」这个动作;
 *     且 filter: blur() 不是合成友好属性, 3000+ span 时是真实成本。
 *   - 单个 ▶ 播放三角 → 三个开关式句内控件 (▶/❙❙ 朗读这句 · ↻ 进/退逐句跟读 · ↧/↥ 核对/收起)。
 *   - 词状态四条独立通道 (设计 §2.5): 颜色只给「正在朗读」(--rd-reading-bg);
 *     生词 1px 下划线; 短语动词 2px 强调线 (hover 两词联动); hover 才出现的可点浅底。
 *
 * 对外挂在 block._ab 上的方法 (renderer/reader_view 调用):
 *   setCurrent() / unsetCurrent()      —— 当前句: 控件常显 + 提示行 + 细痕策略
 *   showSupport('hidden'|'revealed'|'scar')
 *   isRevealed()
 *   setPlaying(bool)                   —— ▶ ↔ ❙❙
 *   setFollow(bool)                    —— ↻ 状态
 *   setWordReading(segIdx) / clearWordReading()
 *   measureSweep() / setSweep(segIdx, leftPx, widthPx)   —— 对照台节奏线
 *   setDimmed(bool)                    —— 逐句节奏下非当前句压暗 (CSS 也兜底)
 */
(function (global) {
  'use strict';

  const t = (key) => ({ 'reader.play': '播放', 'deep.phrasalVerb': '短语动词' }[key] || '');

  const STICKY_PRE = ['(', '[', '{', '“', '‘'];
  const STICKY_POST = ['.', ',', '!', '?', ':', ';', ')', ']', '}', '”', '’', "'", '’'];

  class AtomicBlock {
    static create(sentence, index, handlers, options = {}) {
      const { onPlay, onBubbleClick, onFollowToggle, onRevealToggle } = handlers;
      const {
        mode = 'guess',
        current = false,
        savedSet = new Set(),
        bookmarkIndices = new Set(),
        verifiedSet = new Set(),
        highlights = [], // M7 R21: 当前章摘录 [{sentence_index, start_seg, end_seg}]
      } = options;

      if (!sentence || typeof sentence.original_text === 'undefined') {
        const err = document.createElement('div');
        err.className = 'atomic-block blk';
        err.innerHTML = `<b style="color:var(--md-sys-color-error)">[Data Error: Block ${index} is missing content]</b>`;
        return err;
      }

      const block = document.createElement('div');
      block.className = 'atomic-block blk';
      block.dataset.index = index;

      if (bookmarkIndices.has(index)) block.classList.add('bookmark-active');
      // M7 R17/R21: 摘录标记 —— 整句琥珀左标 + 选中词精确标黄 (两者叠加)
      const hlList = (highlights || []).filter((h) => h.sentence_index === index);
      if (hlList.length) block.classList.add('highlighted');

      // 单击选中(不触发播放),双击书签 —— 原样继承 aidu 语义
      block.onclick = (e) => {
        if (e.target.closest('button')) return;
        if (e.target.closest('.bubble')) return;
        if (handlers.onSelect) handlers.onSelect(index);
      };
      block.ondblclick = (e) => {
        if (handlers.onBookmark) { e.preventDefault(); handlers.onBookmark(index); }
      };

      // --- 左侧 spine 句内控件 (三个开关) ---
      const tools = document.createElement('div');
      tools.className = 'tools';

      const playBtn = document.createElement('button');
      playBtn.className = 'atool atool-play';
      playBtn.title = t('reader.play') || '朗读这句';
      playBtn.textContent = '▶';
      playBtn.onclick = (e) => { e.stopPropagation(); onPlay && onPlay(index); };
      tools.appendChild(playBtn);

      const followBtn = document.createElement('button');
      followBtn.className = 'atool atool-follow';
      followBtn.title = '逐句跟读 (进/退)';
      followBtn.textContent = '↻';
      followBtn.onclick = (e) => { e.stopPropagation(); onFollowToggle && onFollowToggle(index); };
      tools.appendChild(followBtn);

      const revealBtn = document.createElement('button');
      revealBtn.className = 'atool atool-reveal';
      revealBtn.title = '核对 / 收起';
      revealBtn.textContent = '↧';
      revealBtn.onclick = (e) => { e.stopPropagation(); onRevealToggle && onRevealToggle(index); };
      tools.appendChild(revealBtn);
      block.appendChild(tools);

      // --- 原文行 ---
      const rowEn = document.createElement('div');
      rowEn.className = 'row-en sentence';

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
        sentence.segments.forEach((seg, segIdx) => {
          const [word, pos, lemma] = Array.isArray(seg) ? seg : [seg.word || seg.w, seg.pos || seg.p, seg.lemma || seg.l];

          const tok = document.createElement('span');
          tok.textContent = word || '';
          tok.className = 'bubble tok';
          tok.dataset.segIdx = segIdx;

          const linkedPv = indexToPv.get(segIdx);
          const isInteractive = linkedPv || !['STOP', 'NUM', 'PUNCT'].includes(pos);

          if (isInteractive) {
            tok.classList.add('interactive');
            if (lemma) tok.dataset.lemma = lemma.toLowerCase();

            if (savedSet.has(lemma?.toLowerCase()) || savedSet.has((word || '').toLowerCase())) {
              tok.classList.add('saved');
            }

            if (linkedPv) {
              tok.classList.add('phrasal-member');
              tok.title = `${t('deep.phrasalVerb')}: ${linkedPv.lemma}`;
            }

            // 短语连体 hover
            tok.onmouseenter = () => {
              const pv = indexToPv.get(segIdx);
              if (pv) {
                block.querySelectorAll('.bubble').forEach(b => {
                  if (b.dataset.pvId === pv.lemma) b.classList.add('linked-hover');
                });
              }
            };
            tok.onmouseleave = () => {
              block.querySelectorAll('.linked-hover').forEach(b => b.classList.remove('linked-hover'));
            };

            tok.onclick = (e) => {
              e.stopPropagation();
              const pv = indexToPv.get(segIdx);
              let finalSeg = seg;
              block.querySelectorAll('.linked-highlight').forEach(b => b.classList.remove('linked-highlight'));
              if (pv) {
                block.querySelectorAll('.bubble').forEach(b => {
                  const targetIdx = parseInt(b.dataset.segIdx, 10);
                  if (pv.correctedIndices.includes(targetIdx)) b.classList.add('linked-highlight');
                });
                finalSeg = [pv.text, 'VERB', pv.lemma];
              }
              onBubbleClick(tok, finalSeg, sentence.original_text);
            };
          }
          textContainer.appendChild(tok);

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
                tok.dataset.pvId = linkedPv.lemma;
              }
              textContainer.appendChild(spaceSpan);
            }
          }
        });
      } else {
        textContainer.textContent = sentence.original_text;
      }

      rowEn.appendChild(textContainer);
      block.appendChild(rowEn);

      // R21: 摘录的精确 span —— 选中词加软黄底 (整句标记的强化)
      hlList.forEach((h) => {
        if (h.start_seg == null || h.end_seg == null) return;
        for (let i = h.start_seg; i <= h.end_seg; i++) {
          const t = textContainer.querySelector(`.bubble[data-seg-idx="${i}"]`);
          if (t) t.classList.add('hl-span');
        }
      });

      // --- 对照台节奏线 (只在该模式下用, 纯 transform 驱动) ---
      const sweep = document.createElement('div');
      sweep.className = 'sweep';
      block.appendChild(sweep);

      // --- 提示行 (常在的小字提示, 本身即快捷键说明) ---
      const hint = document.createElement('div');
      hint.className = 'hint';
      block.appendChild(hint);

      // --- 支撑区: 折叠细痕 + 内联展开体 ---
      const support = document.createElement('div');
      support.className = 'support';
      const scar = document.createElement('div');
      scar.className = 'scar';
      scar.title = '已核对过 · Enter 再看';
      support.appendChild(scar);
      const supportBody = document.createElement('div');
      supportBody.className = 'support-body';
      if (sentence.translation) {
        const tr = document.createElement('div');
        tr.className = 'translation-row';
        const span = document.createElement('span');
        span.className = 'text';
        span.textContent = sentence.translation;
        tr.appendChild(span);
        supportBody.appendChild(tr);
      }
      if (sentence.explanation) {
        const ex = document.createElement('div');
        ex.className = 'explanation-row';
        const span = document.createElement('span');
        span.className = 'text';
        span.textContent = sentence.explanation;
        ex.appendChild(span);
        supportBody.appendChild(ex);
      }
      support.appendChild(supportBody);
      block.appendChild(support);

      // ==== 句块控制 API (挂在 block._ab) ====
      let supportState = 'hidden'; // hidden | revealed | scar
      let isPlaying = false;
      let isFollow = false;

      const api = {
        el: block,

        isRevealed() { return supportState === 'revealed'; },

        setCurrent() {
          block.classList.add('current');
          hint.textContent = '';
        },

        unsetCurrent() {
          block.classList.remove('current');
        },

        /** 支撑状态: hidden → 只留提示行; revealed → 内联展开带左标线; scar → 2px 细痕 */
        showSupport(state) {
          supportState = state;
          block.classList.remove('support-hidden', 'support-revealed', 'support-scar');
          if (state === 'revealed') {
            block.classList.add('support-revealed');
            revealBtn.textContent = '↥';
            revealBtn.title = '收起';
          } else if (state === 'scar') {
            block.classList.add('support-scar');
            revealBtn.textContent = '↧';
            revealBtn.title = '已核对过 · Enter 再看';
          } else {
            block.classList.add('support-hidden');
            revealBtn.textContent = '↧';
            revealBtn.title = '核对';
          }
        },

        /** 提示行文案 (view 按 ReaderState.hintFor 给) */
        setHint(text) {
          hint.textContent = text || '';
          hint.classList.toggle('visible', !!text && supportState !== 'revealed');
        },

        setPlaying(v) {
          isPlaying = !!v;
          playBtn.textContent = isPlaying ? '❙❙' : '▶';
          playBtn.title = isPlaying ? '暂停这句' : '朗读这句';
          playBtn.classList.toggle('active', isPlaying);
        },

        setFollow(v) {
          isFollow = !!v;
          followBtn.classList.toggle('active', isFollow);
          followBtn.textContent = isFollow ? '⤫' : '↻';
          followBtn.title = isFollow ? '退出逐句跟读' : '逐句跟读 (进/退)';
        },

        /** 词级朗读高亮 (先答后核/静默正文的词底色) */
        setWordReading(segIdx) {
          this._clearWordReadingInner();
          const b = this._bubble(segIdx);
          if (b) b.classList.add('word-reading');
        },

        clearWordReading() {
          this._clearWordReadingInner();
        },

        _bubble(segIdx) {
          return segIdx >= 0 ? block.querySelector(`.bubble[data-seg-idx="${segIdx}"]`) : null;
        },

        _clearWordReadingInner() {
          const cur = block.querySelector('.bubble.word-reading');
          if (cur) cur.classList.remove('word-reading');
        },

        /** 对照台节奏线: 一次性预测量 (句成为当前句时), 播放期间只读这张表、不读布局 (性能 §6) */
        measureSweep() {
          const blockRect = block.getBoundingClientRect();
          const rowRect = rowEn.getBoundingClientRect();
          const top = rowRect.bottom - blockRect.top + 2;
          // 预测量每个词的 offsetLeft/offsetWidth (rowEn 是 position:relative, 即 offsetParent)
          this._sweepWords = [];
          rowEn.querySelectorAll('.bubble[data-seg-idx]').forEach(b => {
            const idx = parseInt(b.dataset.segIdx, 10);
            if (!Number.isNaN(idx)) {
              this._sweepWords[idx] = { left: b.offsetLeft || 0, width: b.offsetWidth || 0 };
            }
          });
          // 基宽 1px, 播放期用 transform: translate3d + scaleX(width) 驱动 —— 合成层属性,
          // 逐帧只动 transform, 不触发布局。transform-origin 左端, scaleX 即像素宽度。
          sweep.style.display = 'block';
          sweep.style.width = '1px';
          sweep.style.top = top + 'px';
          sweep.style.transform = 'translate3d(0px,0,0) scaleX(0)';
          return true;
        },

        /** 播放期按 token 变化写 transform (变化时才写, 只读预测量表, 性能规约 §6) */
        setSweep(segIdx) {
          const m = this._sweepWords && this._sweepWords[segIdx];
          if (!m) { sweep.style.transform = 'translate3d(0px,0,0) scaleX(0)'; return; }
          sweep.style.transform = 'translate3d(' + m.left + 'px,0,0) scaleX(' + Math.max(1, m.width) + ')';
        },

        setSweepVisible(v) {
          sweep.style.display = v ? 'block' : 'none';
        },

        getSweepEl() { return sweep; },
      };

      block._ab = api;

      // 初始状态按 mode 铺
      const initial = supportForMode(mode, current, verifiedSet.has(index));
      api.showSupport(initial.state);
      if (initial.hint) api.setHint(initial.hint);
      if (current) api.setCurrent();
      return block;
    }
  }

  /**
   * 建块时的初始支撑状态 (模式感知)。
   * guess: 当前句未核对 → hidden+提示; 当前句已核对 → scar+提示; 非当前 → hidden 无提示
   * silent/bench: 译文不内联 → hidden; 提示只在 silent 的当前句给 (T 卡片入口)
   */
  function supportForMode(mode, current, verified) {
    if (mode === 'guess') {
      if (current) {
        if (verified) return { state: 'scar', hint: '已核对过 · Enter 再看' };
        return { state: 'hidden', hint: '先自己讲一遍 · Enter 核对' };
      }
      return { state: 'hidden', hint: '' };
    }
    if (mode === 'silent') {
      return { state: 'hidden', hint: current ? 'T 调出支撑卡片' : '' };
    }
    return { state: 'hidden', hint: '' }; // 对照台: 支撑在右栏, 正文不重复
  }

  global.AtomicBlock = AtomicBlock;
})(window);
