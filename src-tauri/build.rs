//! 构建脚本: 声明前端资源为 cargo 构建依赖。
//!
//! 背景 (2026-08-07 真实回归): `generate_context!` 在编译期把 ../reader 下的文件嵌进
//! 二进制, 但 cargo 不知道这件事——默认只 rerun-if-changed 了 tauri.conf.json 和
//! capabilities。于是只改 JS/CSS 时 cargo 认为无事可做, 不重编 main.rs, 嵌进去的前端
//! 永远停在上一次编译时的样子(用户跑的就是"新 Rust 后端 + 旧前端"的错位版本)。
//!
//! 这里递归遍历 ../reader, 对每个文件 emit rerun-if-changed; 目录本身也 emit——
//! 新增文件时目录 mtime 变化能触发重跑, 这样"往 reader/ 加新模块"也不会漏。

use std::path::Path;

fn track_tree(dir: &Path) {
    let mut entries: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(read) = std::fs::read_dir(dir) {
        for e in read.flatten() {
            entries.push(e.path());
        }
    }
    entries.sort();
    for p in entries {
        if p.is_dir() {
            println!("cargo:rerun-if-changed={}", p.display());
            track_tree(&p);
        } else if p.is_file() {
            println!("cargo:rerun-if-changed={}", p.display());
        }
    }
}

fn main() {
    let reader = Path::new(env!("CARGO_MANIFEST_DIR")).join("../reader");
    if reader.is_dir() {
        track_tree(&reader);
    }
    tauri_build::build()
}
