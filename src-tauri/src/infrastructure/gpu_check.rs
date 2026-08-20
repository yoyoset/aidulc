//! infrastructure/gpu_check.rs —— 显卡占用检测 (2026-08-20)
//!
//! 背景 (用户实测复现): 本地词典查询偶发超时/失败, 根因是用户自己另起了一个
//! `llama.cpp` 的 `llama-server.exe`(独立进程, 不是 aidulc 起的), 常驻加载了一个
//! 35B 参数模型, 长期占着显卡——aidulc 自己的词典守护(2.4GB Qwen3-4B)想上卡推理
//! 时要跟它抢显存/算力, 抢不过就超时。用户不知道显卡上还挂着什么, 也不知道怎么关。
//!
//! 方案: 打开书时问一次 `nvidia-smi`, 找出"纯计算类型"(Type 列是 `C`, 不是 `C+G`)
//! 的进程——`C+G` 是普通桌面窗口触发的图形合成, 几乎每个开着的窗口都会挂一条,
//! 不能拿来当"占用信号"; 只有真正在用 GPU 做计算的进程(如 llama-server.exe、
//! aidulc 自己的侧车)才会是纯 `C`。排除掉 aidulc 自己的进程名, 剩下的就是"外部
//! 占用者", 连同显存余量一起报给前端, 由用户决定要不要点掉。
//!
//! nvidia-smi 在这台机器(WDDM 驱动)上不报告单进程显存(`GPU Memory Usage` 列恒为
//! `N/A`), 只有顶部总览行的 `已用/总量` 是准的——所以判定"是否需要提醒"看总览的
//! 剩余显存, 具体是谁占用看 Processes 表的 Type 列, 两条信息来源不同, 分开解析。

use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x08000000;
/// 我们自己的进程 —— 不管这些占了多少显存, 都不算"外部占用"。
const OWN_PROCESS_NAMES: &[&str] = &["aidulc.exe", "aidulc-prep.exe"];
/// 剩余显存低于这个值才提醒 (Qwen3-4B Q4_K_M 权重 2.4GB, 留出 KV cache/运行时余量)。
pub const LOW_FREE_MB_THRESHOLD: u64 = 4096;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct GpuProcess {
    pub pid: u32,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct GpuStatus {
    /// false = 没有 nvidia-smi(非 N 卡机器/驱动没装), 前端应该完全不提这件事。
    pub available: bool,
    pub used_mb: u64,
    pub total_mb: u64,
    pub free_mb: u64,
    /// 纯计算类型(Type=C)且不是 aidulc 自己的进程。
    pub foreign_processes: Vec<GpuProcess>,
}

impl GpuStatus {
    /// 前端要不要弹提示: 显存紧张 且 确实有外部计算进程占着(不是随便一个窗口)。
    pub fn should_warn(&self) -> bool {
        self.available && self.free_mb < LOW_FREE_MB_THRESHOLD && !self.foreign_processes.is_empty()
    }
}

fn unavailable() -> GpuStatus {
    GpuStatus {
        available: false,
        used_mb: 0,
        total_mb: 0,
        free_mb: 0,
        foreign_processes: vec![],
    }
}

/// 问一次 nvidia-smi (纯文本表格模式, 同时带总览行和 Processes 表, 单次调用够用,
/// 不用分别发 --query-gpu 和 --query-compute-apps 两次)。找不到 nvidia-smi 或非 0
/// 退出码 → 判"不可用", 静默跳过 (没有 N 卡是正常情况, 不是错误)。
pub fn check_gpu() -> GpuStatus {
    let output = Command::new("nvidia-smi")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(o) if o.status.success() => parse_nvidia_smi(&String::from_utf8_lossy(&o.stdout)),
        _ => unavailable(),
    }
}

