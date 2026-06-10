//! Synthetic GPU load for the GPU thermal axis (spec §3 阶段 3b): a D3D11
//! compute shader doing long fma chains, dispatched in a loop on the adapter
//! with the most dedicated VRAM (skips iGPU / Microsoft Basic Render).
//! Start returns Err on any failure — the tuner then SKIPS the GPU axis
//! (degrade, never abort). RAII: drop stops and joins the dispatch thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use windows::core::PCSTR;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{ID3DBlob, D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Buffer, ID3D11ComputeShader, ID3D11Device, ID3D11DeviceContext,
    ID3D11UnorderedAccessView, D3D11_BIND_UNORDERED_ACCESS, D3D11_BUFFER_DESC, D3D11_BUFFER_UAV,
    D3D11_CREATE_DEVICE_FLAG, D3D11_RESOURCE_MISC_BUFFER_STRUCTURED, D3D11_SDK_VERSION,
    D3D11_UAV_DIMENSION_BUFFER, D3D11_UNORDERED_ACCESS_VIEW_DESC,
    D3D11_UNORDERED_ACCESS_VIEW_DESC_0, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1};

const SHADER: &str = r#"
RWStructuredBuffer<float> buf : register(u0);
[numthreads(256, 1, 1)]
void main(uint3 id : SV_DispatchThreadID) {
    float a = buf[id.x % 1048576] + 1.0001f;
    [loop] for (uint i = 0; i < 4096; i++) {
        a = a * 1.0000001f + 0.5f;
        a = a * 0.9999999f - 0.4999f;
    }
    buf[id.x % 1048576] = a;
}
"#;

pub struct GpuLoad {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl GpuLoad {
    /// Spin up the dispatch thread. Err = no usable discrete adapter / device /
    /// shader — caller treats it as "skip the GPU axis".
    pub fn start() -> Result<Self, String> {
        // Probe synchronously so failure is immediate and typed…
        let adapter = pick_adapter()?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = Arc::clone(&stop);
        let handle = std::thread::Builder::new()
            .name("gpu-load".into())
            .spawn(move || {
                if let Ok((_device, ctx)) = build_pipeline(&adapter) {
                    while !stop2.load(Ordering::Relaxed) {
                        unsafe {
                            ctx.Dispatch(4096, 1, 1);
                            ctx.Flush();
                        }
                        // Brief yield so the queue stays deep but we can stop fast.
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                }
            })
            .map_err(|e| format!("spawn gpu-load thread: {e}"))?;
        Ok(Self { stop, handle: Some(handle) })
    }
}

impl Drop for GpuLoad {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Adapter with the most dedicated VRAM (the discrete GPU on a desktop).
fn pick_adapter() -> Result<IDXGIAdapter1, String> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| format!("dxgi factory: {e}"))?;
        let mut best: Option<(usize, IDXGIAdapter1)> = None;
        let mut i = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            let desc = adapter.GetDesc1().map_err(|e| format!("adapter desc: {e}"))?;
            let name = String::from_utf16_lossy(&desc.Description)
                .trim_end_matches('\0')
                .to_string();
            if name.to_lowercase().contains("microsoft basic render") {
                continue;
            }
            let vram = desc.DedicatedVideoMemory;
            if best.as_ref().map(|(v, _)| vram > *v).unwrap_or(true) {
                best = Some((vram, adapter));
            }
        }
        let (vram, adapter) = best.ok_or("no DXGI adapter")?;
        if vram < 512 * 1024 * 1024 {
            return Err("no discrete GPU (max dedicated VRAM < 512 MB)".into());
        }
        Ok(adapter)
    }
}

/// Device + compiled compute shader + bound UAV buffer, ready to Dispatch.
fn build_pipeline(adapter: &IDXGIAdapter1) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    unsafe {
        let mut device: Option<ID3D11Device> = None;
        let mut ctx: Option<ID3D11DeviceContext> = None;
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut ctx),
        )
        .map_err(|e| format!("create device: {e}"))?;
        let device = device.ok_or("device is None")?;
        let ctx = ctx.ok_or("context is None")?;

        let mut blob: Option<ID3DBlob> = None;
        let mut errs: Option<ID3DBlob> = None;
        D3DCompile(
            SHADER.as_ptr() as *const _,
            SHADER.len(),
            None,
            None,
            None,
            PCSTR(b"main\0".as_ptr()),
            PCSTR(b"cs_5_0\0".as_ptr()),
            0,
            0,
            &mut blob,
            Some(&mut errs),
        )
        .map_err(|e| format!("compile cs: {e}"))?;
        let blob = blob.ok_or("no shader blob")?;
        let bytecode = std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize());

        let mut shader: Option<ID3D11ComputeShader> = None;
        device
            .CreateComputeShader(bytecode, None, Some(&mut shader))
            .map_err(|e| format!("create cs: {e}"))?;
        let shader = shader.ok_or("no compute shader")?;

        const ELEMS: u32 = 1 << 20; // 1M floats = 4 MB scratch
        let desc = D3D11_BUFFER_DESC {
            ByteWidth: ELEMS * 4,
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_UNORDERED_ACCESS.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: D3D11_RESOURCE_MISC_BUFFER_STRUCTURED.0 as u32,
            StructureByteStride: 4,
        };
        let mut buffer: Option<ID3D11Buffer> = None;
        device
            .CreateBuffer(&desc, None, Some(&mut buffer))
            .map_err(|e| format!("create buffer: {e}"))?;
        let buffer = buffer.ok_or("no buffer")?;

        let uav_desc = D3D11_UNORDERED_ACCESS_VIEW_DESC {
            Format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_UNKNOWN,
            ViewDimension: D3D11_UAV_DIMENSION_BUFFER,
            Anonymous: D3D11_UNORDERED_ACCESS_VIEW_DESC_0 {
                Buffer: D3D11_BUFFER_UAV { FirstElement: 0, NumElements: ELEMS, Flags: 0 },
            },
        };
        let mut uav: Option<ID3D11UnorderedAccessView> = None;
        device
            .CreateUnorderedAccessView(&buffer, Some(&uav_desc), Some(&mut uav))
            .map_err(|e| format!("create uav: {e}"))?;
        let uav = uav.ok_or("no uav")?;

        ctx.CSSetShader(&shader, None);
        ctx.CSSetUnorderedAccessViews(0, 1, Some(&Some(uav)), None);
        Ok((device, ctx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hardware smoke test — needs a discrete GPU, so it is ignored by default.
    /// Run manually: cargo test --lib gpu_load -- --ignored
    #[test]
    #[ignore]
    fn gpu_load_runs_and_stops_on_real_hardware() {
        let load = GpuLoad::start().expect("discrete GPU present");
        std::thread::sleep(std::time::Duration::from_secs(3));
        drop(load);
    }
}
