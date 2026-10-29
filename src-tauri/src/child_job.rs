//! Windows **Job Object**：让工具子进程**随应用一起死**（297 波遗留 ①）。
//!
//! ## 缺陷
//!
//! `execute_command` / MCP / 免费模型插件都会 `spawn` 子进程。应用被强杀、崩溃、
//! 或某个退出路径没走到时，这些子进程（`powershell` / `bash` / `node`）会**变成孤儿**：
//! 它们继续占着端口、锁着工作区、在任务管理器里挂着 —— 用户看到的是"删了进程树却删不掉"。
//!
//! ## 修法
//!
//! 创建一个 Job Object 并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，把每个子进程
//! `AssignProcessToJobObject` 进去。Job 的最后一个句柄在**本进程退出时**被 OS 关闭 ⇒
//! 内核会把 Job 里所有进程一起杀掉，**不依赖**我们的退出代码是否跑完。
//!
//! 与既有 `kill_on_drop` / `taskkill /T` 的关系：那两条是**正常退出路径**的主动回收；
//! 这里是**异常路径**的兜底（崩溃、SIGKILL、拔电前的强制结束）。
//!
//! 判据见本文件底部 `mod tests`（真起一个子进程并断言 `IsProcessInJob` 为真）。

#[cfg(target_os = "windows")]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;

    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Job 句柄（以 `usize` 存，便于放进 `OnceLock` —— `HANDLE` 本身不是 `Sync`）。
    static JOB: OnceLock<Option<usize>> = OnceLock::new();

    fn job_handle() -> Option<HANDLE> {
        let stored = JOB.get_or_init(|| {
            unsafe {
                let job = match CreateJobObjectW(None, PCWSTR::null()) {
                    Ok(j) => j,
                    Err(_) => return None,
                };
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    core::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if set.is_err() {
                    let _ = CloseHandle(job);
                    return None;
                }
                Some(job.0 as usize)
            }
        });
        stored.map(|v| HANDLE(v as *mut core::ffi::c_void))
    }

    /// 按 **pid** 放进 Job（tokio 的 `Child` 只保证给得出 `id()`）。
    ///
    /// 句柄用完就关：Job 的成员关系是内核对象状态，不依赖调用方继续持有句柄。
    pub fn assign_pid(pid: u32) -> Result<(), String> {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(|e| format!("OpenProcess({pid}) 失败：{e}"))?;
            let result = job_handle()
                .ok_or_else(|| "创建 Job Object 失败（KILL_ON_JOB_CLOSE 不可用）".to_string())
                .and_then(|job| {
                    AssignProcessToJobObject(job, process)
                        .map_err(|e| format!("AssignProcessToJobObject 失败：{e}"))
                });
            let _ = CloseHandle(process);
            result
        }
    }

    /// 把一个子进程放进 Job（幂等：重复 assign 同一个 pid 不会失败）。
    pub fn assign(child: &std::process::Child) -> Result<(), String> {
        let Some(job) = job_handle() else {
            return Err("创建 Job Object 失败（KILL_ON_JOB_CLOSE 不可用）".to_string());
        };
        let process = HANDLE(child.as_raw_handle() as *mut core::ffi::c_void);
        unsafe { AssignProcessToJobObject(job, process) }.map_err(|e| format!("AssignProcessToJobObject 失败：{e}"))
    }

    /// 判据用：这个子进程是否真的在 Job 里。
    #[allow(dead_code)] // only used by criteria (IsProcessInJob assertion)
    pub fn is_in_job(child: &std::process::Child) -> Result<bool, String> {
        let Some(job) = job_handle() else {
            return Err("Job Object 不可用".to_string());
        };
        let process = HANDLE(child.as_raw_handle() as *mut core::ffi::c_void);
        let mut in_job = BOOL(0);
        unsafe { IsProcessInJob(process, Some(job), &mut in_job) }.map_err(|e| format!("IsProcessInJob 失败：{e}"))?;
        Ok(in_job.as_bool())
    }
}

#[cfg(target_os = "windows")]
pub use imp::{assign, assign_pid};
#[cfg(test)]
pub use imp::is_in_job;

/// 非 Windows：没有 Job Object 这个概念（Unix 侧由进程组/`kill_on_drop` 负责）。
#[cfg(not(target_os = "windows"))]
pub fn assign(_child: &std::process::Child) -> Result<(), String> {
    Ok(())
}

/// 非 Windows：句柄版同样空实现。
#[cfg(not(target_os = "windows"))]
/// 非 Windows：pid 版同样空实现。
#[cfg(not(target_os = "windows"))]
pub fn assign_pid(_pid: u32) -> Result<(), String> {
    Ok(())
}

/// 非 Windows：判据里按"不支持"处理。
#[cfg(not(target_os = "windows"))]
pub fn is_in_job(_child: &std::process::Child) -> Result<bool, String> {
    Err("非 Windows 平台没有 Job Object".to_string())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    fn spawn_sleeper() -> std::process::Child {
        // 起一个会活 2 秒的进程：足够我们 assign + 查询，又不会拖慢测试。
        std::process::Command::new("cmd")
            .args(["/c", "ping -n 3 127.0.0.1 >nul"])
            .spawn()
            .expect("起测试子进程失败")
    }

    /// JOB-1：子进程真的被放进 Job（`IsProcessInJob` 为真）。
    ///
    /// 变异自证：把 `assign()` 改成直接 `Ok(())` ⇒ 这条必须红。
    #[test]
    fn child_is_assigned_to_kill_on_close_job() {
        let mut child = spawn_sleeper();
        assign(&child).expect("assign 失败");
        assert!(
            is_in_job(&child).expect("查询失败"),
            "子进程没有进 Job ⇒ 应用崩溃时会留下孤儿进程"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    /// JOB-2：两个子进程都能进同一个 Job（幂等、可重复）。
    #[test]
    fn multiple_children_share_the_same_job() {
        let mut a = spawn_sleeper();
        let mut b = spawn_sleeper();
        assign(&a).expect("a assign 失败");
        assign(&b).expect("b assign 失败");
        assert!(is_in_job(&a).unwrap());
        assert!(is_in_job(&b).unwrap());
        let _ = a.kill();
        let _ = b.kill();
        let _ = a.wait();
        let _ = b.wait();
    }
}
