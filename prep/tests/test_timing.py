"""infra/timing.py 的纯函数格式化——性能探针日志行(2026-08-15, 用户反馈"太慢了"后
加的诊断工具, 跑完书后 grep run.log 里的 TIMING 行分析各阶段实际耗时)。"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.infra.timing import format_timing_line


class TestFormatTimingLine:
    def test_basic_shape(self):
        line = format_timing_line("explain", 1.2345, chapter=3, sentence=5)
        assert line.startswith("TIMING stage=explain ")
        assert "chapter=3" in line
        assert "sentence=5" in line
        assert "elapsed=1.234s" in line, line  # 三位小数截断(不是四舍五入到别的位数)

    def test_no_extra_fields_still_valid(self):
        line = format_timing_line("tts", 0.5)
        assert line == "TIMING stage=tts elapsed=0.500s"

    def test_field_order_is_insertion_order(self):
        """grep 分析时按固定顺序读字段更省事——Python 3.7+ dict/kwargs 保序,
        这里锁住行为不要意外变成别的顺序(比如被误改成先排序再拼)。"""
        line = format_timing_line("translate", 0.1, batch_size=15, chapter=2)
        assert line == "TIMING stage=translate batch_size=15 chapter=2 elapsed=0.100s"
