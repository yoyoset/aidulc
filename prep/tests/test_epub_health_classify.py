"""Runner._classify_uncovered_epub_files (2026-08-16): uncovered 列表混了"真的读不到"
(路径解析失败, 数据丢失) 和"读到了但本来就没正文"(插图页/目录页, 正常现象) 两类,
实测在真实书籍(Despereaux 9个未覆盖/Wild Robot 36个未覆盖, 全部是插图页)上如果不
区分会分别算出 13.8%/10.7%, 双双错误触发本该只拦真正数据丢失的 10% 阈值。这里用
内联构造的 EPUB 包复现两种场景, 不依赖真实下载文件(CI/其它机器上不存在)。"""
import io
import os
import shutil
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.core.errors import InputError
from aidulc_prep.pipeline.loader.epub import load_epub_with_spine_health
from aidulc_prep.pipeline.runner import Runner

_CONTAINER = (
    '<?xml version="1.0"?><container><rootfiles>'
    '<rootfile full-path="book.opf"/></rootfiles></container>'
)


def _make_epub(tmp_path, manifest_items: list[tuple[str, str]], written: dict[str, str]) -> str:
    """manifest_items: [(id, href), ...] 写进 opf manifest+spine; written: 实际写进 zip 的文件。
    manifest 引用但不在 written 里的文件 = 模拟"读不到"。"""
    items = "".join(f'<item id="{i}" href="{h}" media-type="application/xhtml+xml"/>' for i, h in manifest_items)
    refs = "".join(f'<itemref idref="{i}"/>' for i, _ in manifest_items)
    opf = (
        '<?xml version="1.0"?><package><metadata><dc:title>T</dc:title></metadata>'
        f"<manifest>{items}</manifest><spine>{refs}</spine></package>"
    )
    p = os.path.join(tmp_path, "test.epub")
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr("META-INF/container.xml", _CONTAINER)
        zf.writestr("book.opf", opf)
        for name, content in written.items():
            zf.writestr(name, content)
    return p


class TestClassifyUncoveredEpubFiles:
    def test_benign_image_only_page_not_counted_as_real_missing(self, tmp_path):
        """插图页文件确实存在于 zip 里(能读到原始 HTML), 只是没有可朗读文本——
        不该被算进"真的读不到"。"""
        p = _make_epub(
            str(tmp_path),
            manifest_items=[("c1", "ch1.xhtml"), ("img", "img.xhtml")],
            written={
                "ch1.xhtml": "<html><body><p>" + "Real prose sentence here. " * 5 + "</p></body></html>",
                "img.xhtml": '<html><body><img src="pic.jpg"/></body></html>',  # 无文本, 只有图
            },
        )
        book, uncovered = load_epub_with_spine_health(p)
        assert "img.xhtml" in uncovered, "插图页应该在 uncovered 里(没产出章节)"
        r = Runner({"book_path": p}, str(tmp_path / "out"))
        real = r._classify_uncovered_epub_files(uncovered)
        assert real == [], f"插图页读得到内容, 不该被判定为真的丢失, 实得 {real}"
        shutil.rmtree(str(tmp_path / "out"), ignore_errors=True)

    def test_genuinely_missing_file_counted_as_real_missing(self, tmp_path):
        """manifest 引用了一个从未真正写进 zip 的文件(模拟路径编码不匹配导致读不到)
        —— 这才是真正的数据丢失, 必须被抓出来。"""
        p = _make_epub(
            str(tmp_path),
            manifest_items=[("c1", "ch1.xhtml"), ("ghost", "ghost.xhtml")],
            written={
                "ch1.xhtml": "<html><body><p>" + "Real prose sentence here. " * 5 + "</p></body></html>",
                # "ghost.xhtml" 故意不写进 zip —— 模拟 KeyError 场景
            },
        )
        book, uncovered = load_epub_with_spine_health(p)
        assert "ghost.xhtml" in uncovered
        r = Runner({"book_path": p}, str(tmp_path / "out"))
        real = r._classify_uncovered_epub_files(uncovered)
        assert real == ["ghost.xhtml"], f"真的读不到的文件必须被抓出来, 实得 {real}"
        shutil.rmtree(str(tmp_path / "out"), ignore_errors=True)

    def test_health_gate_allows_book_with_only_benign_uncovered(self, tmp_path):
        """全部未覆盖文件都是插图页(读得到, 没文本)时不该拦——对应实测的
        Despereaux(9个/全插图)和 Wild Robot(36个/全插图+目录页)场景。"""
        items = [("c1", "ch1.xhtml")] + [(f"img{i}", f"img{i}.xhtml") for i in range(9)]
        written = {"ch1.xhtml": "<html><body><p>" + "Real prose sentence here. " * 5 + "</p></body></html>"}
        for i in range(9):
            written[f"img{i}.xhtml"] = f'<html><body><img src="p{i}.jpg"/></body></html>'
        p = _make_epub(str(tmp_path), items, written)
        book, uncovered = load_epub_with_spine_health(p)
        assert len(uncovered) == 9
        r = Runner({"book_path": p}, str(tmp_path / "out"))
        r._check_epub_health(book, uncovered)  # 不应抛异常
        shutil.rmtree(str(tmp_path / "out"), ignore_errors=True)

    def test_health_gate_blocks_book_with_genuinely_missing_files(self, tmp_path):
        """未覆盖文件里有相当比例是真的读不到(不是插图页)—— 必须拦, 复现
        Tuck Everlasting 场景(25/27 章因路径编码问题读不到)的判断逻辑。"""
        items = [("c1", "ch1.xhtml")] + [(f"ghost{i}", f"ghost{i}.xhtml") for i in range(9)]
        written = {"ch1.xhtml": "<html><body><p>" + "Real prose sentence here. " * 5 + "</p></body></html>"}
        # ghost0..8 故意都不写进 zip
        p = _make_epub(str(tmp_path), items, written)
        book, uncovered = load_epub_with_spine_health(p)
        assert len(uncovered) == 9
        r = Runner({"book_path": p}, str(tmp_path / "out"))
        try:
            r._check_epub_health(book, uncovered)
            assert False, "9 个真实丢失文件占比远超 10%, 应该抛 InputError"
        except InputError as e:
            assert "丢失" in str(e)
        shutil.rmtree(str(tmp_path / "out"), ignore_errors=True)
