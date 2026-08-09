# 书籍工作流重构需求

> 这份文档把“导入原书”和“生成可阅读译本”拆成两个明确阶段。
> 它是实现前的流程基线，不代表当前代码已经满足。

## 1. 用户心智模型

用户只需要理解三件事：

1. **原书**：我导入的 EPUB/PDF/TXT 文件。它只是来源，不能阅读。
2. **译本**：我选择一套 profile、模型和语言后，由原书生成的可阅读版本。
3. **阅读**：我打开某一个译本；阅读进度、书签和音频都属于这个译本。

“导入一次”不能同时制造原书和可阅读成品。导入只登记 source；准备完成后才创建或覆盖 edition。

## 2. 目标流程

### 2.1 导入原书

入口只有一个：`我的书 → 导入原书`。

用户选择文件后，系统必须：

- 校验扩展名和文件可读性。
- 计算稳定的 source identity，避免同一个文件在一次操作中登记两次。
- 只写入一条 source 记录：标题、源文件路径、语言、导入时间。
- 不创建 pack_dir。
- 不创建 reading_state、书签或 edition。
- 导入成功后显示 source 卡，状态为“待配置”，并提供“创建译本”按钮。

重复导入规则：

- 同一 source identity 已存在时，不新增第二条 source。
- 如果文件路径相同但文件内容已改变，提示“原文件已变化”，由用户选择更新 source 或取消；不能静默覆盖。
- 同一拖拽/选择事件只能触发一次导入请求，前端监听器必须可注销。

### 2.2 配置并创建译本

点击 source 卡的“创建译本”后打开 edition 配置面板。配置面板必须在真正开始准备前完成：

- 学习 profile：成人自读、陪小孩读或用户自建 profile。
- 源语言。
- 目标语言。
- LLM 模型。
- TTS 模型。
- NLP 模型。
- 可选的 profile 参数快照：讲解策略、音色、语速、高亮粒度。

配置面板必须展示统一的模型状态：

- 已扫描：发现了文件，但尚未登记。
- 已登记：模型已经进入 `model_registry`。
- 可用：登记记录指向的文件存在且通过完整性检查。
- 已绑定：当前 edition 配置实际选择了它。

这四个状态由后端返回，前端只渲染，不在多个视图中自行推导。

点击“开始准备”前执行 preflight：

- source 文件存在且格式支持。
- LLM/TTS/NLP 依赖满足。
- ffmpeg 和侧车存在。
- 输出目录可写。
- 当前 source 没有同配置的运行中任务。

失败时必须停留在配置面板，显示“原因 + 下一步动作”，不能创建假成功的 edition。

### 2.3 阅读准备

点击“开始准备”后：

- 创建一个明确关联 `source_id` 的 job。
- job 保存完整 profile 和模型快照。
- 使用独占临时输出目录生成 pack。
- 处理过程中 source 状态显示“准备中”，edition 状态显示“生成中”或“尚未登记”。
- UI 显示阶段、句数、百分比、失败原因和可执行操作。
- 处理失败时保留 checkpoint 和 job 详情，允许重试；不能把失败任务伪装成可阅读 edition。

处理成功后：

- 校验 `bookpack.json`。
- 按 `source_id + profile + 语言 + LLM + TTS + NLP` 查找逻辑 edition。
- 同配置重跑覆盖该 edition，保留稳定 edition id；新 pack 完整后再替换旧 pack。
- 不同配置创建新的 edition。
- 每个 edition 必须有独占 pack_dir。
- 将 job 显式关联到 edition_id。

### 2.4 书库展示

书库只保留一个主入口，不再分“原版书库”和“我的书”两个平铺页面。

展示结构：

```text
原书《Alice》
  ├─ 成人自读 · Qwen3 · Kokoro · 中文      [打开阅读] [删除译本]
  └─ 陪小孩读 · Qwen3 · Kokoro · 中文       [打开阅读] [删除译本]
```

source 卡显示：原文件、语言、导入时间、译本数量、准备状态。

edition 卡显示：profile、目标语言、模型组合、可阅读状态、阅读进度和最近打开时间。

source 不能直接“打开阅读”；只有 edition 可以打开阅读。

### 2.5 阅读

打开 edition 时：

- 所有 bookpack、音频、插图和章节请求只使用 edition_id 对应的 pack_dir。
- reading_state、书签、highlights、reading_daily 只使用 edition_id。
- source 被删除或 pack 不存在时，页面显示可读错误和返回书库动作，不能白屏。
- 加载大书时先显示加载态；章节按需加载，不把整本 pack 一次性塞进 IPC。

## 3. 删除规则

### 删除 edition

事务内删除：

- edition 记录。
- reading_state。
- reading_daily。
- highlights/书签。
- edition 关联 jobs。

事务成功后删除独占 pack_dir。若历史数据仍有共享 pack_dir，必须先确认仍有其它 edition 引用，不能误删。

