"""cli.py --standardize-book 入口 (2026-08-19)

Rust 后台任务(standardize_task.rs)spawn 侧车走的就是这个模式: 传源书路径 + --out
报告路径, 期望在 --out 落一个 JSON 文件, 含 verdict/book 两块内容。这里直接调
cli.main(argv), 不起子进程, 覆盖参数校验和文件落盘这两件事——真正的解析/判定逻辑
已经在 test_epub_fallback.py / test_book_audit.py 测过, 不重复测。
"""
import io
import json
import os
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.cli import main


def _make_minimal_epub(tmp_path) -> str:
    opf = """<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>CLI Test Book</dc:title><dc:identifier id="bid">x</dc:identifier>
      <dc:language>en</dc:language>
    </metadata>
    <manifest>
      <item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
      <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    </manifest>
    <spine><itemref idref="c1"/></spine>
    </package>"""
    nav = """<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
    <nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter One</a></li></ol></nav>
    </body></html>"""
    c1 = "<html><body>" + "".join(f"<p>Sentence number {i} is here for real content.</p>" for i in range(60)) + "</body></html>"
    container = (
        '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'
        '<rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles>'
        "</container>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr("META-INF/container.xml", container)
        zf.writestr("OEBPS/book.opf", opf)
        zf.writestr("OEBPS/nav.xhtml", nav)
        zf.writestr("OEBPS/c1.xhtml", c1)
    buf.seek(0)
    p = tmp_path / "cli_test.epub"
    p.write_bytes(buf.read())
    return str(p)


class TestStandardizeBookCli:
    def test_writes_report_with_book_when_ok(self, tmp_path):
        epub = _make_minimal_epub(tmp_path)
        out = tmp_path / "report.json"
        code = main(["--standardize-book", epub, "--out", str(out)])
        assert code == 0
        report = json.loads(out.read_text(encoding="utf-8"))
        assert report["verdict"] in ("ok", "warn")
        assert report["book"]["chapters"][0]["title"] == "Chapter One"
        assert len(report["book"]["chapters"][0]["sentences"]) >= 60

    def test_missing_out_arg_errors_without_crashing(self, tmp_path):
        epub = _make_minimal_epub(tmp_path)
        code = main(["--standardize-book", epub])
        assert code == 2  # 参数校验失败的约定退出码, 不是未捕获异常

    def test_corrupt_file_writes_block_verdict_with_null_book(self, tmp_path):
        bad = tmp_path / "broken.epub"
        bad.write_bytes(b"not a zip")
        out = tmp_path / "report.json"
        code = main(["--standardize-book", str(bad), "--out", str(out)])
        assert code == 0
        report = json.loads(out.read_text(encoding="utf-8"))
        assert report["verdict"] == "block"
        assert report["book"] is None
