"""K12 (2026-08-14) 测试: cli.py --backfill-cover-book/--backfill-cover-pack

DoD: 老 edition(bookpack.json 已存在, 没有 cover)配合源 EPUB 跑这条轻量入口,
只补 cover 字段 + 拷贝封面文件, 不碰 bookpack.json 里其它内容。
"""
import io
import json
import os
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from aidulc_prep.cli import main as cli_main


def _make_epub_with_cover(path: str) -> None:
    opf = """<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf">
      <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Backfill Book</dc:title></metadata>
      <manifest>
        <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
        <item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
      </manifest>
      <spine><itemref idref="c1"/></spine>
    </package>"""
    container = (
        '<?xml version="1.0"?><container><rootfiles>'
        '<rootfile full-path="book.opf"/></rootfiles></container>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("META-INF/container.xml", container)
        zf.writestr("book.opf", opf)
        zf.writestr("c1.xhtml", "<html><body><p>Body sentence here is long enough.</p></body></html>")
        zf.writestr("cover.jpg", b"\xff\xd8\xfffakejpeg")
    buf.seek(0)
    with open(path, "wb") as f:
        f.write(buf.read())


def test_backfill_cover_patches_existing_bookpack(tmp_path):
    epub_path = str(tmp_path / "src.epub")
    _make_epub_with_cover(epub_path)

    pack_dir = str(tmp_path / "pack")
    os.makedirs(pack_dir, exist_ok=True)
    original_bp = {
        "schemaVersion": 1,
        "title": "Backfill Book",
        "chapters": [{"index": 0, "title": "C1", "sentences": []}],
        "quality": {"stages": {}, "summary": "ok"},
    }
    bp_path = os.path.join(pack_dir, "bookpack.json")
    with open(bp_path, "w", encoding="utf-8") as f:
        json.dump(original_bp, f)

    rc = cli_main(["--backfill-cover-book", epub_path, "--backfill-cover-pack", pack_dir])
    assert rc == 0

    with open(bp_path, encoding="utf-8") as f:
        patched = json.load(f)
    assert patched["cover"] == "cover.jpg"
    # 其它字段原样保留 (只补 cover, 不动别的)
    assert patched["title"] == "Backfill Book"
    assert patched["chapters"] == original_bp["chapters"]
    assert os.path.exists(os.path.join(pack_dir, "cover.jpg"))
    with open(os.path.join(pack_dir, "cover.jpg"), "rb") as f:
        assert f.read() == b"\xff\xd8\xfffakejpeg"


def test_backfill_cover_no_cover_in_source_returns_null(tmp_path):
    # 源书没有封面 (properties="cover-image" 去掉) → cli 应正常返回 cover:null, 不报错
    opf = """<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf">
      <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">No Cover Book</dc:title></metadata>
      <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="c1"/></spine>
    </package>"""
    container = (
        '<?xml version="1.0"?><container><rootfiles>'
        '<rootfile full-path="book.opf"/></rootfiles></container>'
    )
    epub_path = str(tmp_path / "nocov.epub")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("META-INF/container.xml", container)
        zf.writestr("book.opf", opf)
        zf.writestr("c1.xhtml", "<html><body><p>Body sentence here is long enough.</p></body></html>")
    buf.seek(0)
    with open(epub_path, "wb") as f:
        f.write(buf.read())

    pack_dir = str(tmp_path / "pack2")
    os.makedirs(pack_dir, exist_ok=True)
    bp_path = os.path.join(pack_dir, "bookpack.json")
    with open(bp_path, "w", encoding="utf-8") as f:
        json.dump({"title": "No Cover Book"}, f)

    rc = cli_main(["--backfill-cover-book", epub_path, "--backfill-cover-pack", pack_dir])
    assert rc == 0
    # 没封面时不改写 bookpack.json (源没有可补的东西)
    with open(bp_path, encoding="utf-8") as f:
        assert json.load(f) == {"title": "No Cover Book"}


def test_backfill_cover_missing_bookpack_json_fails_cleanly(tmp_path):
    epub_path = str(tmp_path / "x.epub")
    _make_epub_with_cover(epub_path)
    pack_dir = str(tmp_path / "no_such_pack")
    rc = cli_main(["--backfill-cover-book", epub_path, "--backfill-cover-pack", pack_dir])
    assert rc == 1
