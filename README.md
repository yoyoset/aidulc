# aidulc

本地整本书英语精读/跟读工作站。丢一本 EPUB/PDF/TXT 进去,全自动跑完译文+分档讲解+高质量朗读+
逐词时间轴,生词经 CF Worker 同步到 [aidu](../aidu) 扩展/移动端复习。

架构与强制规约见 [CLAUDE.md](CLAUDE.md)(存储所有权表、contracts 校验、测试门禁、已知坑)。
当前待办见 [docs/ROADMAP.md](docs/ROADMAP.md)。历史执行记录(已归档,仅供追溯)见
[docs/archive/](docs/archive/)。

## 结构

```
src-tauri/  Rust 外壳(Tauri): 窗口/SQLite/子进程治理/CF 同步
reader/     WebView 前端: 阅读器 + 备料台 UI
prep/       Python 侧车: 一本书跑一次的离线批处理流水线
contracts/  三端共享的 JSON Schema(唯一权威, prep/aidulc_prep/schemas/ 是打包用的拷贝)
memory/     踩过的坑(配置/外部集成/状态管理/错误反馈), 改动前建议先读
docs/       BASELINE.md(回滚基准) + ROADMAP.md(活跃待办) + archive/(历史记录) + measurements/(Phase 0 实测数据)
```

## 环境要求

- Windows 11, Rust(stable, 2024 edition), Python 3.13(prep/.venv)
- NVIDIA GPU(RTX 3060 12GB 起步), CUDA 可用
- Node.js(仅前端测试需要, `reader/` 本身零构建步骤, 纯静态 JS/HTML/CSS)

## 首次设置

```powershell
# Python 侧车虚拟环境(prep/setup.ps1 里有完整步骤, 含 torch cu124 专用 index)
cd prep
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .

# 前端测试依赖
cd ..\reader
npm install
```

Rust 依赖由 `cargo` 在首次构建时自动拉取, 无需额外步骤。

## 开发

```powershell
# 起 Tauri 应用(reader/ 是静态文件, 无需单独跑前端 dev server)
cd src-tauri
cargo run
```

## 测试

一条命令跑全部(Python + Rust + 前端 + schema 校验 + fmt + clippy):

```powershell
.\scripts\check.ps1
```

单独跑某一层, 见 [CLAUDE.md](CLAUDE.md) 的"测试"一节。**Rust 测试必须 `--test-threads=1`**
(并行有共享临时 DB 状态冲突, 已知问题)。

## 构建

```powershell
# 1. Python 侧车(PyInstaller onedir, 就地换件不碰用户数据/日志)
.\scripts\build_prep.ps1

# 2. Rust 外壳
cd src-tauri
cargo build --release
```

产物: `src-tauri/target/release/aidulc.exe` + `prep/dist/aidulc-prep/`(需复制到 exe 同级
`prep/` 目录下, 参照 `dist/aidulc-portable/` 的现有布局)。**构建前需先关闭正在运行的应用**,
exe 运行时会被锁定。

## 已知问题

见 [docs/ROADMAP.md](docs/ROADMAP.md) 的 P0(书库路径解析 bug, 导致目前无法预测书包实际存放位置)。
