//! jobs/job_guard.rs —— Job Object 治理 (照抄 subgen job_guard.rs, 含 R11 孙进程集成测试)
//!
//! aidulc 的孙进程结构: Rust 拉 Python 侧车, Python 拉 ffmpeg (TTS 已改为进程内库,
//! llama-server 也改为 llama_cpp_python 进程内 → 孙进程只剩 ffmpeg)。
//! 但 Python 自己 spawn 的进程**不会**自动进 Rust 建的 Job —— 除非 Job 是 kill-on-close
//! 且 Python 进程也被绑定 (Windows Job Object 默认子进程继承, Python 的孙进程会进同一个 Job)。

use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::sync::OnceLock;
use win32job::Job;

static CHILD_JOB: OnceLock<Job> = OnceLock::new();

/// 程序启动时调用一次。失败不阻断 (退化无防护, 比起不来好)。
pub fn init_child_job_object() {
    let Ok(job) = Job::create() else { return };
    let mut info = job.query_extended_limit_info().unwrap_or_default();
    info.limit_kill_on_job_close();
    if job.set_extended_limit_info(&info).is_err() {
        return;
    }
    let _ = CHILD_JOB.set(job);
}

/// spawn 后调用, 把子进程绑入 Job。失败静默忽略。
pub fn bind_child_to_job(child: &Child) {
    if let Some(job) = CHILD_JOB.get() {
        let handle = child.as_raw_handle() as isize;
        let _ = job.assign_process(handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;

    /// R11 实测: 真拉起孙进程再杀父 (照抄 subgen 的测法, 不接受"文档说会继承")。
    #[test]
    fn dropping_the_job_kills_bound_child_process() {
        let job = Job::create().expect("创建 Job Object 失败");
        let mut info = job.query_extended_limit_info().unwrap_or_default();
        info.limit_kill_on_job_close();
        job.set_extended_limit_info(&info)
            .expect("设置 KILL_ON_JOB_CLOSE 失败");

        let mut child = std::process::Command::new("cmd")
            .args(["/C", "ping -n 31 127.0.0.1 >nul"])
            // CREATE_NO_WINDOW (2026-08-09): 不弹 cmd 控制台窗口。此前裸 spawn 控制台
            // 子进程, 每次 cargo test 都弹一个窗口; 部分终端/管道环境下还会偶发
            // 0x800700E8 (ERROR_NO_DATA) 的 spawn 失败报错。
            .creation_flags(0x08000000)
            .spawn()
            .expect("无法拉起测试用的长命令");
        let handle = child.as_raw_handle() as isize;
        job.assign_process(handle).expect("绑定子进程到 Job 失败");

        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            child.try_wait().unwrap().is_none(),
            "子进程绑定后应该还在运行"
        );

        drop(job);

        std::thread::sleep(std::time::Duration::from_millis(500));
        let status = child.try_wait().expect("查询子进程状态失败");
        assert!(status.is_some(), "Job 被 drop 后绑定的子进程应被系统终止");

        let _ = child.kill();
        let _ = child.wait();
    }
}
