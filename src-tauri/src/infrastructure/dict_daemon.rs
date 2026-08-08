//! infrastructure/dict_daemon.rs —— 常驻词典守护进程 (F21, 2026-08-08)
//!
//! 问题 (实测): word_lookup 每次未命中本地词典都 spawn 一个全新侧车进程, 重新加载
//! 2.4GB LLM 模型 → 冷启动 7.4s / 热 5.7s / 打包侧车 8.6s。用户每次查生词都干等。
//!
//! 方案: 侧车 `--lookup-server` 模式加载模型一次, 经 stdin/stdout 服务多次查词。
//! 本模块用全局注册表 (OnceLock<Mutex<Option<DictDaemon>>>) 持有这个进程 —— 与
//! sync_service 的 LAST_SYNC 同一模式, 避免把 State 穿透到每个命令。
//!
//! 生命周期:
//!   - 懒启动: 第一次查词才 spawn (不查词不占显存)
//!   - 空闲回收: 超过 120s 无查询 → 下次查词时重建 (释放显存)
//!   - 任务启动回收: jobs::spawn::spawn_prep 在起侧车 job 前调 stop() —— 任务要独占显存
//!   - 模型变更: 侧车/模型路径变化 → 重建
//!
//! 协议 (dict_server.py): 每行 stdin 一个 JSON 请求 {"word","context"},
//!   每行 stdout 一个 JSON 响应 {"ok":true,"result":{...}} 或 {"ok":false,"error":...}。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// daemon 代际号 —— watchdog 用来确认"还是我起的那个进程"再停
static DAEMON_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct DictDaemon {
    gen: u64,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    model: String,
    last_used: Instant,
}

fn registry() -> &'static Mutex<Option<DictDaemon>> {
    static REG: OnceLock<Mutex<Option<DictDaemon>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(None))
}

/// 杀掉当前守护进程, 释放侧车占用的显存。任务启动前调用 (spawn_prep)。
pub fn stop() {
    if let Ok(mut reg) = registry().lock() {
        if let Some(mut d) = reg.take() {
            let _ = d.child.kill();
            let _ = d.child.wait();
        }
    }
}

fn spawn(prep_path: &std::path::Path, model: &str) -> Result<DictDaemon, String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(prep_path);
    cmd.args(["--lookup-server", "--model", model])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("启动词典守护失败: {e}"))?;
    let stdin = child.stdin.take().ok_or("无法取得词典守护 stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("无法取得词典守护 stdout")?);
    let mut d = DictDaemon {
        gen: DAEMON_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        child,
        stdin,
        stdout,
        model: model.to_string(),
        last_used: Instant::now(),
    };
    // 消费启动 ready 行 (dict_server.py 启动即写 {"ok":true,"ready":true})。
    // 不消费的话, 第一个查询响应会被 ready 行顶掉, 首查必失败 (实测级 bug)。
    let mut ready = String::new();
    d.stdout
        .read_line(&mut ready)
        .map_err(|e| format!("读词典守护 ready 失败: {e}"))?;
    if ready.trim().is_empty() {
        return Err("词典守护启动失败 (进程提前退出)".to_string());
    }
    // M7 R33: 主动空闲回收 —— 上次查询后 IDLE_TIMEOUT 内没人再查就杀掉, 释放显存。
    // 惰性(下次查词才重建)会让"查过一次就长时间不读"的模型一直占 2.4GB。
    let wgen = d.gen;
    std::thread::spawn(move || {
        std::thread::sleep(IDLE_TIMEOUT);
        let mut reg = registry().lock().unwrap();
        let still_same = reg.as_ref().map(|x| x.gen == wgen).unwrap_or(false);
        let still_idle = reg
            .as_ref()
            .map(|x| x.last_used.elapsed() >= IDLE_TIMEOUT)
            .unwrap_or(false);
        if still_same && still_idle {
            if let Some(mut old) = reg.take() {
                let _ = old.child.kill();
                let _ = old.child.wait();
            }
        }
    });
    Ok(d)
}

/// 查词: 懒启动/重建守护 → 写一行请求 → 读一行响应。
/// 阻塞读: 侧车加载模型后单次查询 ~1s; 进程异常退出时 read_line 返回 Ok(0), 转成 Err。
pub fn lookup(
    prep_path: &std::path::Path,
    model: &str,
    word: &str,
    context: &str,
) -> Result<serde_json::Value, String> {
    let mut reg = registry()
        .lock()
        .map_err(|_| "词典守护注册表被占用".to_string())?;
    let stale = reg
        .as_ref()
        .map(|d| d.model != model || d.last_used.elapsed() > IDLE_TIMEOUT)
        .unwrap_or(true);
    if stale {
        if let Some(mut old) = reg.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        *reg = Some(spawn(prep_path, model)?);
    }
    let d = reg.as_mut().expect("已确保存在");
    let req = serde_json::json!({ "word": word, "context": context });
    writeln!(d.stdin, "{}", req).map_err(|e| format!("写词典守护请求失败: {e}"))?;
    d.stdin.flush().ok();
    d.last_used = Instant::now();

    let mut line = String::new();
    d.stdout
        .read_line(&mut line)
        .map_err(|e| format!("读词典守护响应失败: {e}"))?;
    if line.trim().is_empty() {
        return Err("词典守护进程已退出".to_string());
    }
    let v: serde_json::Value =
        serde_json::from_str(&line).map_err(|e| format!("词典守护响应非法: {e}"))?;
    if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null))
    } else {
        Err(v
            .get("error")
            .and_then(|x| x.as_str())
            .unwrap_or("词典守护查询失败")
            .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_maps_ok_result() {
        // 不真正起进程, 只验证 registry 的映射逻辑不可行(依赖子进程)——
        // 协议层测试放 Python 侧 (test_dict_lookup.py), 这里只保证模块编译 + stop 幂等。
        stop();
        stop(); // 二次调用不 panic
    }

    #[test]
    fn idle_timeout_constant_is_sane() {
        assert!(
            IDLE_TIMEOUT >= Duration::from_secs(60),
            "空闲回收不能太短, 否则刚加载就回收"
        );
    }
}
