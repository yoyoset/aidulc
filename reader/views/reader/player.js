/**
 * views/reader/player.js —— 音频播放器 (R2 拆分自 reader_view.js)
 * 单一职责: <audio> 生命周期 + 分块加载 + 进度条/时间显示 + 跟读控制条。
 * 对外暴露: bindDOM / loadChapter / playFrom / stepSentence / seek / speed / destroy。
 * 内部: rAF tick 同步进度条 + 触发 renderer 高亮; shadow 状态机驱动重复/AB 循环。
 */
(function (global) {
  'use strict';

  class ReaderPlayer {
    constructor() {
      this.audio = null;
      this._blobUrl = null;
      this._generation = 0;
      this.playing = false;
      this.speed = 1.0;
      this.anchorIndex = -1; // 锚点句: 三角/全局键停止后, 重新开始时从这里播
      this.timeSpentMs = 0;  // M7 R18: 累计阅读时长 (播放计时, ms)
      this._lastTickTs = null;

      this.slider = null;      // <input type=range> (S5: 由 view 的外部进度轨注入)
      this.timeLabel = null;   // <span> (S5: 不再显示数字, 保留字段防旧调用)
      this.shadow = null;      // ShadowMachine 实例 (bindDOM 时注入)
      this.renderer = null;    // ReaderRenderer (loadChapter 时注入, 供 tick 高亮)
      this.sentences = [];

      // S5 (2026-08-10): 单句停止 (playOne) —— _oneShot 时播到 _stopAtMs 即停
      // (shadow repeat 未用完则重复, 用完 next → 停); _stopIndex 供锚点不越界
      this._oneShot = false;
      this._stopAtMs = null;
      this._stopIndex = -1;

      this._onStatus = null;      // (text) => void
      this._onSaveProgress = null; // () => void
      this._onSentenceEnded = null; // (sentenceIndex) => void
      this._onAnchorChange = null;  // (sentenceIndex) => void (S5: 朗读句变化, 供 view 追锚点)
      this._onShadowAction = null;  // (action) => void (S5: 跟读动作, 供 view 刷节拍点)
      this._onPlayingChange = null; // (playing: bool) => void (S5: 供 view 复位 ▶/❙❙)
      this._lastAnchorSi = -1;
    }

    /**
     * @param {object} deps { shadow, onStatus, onSaveProgress, onAnchorChange, onShadowAction, onPlayingChange }
     */
    bindDOM(deps) {
      this.shadow = deps.shadow;
      this._onStatus = deps.onStatus || (() => {});
      this._onSaveProgress = deps.onSaveProgress || (() => {});
      this._onSentenceEnded = deps.onSentenceEnded || (() => {});
      this._onAnchorChange = deps.onAnchorChange || (() => {});
      this._onShadowAction = deps.onShadowAction || (() => {});
      this._onPlayingChange = deps.onPlayingChange || (() => {});
      this._lastAnchorSi = -1;
    }

    /** S5: 注入外部进度轨 (view 建的底部 3px rail 的 <input type=range>) */
    attachSlider(slider) {
      this.slider = slider;
      if (slider) {
        slider.addEventListener('input', () => {
          if (this.audio && this.audio.duration) {
            this.audio.currentTime = (parseFloat(slider.value) / 100) * this.audio.duration;
          }
        });
      }
    }

    /**
     * 加载一章音频: 分块读 (2MB/块) → base64 → Blob → ObjectURL。
     * 竞态防护: 切章/离开时 _generation 变化, 旧读取循环立即中止。
     */
    async loadChapter(ch) {
      this._generation++;
      const gen = this._generation;
      // R1-1 (2026-08-08): audioReady —— 供 _restoreState await, 位置恢复不再被
      // "audio 还没就绪"静默跳过。在所有出口 resolve (成功/失败/竞态), 绝不挂死。
      let resolveReady;
      this.audioReady = new Promise((resolve) => { resolveReady = resolve; });
      const finishReady = () => { if (resolveReady) { resolveReady(); resolveReady = null; } };

      const audio = new Audio();
      audio.preload = 'auto';
      // 修复: 只在 blob 创建后设 this.audio; 旧调用 (gen 过时) 不碰全局状态
      const prevAudio = this.audio;
      if (prevAudio) { prevAudio.pause(); prevAudio.src = ''; prevAudio.remove(); }
      const oldBlob = this._blobUrl;
      this._blobUrl = null;
      if (oldBlob) URL.revokeObjectURL(oldBlob);

      const parts = [];
      let offset = 0;
      const CHUNK = 2 * 1024 * 1024; // 2MB/块
      try {
        for (;;) {
          // Bug fix (审查确认): 切章后立即中止旧章节读取循环
          if (gen !== this._generation) { finishReady(); return; }
          const r = await AiduLibraryService.readAudioRange(this.basePath, ch.audioFile, offset, CHUNK);
          if (!r.ok) throw new Error(r.error);
          // base64 → Uint8Array (修复: JSON 数字数组序列化开销大/截断 → blob 空, 无声音)
          const b64 = r.data && r.data.data_b64;
          if (!b64) throw new Error('音频数据为空');
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
          parts.push(bytes);
          offset += r.data.read;
          if (r.data.end || r.data.read === 0) break;
        }
      } catch (e) {
        if (gen !== this._generation) { finishReady(); return; }
        this._onStatus('音频加载失败: ' + (e && e.message || e));
        finishReady();
        return;
      }
      if (gen !== this._generation) { finishReady(); return; } // 旧章节结果丢弃
      const blob = new Blob(parts, { type: 'audio/ogg; codecs=opus' });
      this._blobUrl = URL.createObjectURL(blob);
      this.audio = audio;  // 修复: blob 就绪后才设 this.audio (旧调用不覆盖)
      audio.src = this._blobUrl;
      audio.load();
      audio.addEventListener('loadedmetadata', finishReady, { once: true });
      audio.addEventListener('error', finishReady, { once: true });
      // 修复: audio 挂到 reader-page; 替换旧实例 (否则 DOM 残留空 src 旧 audio)
      audio.id = 'reader-audio';
      audio.style.display = 'none';
      const page = document.querySelector('.reader-page');
      const old = document.getElementById('reader-audio');
      if (old) { old.onerror = null; old.remove(); }
      if (page) page.appendChild(audio);
      audio.addEventListener('error', () => {
        // UX7 #1: 切章/重开时 prevAudio.src='' (L85) 会让旧一代这个监听器异步触发,
        // 此时新章节已经在播——不判 gen 就是"音频正常但报错一闪而过"的假阳性。
        if (gen !== this._generation) return;
        this._onStatus('音频播放错误: ' + (audio.error ? audio.error.message : '未知'));
      });

      // 跟读状态机动作: 重复本句 / 播下一句
      // S5: 单句模式 (oneShot) 下 repeat 正常重播; next 表示"本句重复用完"→ 停, 不接下一句
      this.shadow.onAction = (action) => {
        if (action.type === 'repeat') {
          const s = this.sentences[action.sentenceIndex];
          if (s && s.audio) { audio.currentTime = s.audio.start_ms / 1000; audio.play(); }
        } else if (action.type === 'next') {
          if (this._oneShot) {
            this._stopAtMs = null;
            this._stopIndex = -1;
            this._oneShot = false;
            audio.pause();
          } else if (action.sentenceIndex < this.sentences.length) {
            this.playFrom(action.sentenceIndex);
          }
        }
        this._onShadowAction(action);
      };
      audio.addEventListener('ended', () => {
        const idx = this.sentences.findIndex(s =>
          s.audio && Math.abs(audio.currentTime * 1000 - s.audio.end_ms) < 200);
        if (idx >= 0) this._onSentenceEnded(idx);
      });
      audio.addEventListener('play', () => {
        this.playing = true;
        this._onPlayingChange(true);
        requestAnimationFrame(() => this._tick());
      });
      audio.addEventListener('pause', () => {
        this.playing = false;
        this._lastTickTs = null;
        this._onPlayingChange(false);
        this._onSaveProgress();
      });
    }

    /** 从某个句子开始播放 (整章一条流, 定位到句音频区间起点)。锚点更新到该句。
     *  通篇模式: 一路往下 (S5 维持现状)。 */
    playFrom(index) {
      const s = this.sentences[index];
      if (!s || !s.audio || !this.audio) {
        this._onStatus('音频尚未就绪, 请稍候再试');
        return;
      }
      this.anchorIndex = index;
      // S5: 通篇模式不是 oneShot —— 清除单句停止标记
      this._oneShot = false;
      this._stopAtMs = null;
      this._stopIndex = -1;
      // R1: 目标句可能还没建 DOM(书签跳转/搜索跳转), 先补渲染, 高亮不会扑空
      if (this.renderer && index > this.renderer._renderedUpTo) {
        this.renderer.ensureRendered(index);
      }
      this.shadow.sentenceStarted(index);
      this._lastAnchorSi = index;
      this._onAnchorChange(index);
      this.audio.currentTime = s.audio.start_ms / 1000;
      this.audio.playbackRate = this.speed;
      this.audio.play().catch(e => {
        this._onStatus('播放失败: ' + e.message);
      });
    }

    /** S5: 只播这一句 (逐句模式 / 句前按钮)。
     *  设 _stopAtMs = 句末, _tick 越过即 pause。若当前是跟读类预设 (repeat N),
     *  shadow 状态机的 repeat 动作会重播本句, 直到 repeat 用完才 next → 停。 */
    playOne(index) {
      const s = this.sentences[index];
      if (!s || !s.audio || !this.audio) {
        this._onStatus('音频尚未就绪, 请稍候再试');
        return;
      }
      this.anchorIndex = index;
      if (this.renderer && index > this.renderer._renderedUpTo) {
        this.renderer.ensureRendered(index);
      }
      this.shadow.sentenceStarted(index);
      this._lastAnchorSi = index;
      this._onAnchorChange(index);
      this._oneShot = true;
      this._stopAtMs = s.audio.end_ms;
      this._stopIndex = index;
      this.audio.currentTime = s.audio.start_ms / 1000;
      this.audio.playbackRate = this.speed;
      this.audio.play().catch(e => {
        this._onStatus('播放失败: ' + e.message);
      });
    }

    /** 停止播放 (暂停; 锚点留在当前句, 下次开始从锚点句播) */
    stop() {
      if (!this.audio) return;
      if (!this.audio.paused) this.audio.pause();
      this.playing = false;
    }

    /** 是否正在播放指定句 (三角切换用) */
    isPlayingSentence(index) {
      return this.playing && this.shadow.currentSentence === index;
    }

    /** 上一句/下一句 */
    stepSentence(delta) {
      if (!this.audio) return;
      const ms = this.audio.currentTime * 1000;
      const idx = this.sentences.findIndex(s => s.audio && ms >= s.audio.start_ms && ms < s.audio.end_ms);
      if (idx < 0) return;
      const target = idx + delta;
      if (target < 0 || target >= this.sentences.length) return;
      this.playFrom(target);
    }

    _tick() {
      if (!this.playing || !this.audio) return;
      if (this.audio.paused) { this.playing = false; this._lastTickTs = null; return; }
      // M7 R18: 播放计时 (rAF 每帧累加, 暂停即停)
      const now = Date.now();
      if (this._lastTickTs != null) this.timeSpentMs += now - this._lastTickTs;
      this._lastTickTs = now;
      const ms = this.audio.currentTime * 1000;
      // 优先级: AB 循环先于单句停止 (重复/循环没结束就不停)
      if (this.shadow.shouldLoopBack(ms)) {
        this.audio.currentTime = this.shadow.loopBackPoint() / 1000;
      } else if (this._oneShot && this._stopAtMs != null && this.shadow.shouldStopAt(ms, this._stopAtMs)) {
        // S5: 越过句末 → 交给 shadow.sentenceEnded 决定: repeat 未用完 → onAction repeat
        // 重播本句; 用完 → onAction next → (oneShot) 停。锚点停在当前句, 不越界。
        this.shadow.sentenceEnded(this._stopIndex);
      } else {
        this.renderer.highlightAt(ms, this.sentences);
        // 锚点跟随当前正在播的句 (句间留白时保持上一句)
        const si = AiduTimeline.findSentenceIndex(this.sentences, ms);
        if (si >= 0) {
          this.anchorIndex = si;
          if (si !== this._lastAnchorSi) {
            this._lastAnchorSi = si;
            this._onAnchorChange(si);
          }
        }
      }
      // 进度轨同步 (3px, 无数字; 用 CSS 变量画已播放填充)
      if (this.slider && this.audio.duration) {
        const pct = (this.audio.currentTime / this.audio.duration) * 100;
        this.slider.value = String(pct);
        this.slider.style.setProperty('--rd-pos', pct + '%');
      }
      requestAnimationFrame(() => this._tick());
    }

    get currentTimeMs() {
      return this.audio ? Math.floor((this.audio.currentTime || 0) * 1000) : 0;
    }

    setPosition(ms) {
      if (this.audio && ms) this.audio.currentTime = ms / 1000;
    }

    /**
     * 全局播放键: 点一下开始 (从锚点句), 再点一下停止。
     * 锚点默认句 0; 未加载音频时不动作。
     */
    toggle() {
      if (!this.audio) return;
      if (this.playing) {
        this.stop();
      } else {
        this.playFrom(this.anchorIndex >= 0 ? this.anchorIndex : 0);
      }
    }

    cleanup() {
      this._generation++;
      this._lastTickTs = null;
      // 离开前 flush 进度
      if (this.audio) {
        this._onSaveProgress();
        this.audio.pause(); this.audio.src = ''; this.audio = null;
      }
      if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
      this.playing = false;
    }
  }

  global.ReaderPlayer = ReaderPlayer;
})(window);
