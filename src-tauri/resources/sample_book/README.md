# 内置样书资产

随安装包发的带朗读样书, 由 `application/sample_book.rs` 用 `include_bytes!` 编进二进制。

- **文本**: Alice's Adventures in Wonderland 前三章的 11 个句子 (1865 年, 公版)。原文是自己打字的,
  源文件 `contracts/fixtures/sample_book/alice_sample.epub`, 由 `scripts/make_sample_book.py` 生成。
- **成品**: 2026-11-16 用真实侧车跑出来 (Qwen3-4B-Instruct-2507-Q4_K_M 翻译+讲解, Kokoro-82M `af_heart` 朗读,
  语速 1.0, 句级高亮)。11/11 句五个阶段全部成功 (`quality` 字段里有记录)。
- **人工改动只有三处**: `title` 改成"Sample: Alice in Wonderland (样书, 带朗读)"; `profile.name` 改成"成人自读";
  `models` 里的本机绝对路径换成模型名 (安装包里不能带生成机器的路径); 没有封面则删掉 `cover` 键。
- **体积**: bookpack.json 32 KB + 三章 opus 共 184 KB。

## 重新生成

```powershell
# 1. 写 job_request.json (models 指向本机的 llm/tts 文件, out_dir 用一个空目录, 不要指向真实书库)
# 2. 跑侧车 (不经过应用, 不碰数据库):
prep\dist\aidulc-prep\aidulc-prep.exe --job <job_request.json> --out <空目录>
# 3. 把产出的 bookpack.json 和 audio\ch_*.opus 拷到这里, 重做上面三处人工改动
```

`sample_book.rs` 里的单测 `embedded_bookpack_matches_embedded_audio` 会校验: 每章音频都内置、每句 `status == ok`、
没有 `hf_cache` / `C:/Users` 这类本机路径。换了资产或章数, 同步改 `AUDIO` 数组。

**注意**: 重新生成会换掉讲解/译文 (LLM 输出不是确定性的), 换完要人耳听一遍声音和高亮是否对得上。
