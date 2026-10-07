// What CorePilot sends to the AMD SMU, and which CPUs it may send it to.
//
// The SMU mailbox itself is driven by the RyzenSMU PawnIO module (see
// RyzenSmuHost.cs); this file only holds the handful of RSMU message IDs the
// tuning UI uses, the argument encoding, the value bounds, and the CPU gate.
// Message IDs and bit layouts are hardware-interface facts, written here from
// the observed AM5 desktop behaviour.

using System;
using System.Runtime.Intrinsics.X86;

namespace Sensord.Smu;

/// <summary>RSMU message IDs used by the tuning UI. Valid on AM5 desktop dies
/// only — see <see cref="CpuGate"/>.</summary>
public static class Zen5
{
    public const uint MsgSetCoMarginPerCore = 0x06;
    public const uint MsgSetCoMarginAllCores = 0x07;
    public const uint MsgSetPptLimit = 0x56;
    public const uint MsgSetTdcLimit = 0x57;
    public const uint MsgSetEdcLimit = 0x58;
    public const uint MsgSetPboScalar = 0x5B;
}

/// <summary>Argument encoding + accepted ranges.</summary>
public static class SmuEncoding
{
    /// <summary>Curve-Optimizer margin range on Zen 4 and newer.</summary>
    public const int CoMarginMin = -50;
    public const int CoMarginMax = 50;

    /// <summary>Lowest limits we will write. Zero (which the old [0, 1000] clamp
    /// let through) throttles the CPU to a crawl for the rest of the boot.</summary>
    public const double PptMinWatts = 45;
    public const double CurrentMinAmps = 30;
    public const double LimitMax = 1000;

    public const int ScalarMin = 1;
    public const int ScalarMax = 10;

    /// <summary>Per-core CO address in the argument's high nibbles:
    /// [31:28] CCD, [27:24] CCX (0 on these dies), [23:20] core within the CCX.</summary>
    public static uint CoreMask(int ccd, int ccx, int core) =>
        ((uint)(ccd & 0xF) << 28) | ((uint)(ccx & 0xF) << 24) | ((uint)(core & 0xF) << 20);

    /// <summary>Per-core CO argument: core address high, signed margin as 16-bit
    /// two's complement low.</summary>
    public static uint CoMarginArg(uint coreMask, int margin) =>
        (coreMask & 0xFFF00000u) | (uint)(margin & 0xFFFF);
}

/// <summary>
/// The CPUs whose RSMU table the IDs above match. On Zen 2 / Zen 3 the RyzenSMU
/// module loads just as happily, but 0x56 there is the HTC (Tctl) limit and the
/// scalar / EDC IDs land on unrelated functions, so every write is refused
/// unless the die is one of these.
/// </summary>
public static class CpuGate
{
    private static readonly (int Family, int Model, string Name)[] Supported =
    {
        (0x19, 0x61, "Raphael / Dragon Range (Ryzen 7000)"),
        (0x1A, 0x44, "Granite Ridge / Fire Range (Ryzen 9000)"),
    };

    /// <summary>Null when writes are allowed; otherwise a short English reason.</summary>
    public static readonly string? UnsupportedReason = Check();

    public static bool Allowed => UnsupportedReason == null;

    private static string? Check()
    {
        if (!X86Base.IsSupported)
            return "cpuid unavailable";
        (int _, int ebx, int ecx, int edx) = X86Base.CpuId(0, 0);
        string vendor = string.Concat(Ascii(ebx), Ascii(edx), Ascii(ecx));
        if (vendor != "AuthenticAMD")
            return $"vendor {vendor} not supported";
        (int eax, _, _, _) = X86Base.CpuId(1, 0);
        int baseFamily = (eax >> 8) & 0xF;
        int family = baseFamily == 0xF ? baseFamily + ((eax >> 20) & 0xFF) : baseFamily;
        int model = baseFamily == 0xF ? (((eax >> 16) & 0xF) << 4) | ((eax >> 4) & 0xF) : (eax >> 4) & 0xF;
        foreach (var s in Supported)
        {
            if (s.Family == family && s.Model == model)
                return null;
        }
        return $"cpu family 0x{family:X} model 0x{model:X} not supported";
    }

    private static string Ascii(int reg) =>
        new(new[] { (char)(reg & 0xFF), (char)((reg >> 8) & 0xFF), (char)((reg >> 16) & 0xFF), (char)((reg >> 24) & 0xFF) });
}