删除一个 edition 后，同一 source 的其它 editions 必须仍能打开阅读。

### 删除 source

按已确认产品决策级联删除 source 的全部 editions，并执行每个 edition 的清理规则。完成后不得存在：

- 指向不存在 edition 的阅读状态。
- 指向不存在 edition 的书签或摘录。
- 指向不存在 source/edition 的 job。
- 仍被数据库引用的 pack_dir。

## 4. 阶段 0 取证结果(2026-08-09, 详见 docs/FORENSIC_P0.md)

> 原取证任务已执行完毕, 本节记录结论, 作为阶段 2/3 修复依据。

### 导入两次(结论)

- **F34 fix 顺序颠倒(工作树 + 提交 786ca83 都有)**: `_buildImportCard()` 先注册新的
  `tauri://drag-drop` listener 并把 unlisten 存进 `this._offDrag`, 随后 render() 里
  `if (this._offDrag) { this._offDrag(); this._offDrag = null; }` 立刻注销了**刚注册的
  listener** —— 不是注销旧的。结果: 每次 render 后拖拽 listener 被立即杀死, 拖拽导入
  在当前代码实际不工作(与 F34 想解决的"累积"相反)。
- 后端 `batch_import` **source 幂等**(`book_id_from_path(path, profile)` 去重, 同路径同
  profile 重复导入只登记一次), 但**每次调用必新建一个 batch**。
- 真实 DB 快照: 1 source / 4 batch(3 历史 completed + 1 当前 running) / 1 job, 无重复 source。
- 单次动作的 invoke 次数、拖拽/文件选择双对话框是否触发两次导入: 待阶段 2 在 exe 内注入
  drag-drop + 连续点按复现, 并配自动化测试(同路径二次导入仍 1 source; 单次拖拽单 batch;
  re-render 不累积 listener; 刷新不重放导入)。

### 阅读卡死(结论)

- 92MB 整包 IPC 卡死已由 916534b 修复(`load_bookpack` 只回元信息 + 按需单章 + 渐进渲染)。
- 剩余真实结构问题: `load_bookpack` / `load_bookpack_chapter` **每次请求都整文件读 + 全量
  JSON 解析**。真实 Wolf 21 书包(23.88MB / 8007 句 / 46 章)实测: 单次 open 读+解析 ≈ 470ms;
  **每切一章 ≈ 419ms 整文件重读重解析**; meta 响应仍含全部 original_text(1.3MB)。
- ~100KB EPUB 的 bookpack 约 1.5MB(parse ~26ms), 不构成大小卡死 —— 不归因于文件大小。
- 用户当前这本书仍在 processing(无 bookpack), 无法在 exe 里直接复现; 待该书完成后在 exe 里
  复现, 并修 `load_bookpack_chapter` 改为按章只读/缓存 + loading/error/retry 可见态(阶段 3)。

## 5. 本轮不做

- 不在没有确认重复导入根因前继续叠加导入兼容逻辑。
- 不把 source 伪装成 edition。
- 不重跑现有大书做批量迁移。
- 不修改 F26、F38、F39。

## 6. 阶段收尾交付清单(固定动作, 每阶段必做)

> 2026-08-09 起强制。教训: F36/F37 便携版过期每阶段都重新发现一次 —— 只有把
> "重打便携版" 写成本阶段收尾的固定动作, 才不会每个阶段再踩一遍。
> 2026-08-10 复核补一条硬顺序: **必须先等代码全部提交完, 再打包** —— 先打包后提交
> 会让便携版比最后一个代码提交早 (N5b 实测: 打包 18:53, N6 代码提交 19:00, 便携版不含
> N6 改动)。

阶段收尾(写阶段报告/打 tag 之前)依次执行:

1. `.\scripts\check.ps1` 全绿。
2. **代码全部提交完**(N1-Nn 一条一提交, 不许边打包边提交)。
3. 重打便携版 `dist\aidulc-portable\`(三步, 缺一不可):
   a. 先结束运行中的 `aidulc.exe` / `aidulc-prep.exe`(运行中会锁文件, 构建失败踩过);
   b. `cargo build --release`(嵌当前前端) → 复制 `src-tauri\target\release\aidulc.exe`
      到 `dist\aidulc-portable\aidulc.exe`;
   c. `.\scripts\build_prep.ps1`(重打侧车, 含全部 prep 改动) → 复制
      `prep\dist\aidulc-prep\aidulc-prep.exe` + `_internal` 到 `dist\aidulc-portable\prep\`
      (先删旧的 `_internal`)。
   d. 确认 `config.toml` 仍是干净默认(无开发机绝对路径)。
4. 核对便携版两个二进制时间戳 ≥ **最后一个代码提交**的时间, 否则就是漏了第 2/3 步。
5. 在阶段报告/交接记录里注明便携版已重打(或明确本次不做 + 理由)。
