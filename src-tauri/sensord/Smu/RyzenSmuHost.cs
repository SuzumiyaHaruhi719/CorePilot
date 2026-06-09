// Ryzen SMU write host (clean-room) — the privileged backend for CorePilot's
// SMU tuning (Curve Optimizer / PBO).
//
// Ring-0 is provided by the **PawnIO** driver (signed, Microsoft-attested) — the
// same driver LibreHardwareMonitor already loads for MSR/SMN reads. We do NOT
// ship or modify the driver (GPL): we talk to it at arm's length via its public
// DeviceIoControl interface (device path + IOCTL codes are facts). The SMU
// mailbox itself is executed inside the **RyzenSMU PawnIO module** (LGPL, loaded
// as data) via its generic `ioctl_send_smu_command`, so the delicate request/
// response timing + PCI serialization live in audited, signed code rather than
// being hand-rolled. CorePilot supplies only the message IDs + argument encoding
// (see SmuProtocol.cs) and the UX/safety layer — CorePilot's own tree stays
// license-free.
//
// NOTE: every method here only acts when explicitly called (from an `smu …`
// stdin command the user opted into). Nothing here runs on its own. All writes
// are clamped as a defense layer in addition to the Rust/UI clamps.

using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Runtime.Versioning;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Sensord.Smu;

/// <summary>Outcome of an SMU operation, surfaced to the Rust bridge as JSON.</summary>
public readonly record struct SmuResult(bool ok, string detail)
{
    public static SmuResult Fail(string d) => new(false, d);
    public static SmuResult Good(string d = "") => new(true, d);
}

