//! System-wide CPU + memory sampling (shared `System` lives in AppState).

use serde::Serialize;
use sysinfo::System;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub cpu_overall: f32,
    pub per_core: Vec<f32>,
    pub mem_used: u64,
    pub mem_total: u64,
}

pub fn sample(sys: &mut System) -> Metrics {
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    Metrics {
        cpu_overall: sys.global_cpu_usage(),
        per_core: sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
        mem_used: sys.used_memory(),
        mem_total: sys.total_memory(),
    }
}
