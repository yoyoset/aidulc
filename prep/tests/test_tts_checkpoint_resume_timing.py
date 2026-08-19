"""tts/stage.py::synth_chapter 断点续跑的时间轴错位 (2026-08-19, 用户报"重大 BUG")

实测复现: Frindle 第 10 章第 20 句, 上一轮跑时 checkpoint 存的绝对时间戳是
88700-90500ms; 这一轮"重试失败句"只重新合成了它前面几句(新语音时长跟上一轮不同,
TTS 合成不保证逐字等长), 前一句这一轮实际止于 106100ms。第 20 句自己没变,
从 checkpoint 复用没问题, 但直接照抄它存的绝对时间戳(88700), 导致它在本轮音轨里
的真实播放位置(106100 之后)和它自称的位置(88700)相差 17.4 秒——从它开始往后
所有句子的"点句跳转"/"逐词高亮"全部错位, 但文字本身完全正确, 不是文字对不上
(用户原先怀疑"章节标题混进去了", 实测排除——句子文字读起来是连贯剧情, 唯独
时间戳跳变)。

排查过程排除的两种假设(记录, 避免以后重蹈):
1. "TTS 把章节标题也合成进音频了" —— 全库扫描 chapter.sentences[0] 是否等于
   chapter.title, 或标题文本混进首句, 全部未命中, 排除。
2. "章节边界本身变了, checkpoint 对错了句子" —— 检查 Frindle 出问题位置前后
   的句子文本, 剧情连贯(不是张冠李戴), 只有音频时间戳跳变, 排除。
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest

from aidulc_prep.core.models import Chapter, Sentence
from aidulc_prep.core.quality import QualityReport
from aidulc_prep.infra.checkpoint import save_sentence
from aidulc_prep.pipeline.tts.stage import synth_chapter


@pytest.fixture(autouse=True)
def _no_real_tts_engine(monkeypatch):
    """两句都从 checkpoint 恢复, 引擎不应该被真的调用——但 synth_chapter 在循环外
    无条件 create_engine() 一次(不管这一章要不要真合成), 测试环境没有真实模型文件,
    stub 掉它。如果 synth 真的被调用了(说明这条修复的判断分支走漏了、掉进了
    "需要真合成"那条路), 让 .synth() 直接抛错, 测试会明确失败而不是静默用假音频。"""
    class _StubEngine:
        def synth(self, *a, **kw):
            raise AssertionError("不应该真的调用 TTS 引擎——两句都该走 checkpoint 恢复分支")

    monkeypatch.setattr(
        "aidulc_prep.pipeline.tts.registry.create_engine", lambda *a, **kw: _StubEngine()
    )


def _make_chapter_with_stale_checkpoint(out_dir):
    """两句都已经在 checkpoint 里(不需要真的调 TTS 引擎)。第 0 句这一轮"应该"
    合成出 1500ms(模拟这一轮重新合成、时长跟上一轮不同); 第 1 句的 checkpoint
    存的是上一轮的绝对时间戳(基于上一轮第 0 句更短的时长算出来的), 跟这一轮
    完全对不上——这正是 bug 复现的关键结构。"""
    ch = Chapter(index=0, title="T", sentences=[
        Sentence(original_text="First sentence."),
        Sentence(original_text="Second sentence."),
    ])
    # 第 0 句: 这一轮的 checkpoint 时长是 1500ms (0 -> 1500)
    save_sentence(out_dir, 0, 0, {
        "translation": "x", "audio": {"chapter": 0, "start_ms": 0, "end_ms": 1500}, "words": [],
    })
    # 第 1 句: **上一轮**的绝对时间戳 (基于上一轮第 0 句更短的时长, 比如上一轮
    # 第 0 句只有 800ms, 于是第 1 句上一轮存的是 800-2100)。这一轮第 0 句实际是
    # 1500ms, 第 1 句理应从 1500 开始, 而不是照抄这个 800。
    save_sentence(out_dir, 0, 1, {
        "translation": "y", "audio": {"chapter": 0, "start_ms": 800, "end_ms": 2100}, "words": [
            {"seg_idx": 0, "start_ms": 50, "end_ms": 300},
        ],
    })
    return ch


class TestCheckpointResumeTimingReanchor:
    def test_second_sentence_start_reanchored_to_current_chapter_position(self, tmp_path):
        out_dir = str(tmp_path)
        ch = _make_chapter_with_stale_checkpoint(out_dir)
        quality = QualityReport()
        synth_chapter(ch, "irrelevant.pth", "af_heart", 1.0, out_dir, quality)

        s0, s1 = ch.sentences
        assert s0.audio.start_ms == 0
        assert s0.audio.end_ms == 1500, "第 0 句直接复用它自己的 checkpoint, 时长不变"

        # 核心断言: 第 1 句的 start_ms 必须是"这一轮"第 0 句结束的位置(1500),
        # 不能是它 checkpoint 里存的那个上一轮的绝对值(800)。
        assert s1.audio.start_ms == 1500, (
            f"第 1 句的起点应重新锚定到这一轮累计位置 1500, 实得 {s1.audio.start_ms} "
            "(等于 800 说明 bug 复现: 直接照抄了上一轮的绝对时间戳)"
        )
        # 时长(1300ms = 2100-800, 来自它自己那份音频文件的真实长度)必须保留——
        # 音频文件本身没有重新合成, 时长不该变, 只是起点要挪。
        duration = s1.audio.end_ms - s1.audio.start_ms
        assert duration == 1300, f"音频时长应保留 checkpoint 里的原值 1300, 实得 {duration}"
        assert s1.audio.end_ms == 2800  # 1500 + 1300

    def test_word_timings_are_not_shifted(self, tmp_path):
        # words 是相对这句音频开头的偏移(不是章节绝对时间戳, 实测确认: Frindle
        # 真实数据里第一个词 start_ms=275 远小于整句 1800ms), 挪动句子在章节里
        # 的位置不该改动 words 数组本身。
        out_dir = str(tmp_path)
        ch = _make_chapter_with_stale_checkpoint(out_dir)
        quality = QualityReport()
        synth_chapter(ch, "irrelevant.pth", "af_heart", 1.0, out_dir, quality)
        w = ch.sentences[1].words
        assert len(w) == 1
        assert w[0].start_ms == 50 and w[0].end_ms == 300, "words 不应跟着 start_ms 平移"

    def test_first_sentence_unaffected_when_it_is_the_first_in_chapter(self, tmp_path):
        # 退化情形: 章节第一句本来就该从 0 开始, 复用 checkpoint 后依然是 0,
        # 不应该因为这条修复引入回归。
        out_dir = str(tmp_path)
        ch = _make_chapter_with_stale_checkpoint(out_dir)
        quality = QualityReport()
        synth_chapter(ch, "irrelevant.pth", "af_heart", 1.0, out_dir, quality)
        assert ch.sentences[0].audio.start_ms == 0

    def test_no_stale_gap_left_when_checkpoint_already_correct(self, tmp_path):
        # 对照组: checkpoint 里的绝对时间戳本来就跟这一轮累计位置一致时(没有任何
        # 句子被重新合成过, 正常首次全量跑完的书), 修复后行为不变——不能因为这条
        # 修复让"本来就对"的书也被误判成需要挪动。
        out_dir = str(tmp_path)
        ch = Chapter(index=0, title="T", sentences=[
            Sentence(original_text="A."), Sentence(original_text="B."),
        ])
        save_sentence(out_dir, 0, 0, {"audio": {"chapter": 0, "start_ms": 0, "end_ms": 1000}, "words": []})
        save_sentence(out_dir, 0, 1, {"audio": {"chapter": 0, "start_ms": 1000, "end_ms": 2200}, "words": []})
        quality = QualityReport()
        synth_chapter(ch, "irrelevant.pth", "af_heart", 1.0, out_dir, quality)
        assert ch.sentences[1].audio.start_ms == 1000
        assert ch.sentences[1].audio.end_ms == 2200
