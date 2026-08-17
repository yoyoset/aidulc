# TASKS.md

2026-08-17 夜。来源: `docs/WATCH_2026-08-17.md` 跑批观察 + 封面缺失排查。
状态: 待分派 / 进行中 / 待审核 / 已完成。**只有编排会话改这份文件。**

---

## A. 行内标签把句子切碎(最严重, 编排方自己做)

状态: **进行中**

`prep/aidulc_prep/pipeline/loader/epub.py::_strip_tags` 把**所有**标签一律换成换行,
包括 `<em>/<a>/<span>/<strong>` 这些**行内**标签。后果实测(Charlotte's Web 开篇名句):

```
输入: "Where is Papa going with that <em>ax</em>?" said Fern to her mother...
输出: ① "Where is Papa going with that
      ② ?" said Fern to her mother as they were setting the table.
      (ax 被整个丢掉)
```

约 20% 的段落含行内标签(Charlotte's Web 30/148, Hatchet 34/159), 全部被切碎。
下游翻译/讲解/配音/对齐都建立在这些残句上。

同一根因还导致:
- Frindle 21 章标题全是 'Nick'(`<p class="ChapterTitle"><a>Chapter One - Nick</a></p>`
  的 `<a>` 被换成换行 → `[[HEADING]]` 后面空了 → 全部退回 TOC 兜底标题)
- 2026-08-16 为 Hatchet 放弃的"向后吸收行"启发式 —— 那个方案本来就是错的,
  正确解法是区分块级/行内标签, 不是猜。

验收: 10 本书前后对比, 章数基本不变、句数下降(碎片被拼回)、提取到的正文总字符数
不减(被吞掉的行内词回来了)。

---

## B. 封面正则写死了属性顺序

状态: **已完成** (pi/flash 实现, 编排方复核)

`epub.py` 的 `<meta name="cover" content="id"/>` 正则要求 `name` 在 `content` 之前,
但 XML 属性顺序是任意的。实测 Winn-Dixie 和 Holes 写的都是
`<meta content="..." name="cover"/>`, 当前代码解析结果为 None → 这两本没封面。

---

## C. Number the Stars 老书包无封面

状态: **待用户操作**(不需要改代码)

它的书包是 08-13 01:04 打的, 早于封面功能。当前代码能正确解析出 `cover.jpeg`。
书卡菜单里的「补封面」可直接回填。若 A 之后要全量重跑, 这一条会被顺带解决。

---

## D. S5 判据不看标题重复度

状态: **已完成** (pi/flash 实现, 编排方复核)

`core/standard.py` 的 S5 只数 `(Untitled)` 占比。Frindle 21 章标题全是 'Nick',
无题 0% → 判"达标", 但章节列表里 21 行同名, 可用性等同于全部无题。
补一维: 标题去重数 / 章数过低 → 报警。

---

## E. 4 本书讲解新旧混杂

状态: **等 A 定案**

Hatchet / Charlottes Web / Wild Robot / Despereaux 的成品里, 讲解是"K33 新短 + 旧长"
混着的(旧数据占 47%-100%)。若 A 落地后要全量重跑, 这一条随之解决, 不单独做。
