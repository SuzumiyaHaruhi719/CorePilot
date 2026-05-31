//! Shared application state.

use crate::topology::{self, CpuTopology};
use parking_lot::Mutex;
use sysinfo::System;

pub struct AppState {
    pub sys: Mutex<System>,
    pub topo: CpuTopology,
}

impl AppState {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        let topo = topology::detect();
        Self {
            sys: Mutex::new(sys),
            topo,
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
