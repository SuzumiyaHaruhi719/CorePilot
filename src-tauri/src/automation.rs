//! 定时任务 (Cron) and the memory-leak watcher.
//!
//! * Jobs (trim working sets, purge standby, clean temp, flush DNS, leak alerts)
//!   are pushed from the frontend as flat config (rule 6) and run on a background
//!   thread, so they keep working while the window sits in the tray. Every task
//!   has a minimum interval enforced HERE, not just in the UI: purging standby or
//!   trimming working sets every few seconds throws away Windows' caches and makes
//!   every app page its memory back in — slower, never faster.
//! * Standby purge can be condition-triggered the way ISLC does it: only when the
//!   FREE list is low while the standby list is large ("available" already counts
//!   standby, so it can't express this).
//! * The leak watcher samples every process's private bytes plus the kernel pools
//!   once a minute for an hour. A suspect needs sustained, mostly-monotonic growth
//!   — trimming would not fix a leak, it only pushes it into the page file.
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const MB: u64 = 1024 * 1024;

// ============================================================ memory lists
#[repr(C)]
#[derive(Default)]
struct SysMemList {
    zero: usize,
    free: usize,
    modified: usize,
    modified_no_write: usize,
    bad: usize,
    standby: [usize; 8],
    repurposed: [usize; 8],
    modified_pagefile: usize,
}

#[link(name = "ntdll")]
extern "system" {
    fn NtQuerySystemInformation(class: i32, info: *mut c_void, len: u32, ret: *mut u32) -> i32;
}

#[derive(Serialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemLists {
    pub free: u64,
    pub standby: u64,
    pub modified: u64,
    pub total: u64,
}

static PRIV: AtomicBool = AtomicBool::new(false);

/// Free (+zeroed), standby and modified page lists — what RAMMap shows.
pub fn mem_lists() -> Option<MemLists> {
    if !PRIV.load(Ordering::Relaxed) {
        crate::optimize::enable_privilege("SeProfileSingleProcessPrivilege").ok()?;
        PRIV.store(true, Ordering::Relaxed);
    }
    let mut info = SysMemList::default();
    let mut ret = 0u32;
    // SystemMemoryListInformation (80)
    let st = unsafe { NtQuerySystemInformation(80, &mut info as *mut _ as *mut c_void, std::mem::size_of::<SysMemList>() as u32, &mut ret) };
    if st != 0 {
        return None;
    }
    let page = page_size();
    Some(MemLists {
        free: (info.free + info.zero) as u64 * page,
        standby: info.standby.iter().sum::<usize>() as u64 * page,
        modified: info.modified as u64 * page,
        total: crate::optimize::memory_detail().map(|m| m.total).unwrap_or(0),
    })
}

fn page_size() -> u64 {
    use windows::Win32::System::SystemInformation::{GetSystemInfo, SYSTEM_INFO};
    let mut si = SYSTEM_INFO::default();
    unsafe { GetSystemInfo(&mut si) };
    (si.dwPageSize as u64).max(4096)
}

// ============================================================ leak watcher
/// One hour of per-minute samples.
const LEAK_WINDOW: usize = 60;
/// A suspect needs at least this much history, growth and slope.
const LEAK_MIN_SAMPLES: usize = 15;
const LEAK_MIN_GROWTH: u64 = 300 * MB;
const LEAK_MIN_SLOPE_MB_MIN: f64 = 4.0;
const LEAK_MIN_RISING: f64 = 0.75;
/// Share of minutes that must actually grow (> 1 MB): a plateau isn't a leak
/// (bursty leakers that grow every 2nd–3rd minute still qualify).
const LEAK_MIN_UPS: f64 = 0.3;
/// The biggest single-minute jump may be at most this share of the total growth —
/// one big allocation (a disk-scan tree, a loaded level) followed by a flat line
/// is a step, not a leak.
const LEAK_MAX_JUMP_SHARE: f64 = 0.4;

struct Track {
    name: String,
    path: Option<String>,
    /// private bytes per minute
    samples: VecDeque<u64>,
}

#[derive(Default)]
struct LeakState {
    procs: HashMap<(u32, u64), Track>,
    /// (paged pool, nonpaged pool, commit, commit limit) per minute
    kernel: VecDeque<(u64, u64, u64, u64)>,
    minutes: u64,
}
static LEAK: Lazy<Mutex<LeakState>> = Lazy::new(|| Mutex::new(LeakState::default()));

