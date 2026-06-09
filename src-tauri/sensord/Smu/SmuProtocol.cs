// SMU mailbox protocol for AMD Ryzen (clean-room).
//
// These are HARDWARE-INTERFACE FACTS — SMN mailbox register addresses, SMU
// message IDs, the request/response handshake, and the Curve-Optimizer argument
// bit-packing. Facts/interfaces aren't copyrightable; this is an original
// implementation written from the documented register map, not a port of any
// GPL source.
//
// Ring-0 register access (PCI config dword r/w on the data-fabric device, which
// reaches the SMN index/data pair) is abstracted behind ISmnAccess so this file
// stays pure protocol logic — the privileged backend (PawnIO) plugs in separately.

using System;

namespace Sensord.Smu;

/// <summary>One SMU mailbox: the three SMN dword addresses it is driven through.</summary>
public readonly record struct SmuMailbox(uint MsgAddr, uint RspAddr, uint ArgAddr);

/// <summary>Result of an SMU mailbox transaction (the value the SMU writes to RSP).</summary>
public enum SmuStatus : byte
{
    Ok = 0x01,
    Failed = 0xFF,
    UnknownCommand = 0xFE,
    RejectedPrereq = 0xFD,
    RejectedBusy = 0xFC,
    // Local (not from the SMU): the handshake never completed.
    TimeoutReady = 0x10,
    TimeoutResponse = 0x11,
    AccessFailed = 0x12,
}

/// <summary>
/// Privileged SMN register access + bus serialization. Implemented by the ring-0
/// backend (PawnIO). All SMU traffic shares one system-wide PCI mutex, so callers
/// take <see cref="LockBus"/> for the duration of a whole transaction.
/// </summary>
public interface ISmnAccess
{
    /// <summary>Read one SMN dword (via PCI cfg index/data on dev 0:0:0). False on failure.</summary>
    bool ReadRegister(uint smnAddress, out uint value);

    /// <summary>Write one SMN dword. False on failure.</summary>
    bool WriteRegister(uint smnAddress, uint value);

    /// <summary>Acquire the global PCI/SMN bus lock; dispose to release.</summary>
    IDisposable LockBus();
}

/// <summary>
/// SMN mailbox addresses and SMU message IDs for Zen 4 / Zen 5 (Granite Ridge =
/// Ryzen 9000, our 9950X3D). Zen 5 shares Zen 4's RSMU/MP1 layout; only HSMP moved.
/// </summary>
public static class Zen5
{
    public const int ArgCount = 6;

    // SMN index/data registers live in the data-fabric device's PCI config space.
    public const uint PciIndexRegister = 0x60;
    public const uint PciDataRegister = 0x64;

    public static readonly SmuMailbox Rsmu = new(0x03B10524, 0x03B10570, 0x03B10A40);
    public static readonly SmuMailbox Mp1 = new(0x03B10530, 0x03B1057C, 0x03B109C4);
    public static readonly SmuMailbox Hsmp = new(0x03B10934, 0x03B10980, 0x03B109E0);

    // RSMU message IDs.
    public const uint MsgGetSmuVersion = 0x02;
    public const uint MsgGetTableVersion = 0x05;
    public const uint MsgGetDramBaseAddress = 0x04;
    public const uint MsgTransferTableToDram = 0x03;

    // Curve Optimizer (per-core DLDO PSM margin) + all-core.
    public const uint MsgSetCoMarginPerCore = 0x06;
    public const uint MsgSetCoMarginAllCores = 0x07;
    public const uint MsgGetCoMargin = 0xD5;

    // PBO / DPTC limits.
    public const uint MsgSetPptLimit = 0x56;
    public const uint MsgSetTdcLimit = 0x57;
    public const uint MsgSetEdcLimit = 0x58;
    public const uint MsgSetTctlMax = 0x59;
    public const uint MsgSetPboScalar = 0x5B;
    public const uint MsgGetPboScalar = 0x6D;

    // Manual OC (advanced; gated in UI).
    public const uint MsgEnableOcMode = 0x5D;
    public const uint MsgDisableOcMode = 0x5E;
    public const uint MsgSetFreqAllCores = 0x5F;
    public const uint MsgSetCpuVid = 0x61;
}

