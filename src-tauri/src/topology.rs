//! CPU topology detection, generalized across desktop hardware.
//!
//! Strategy: `GetLogicalProcessorInformationEx(RelationAll)`.
//!  • AMD multi-CCD (incl. 3D V-Cache): each L3 cache record maps to one CCD;
//!    the L3 larger than its sibling is the 3D V-Cache CCD.
//!  • Intel hybrid (P-core / E-core): a single shared L3 means L3 grouping can't
//!    split the cores, so when the system is hybrid (cores report differing
//!    Windows `EfficiencyClass`) we cluster by efficiency class instead — the
//!    highest class is the performance (P) cluster.
//!  • Everything else (single-CCD Ryzen, homogeneous Intel) collapses to one
//!    cluster covering all cores.
//!
//! Falls back to a sane split if detection is ambiguous.

use serde::Serialize;
use windows::Win32::System::SystemInformation::{
    GetLogicalProcessorInformationEx, GROUP_AFFINITY, RelationAll, RelationCache,
    RelationProcessorCore, SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalCpu {
    pub id: u32,
    pub group: u16,
    pub core_id: u32,
    pub ccd_id: u32,
    pub is_vcache: bool,
    /// Windows efficiency class (higher = more performant). 0 on homogeneous CPUs.
    pub efficiency_class: u8,
    pub smt_sibling: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ccd {
    pub ccd_id: u32,
    pub is_vcache: bool,
    pub l3_bytes: u64,
    pub logical_cpus: Vec<u32>,
    pub mask: u64,
    /// Cluster nature: "vcache" | "freq" | "standard" | "pcore" | "ecore".
    pub kind: String,
    /// Display label, e.g. "3D V-Cache", "频率核心", "CCD", "性能核", "能效核".
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuTopology {
    pub logical_count: u32,
    pub physical_cores: u32,
    pub smt: bool,
    /// True when clusters were split by efficiency class (Intel P/E hybrid).
    pub hybrid: bool,
    pub ccds: Vec<Ccd>,
    pub logical: Vec<LogicalCpu>,
    pub vcache_ccd: Option<u32>,
    pub detection: String,
}

struct CoreRec {
    mask: u64,
    /// EfficiencyClass from the processor relationship (higher = faster core).
    eff: u8,
}

struct L3Rec {
    mask: u64,
    size: u64,
}

/// Returns bit positions (logical CPU ids) set in a group-0 mask.
fn bits(mask: u64) -> Vec<u32> {
    (0..64).filter(|i| mask & (1u64 << i) != 0).collect()
}

/// Pick a (kind, label) for an L3-based cluster.
fn l3_kind(is_vcache: bool, has_smaller: bool) -> (&'static str, &'static str) {
    if is_vcache {
        ("vcache", "3D V-Cache")
    } else if has_smaller {
        // Only meaningful as the smaller-cache sibling of a V-Cache CCD.
        ("freq", "频率核心")
    } else {
        ("standard", "CCD")
    }
}

pub fn detect() -> CpuTopology {
    match unsafe { raw_detect() } {
        Some(t) if !t.ccds.is_empty() => t,
        _ => fallback(),
    }
}

unsafe fn raw_detect() -> Option<CpuTopology> {
    let mut len: u32 = 0;
    // First call: discover required buffer length.
    let _ = GetLogicalProcessorInformationEx(RelationAll, None, &mut len);
    if len == 0 {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    GetLogicalProcessorInformationEx(
        RelationAll,
        Some(buf.as_mut_ptr() as *mut SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX),
        &mut len,
    )
    .ok()?;

    let mut cores: Vec<CoreRec> = Vec::new();
    let mut l3s: Vec<L3Rec> = Vec::new();

    let mut offset = 0usize;
    while offset < len as usize {
        let rec = &*(buf.as_ptr().add(offset) as *const SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX);
        let size = rec.Size as usize;
        if size == 0 {
            break;
        }
        if rec.Relationship == RelationProcessorCore {
            let pr = &rec.Anonymous.Processor;
            let gm = pr.GroupMask.as_ptr();
            let mut mask = 0u64;
            for i in 0..pr.GroupCount as usize {
                let ga = &*gm.add(i);
                if ga.Group == 0 {
                    mask |= ga.Mask as u64;
                }
            }
            cores.push(CoreRec {
                mask,
                eff: pr.EfficiencyClass,
            });
        } else if rec.Relationship == RelationCache {
            let cr = &rec.Anonymous.Cache;
            if cr.Level == 3 {
                // GroupMask (single) and GroupMasks[0] overlap in the union.
                let gm = &cr.Anonymous as *const _ as *const GROUP_AFFINITY;
                let count = cr.GroupCount.max(1) as usize;
                let mut mask = 0u64;
                for i in 0..count {
                    let ga = &*gm.add(i);
                    if ga.Group == 0 {
                        mask |= ga.Mask as u64;
                    }
                }
                l3s.push(L3Rec {
                    mask,
                    size: cr.CacheSize as u64,
                });
            }
        }
        offset += size;
    }

    if cores.is_empty() {
        return None;
    }

    // Decide clustering strategy. L3 grouping wins whenever there are ≥2 L3
    // caches (AMD multi-CCD) — this keeps V-Cache detection byte-identical and
    // never mistakes an AMD chip for a hybrid. Only when there's a single (or
    // no) L3 *and* the cores report differing efficiency classes do we treat it
    // as an Intel-style P/E hybrid and split by efficiency class.
    let max_eff = cores.iter().map(|c| c.eff).max().unwrap_or(0);
    let min_eff = cores.iter().map(|c| c.eff).min().unwrap_or(0);
    let use_efficiency = l3s.len() < 2 && max_eff != min_eff;

    let mut ccds: Vec<Ccd> = Vec::new();
    if use_efficiency {
        // Intel hybrid: highest efficiency class = performance (P) cluster.
        let mut classes: Vec<u8> = cores.iter().map(|c| c.eff).collect();
        classes.sort_unstable();
        classes.dedup();
        classes.reverse(); // highest (P) first → ccd_id 0
        for (idx, class) in classes.iter().enumerate() {
            let mask: u64 = cores
                .iter()
                .filter(|c| c.eff == *class)
                .fold(0u64, |a, c| a | c.mask);
            let is_p = idx == 0;
            ccds.push(Ccd {
                ccd_id: idx as u32,
                is_vcache: false,
                l3_bytes: 0,
                logical_cpus: bits(mask),
                mask,
                kind: if is_p { "pcore" } else { "ecore" }.into(),
                label: if is_p { "性能核" } else { "能效核" }.into(),
            });
        }
    } else if !l3s.is_empty() {
        // L3-based CCDs (AMD multi-CCD, or single L3). Ordered by lowest id.
        l3s.sort_by_key(|l| l.mask.trailing_zeros());
        let max_l3 = l3s.iter().map(|l| l.size).max().unwrap_or(0);
        // V-Cache only exists when one CCD's L3 is *larger* than another's. On a
        // non-3D dual-CCD part (equal L3) no CCD is V-Cache.
        let has_smaller = l3s.iter().any(|l| l.size < max_l3);
        for (idx, l) in l3s.iter().enumerate() {
            let is_vcache = has_smaller && l.size == max_l3;
            let (kind, label) = l3_kind(is_vcache, has_smaller);
            ccds.push(Ccd {
                ccd_id: idx as u32,
                is_vcache,
                l3_bytes: l.size,
                logical_cpus: bits(l.mask),
                mask: l.mask,
                kind: kind.into(),
                label: label.into(),
            });
        }
    } else {
        // No L3 info and not hybrid: one cluster covering every core.
        let mask = cores.iter().fold(0u64, |a, c| a | c.mask);
        ccds.push(Ccd {
            ccd_id: 0,
            is_vcache: false,
            l3_bytes: 0,
            logical_cpus: bits(mask),
            mask,
            kind: "standard".into(),
            label: "CCD".into(),
        });
    }

    let logical_count: u32 = cores
        .iter()
        .map(|c| c.mask.count_ones())
        .sum::<u32>()
        .max(bits(ccds.iter().fold(0, |a, c| a | c.mask)).len() as u32);
    let smt = cores.iter().any(|c| c.mask.count_ones() > 1);

    // Per-logical-CPU mapping.
    let mut logical: Vec<LogicalCpu> = Vec::new();
    let total_bits = ccds.iter().fold(0u64, |a, c| a | c.mask)
        | cores.iter().fold(0u64, |a, c| a | c.mask);
    for id in bits(total_bits) {
        let core_idx = cores
            .iter()
            .position(|c| c.mask & (1u64 << id) != 0)
            .unwrap_or(id as usize) as u32;
        let (ccd_id, is_vcache) = ccds
            .iter()
            .find(|c| c.mask & (1u64 << id) != 0)
            .map(|c| (c.ccd_id, c.is_vcache))
            .unwrap_or((0, false));
        let core = cores.get(core_idx as usize);
        let sibling = core.and_then(|c| bits(c.mask).into_iter().find(|&b| b != id));
        logical.push(LogicalCpu {
            id,
            group: 0,
            core_id: core_idx,
            ccd_id,
            is_vcache,
            efficiency_class: core.map(|c| c.eff).unwrap_or(0),
            smt_sibling: sibling,
        });
    }

    let vcache_ccd = ccds.iter().find(|c| c.is_vcache).map(|c| c.ccd_id);

    Some(CpuTopology {
        logical_count,
        physical_cores: cores.len() as u32,
        smt,
        hybrid: use_efficiency,
        ccds,
        logical,
        vcache_ccd,
        detection: "GetLogicalProcessorInformationEx".into(),
    })
}

/// Fallback when detection fails entirely: a single cluster spanning all logical
/// CPUs. Hardware-agnostic — makes no V-Cache / CCD assumptions.
fn fallback() -> CpuTopology {
    let n = std::thread::available_parallelism()
        .map(|v| v.get() as u32)
        .unwrap_or(8)
        .min(64);
    let mask: u64 = if n >= 64 { u64::MAX } else { (1u64 << n) - 1 };
    // Assume SMT (2 threads/core) only on clearly multi-threaded parts; this is
    // a best-effort guess used solely when the OS topology query fails.
    let smt = n >= 4 && n % 2 == 0;
    let cores_per = if smt { 2 } else { 1 };
    let mut logical = Vec::new();
    for id in 0..n {
        let sibling = if smt {
            Some(if id % 2 == 0 { id + 1 } else { id - 1 })
        } else {
            None
        };
        logical.push(LogicalCpu {
            id,
            group: 0,
            core_id: id / cores_per,
            ccd_id: 0,
            is_vcache: false,
            efficiency_class: 0,
            smt_sibling: sibling,
        });
    }
    CpuTopology {
        logical_count: n,
        physical_cores: n / cores_per,
        smt,
        hybrid: false,
        ccds: vec![Ccd {
            ccd_id: 0,
            is_vcache: false,
            l3_bytes: 0,
            logical_cpus: bits(mask),
            mask,
            kind: "standard".into(),
            label: "CCD".into(),
        }],
        logical,
        vcache_ccd: None,
        detection: "fallback".into(),
    }
}