/// Least-squares slope (units per sample), growth, and the share of non-falling steps.
fn trend(v: &[u64]) -> (f64, u64, f64) {
    let n = v.len();
    if n < 2 {
        return (0.0, 0, 0.0);
    }
    let mean_x = (n - 1) as f64 / 2.0;
    let mean_y = v.iter().map(|&y| y as f64).sum::<f64>() / n as f64;
    let (mut num, mut den) = (0.0, 0.0);
    for (i, &y) in v.iter().enumerate() {
        let dx = i as f64 - mean_x;
        num += dx * (y as f64 - mean_y);
        den += dx * dx;
    }
    // a 1 % dip still counts as "not falling" (allocator noise)
    let rising = v.windows(2).filter(|w| w[1] as f64 >= w[0] as f64 * 0.99).count() as f64 / (n - 1) as f64;
    (num / den, v[n - 1].saturating_sub(v[0]), rising)
}

/// Sustained, mostly-monotonic growth of private bytes — the signature of a leak.
fn is_leak(v: &[u64]) -> bool {
    if v.len() < LEAK_MIN_SAMPLES {
        return false;
    }
    let (slope, growth, rising) = trend(v);
    let steps = v.windows(2).map(|w| w[1] as i64 - w[0] as i64);
    let ups = steps.clone().filter(|&d| d > MB as i64).count() as f64 / (v.len() - 1) as f64;
    let max_jump = steps.max().unwrap_or(0).max(0) as f64;
    growth >= LEAK_MIN_GROWTH
        && slope / MB as f64 >= LEAK_MIN_SLOPE_MB_MIN
        && rising >= LEAK_MIN_RISING
        && ups >= LEAK_MIN_UPS
        && max_jump <= growth as f64 * LEAK_MAX_JUMP_SHARE
}