/// <summary>Bit-packing + unit conversions for SMU command arguments (Zen 4/5).</summary>
public static class SmuEncoding
{
    /// <summary>Curve-Optimizer margin range on Zen 4 and newer.</summary>
    public const int CoMarginMin = -50;
    public const int CoMarginMax = 50;

    /// <summary>
    /// Pack a logical core address into the high nibbles used by the per-core CO
    /// command: [31:28]=CCD, [27:24]=CCX (0 on Zen5), [23:20]=core within CCX.
    /// </summary>
    public static uint CoreMask(int ccd, int ccx, int core) =>
        ((uint)(ccd & 0xF) << 28) | ((uint)(ccx & 0xF) << 24) | ((uint)(core & 0xF) << 20);

    /// <summary>
    /// Build the per-core CO command argument: core address in the high bits, the
    /// signed margin as 16-bit two's-complement in the low 16. Margin is clamped.
    /// </summary>
    public static uint CoMarginArg(uint coreMask, int margin)
    {
        int clamped = Math.Clamp(margin, CoMarginMin, CoMarginMax);
        return (coreMask & 0xFFF00000u) | (uint)(clamped & 0xFFFF);
    }

    /// <summary>SVI3 (Zen4/5) VID → volts.</summary>
    public static double VidToVolts(uint vid) => 0.245 + vid * 0.005;

    /// <summary>SVI3 volts → VID (clamped at the 0.245 V floor).</summary>
    public static uint VoltsToVid(double volts) =>
        volts < 0.245 ? 0u : (uint)Math.Round((volts - 0.245) / 0.005);
}

/// <summary>
/// Drives the SMU request/response handshake over an <see cref="ISmnAccess"/>.
/// Sequence per transaction (under the bus lock): wait until RSP is non-zero
/// (previous command done) → clear RSP → write the argument dwords → write the
/// message id → wait until RSP is non-zero again → read status → on OK, read the
/// argument dwords back.
/// </summary>
public sealed class SmuMailboxClient
{
    private const int MaxArgs = Zen5.ArgCount;
    private const int PollAttempts = 8192;

    private readonly ISmnAccess _smn;

    public SmuMailboxClient(ISmnAccess smn) => _smn = smn ?? throw new ArgumentNullException(nameof(smn));

    /// <summary>
    /// Send <paramref name="message"/> on <paramref name="mailbox"/> with up to six
    /// argument dwords (padded/truncated to six). On success the SMU's reply is
    /// copied back into <paramref name="args"/>.
    /// </summary>
    public SmuStatus Send(SmuMailbox mailbox, uint message, uint[] args)
    {
        if (mailbox.MsgAddr == 0 || mailbox.RspAddr == 0 || mailbox.ArgAddr == 0 || message == 0)
            return SmuStatus.UnknownCommand;

        var payload = new uint[MaxArgs];
        if (args != null)
            Array.Copy(args, payload, Math.Min(args.Length, MaxArgs));

        using (_smn.LockBus())
        {
            if (!WaitResponse(mailbox))
                return SmuStatus.TimeoutReady;

            if (!_smn.WriteRegister(mailbox.RspAddr, 0))
                return SmuStatus.AccessFailed;

            for (uint i = 0; i < MaxArgs; i++)
            {
                if (!_smn.WriteRegister(mailbox.ArgAddr + i * 4, payload[i]))
                    return SmuStatus.AccessFailed;
            }

            if (!_smn.WriteRegister(mailbox.MsgAddr, message))
                return SmuStatus.AccessFailed;

            if (!WaitResponse(mailbox))
                return SmuStatus.TimeoutResponse;

            if (!_smn.ReadRegister(mailbox.RspAddr, out uint status))
                return SmuStatus.AccessFailed;

            var result = (SmuStatus)(byte)status;
            if (result == SmuStatus.Ok && args != null)
            {
                int n = Math.Min(args.Length, MaxArgs);
                for (int i = 0; i < n; i++)
                {
                    if (!_smn.ReadRegister(mailbox.ArgAddr + (uint)i * 4, out uint v))
                        return SmuStatus.AccessFailed;
                    args[i] = v;
                }
            }
            return result;
        }
    }

    /// <summary>Spin until the response register reads back non-zero, or give up.</summary>
    private bool WaitResponse(SmuMailbox mailbox)
    {
        for (int i = 0; i < PollAttempts; i++)
        {
            if (_smn.ReadRegister(mailbox.RspAddr, out uint v) && v != 0)
                return true;
        }
        return false;
    }
}
