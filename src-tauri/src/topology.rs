//! CPU topology detection for Ryzen dual-CCD parts (e.g. 9950X3D).
//!
//! Strategy: `GetLogicalProcessorInformationEx(RelationAll)`. Each L3 cache
//! record maps to one CCD; the L3 with the largest `CacheSize` is the 3D
//! V-Cache CCD. Falls back to a sane split if detection is ambiguous.

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuTopology {
    pub logical_count: u32,
    pub physical_cores: u32,
    pub smt: bool,
    pub ccds: Vec<Ccd>,
    pub logical: Vec<LogicalCpu>,
    pub vcache_ccd: Option<u32>,
    pub detection: String,
}

struct CoreRec {
    mask: u64,
}

struct L3Rec {
    mask: u64,
    size: u64,
}

/// Returns bit positions (logical CPU ids) set in a group-0 mask.
fn bits(mask: u64) -> Vec<u32> {
    (0..64).filter(|i| mask & (1u64 << i) != 0).collect()
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
            cores.push(CoreRec { mask });
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

    // Build CCDs from L3 groups, ordered by lowest logical id for stable ids.
    l3s.sort_by_key(|l| l.mask.trailing_zeros());
    let max_l3 = l3s.iter().map(|l| l.size).max().unwrap_or(0);
    let multi = l3s.len() > 1;
    let mut ccds: Vec<Ccd> = Vec::new();
    for (idx, l) in l3s.iter().enumerate() {
        ccds.push(Ccd {
            ccd_id: idx as u32,
            is_vcache: multi && l.size == max_l3,
            l3_bytes: l.size,
            logical_cpus: bits(l.mask),
            mask: l.mask,
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
        let sibling = cores
            .get(core_idx as usize)
            .and_then(|c| bits(c.mask).into_iter().find(|&b| b != id));
        logical.push(LogicalCpu {
            id,
            group: 0,
            core_id: core_idx,
            ccd_id,
            is_vcache,
            smt_sibling: sibling,
        });
    }

    let vcache_ccd = ccds.iter().find(|c| c.is_vcache).map(|c| c.ccd_id);

    Some(CpuTopology {
        logical_count,
        physical_cores: cores.len() as u32,
        smt,
        ccds,
        logical,
        vcache_ccd,
        detection: "GetLogicalProcessorInformationEx".into(),
    })
}

/// Fallback assuming a 9950X3D-like layout: CCD0 (logical 0..15) = V-Cache,
/// CCD1 (logical 16..31) = frequency. Uses the real logical count.
fn fallback() -> CpuTopology {
    let n = std::thread::available_parallelism()
        .map(|v| v.get() as u32)
        .unwrap_or(32);
    let half = (n / 2).max(1);
    let mask0: u64 = if half >= 64 { u64::MAX } else { (1u64 << half) - 1 };
    let mask1: u64 = if n >= 64 {
        !mask0
    } else {
        ((1u64 << n) - 1) & !mask0
    };
    let smt = n > 8;
    let cores_per = if smt { 2 } else { 1 };
    let mut logical = Vec::new();
    for id in 0..n {
        let ccd_id = if (mask0 & (1u64 << id)) != 0 { 0 } else { 1 };
        let core_id = id / cores_per;
        let sibling = if smt {
            Some(if id % 2 == 0 { id + 1 } else { id - 1 })
        } else {
            None
        };
        logical.push(LogicalCpu {
            id,
            group: 0,
            core_id,
            ccd_id,
            is_vcache: ccd_id == 0,
            smt_sibling: sibling,
        });
    }
    CpuTopology {
        logical_count: n,
        physical_cores: n / cores_per,
        smt,
        ccds: vec![
            Ccd {
                ccd_id: 0,
                is_vcache: true,
                l3_bytes: 96 * 1024 * 1024,
                logical_cpus: bits(mask0),
                mask: mask0,
            },
            Ccd {
                ccd_id: 1,
                is_vcache: false,
                l3_bytes: 32 * 1024 * 1024,
                logical_cpus: bits(mask1),
                mask: mask1,
            },
        ],
        logical,
        vcache_ccd: Some(0),
        detection: "fallback".into(),
    }
}