/// 杀掉一个显卡占用进程 (用户在提示里点了"关闭"才会调, 不在检测阶段自动执行)。
pub fn kill_process(pid: u32) -> Result<(), String> {
    let out = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("调用 taskkill 失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "关闭进程失败 (PID {pid}): {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// 解析 `nvidia-smi` 纯文本输出。总览行形如 `11732MiB / 12288MiB`; Processes 表每行
/// 形如 `|    0   N/A  N/A           11236      C   ...os\llama.cpp\llama-server.exe      N/A      |`
/// —— 用空白分词后定位 PID(第 4 列)/Type(第 5 列)/进程名(第 6 列, 路径可能被截断
/// 但文件名后缀在, basename 匹配够用)。
fn parse_nvidia_smi(text: &str) -> GpuStatus {
    let mem_re_used_total = text.lines().find_map(parse_mem_line);
    let Some((used_mb, total_mb)) = mem_re_used_total else {
        return unavailable();
    };

    let mut foreign = Vec::new();
    let mut in_process_table = false;
    for line in text.lines() {
        if line.contains("PID") && line.contains("Type") {
            in_process_table = true;
            continue;
        }
        if !in_process_table {
            continue;
        }
        if let Some(p) = parse_process_line(line) {
            let base = p.name.rsplit(['\\', '/']).next().unwrap_or(&p.name);
            let is_own = OWN_PROCESS_NAMES
                .iter()
                .any(|own| own.eq_ignore_ascii_case(base));
            if !is_own {
                foreign.push(p);
            }
        }
    }

    GpuStatus {
        available: true,
        used_mb,
        total_mb,
        free_mb: total_mb.saturating_sub(used_mb),
        foreign_processes: foreign,
    }
}

fn parse_mem_line(line: &str) -> Option<(u64, u64)> {
    // 例: "|  0%   46C    P8             17W /  170W |   11732MiB /  12288MiB |      8%      Default |"
    let idx = line.find("MiB")?;
    let after_first = &line[idx + 3..];
    let idx2 = after_first.find("MiB")?;
    let used = line[..idx]
        .rsplit(char::is_whitespace)
        .find(|s| !s.is_empty())?
        .parse::<u64>()
        .ok()?;
    let total_segment = &after_first[..idx2];
    let total = total_segment
        .trim()
        .trim_start_matches('/')
        .trim()
        .parse::<u64>()
        .ok()?;
    Some((used, total))
}

fn parse_process_line(line: &str) -> Option<GpuProcess> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    // 期望列: [ | , GPU(0), GI(N/A), CI(N/A), PID, Type, ProcessName..., GPUMemory, |]
    // Type 必须严格等于 "C"(纯计算) —— "C+G" 是普通窗口图形合成, 不算占用信号。
    let type_idx = cols.iter().position(|c| *c == "C")?;
    if type_idx < 1 {
        return None;
    }
    let pid: u32 = cols[type_idx - 1].parse().ok()?;
    // 进程名在 Type 之后、到倒数第二列(最后一列是收尾的 "|", 倒数第二列是显存用量列)。
    if cols.len() < type_idx + 3 {
        return None;
    }
    let name = cols[type_idx + 1..cols.len() - 2].join(" ");
    if name.is_empty() {
        return None;
    }
    Some(GpuProcess { pid, name })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 实测抓的真实 nvidia-smi 输出(本机 RTX 3060, 2026-08-20): 27 个 C+G 窗口进程
    /// (含 aidulc 自己会误撞到的 explorer.exe 等) + 3 个纯 C 计算进程(2 个 aidulc-prep.exe
    /// 该被排除, 1 个 llama-server.exe 该被保留)。
    const FIXTURE: &str = r#"Thu Aug 20 20:49:00 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 610.74                 KMD Version: 610.74        CUDA UMD Version: 13.3     |
+-----------------------------------------+------------------------+----------------------+
| GPU  Name                  Driver-Model | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
|                                         |                        |               MIG M. |
|=========================================+========================+======================|
|   0  NVIDIA GeForce RTX 3060      WDDM  |   00000000:03:00.0  On |                  N/A |
|  0%   46C    P8             17W /  170W |   11732MiB /  12288MiB |      8%      Default |
|                                         |                        |                  N/A |
+-----------------------------------------+------------------------+----------------------+

+-----------------------------------------------------------------------------------------+
| Processes:                                                                              |
|  GPU   GI   CI              PID   Type   Process name                        GPU Memory |
|        ID   ID                                                               Usage      |
|=========================================================================================|
|    0   N/A  N/A            2612    C+G   D:\OrcaSlicer\orca-slicer.exe         N/A      |
|    0   N/A  N/A           10328    C+G   C:\Windows\explorer.exe               N/A      |
|    0   N/A  N/A           10816      C   ...t\aidulc-prep\aidulc-prep.exe      N/A      |
|    0   N/A  N/A           11236      C   ...os\llama.cpp\llama-server.exe      N/A      |
|    0   N/A  N/A           48916      C   ...t\aidulc-prep\aidulc-prep.exe      N/A      |
+-----------------------------------------------------------------------------------------+
"#;

    #[test]
    fn parses_total_and_used_memory() {
        let s = parse_nvidia_smi(FIXTURE);
        assert!(s.available);
        assert_eq!(s.used_mb, 11732);
        assert_eq!(s.total_mb, 12288);
        assert_eq!(s.free_mb, 556);
    }

    #[test]
    fn excludes_own_processes_and_graphics_type() {
        let s = parse_nvidia_smi(FIXTURE);
        // 只剩 llama-server.exe: aidulc-prep.exe ×2 被排除(自己的进程),
        // orca-slicer.exe/explorer.exe 被排除(Type 是 C+G, 不是纯计算)。
        assert_eq!(s.foreign_processes.len(), 1, "{:?}", s.foreign_processes);
        assert_eq!(s.foreign_processes[0].pid, 11236);
        assert!(s.foreign_processes[0].name.ends_with("llama-server.exe"));
    }

    #[test]
    fn should_warn_when_free_low_and_foreign_process_present() {
        let s = parse_nvidia_smi(FIXTURE);
        assert!(s.should_warn(), "556MB 剩余 + 有外部占用者, 必须提醒");
    }

    #[test]
    fn does_not_warn_when_only_own_processes_present() {
        let fixture_own_only = FIXTURE.replace(
            r"...os\llama.cpp\llama-server.exe",
            r"...t\aidulc-prep\aidulc-prep.exe",
        );
        let s = parse_nvidia_smi(&fixture_own_only);
        assert!(s.foreign_processes.is_empty());
        assert!(!s.should_warn(), "只有自己的进程占用时不该提醒用户");
    }

    #[test]
    fn does_not_warn_when_memory_is_plentiful() {
        let fixture_plenty = FIXTURE.replace("11732MiB", "2000MiB");
        let s = parse_nvidia_smi(&fixture_plenty);
        assert_eq!(s.free_mb, 10288);
        assert!(
            !s.should_warn(),
            "显存充足时不该提醒, 哪怕有外部计算进程在跑"
        );
    }

    #[test]
    fn unavailable_when_output_has_no_memory_line() {
        let s = parse_nvidia_smi("command not found");
        assert!(!s.available);
        assert!(!s.should_warn());
    }
}
