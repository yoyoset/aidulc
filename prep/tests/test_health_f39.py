"""F39 (2026-08-10) 测试: 处理前体检的异常检测 + spine 覆盖信息

DoD:
- detect_anomalies 纯函数两条新防线 (spine 覆盖率 / 句数离群) + 既有规则保留;
- load_epub_with_spine_health 对 N1 合成 EPUB (spine 5, TOC 只指 2) 报全覆盖。
"""
import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.core.health import detect_anomalies
from aidulc_prep.pipeline.loader.epub import load_epub_with_spine_health


class TestDetectAnomalies:
    def test_f38_shape_reports_spine_coverage_and_outliers(self):
        # 银河系修前形状 (真实): 10 章, 五部长篇正文没进来 (各 3-14 段),
        # 5 个 spine 文件没被任何章节覆盖。两条防线都必须报。
        counts = [87, 3, 14, 4, 3, 112, 5, 76, 11, 16]
        uncovered = [
            "text00005.html", "text00006.html", "text00007.html",
            "text00010.html", "text00011.html",
        ]
        a = detect_anomalies(counts, uncovered)
        cov = [x for x in a if "未被任何章节覆盖" in x]
        assert len(cov) == 5, f"5 个未覆盖文件都该报, 实得 {len(cov)}: {a}"
        out = [x for x in a if "离群" in x]
        assert len(out) >= 1, f"远低于中位数的章该报离群, 实得 {len(out)}: {a}"

    def test_normal_book_no_false_positive(self):
        assert detect_anomalies([120, 130, 140, 150, 160, 170], []) == []

    def test_small_book_uneven_counts_stay_quiet(self):
        # 小书 (中位数小) 不触发离群误报; 唯一句章规则也不误伤
        assert detect_anomalies([2, 3, 4, 5, 6]) == []

    def test_keeps_existing_rules(self):
        # 0 句 / 恰好 1 句 / >1000 巨章 保留
        a = detect_anomalies([1, 5, 2000])
        assert any("碎片章" in x for x in a)
        assert any("巨章" in x for x in a)
        a0 = detect_anomalies([0, 5, 10])
        assert any("无正文" in x for x in a0)

    def test_short_section_in_long_book_flagged(self):
        # 200 句章的书里夹一个 12 句章: 远低于中位数 → 值得人看一眼
        a = detect_anomalies([12, 200, 210, 190, 180])
        assert any("离群" in x for x in a)


class TestSpineCoverage:
    @staticmethod
    def _make_epub(opf: str, extra: dict[str, str]) -> str:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("META-INF/container.xml",
                        '<?xml version="1.0"?><container><rootfiles>'
                        '<rootfile full-path="book.opf"/></rootfiles></container>')
            zf.writestr("book.opf", opf)
            for name, content in extra.items():
                zf.writestr(name, content)
        buf.seek(0)
        tmp = os.path.join(os.path.dirname(__file__), "..", "_tmp_f39.epub")
        with open(tmp, "wb") as f:
            f.write(buf.read())
        return tmp

    def test_n1_synthetic_reports_full_coverage_after_f38_fix(self):
        # N1 合成 EPUB (spine 5, TOC 只指前 2): F38 修后 5 文件全被覆盖 → uncovered=[]
        opf = """<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf">
          <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Cover</dc:title></metadata>
          <manifest>
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
            <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
            <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
            <item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>
            <item id="c4" href="c4.xhtml" media-type="application/xhtml+xml"/>
            <item id="c5" href="c5.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine toc="ncx">
            <itemref idref="c1"/><itemref idref="c2"/>
            <itemref idref="c3"/><itemref idref="c4"/><itemref idref="c5"/>
          </spine>
        </package>"""
        ncx = """<?xml version="1.0"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
          <navMap>
            <navPoint id="n1"><navLabel><text>Chapter One</text></navLabel><content src="c1.xhtml"/></navPoint>
            <navPoint id="n2"><navLabel><text>Chapter Two</text></navLabel><content src="c2.xhtml"/></navPoint>
          </navMap>
        </ncx>"""
        extra = {
            "toc.ncx": ncx,
            "c1.xhtml": "<html><body><p>Alpha first sentence is real body.</p></body></html>",
            "c2.xhtml": "<html><body><p>Beta first sentence is real body.</p></body></html>",
            "c3.xhtml": "<html><body><p>Gamma first sentence is real body.</p></body></html>",
            "c4.xhtml": "<html><body><p>Delta first sentence is real body.</p></body></html>",
            "c5.xhtml": "<html><body><p>Epsilon first sentence is real body.</p></body></html>",
        }
        tmp = self._make_epub(opf, extra)
        try:
            book, uncovered = load_epub_with_spine_health(tmp)
            assert len(book.chapters) == 5
            assert uncovered == [], f"F38 修后 spine 5 文件应全覆盖, 实得未覆盖 {uncovered}"
        finally:
            os.remove(tmp)