fn leak_sample() {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::ProcessStatus::{GetPerformanceInfo, GetProcessMemoryInfo, PERFORMANCE_INFORMATION, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};

    let mut seen: HashMap<(u32, u64), (String, u64)> = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut e).is_ok();
        while ok {
            let pid = e.th32ProcessID;
            if pid > 4 {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let name = String::from_utf16_lossy(&e.szExeFile[..len]);
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid).or_else(|_| OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid));
                if let Ok(h) = h {
                    let (mut c, mut x, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
                    let born = if GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u).is_ok() { ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64 } else { 0 };
                    let mut pmc = PROCESS_MEMORY_COUNTERS_EX { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32, ..Default::default() };
                    if GetProcessMemoryInfo(h, &mut pmc as *mut _ as *mut PROCESS_MEMORY_COUNTERS, pmc.cb).is_ok() {
                        seen.insert((pid, born), (name, pmc.PrivateUsage as u64));
                    }
                    let _ = CloseHandle(h);
                }
            }
            ok = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    let kernel = unsafe {
        let mut pi = PERFORMANCE_INFORMATION { cb: std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32, ..Default::default() };
        GetPerformanceInfo(&mut pi, pi.cb).ok().map(|_| {
            let p = pi.PageSize as u64;
            (pi.KernelPaged as u64 * p, pi.KernelNonpaged as u64 * p, pi.CommitTotal as u64 * p, pi.CommitLimit as u64 * p)
        })
    };
    let new_pids: Vec<(u32, u64)> = { let st = LEAK.lock(); seen.keys().filter(|k| !st.procs.contains_key(k)).copied().collect() };
    // resolve paths only for processes we haven't seen (outside the lock)
    let paths: HashMap<(u32, u64), Option<String>> = new_pids.into_iter().map(|k| (k, crate::fps::process_image_path(k.0))).collect();
    let mut st = LEAK.lock();
    st.procs.retain(|k, _| seen.contains_key(k));
    for (k, (name, private)) in seen {
        let t = st.procs.entry(k).or_insert_with(|| Track { name, path: paths.get(&k).cloned().flatten(), samples: VecDeque::new() });
        t.samples.push_back(private);
        if t.samples.len() > LEAK_WINDOW {
            t.samples.pop_front();
        }
    }
    if let Some(k) = kernel {
        st.kernel.push_back(k);
        if st.kernel.len() > LEAK_WINDOW {
            st.kernel.pop_front();
        }
    }
    st.minutes += 1;
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LeakSuspect {
    pub pid: u32,
    pub name: String,
    pub path: Option<String>,
    pub private_bytes: u64,
    pub growth_bytes: u64,
    pub slope_mb_per_min: f64,
    pub minutes: u64,
    /// private MB per minute, oldest first
    pub trend: Vec<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelMem {
    pub paged: u64,
    pub nonpaged: u64,
    pub commit: u64,
    pub commit_limit: u64,
    pub nonpaged_slope_mb_per_min: f64,
    pub paged_slope_mb_per_min: f64,
    pub nonpaged_trend: Vec<u64>,
    /// non-paged pool large and still climbing: the classic driver leak
    pub leak: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeakReport {
    pub suspects: Vec<LeakSuspect>,
    /// biggest private-byte growers even when they don't (yet) qualify
    pub growers: Vec<LeakSuspect>,
    pub kernel: Option<KernelMem>,
    pub minutes: u64,
    pub needed_minutes: u64,
}

fn suspect(k: &(u32, u64), t: &Track) -> LeakSuspect {
    let v: Vec<u64> = t.samples.iter().copied().collect();
    let (slope, growth, _) = trend(&v);
    LeakSuspect {
        pid: k.0,
        name: t.name.clone(),
        path: t.path.clone(),
        private_bytes: *v.last().unwrap_or(&0),
        growth_bytes: growth,
        slope_mb_per_min: slope / MB as f64,
        minutes: v.len() as u64,
        trend: v.iter().map(|b| b / MB).collect(),
    }
}

pub fn leak_report_now() -> LeakReport {
    let st = LEAK.lock();
    let mut suspects = Vec::new();
    let mut growers = Vec::new();
    for (k, t) in &st.procs {
        let v: Vec<u64> = t.samples.iter().copied().collect();
        if is_leak(&v) {
            suspects.push(suspect(k, t));
        } else if v.len() >= 5 && v[v.len() - 1] > v[0] + 50 * MB {
            growers.push(suspect(k, t));
        }
    }
    suspects.sort_by(|a, b| b.growth_bytes.cmp(&a.growth_bytes));
    growers.sort_by(|a, b| b.growth_bytes.cmp(&a.growth_bytes));
    growers.truncate(8);
    let kernel = st.kernel.back().map(|&(paged, nonpaged, commit, commit_limit)| {
        let np: Vec<u64> = st.kernel.iter().map(|x| x.1).collect();
        let pp: Vec<u64> = st.kernel.iter().map(|x| x.0).collect();
        let (ns, _, nr) = trend(&np);
        let (ps, _, _) = trend(&pp);
        KernelMem {
            paged,
            nonpaged,
            commit,
            commit_limit,
            nonpaged_slope_mb_per_min: ns / MB as f64,
            paged_slope_mb_per_min: ps / MB as f64,
            nonpaged_trend: np.iter().map(|b| b / MB).collect(),
            leak: np.len() >= LEAK_MIN_SAMPLES && nonpaged >= 1024 * MB && ns / MB as f64 >= 2.0 && nr >= LEAK_MIN_RISING,
        }
    });
    LeakReport { suspects, growers, kernel, minutes: st.minutes, needed_minutes: LEAK_MIN_SAMPLES as u64 }
}

#[tauri::command]
pub async fn leak_report() -> LeakReport {
    crate::commands::run_blocking_default("leak_report", leak_report_now).await
}

impl Default for LeakReport {
    fn default() -> Self {
        LeakReport { suspects: vec![], growers: vec![], kernel: None, minutes: 0, needed_minutes: LEAK_MIN_SAMPLES as u64 }
    }
}

// ============================================================ scheduler
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobCfg {
    pub id: String,
    pub task: String,
    pub enabled: bool,
    pub every_secs: u64,
    /// purge_standby only: run when free < free_mb AND standby > standby_mb
    #[serde(default)]
    pub cond: bool,
    #[serde(default)]
    pub free_mb: u64,
    #[serde(default)]
    pub standby_mb: u64,
    /// don't run while a game is in the foreground (a trim/purge mid-game stutters)
    #[serde(default = "yes")]
    pub skip_in_game: bool,
}
fn yes() -> bool {
    true
}

/// The shortest interval each task may run at, and why (shown in the UI too).
pub fn min_secs(task: &str) -> Option<u64> {
    match task {
        "trim_ws" => Some(300),
        "purge_standby" => Some(300),
        "clean_temp" => Some(3600),
        "flush_dns" => Some(600),
        "leak_alert" => Some(60),
        _ => None,
    }
}
/// A condition-triggered purge may fire at most this often.
const COND_GAP: Duration = Duration::from_secs(60);
const COND_CHECK: Duration = Duration::from_secs(10);

static JOBS: Lazy<Mutex<Vec<JobCfg>>> = Lazy::new(|| Mutex::new(Vec::new()));
static LAST: Lazy<Mutex<HashMap<String, Instant>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static HISTORY: Lazy<Mutex<VecDeque<RunRecord>>> = Lazy::new(|| Mutex::new(VecDeque::new()));
static ALERTED: Lazy<Mutex<HashSet<(u32, String)>>> = Lazy::new(|| Mutex::new(HashSet::new()));

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub at: f64,
    pub id: String,
    pub task: String,
    pub ok: bool,
    pub detail: String,
}

/// Validate and store the job list (trust boundary: clamp to each task's minimum).
pub fn sanitize(jobs: Vec<JobCfg>) -> Vec<JobCfg> {
    jobs.into_iter()
        .filter(|j| j.id.len() <= 64)
        .filter_map(|mut j| {
            let min = min_secs(&j.task)?;
            j.every_secs = j.every_secs.max(min);
            j.free_mb = j.free_mb.clamp(64, 1 << 20);
            j.standby_mb = j.standby_mb.min(1 << 20);
            j.cond &= j.task == "purge_standby";
            Some(j)
        })
        .take(32)
        .collect()
}

#[tauri::command]
pub fn automation_config(jobs: Vec<JobCfg>) {
    let jobs = sanitize(jobs);
    let mut last = LAST.lock();
    // a newly enabled interval job first runs one full interval from now
    for j in &jobs {
        last.entry(j.id.clone()).or_insert_with(Instant::now);
    }
    *JOBS.lock() = jobs;
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoStatus {
    pub history: Vec<RunRecord>,
    /// job id → seconds until its next interval run (condition jobs: none)
    pub next: HashMap<String, u64>,
    pub mem: Option<MemLists>,
}

#[tauri::command]
pub async fn automation_status() -> AutoStatus {
    crate::commands::run_blocking_default("automation_status", || {
        let last = LAST.lock().clone();
        let next = JOBS
            .lock()
            .iter()
            .filter(|j| j.enabled && !j.cond)
            .map(|j| {
                let since = last.get(&j.id).map(|t| t.elapsed().as_secs()).unwrap_or(0);
                (j.id.clone(), j.every_secs.saturating_sub(since))
            })
            .collect();
        AutoStatus { history: HISTORY.lock().iter().rev().cloned().collect(), next, mem: mem_lists() }
    })
    .await
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn run_task(j: &JobCfg) -> Option<(bool, String)> {
    let mb = |b: u64| format!("{:.0} MB", b as f64 / MB as f64);
    Some(match j.task.as_str() {
        "trim_ws" => match crate::optimize::free_working_sets() {
            Ok(()) => (true, "工作集已释放".into()),
            Err(e) => (false, e.to_string()),
        },
        "purge_standby" => {
            let before = mem_lists().map(|m| m.free).unwrap_or(0);
            match crate::optimize::purge_standby() {
                Ok(()) => (true, format!("空闲内存 +{}", mb(mem_lists().map(|m| m.free).unwrap_or(0).saturating_sub(before)))),
                Err(e) => (false, e.to_string()),
            }
        }
        "clean_temp" => {
            let r = crate::optimize::clean_temp();
            (true, format!("清理 {} · {} 个文件", mb(r.bytes), r.files))
        }
        "flush_dns" => match crate::optimize::flush_dns() {
            Ok(()) => (true, "DNS 缓存已刷新".into()),
            Err(e) => (false, e.to_string()),
        },
        "leak_alert" => {
            let report = leak_report_now();
            let mut alerted = ALERTED.lock();
            let fresh: Vec<String> = report
                .suspects
                .iter()
                .filter(|s| alerted.insert((s.pid, s.name.clone())))
                .map(|s| format!("{} +{} ({:.1} MB/min)", s.name, mb(s.growth_bytes), s.slope_mb_per_min))
                .collect();
            let kernel = report.kernel.as_ref().filter(|k| k.leak).map(|k| format!("内核非分页池 {} 持续增长", mb(k.nonpaged)));
            let lines: Vec<String> = fresh.into_iter().chain(kernel.filter(|_| alerted.insert((0, "kernel".into())))).collect();
            if lines.is_empty() {
                return None; // nothing new: no history noise
            }
            (true, format!("疑似内存泄漏：{}", lines.join("；")))
        }
        _ => return None,
    })
}

fn tick(app: &AppHandle, last_leak: &mut Instant, last_cond: &mut Instant) {
    if last_leak.elapsed() >= Duration::from_secs(60) {
        *last_leak = Instant::now();
        leak_sample();
    }
    let jobs = JOBS.lock().clone();
    let check_cond = last_cond.elapsed() >= COND_CHECK;
    if check_cond {
        *last_cond = Instant::now();
    }
    let mut in_game: Option<bool> = None;
    for j in jobs.iter().filter(|j| j.enabled) {
        let since = LAST.lock().get(&j.id).map(|t| t.elapsed()).unwrap_or(Duration::MAX);
        let due = if j.cond {
            check_cond && since >= COND_GAP && mem_lists().is_some_and(|m| m.free < j.free_mb * MB && m.standby > j.standby_mb * MB)
        } else {
            since >= Duration::from_secs(j.every_secs)
        };
        if !due {
            continue;
        }
        if j.skip_in_game && j.task != "leak_alert" && *in_game.get_or_insert_with(|| crate::fps::foreground_info_now().is_game) {
            continue; // try again next tick; the game will end
        }
        LAST.lock().insert(j.id.clone(), Instant::now());
        let Some((ok, detail)) = run_task(j) else { continue };
        if !ok {
            tracing::warn!("automation {} ({}) failed: {detail}", j.id, j.task);
        }
        let rec = RunRecord { at: now_ms(), id: j.id.clone(), task: j.task.clone(), ok, detail };
        {
            let mut h = HISTORY.lock();
            h.push_back(rec.clone());
            if h.len() > 80 {
                h.pop_front();
            }
        }
        let _ = app.emit("auto://run", &rec);
    }
}

/// Start the scheduler + leak watcher (once, from `lib.rs` setup).
pub fn start(app: AppHandle) {
    let _ = std::thread::Builder::new().name("automation".into()).spawn(move || {
        let mut last_leak = Instant::now() - Duration::from_secs(120); // sample right away
        let mut last_cond = Instant::now();
        loop {
            crate::commands::guarded_tick("automation", || tick(&app, &mut last_leak, &mut last_cond));
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leak_needs_sustained_monotonic_growth() {
        let rising: Vec<u64> = (0..20).map(|i| 500 * MB + i * 20 * MB).collect(); // +380 MB, 20 MB/min
        assert!(is_leak(&rising));
        let saw: Vec<u64> = (0..20).map(|i| 500 * MB + if i % 2 == 0 { 0 } else { 400 * MB }).collect();
        assert!(!is_leak(&saw), "fluctuating is not a leak");
        let slow: Vec<u64> = (0..20).map(|i| 500 * MB + i * MB).collect();
        assert!(!is_leak(&slow), "19 MB over 20 min is not a leak");
        assert!(!is_leak(&rising[..10]), "needs 15 minutes of history");
        // CorePilot loading a disk-scan tree: one +1 GB jump, then flat — a step
        let step: Vec<u64> = (0..33).map(|i| 100 * MB + if i >= 4 { 1000 * MB } else { 0 }).collect();
        assert!(!is_leak(&step), "a single jump then a plateau is not a leak");
        // bursty growth (every other minute) still counts
        let bursty: Vec<u64> = (0..30).map(|i| 500 * MB + (i / 2) * 40 * MB).collect();
        assert!(is_leak(&bursty));
    }

    #[test]
    fn jobs_are_clamped_to_safe_minimums() {
        let j = |task: &str, every: u64| JobCfg { id: task.into(), task: task.into(), enabled: true, every_secs: every, cond: true, free_mb: 0, standby_mb: 0, skip_in_game: true };
        let out = sanitize(vec![j("purge_standby", 10), j("trim_ws", 60), j("rm_rf", 1)]);
        assert_eq!(out.len(), 2, "unknown task dropped");
        assert_eq!(out[0].every_secs, 300);
        assert!(out[0].cond && out[0].free_mb >= 64);
        assert_eq!(out[1].every_secs, 300);
        assert!(!out[1].cond, "only standby purge can be conditional");
    }
}
