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
//!
//! K2 (2026-08-11): 读响应加超时 —— 侧车挂死时 `read_line` 会永久阻塞。改成
//! 专用 reader 线程 + `recv_timeout` (与 services/components.rs::read_stdout_with_timeout
//! 同一模式, 不新造一套): 超时 → kill 守护 → 从注册表移除 → 返回明确错误。查词路径
//! 永远在超时内返回, 不会再永久挂起主线程。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// 守护进程启动后等待 ready 行的上限 (侧车要解包 66MB + 加载模型, 给足时间)
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// 单次查词读响应上限: 正常单查询 ~1s, 慢机/忙时留足余量; 挂死则在此内返回错误
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(30);

/// daemon 代际号 —— watchdog 用来确认"还是我起的那个进程"再停
static DAEMON_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct DictDaemon {
    gen: u64,
    child: Child,
    stdin: ChildStdin,
    /// reader 线程推送的 stdout 行 (每查一词消费一行)
    rx: mpsc::Receiver<String>,
    /// stderr 尾部 (进程秒退时取最后几行给人话, 不吞)
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
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
    // 参数名契约 (2026-08-13 实测修正): 打包入口是 cli.py, 它只认 --lookup-model,
    // 不是 --model。旧代码传 --model → 侧车 argparse 秒退 (exit 2), ready 行永远等不到,
    // recv_timeout 拿到 Disconnected 又被误标成"启动超时 (侧车未就绪)" —— 用户看到的
    // 正是这句话。dict_server.py 自己的 argparse 才接受 --model (单测直连它, 所以一直没暴露)。
    cmd.args(["--lookup-server", "--lookup-model", model])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // 2026-08-13 实测修正: 原来 Stdio::null() 把侧车启动失败的原因整个吞掉 (秒退时
        // 用户只看到"启动超时", 不知道 argparse 报了什么)。改 piped + 专用线程读尾部,
        // 进程秒退时把最后几行 stderr 一起上屏, 失败原因人话可见。
        .stderr(Stdio::piped())
        .creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("启动词典守护失败: {e}"))?;
    let stdin = child.stdin.take().ok_or("无法取得词典守护 stdin")?;
    let stdout = child.stdout.take().ok_or("无法取得词典守护 stdout")?;
    let stderr = child.stderr.take().ok_or("无法取得词典守护 stderr")?;

    // K2: 专用 reader 线程持有 BufReader, 每行经 channel 推给主线程。
    // 查词侧用 recv_timeout 读, 侧车挂死也只会阻塞到 LOOKUP_TIMEOUT。
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break, // EOF (进程退出)
                Ok(_) => {
                    if tx.send(line).is_err() {
                        break; // 接收端已弃 (守护被杀)
                    }
                }
                Err(_) => break,
            }
        }
    });

    // stderr 尾部缓冲 (2026-08-13): 进程秒退时把最后几行报错上屏。侧车挂死/慢启动时
    // 这段缓冲也在, 启动成功后的运行期 stderr 不读 (留给查词超时排查用, 只留尾部)。
    let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    {
        let buf = stderr_tail.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let mut b = buf.lock().unwrap();
                        b.push_back(line.trim_end().to_string());
                        if b.len() > 8 {
                            b.pop_front();
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    let d = DictDaemon {
        gen: DAEMON_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        child,
        stdin,
        rx,
        stderr_tail: stderr_tail.clone(),
        model: model.to_string(),
        last_used: Instant::now(),
    };
    // 消费启动 ready 行 (dict_server.py 启动即写 {"ok":true,"ready":true})。
    // 不消费的话, 第一个查询响应会被 ready 行顶掉, 首查必失败 (实测级 bug)。
    // 2026-08-13: 区分"超时"(进程还活着没 ready) 与"进程秒退/提前退出"—— 后者带 stderr
    // 尾部上屏 (否则又是"启动超时"一句空话, 不知道侧车为什么没起来)。
    match d.rx.recv_timeout(START_TIMEOUT) {
        Ok(ready) => {
            if ready.trim().is_empty() {
                let tail = stderr_tail_string(&d);
                return Err(format!("词典守护启动失败 (进程未输出就绪行){}", tail));
            }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(
                "词典守护启动超时 (侧车未就绪, 可稍后重试; 仍失败请在设置·组件健康检查侧车)".into(),
            );
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let tail = stderr_tail_string(&d);
            return Err(format!("词典守护启动失败 (侧车提前退出){}", tail));
        }
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

/// 进程提前退出时, 把 stderr 尾部的报错拼进错误文案 (人话: 用户能看到侧车为什么没起来)。
fn stderr_tail_string(d: &DictDaemon) -> String {
    let lines: Vec<String> = d.stderr_tail.lock().unwrap().iter().cloned().collect();
    if lines.is_empty() {
        String::new()
    } else {
        format!(": {}", lines.join(" | "))
    }
}

/// 查词: 懒启动/重建守护 → 写一行请求 → 带超时读一行响应。
/// K2: 读响应用 recv_timeout; 超时 → kill 守护并清出注册表, 下次查词重建。
///
/// 2026-09-05 (用户: "为什么不重新指定即使失败也可以重新用本地来查询的方式从
/// 结构上杜绝这个问题"): 单次失败(挂死超时/进程提前退出/写请求失败)大概率是
/// 守护卡在坏状态, 不是这个词真查不到——不再要求用户手动点"重置并重试", 这里
/// 自己强制清一次注册表再试一次。这样"查词失败面板点重置也失败"这类问题, 只要
/// 第二次真能成功, 用户压根看不到失败态。仍失败才把(第二次的)原因交给上层。
pub fn lookup(
    prep_path: &std::path::Path,
    model: &str,
    word: &str,
    context: &str,
) -> Result<serde_json::Value, String> {
    lookup_with_retry(prep_path, model, word, context, LOOKUP_TIMEOUT)
}

/// 可注入超时版本的 lookup(重试)(K2 单测写法的延续: 短超时验证重试路径不用
/// 真等 LOOKUP_TIMEOUT)。
fn lookup_with_retry(
    prep_path: &std::path::Path,
    model: &str,
    word: &str,
    context: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    if let Ok(v) = lookup_with_timeout(prep_path, model, word, context, timeout) {
        return Ok(v);
    }
    stop();
    lookup_with_timeout(prep_path, model, word, context, timeout)
}

/// 可注入超时版本的 lookup (K2 单测: 用永不响应的假进程 + 短超时验证超时路径)。
fn lookup_with_timeout(
    prep_path: &std::path::Path,
    model: &str,
    word: &str,
    context: &str,
    timeout: Duration,
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
    let req = serde_json::json!({ "word": word, "context": context });
    {
        let d = reg.as_mut().expect("已确保存在");
        writeln!(d.stdin, "{}", req).map_err(|e| format!("写词典守护请求失败: {e}"))?;
        d.stdin.flush().ok();
        d.last_used = Instant::now();
    }

    // K2: 读响应只在 timeout 内等待; 超时/进程退出 → kill 并清出注册表 (下次重建)
    let line = {
        let d = reg.as_mut().expect("已确保存在");
        match d.rx.recv_timeout(timeout) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // 侧车挂死: kill + 移除, 返回明确错误
                let mut hung = reg.take().expect("已确保存在");
                let _ = hung.child.kill();
                let _ = hung.child.wait();
                return Err("词典守护响应超时, 已重置守护进程".to_string());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = reg.take();
                return Err("词典守护进程已退出".to_string());
            }
        }
    };
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

    #[test]
    fn recv_timeout_on_dead_channel_returns_disconnected() {
        // K2: 超时语义验证 —— 通道已关 (进程退出) → Disconnected, 不 panic
        let (tx, rx) = mpsc::channel::<String>();
        std::mem::drop(tx);
        let r = rx.recv_timeout(Duration::from_millis(50));
        assert!(matches!(r, Err(mpsc::RecvTimeoutError::Disconnected)));
    }

    #[test]
    fn hung_daemon_times_out_and_is_reset() {
        // K2: 注入永不响应的假守护 → 查词在超时内返回错误 (照 S0 单测写法)。
        // 假守护 = 一段 .bat: 输出 ready 行后挂起 (ping 自己 ~30 秒), 从不读 stdin 也不回复。
        // 用短超时 (300ms) 验证 recv_timeout 路径: 超时 → kill 守护 → 返回"响应超时"。
        let dir = std::env::temp_dir().join(format!(
            "aidulc_dd_fake_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake_prep.bat");
        std::fs::write(
            &fake,
            "@echo off\r\necho {\"ok\":true,\"ready\":true}\r\nping -n 30 127.0.0.1 >nul\r\n",
        )
        .unwrap();

        let t0 = Instant::now();
        let r = lookup_with_timeout(
            &fake,
            "fake-model",
            "doorway",
            "ctx",
            Duration::from_millis(300),
        );
        let elapsed = t0.elapsed();
        stop();

        // 超时路径: 返回"响应超时", 且远小于 READY 超时 (证明没等侧车无界阻塞)
        let msg = r.expect_err("永不响应的守护必须超时失败");
        assert!(msg.contains("超时"), "应为超时文案: {msg}");
        assert!(
            elapsed < Duration::from_secs(5),
            "应在短超时内返回, 实耗 {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retry_recovers_when_first_attempt_hangs_and_second_succeeds() {
        // 2026-09-05 (用户: "为什么不重新指定即使失败也可以重新用本地来查询的方式
        // 从结构上杜绝这个问题"): lookup_with_retry 第一次失败后自己 stop()+重试
        // 一次, 不需要用户手动点"重置并重试"。假守护用标记文件模拟"第一次挂死,
        // 重建后第二次能正常应答"——同一个 .bat 被 spawn 两次(第一次超时后旧进程
        // 被杀、注册表清空, 第二次 stale=true 会真的重新起一个新进程)。
        let dir = std::env::temp_dir().join(format!(
            "aidulc_dd_retry_ok_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake_prep.bat");
        std::fs::write(
            &fake,
            "@echo off\r\n\
             if exist \"%~dp0marker.txt\" goto respond\r\n\
             echo x > \"%~dp0marker.txt\"\r\n\
             echo {\"ok\":true,\"ready\":true}\r\n\
             ping -n 30 127.0.0.1 >nul\r\n\
             exit /b\r\n\
             :respond\r\n\
             echo {\"ok\":true,\"ready\":true}\r\n\
             set /p REQ=\r\n\
             echo {\"ok\":true,\"result\":{\"pos\":\"NOUN\",\"phonetic\":\"\",\"meanings\":[\"斑马\"],\"examples\":[],\"example_zh\":[],\"usage\":\"\",\"phrases\":[]}}\r\n",
        )
        .unwrap();

        let r = lookup_with_retry(
            &fake,
            "fake-model",
            "zebra",
            "ctx",
            Duration::from_millis(300),
        );
        stop();
        let v = r.expect("第二次应该成功, 不该把第一次的失败当最终结果");
        assert_eq!(v["meanings"][0], "斑马");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retry_gives_up_after_second_attempt_also_fails() {
        // 两次都挂死: 只重试一次, 不无限重试; 返回第二次的失败, 总耗时约 2x 单次超时
        // (不是无界拖长)。
        let dir = std::env::temp_dir().join(format!(
            "aidulc_dd_retry_fail_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake_prep.bat");
        std::fs::write(
            &fake,
            "@echo off\r\necho {\"ok\":true,\"ready\":true}\r\nping -n 30 127.0.0.1 >nul\r\n",
        )
        .unwrap();

        let t0 = Instant::now();
        let r = lookup_with_retry(
            &fake,
            "fake-model",
            "zebra",
            "ctx",
            Duration::from_millis(300),
        );
        let elapsed = t0.elapsed();
        stop();
        let msg = r.expect_err("两次都挂死应该最终失败, 不能假装成功");
        assert!(msg.contains("超时"), "应为超时文案: {msg}");
        assert!(
            elapsed < Duration::from_secs(10),
            "重试次数应有界(1 次), 不该拖成无界等待, 实耗 {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidecar_exiting_early_surfaces_stderr_not_timeout() {
        // 2026-08-13 实测根因回归: 打包入口 cli.py 只认 --lookup-model, Rust 传 --model
        // 会让侧车 argparse 秒退 (exit 2)。旧代码把 stderr 设 null + Disconnected 误标
        // "启动超时" → 用户只看到"侧车未就绪"一句空话。现在必须: ①报"启动失败 (侧车提前退出)"
        // 而不是"超时"; ②把 stderr 尾部的真实报错带上屏。
        // 假守护 = .bat 写一行 usage 报错到 stderr 后退出 (模拟 cli.py 拒 --model)。
        let dir = std::env::temp_dir().join(format!(
            "aidulc_dd_early_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("early_prep.bat");
        std::fs::write(
            &fake,
            "@echo off\r\necho unrecognized arguments: --model 1>&2\r\n",
        )
        .unwrap();

        let r = lookup_with_timeout(
            &fake,
            "fake-model",
            "doorway",
            "ctx",
            Duration::from_secs(5),
        );
        stop();
        let msg = r.expect_err("秒退的守护必须失败");
        assert!(
            msg.contains("启动失败") || msg.contains("提前退出"),
            "应报启动失败而非超时: {msg}"
        );
        assert!(
            !msg.contains("超时 (侧车未就绪)"),
            "不应该是误导的启动超时文案: {msg}"
        );
        assert!(
            msg.contains("unrecognized arguments"),
            "stderr 报错应上屏: {msg}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
