//! Injectable in-game OSD overlay DLL.
//!
//! STUB — the real implementation hooks the game's `Present` (DX11/DX12/OpenGL via
//! `hudhook`) and renders the metrics read from [`corepilot_osd_ipc::OsdShared`]
//! into the game's back buffer. This placeholder keeps the workspace valid; the
//! hook + render code is added in the implementation step.

// Touch the IPC crate so the dependency (and the shared layout) is wired now.
pub use corepilot_osd_ipc::{OsdShared, OsdSharedBlock};
