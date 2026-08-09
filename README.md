# aidulc

本地整本书英语精读 + 跟读工作站。丢一本 EPUB / PDF / TXT 进去, 全自动跑完
**分词 → 翻译 → 分档讲解 → 高质量朗读 → 逐词时间轴**, 然后你在一套为专注而设计的
阅读器里精读、查词、收生词、跟读; 生词可经 CF Worker 同步到 [aidu](../aidu) 扩展做复习。

架构与强制规约见 [CLAUDE.md](CLAUDE.md)(存储所有权表、contracts 校验、测试门禁、已知坑)。
当前待办见 [docs/ROADMAP.md](docs/ROADMAP.md); 历史执行记录(已归档, 仅供追溯)在
[docs/archive/](docs/archive/)。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 书籍主流程(原书 → 译本)

精读工作流拆成两个明确阶段, 详见 [docs/BOOK_WORKFLOW.md](docs/BOOK_WORKFLOW.md):

1. **导入原书**: 拖入/选择一本 EPUB / PDF / TXT, 只登记为"原书"(来源, 不可读)。
   同一文件重复导入不会产生第二条 source。
2. **创建译本**: 在原书卡点"创建译本"→ 配置学习档案 / 语言 / LLM / TTS → 开始备料。
   备料完成生成可阅读的"译本"; 相同参数重跑覆盖原译本, 不同参数生成多个译本。
3. **阅读**: 只能打开译本; 进度、书签、摘录都归属到具体译本。
4. **删除**: 删译本只清它自己; 删原书级联删除它的全部译本与数据。

## 功能亮点

- **三模式阅读器**(先答后核 / 静默正文 / 对照台 × 通篇 / 逐句跟读): 切换 `1/2/3`,
  `S` 换节奏, `J/K` 上/下句, `Enter` 核对, `T` 支撑卡片, `Ctrl+K` 命令面板。
  揭示机制按"先自己讲、再核对"设计(测试效应), 已核对的句子折叠成细痕, 跨会话记住。
- **主题**: 五套色系(陶土/青苔/海蓝/蔷薇/灰蓝 × 浅深)+ **自定义强调色**(色盘自由选,
  WCAG 亮度自动黑/白字)——全部经 WCAG AA 对比度实测(门禁校验)。
- **摘录标注**: 选中文字直接划句, 精确到词的软黄底 + 整句琥珀标, 可加备注, 跨设备随
  .aidu-data 备份/恢复。
- **阅读进度反馈**: 书库卡片显示"已读至第 X 章 · 共读 Y 分钟"; 播放位置跨会话精确恢复。
- **学习档案**: 成人/儿童/自建多档案, 每档独立讲解深度、音色、语速、高亮粒度; 重试失败句
  保留原档案参数。
- **一键下载引擎**: 模型中心直接下载 Qwen3-4B + Kokoro, 后台线程(不冻结 UI)+ 实时进度 +
  断点续传 + sha256 校验 + 防重复, 完成自动登记。
- **常驻词典服务**: 加载一次 LLM 模型, 多次查词复用(每次查词 5-8s → ~1s); 空闲自动回收/
  任务启动/退出时释放显存。
- **生词积累可见**: 近 14 天每日新增条形图 + 四阶段掌握度概览; .aidu-data 备份/恢复
  (生词/词典/摘录)。
- **完整闭环**: 书库(原书 + 译本层级) → 阅读准备(按批次分组, 暂停/继续/重试失败句/查看详情)
  → 译本 → 阅读 → 生词本 → CF 同步(可断开, 显示当前 Worker)。

## 结构

```
src-tauri/  Rust 外壳 (Tauri): 窗口/SQLite/子进程治理/CF 同步/常驻词典守护
reader/     WebView 前端: 三模式阅读器 + 书库/备料台/生词本/模型/设置/向导
prep/       Python 侧车: 一本书跑一次的离线批处理流水线
contracts/  三端共享的 JSON Schema (唯一权威; prep/aidulc_prep/schemas/ 是打包拷贝)
memory/     踩过的坑 (配置/外部集成/状态管理/错误反馈/阅读器), 改动前先读
docs/       BASELINE.md(回滚基准) + ROADMAP.md(活跃待办) + requirements.md(需求账本)
            + ARCHITECTURE.md(实测现状) + BOOK_WORKFLOW.md(书籍主流程基线)
            + FORENSIC_P0.md(取证报告) + ACCEPTANCE_P5.md(exe 验收) + UX_REQUIREMENTS.md
            + archive/(历史记录) + measurements/(实测数据)
scripts/    check.ps1(全量门禁) + run.ps1(构建并启动) + sync_schema.ps1(契约同步)
```

## 环境要求

- Windows 11, Rust(stable, 2024 edition), Python 3.13(`prep/.venv`)
- NVIDIA GPU(RTX 3060 12GB 起步), CUDA 可用
- Node.js(仅前端测试需要; `reader/` 零构建步骤, 纯静态 JS/HTML/CSS)

## 首次设置

```powershell
# Python 侧车虚拟环境 (prep/setup.ps1 有完整步骤, 含 torch cu124 专用 index)
cd prep
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .

# 前端测试依赖
cd ..\reader
npm install
```

Rust 依赖由 `cargo` 首次构建时自动拉取, 无需额外步骤。

## 启动

```powershell
# 构建并启动 (构建失败会停下来, 避免跑旧 exe)
.\scripts\run.ps1

# 或手动: 先 cargo build --release (前端资源编译期内嵌), 再跑 exe
cd src-tauri; cargo run
```

首次运行走向导; 模型可到"模型中心"一键下载, 或点"扫描已有模型"复用本地文件。

## 测试

```powershell
.\scripts\check.ps1   # 全量门禁: 契约一致 / fmt / clippy / build / Rust 测试 /
                      # Python 测试 / 前端测试 / DOM 冒烟 / css 令牌纪律 / 对比度
```

单独跑某一层见 [CLAUDE.md](CLAUDE.md)(Rust 必须 `--test-threads=1`)。