/// <summary>
/// Loads the RyzenSMU PawnIO module and issues RSMU commands through it. One
/// instance per process; all calls are serialized on <see cref="_gate"/> (the
/// caller should additionally serialize against LHM's own polling — see the
/// sidecar's hardware lock).
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class RyzenSmuHost : IDisposable
{
    // PawnIO device + IOCTLs (facts: device control codes).
    private const string DevicePath = @"\\?\GLOBALROOT\Device\PawnIO";
    private const uint DeviceType = 41394u << 16;
    private const uint FnExecute = 0x841u << 2;
    private const uint FnLoadBinary = 0x821u << 2;
    private const int FnNameLen = 32; // module function names are a 32-byte ASCII field

    private readonly object _gate = new();
    private SafeFileHandle? _handle;
    private bool _disposed;

    public bool IsLoaded => _handle is { IsInvalid: false, IsClosed: false };

    /// <summary>True if the PawnIO driver is installed (registry probe).</summary>
    public static bool IsPawnIoInstalled
    {
        get
        {
            try
            {
                using RegistryKey? k = Registry.LocalMachine.OpenSubKey(
                    @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO");
                return k?.GetValue("DisplayVersion") != null;
            }
            catch { return false; }
        }
    }

    /// <summary>
    /// Open the PawnIO device and load the RyzenSMU module. The module binary is
    /// taken from the already-referenced LibreHardwareMonitorLib assembly's
    /// embedded resources (loaded as data; not copied into our tree). Returns a
    /// loaded host, or one whose <see cref="IsLoaded"/> is false on any failure.
    /// </summary>
    public static RyzenSmuHost TryLoad()
    {
        var host = new RyzenSmuHost();
        try
        {
            byte[]? module = ExtractRyzenSmuModule();
            if (module == null || module.Length == 0)
                return host; // module resource not found — stays unloaded.

            IntPtr raw = CreateFile(DevicePath, GenericRead | GenericWrite, ShareReadWrite,
                IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
            if (raw == IntPtr.Zero || raw.ToInt64() == -1)
                return host; // driver not present / access denied.

            if (DeviceIoControl(raw, DeviceType | FnLoadBinary, module, (uint)module.Length,
                    null, 0, out _, IntPtr.Zero))
            {
                host._handle = new SafeFileHandle(raw, ownsHandle: true);
            }
            else
            {
                using (new SafeFileHandle(raw, true)) { } // close the raw handle.
            }
        }
        catch
        {
            // Any failure → unloaded host; SMU tuning simply stays unavailable.
        }
        return host;
    }

    /// <summary>Find + read the embedded RyzenSMU PawnIO module from LHM (LGPL data).</summary>
    private static byte[]? ExtractRyzenSmuModule()
    {
        try
        {
            // The public LHM `Computer` type anchors the LibreHardwareMonitorLib assembly.
            Assembly lhm = typeof(LibreHardwareMonitor.Hardware.Computer).Assembly;
            string? name = Array.Find(lhm.GetManifestResourceNames(),
                n => n.IndexOf("RyzenSMU", StringComparison.OrdinalIgnoreCase) >= 0
                     && (n.EndsWith(".bin", StringComparison.OrdinalIgnoreCase)
                         || n.EndsWith(".amx", StringComparison.OrdinalIgnoreCase)));
            if (name == null)
                return null;
            using Stream? s = lhm.GetManifestResourceStream(name);
            if (s == null)
                return null;
            using var ms = new MemoryStream();
            s.CopyTo(ms);
            return ms.ToArray();
        }
        catch { return null; }
    }

    /// <summary>
    /// Send one RSMU command (message id + up to six args) through the module's
    /// generic mailbox IOCTL. On success the SMU's reply is copied back into
    /// <paramref name="args"/>. Returns the IOCTL HRESULT (0 = success).
    /// </summary>
    public int SendRsmu(uint message, uint[] args)
    {
        if (!IsLoaded)
            return unchecked((int)0x80070006); // E_HANDLE

        lock (_gate)
        {
            long[] input = new long[7];
            input[0] = message;
            for (int i = 0; i < 6; i++)
                input[i + 1] = i < args.Length ? args[i] : 0;

            long[] output = new long[6];
            int hr = ExecuteHr("ioctl_send_smu_command", input, output);
            for (int i = 0; i < 6 && i < args.Length; i++)
                args[i] = (uint)output[i];
            return hr;
        }
    }

    /// <summary>Read the SMU firmware version (read-only sanity check for `smu status`).</summary>
    public uint GetSmuVersion()
    {
        if (!IsLoaded)
            return 0;
        lock (_gate)
        {
            long[] output = new long[1];
            int hr = ExecuteHr("ioctl_get_smu_version", Array.Empty<long>(), output);
            return hr == 0 ? unchecked((uint)output[0]) : 0;
        }
    }

    // ---- high-level tuning ops (each clamps as a defense layer) --------------

    /// <summary>Apply a per-core Curve Optimizer margin (clamped to ±50).</summary>
    public SmuResult SetCurveOptimizer(int ccd, int coreInCcd, int margin)
    {
        int m = Math.Clamp(margin, SmuEncoding.CoMarginMin, SmuEncoding.CoMarginMax);
        uint mask = SmuEncoding.CoreMask(ccd, 0, coreInCcd); // Zen5: ccx = 0
        uint[] args = { SmuEncoding.CoMarginArg(mask, m) };
        int hr = SendRsmu(Zen5.MsgSetCoMarginPerCore, args);
        return hr == 0
            ? SmuResult.Good($"CO ccd{ccd} core{coreInCcd} = {m}")
            : SmuResult.Fail($"CO write failed (hr=0x{hr:X8})");
    }

    /// <summary>Apply an all-core Curve Optimizer margin (clamped to ±50).</summary>
    public SmuResult SetCurveOptimizerAll(int margin)
    {
        int m = Math.Clamp(margin, SmuEncoding.CoMarginMin, SmuEncoding.CoMarginMax);
        uint[] args = { (uint)(m & 0xFFFF) };
        int hr = SendRsmu(Zen5.MsgSetCoMarginAllCores, args);
        return hr == 0 ? SmuResult.Good($"CO all = {m}") : SmuResult.Fail($"CO-all failed (hr=0x{hr:X8})");
    }

    /// <summary>Set a PBO power/current limit. <paramref name="units"/> is W (PPT) or A
    /// (TDC/EDC); the SMU takes milli-units, so we pass units×1000.</summary>
    public SmuResult SetLimit(uint message, double units, string label, double maxUnits)
    {
        double clamped = Math.Clamp(units, 0, maxUnits);
        uint[] args = { (uint)Math.Round(clamped * 1000.0) };
        int hr = SendRsmu(message, args);
        return hr == 0 ? SmuResult.Good($"{label} = {clamped:0}") : SmuResult.Fail($"{label} failed (hr=0x{hr:X8})");
    }

    /// <summary>Set the PBO scalar (1×–10×); the SMU takes scalar×100.</summary>
    public SmuResult SetPboScalar(int scalar)
    {
        int s = Math.Clamp(scalar, 1, 10);
        uint[] args = { (uint)(s * 100) };
        int hr = SendRsmu(Zen5.MsgSetPboScalar, args);
        return hr == 0 ? SmuResult.Good($"scalar = {s}x") : SmuResult.Fail($"scalar failed (hr=0x{hr:X8})");
    }

    // ---- low-level PawnIO IOCTL ---------------------------------------------

    private int ExecuteHr(string fn, long[] input, long[] output)
    {
        if (_handle == null)
            return unchecked((int)0x80070006);

        byte[] inBytes = new byte[input.Length * 8 + FnNameLen];
        byte[] fnBytes = Encoding.ASCII.GetBytes(fn);
        Buffer.BlockCopy(fnBytes, 0, inBytes, 0, Math.Min(FnNameLen - 1, fnBytes.Length));
        Buffer.BlockCopy(input, 0, inBytes, FnNameLen, input.Length * 8);

        byte[] outBytes = new byte[output.Length * 8];
        bool ok = DeviceIoControl(_handle, DeviceType | FnExecute, inBytes, (uint)inBytes.Length,
            outBytes, (uint)outBytes.Length, out uint read, IntPtr.Zero);
        if (!ok)
            return Marshal.GetHRForLastWin32Error();

        int copy = Math.Min((int)read, output.Length * 8);
        if (copy > 0)
            Buffer.BlockCopy(outBytes, 0, output, 0, copy);
        return 0;
    }

    public void Dispose()
    {
        if (_disposed)
            return;
        _disposed = true;
        _handle?.Dispose();
    }

    // ---- P/Invoke -----------------------------------------------------------

    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint ShareReadWrite = 0x00000003;
    private const uint OpenExisting = 3;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFile(string fileName, uint access, uint share,
        IntPtr security, uint creationDisposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(IntPtr device, uint controlCode,
        byte[] inBuffer, uint inSize, byte[]? outBuffer, uint outSize,
        out uint bytesReturned, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(SafeFileHandle device, uint controlCode,
        byte[] inBuffer, uint inSize, byte[]? outBuffer, uint outSize,
        out uint bytesReturned, IntPtr overlapped);
}
