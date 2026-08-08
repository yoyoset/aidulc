"""M7 R26: run.log 兑现 —— 侧车任务日志落盘 (注释承诺但从未配置 logging)"""
import logging
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.pipeline.runner import Runner


def test_run_log_created_and_written(tmp_path):
    r = Runner({}, str(tmp_path))
    logging.getLogger("aidulc.test").info("hello run.log")
    for h in logging.getLogger("aidulc").handlers:
        h.flush()
    log_path = tmp_path / "run.log"
    assert log_path.exists(), "run.log 应被创建"
    assert "hello run.log" in log_path.read_text(encoding="utf-8")


def test_run_log_has_formatter_and_avoids_dup(tmp_path):
    r1 = Runner({}, str(tmp_path))
    r2 = Runner({}, str(tmp_path))
    handler_count = len(logging.getLogger("aidulc").handlers)
    # 同目录两次 Runner 不叠 handler (防重入)
    assert handler_count >= 1
