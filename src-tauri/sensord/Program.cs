// sensord — CorePilot hardware sensor sidecar.
//
// Reads CPU/GPU power & temperature AND motherboard fans / temperatures / fan
// controls via LibreHardwareMonitorLib (MPL-2.0), emitting one compact JSON
// object per line to stdout (~1 Hz):
//   {"cpuPower":<W|null>,"cpuTemp":<C|null>,"gpuPower":<W|null>,"gpuTemp":<C|null>,
//    "fans":[{"id","name","rpm"}],"temps":[{"id","name","c"}],
//    "controls":[{"id","name","pct","controllable","hw"}]}
//
// It ALSO accepts one command per line on stdin to drive software fan control
// (this is the "FanXpert" engine's actuator):
//   set <controlId> <0..100>   -> IControl.SetSoftware(pct)
//   auto <controlId>           -> IControl.SetDefault()  (back to BIOS control)
//   autoall                    -> reset every control touched this session
//
// Opening the Computer loads a kernel driver to read MSRs / Super-I/O, which
// requires elevation. Every read is wrapped so a failure emits a null-ish line
// and the process keeps running rather than crashing. On shutdown (stdin EOF or
// process exit) every control we ever drove is returned to BIOS default so a fan
// is never left pinned if CorePilot exits.

using System.Globalization;
using System.Text.Json;
using LibreHardwareMonitor.Hardware;

namespace Sensord;

/// <summary>
/// Visitor that traverses hardware and its sub-hardware calling Update(), as
/// required by LibreHardwareMonitorLib before sensor values are valid.
/// </summary>
internal sealed class UpdateVisitor : IVisitor
{
    public void VisitComputer(IComputer computer) => computer.Traverse(this);

    public void VisitHardware(IHardware hardware)
    {
        hardware.Update();
        foreach (IHardware sub in hardware.SubHardware)
        {
            sub.Accept(this);
        }
    }

    public void VisitSensor(ISensor sensor) { }

    public void VisitParameter(IParameter parameter) { }
}

internal static class Program
{
    private const int PollIntervalMs = 1000;

    /// <summary>Serializes all LibreHardwareMonitor access (poll updates and
    /// control writes happen on different threads).</summary>
    private static readonly object Gate = new();

    /// <summary>controlId -> the controllable Control sensor (rebuilt each poll).</summary>
    private static Dictionary<string, ISensor> _controls = new();

    /// <summary>Controls we have driven via SetSoftware — reset to default on exit.</summary>
    private static readonly HashSet<string> _touched = new();

    /// <summary>True once we've read a nonzero motherboard fan RPM — gates the
    /// re-open-on-stale logic so a fanless board doesn't thrash.</summary>
    private static bool _sawMoboFan;

    /// <summary>Reopen spacing while the bank is genuinely refreshing (fans spin,
    /// the read was merely stale) — roughly one poll interval, so a stale NCT6701D
    /// bank is refreshed promptly with no visible 0-RPM flicker.</summary>
    private const int LiveReopenCooldownMs = 1_500;

    /// <summary>Reopen spacing after a reopen that stayed all-zero — i.e. a genuine
    /// BIOS fan-stop. Backed off this far so legit 0 RPM never churns the driver.</summary>
    private const int StaleReopenCooldownMs = 8_000;

    /// <summary>Adaptive spacing between chip reopens: starts live, backs off to
    /// the stale value whenever a reopen fails to restore any fan RPM.</summary>
    private static int _reopenCooldownMs = LiveReopenCooldownMs;

    /// <summary>Tick (ms) of the last chip reopen, for the cooldown above.</summary>
    private static long _lastReopenTick = -StaleReopenCooldownMs;

    /// <summary>Cold-start recovery: the chip can power up (or be left by an abrupt
    /// prior exit) with an already-stale fan bank, so the very first reads are 0 and
    /// <see cref="_sawMoboFan"/> never flips — which would leave the normal reopen
    /// gate dormant forever. We allow this many reopens BEFORE we've ever seen a
    /// spinning fan; a reopen refreshes the bank and usually yields real RPM. A
    /// genuinely fanless board simply exhausts these and then stops thrashing.</summary>
    private const int MaxColdStartReopens = 10;
    private static int _coldStartReopens;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        // Default options reject NaN/Infinity; we sanitize to null beforehand so
        // the emitted JSON is always strict and the Rust serde parser is happy.
    };

    private static int Main(string[] args)
    {
        // Diagnostic: enumerate motherboard Control/Fan/Temperature sensors to
        // determine whether software fan control is possible on this board.
        if (args.Length > 0 && args[0] == "--list")
        {
            return ListControls();
        }

        var stdout = Console.Out;

        // One LHM Computer (CPU + GPU + Motherboard/Super-I/O). The Nuvoton
        // NCT6701D returns valid fan RPM only for the first few Update() calls
        // after Open(); its register bank then goes stale and every fan reads 0
        // (LHM caches the bank and never re-selects it). The fix: when the board
        // fans degrade to all-zero, Close()+Open() the Computer and rebuild the
        // sample INLINE so the consumer never sees the spurious 0. (Splitting the
        // motherboard into its own Computer does NOT work — the CPU/GPU bus access
        // dirties the Super-I/O read; a single coordinated LHM update is needed.)
        Computer? computer = OpenComputer();

        // Reset any controls we drove, on a clean or abrupt shutdown.
        AppDomain.CurrentDomain.ProcessExit += (_, _) => ResetTouched();

        // Command reader: applies fan control commands from stdin on its own
        // thread so the 1 Hz poll loop is never blocked waiting for input.
        var cmdThread = new Thread(() => CommandLoop(Console.In))
        {
            IsBackground = true,
            Name = "sensord-cmd",
        };
        cmdThread.Start();

        var visitor = new UpdateVisitor();

        while (true)
        {
            string line;
            try
            {
                line = BuildSample(computer, visitor, out bool stale);

                // Stale NCT6701D bank: board fans read all-zero after having spun
                // this session. Reopen the chip PROMPTLY to refresh its register
                // bank, then rebuild the sample inline so the emitted line carries
                // real RPM (no 0-flicker). The cooldown is adaptive: after a reopen
                // that restores RPM we keep refreshing at the live cadence; one that
                // stays all-zero means a genuine BIOS fan-stop, so we back off and
                // never churn the kernel driver while fans are legitimately parked.
                // (Driven fans are NOT reset here — the chip holds the last PWM
                // across the reopen and the engine re-applies via the rebuilt map;
                // ResetTouched runs on the exit paths so nothing is left pinned.)
                long nowTick = Environment.TickCount64;
                // Reopen when the board has spun this session (normal stale-bank
                // refresh) OR during cold start (first reads already 0, so
                // _sawMoboFan hasn't flipped yet) — bounded so a fanless board stops.
                bool coldStart = !_sawMoboFan && _coldStartReopens < MaxColdStartReopens;
                if (stale
                    && (_sawMoboFan || coldStart)
                    && computer != null
                    && nowTick - _lastReopenTick >= _reopenCooldownMs)
                {
                    lock (Gate)
                    {
                        try { computer.Close(); } catch { /* ignore */ }
                        computer = OpenComputer();
                    }
                    _lastReopenTick = nowTick;
                    if (coldStart)
                    {
                        _coldStartReopens++;
                    }
                    line = BuildSample(computer, visitor, out bool stillStale);
                    // Cold-start retries stay quick (catch the fresh-read window);
                    // once fans are confirmed (or cold-start is exhausted) fall back
                    // to the adaptive cooldown (live when refreshing, long on a real
                    // fan-stop so we never churn the driver).
                    _reopenCooldownMs = (!_sawMoboFan && _coldStartReopens < MaxColdStartReopens)
                        ? LiveReopenCooldownMs
                        : stillStale ? StaleReopenCooldownMs : LiveReopenCooldownMs;
                }
            }
            catch
            {
                line = NullLine();
            }

            try
            {
                stdout.WriteLine(line);
                stdout.Flush();
            }
            catch
            {
                break; // stdout closed (parent exited)
            }

            Thread.Sleep(PollIntervalMs);
        }

        ResetTouched();
        try { computer?.Close(); } catch { /* ignore shutdown errors */ }
        return 0;
    }

    /// <summary>Build and open the LHM Computer (CPU + GPU + Motherboard/Super-I/O
    /// controllers). Returns null if the driver can't load (blocked / not elevated).</summary>
    private static Computer? OpenComputer()
    {
        try
        {
            var c = new Computer
            {
                IsCpuEnabled = true,
                IsGpuEnabled = true,
                // Enumerating motherboard fans/controls is read-only; a fan is only
                // ever driven by an explicit `set` command on stdin.
                IsMotherboardEnabled = true,
                IsControllerEnabled = true,
            };
            c.Open();
            return c;
        }
        catch
        {
            return null;
        }
    }

    // --- fan control command loop --------------------------------------------

    /// <summary>
    /// Read one command per line until EOF. Commands mutate fan controls under
    /// <see cref="Gate"/>. On EOF (parent closed stdin) reset every driven
    /// control to BIOS default so fans are never left pinned.
    /// </summary>
    private static void CommandLoop(TextReader stdin)
    {
        string? raw;
        try
        {
            while ((raw = stdin.ReadLine()) != null)
            {
                HandleCommand(raw);
            }
        }
        catch
        {
            // stdin error/closed — fall through to reset.
        }
        ResetTouched();
    }

    private static void HandleCommand(string raw)
    {
        string[] parts = raw.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0)
        {
            return;
        }

        string verb = parts[0].ToLowerInvariant();
        try
        {
            lock (Gate)
            {
                switch (verb)
                {
                    // Exact token counts only: a malformed line (extra/missing
                    // args) is ignored rather than partially interpreted.
                    case "set" when parts.Length == 3:
                        ApplySet(parts[1], parts[2]);
                        break;
                    case "auto" when parts.Length == 2:
                        ApplyAuto(parts[1]);
                        break;
                    case "autoall" when parts.Length == 1:
                        foreach (string id in _touched)
                        {
                            if (_controls.TryGetValue(id, out ISensor? s) && s.Control != null)
                            {
                                s.Control.SetDefault();
                            }
                        }
                        _touched.Clear();
                        break;
                }
            }
        }
        catch
        {
            // A bad/locked control must not kill the sidecar; ignore and continue.
        }
    }

    private static void ApplySet(string id, string pctText)
    {
        if (!_controls.TryGetValue(id, out ISensor? sensor) || sensor.Control == null)
        {
            return;
        }
        if (!float.TryParse(pctText, NumberStyles.Float, CultureInfo.InvariantCulture, out float pct))
        {
            return;
        }
        IControl control = sensor.Control;
        float min = control.MinSoftwareValue;
        float max = control.MaxSoftwareValue;
        if (max <= min)
        {
            min = 0f;
            max = 100f;
        }
        pct = Math.Clamp(pct, min, max);
        control.SetSoftware(pct);
        _touched.Add(id);
    }

    private static void ApplyAuto(string id)
    {
        if (_controls.TryGetValue(id, out ISensor? sensor) && sensor.Control != null)
        {
            sensor.Control.SetDefault();
            _touched.Remove(id);
        }
    }

    private static void ResetTouched()
    {
        try
        {
            lock (Gate)
            {
                foreach (string id in _touched)
                {
                    if (_controls.TryGetValue(id, out ISensor? s) && s.Control != null)
                    {
                        try { s.Control.SetDefault(); } catch { /* ignore */ }
                    }
                }
                _touched.Clear();
            }
        }
        catch
        {
            // ignore — best-effort safety reset
        }
    }

    // --- sampling -------------------------------------------------------------

    /// <summary>
    /// Update all hardware, refresh the control map, and build the JSON line with
    /// CPU/GPU power+temp plus the fan / temperature / control arrays.
    /// </summary>
    private static string BuildSample(Computer? computer, UpdateVisitor visitor, out bool moboFansAllZero)
    {
        moboFansAllZero = false;
        if (computer is null)
        {
            return NullLine();
        }

        float? cpuPower = null;
        float? cpuTemp = null;
        float? gpuPower = null;
        float? gpuTemp = null;

        var fans = new List<SensorReading>();
        var temps = new List<SensorReading>();
        var controls = new List<ControlReading>();
        var cpuSensors = new List<CpuSensorReading>();
        var controlMap = new Dictionary<string, ISensor>();

        lock (Gate)
        {
            computer.Accept(visitor);

            foreach (IHardware hardware in computer.Hardware)
            {
                switch (hardware.HardwareType)
                {
                    case HardwareType.Cpu:
                        cpuPower ??= FindCpuPower(hardware);
                        cpuTemp ??= FindCpuTemp(hardware);
                        CollectCpuSensors(hardware, cpuSensors);
                        break;
                    case HardwareType.GpuNvidia:
                    case HardwareType.GpuAmd:
                    case HardwareType.GpuIntel:
                        gpuPower ??= FindGpuPower(hardware);
                        gpuTemp ??= FindGpuTemp(hardware);
                        break;
                }

                // Collect fans / temps / controls from EVERY hardware node
                // (motherboard Super-I/O AND the GPU's own fans) so the fan page
                // shows them all. The `hw` field lets the UI label them.
                Collect(hardware, fans, temps, controls, controlMap);
            }

            // Publish the freshly-collected control map for the command thread.
            _controls = controlMap;
        }

        // Motherboard fans are the non-GPU fan readings. Detect the stale-bank
        // condition (we've seen them spin, but now every board fan reads 0) so the
        // caller can re-open the chip. GPU fans (always ~1000) are excluded.
        var moboFans = fans.FindAll(f => !f.name.Contains("GPU", StringComparison.OrdinalIgnoreCase));
        if (moboFans.Exists(f => (f.value ?? 0) > 0))
        {
            _sawMoboFan = true;
        }
        if (moboFans.Count > 0 && moboFans.TrueForAll(f => (f.value ?? 0) <= 0))
        {
            moboFansAllZero = true;
        }

        return BuildLine(cpuPower, cpuTemp, gpuPower, gpuTemp, fans, temps, controls, cpuSensors);
    }

    /// <summary>
    /// Recursively gather Fan (RPM), Temperature (°C), and Control (PWM %) sensors
    /// from a hardware node and its sub-hardware (the Super-I/O chip lives under
    /// the Motherboard node; the GPU exposes its own fans/controls too — both are
    /// shown, distinguished by the `hw` field).
    /// </summary>
    private static void Collect(
        IHardware hardware,
        List<SensorReading> fans,
        List<SensorReading> temps,
        List<ControlReading> controls,
        Dictionary<string, ISensor> controlMap)
    {
        foreach (ISensor s in hardware.Sensors)
        {
            string id = s.Identifier.ToString() ?? string.Empty;
            if (id.Length == 0)
            {
                continue;
            }
            switch (s.SensorType)
            {
                case SensorType.Fan:
                    fans.Add(new SensorReading(id, s.Name, Finite(s.Value)));
                    break;
                case SensorType.Temperature:
                    temps.Add(new SensorReading(id, s.Name, Finite(s.Value)));
                    break;
                case SensorType.Control:
                    bool controllable = s.Control != null;
                    controls.Add(new ControlReading(id, s.Name, Finite(s.Value), controllable, hardware.Name));
                    if (controllable)
                    {
                        controlMap[id] = s;
                    }
                    break;
            }
        }
        foreach (IHardware sub in hardware.SubHardware)
        {
            Collect(sub, fans, temps, controls, controlMap);
        }
    }

    /// <summary>
    /// Diagnostic enumeration (read-only): list every Control / Fan / Temperature
    /// sensor and whether it is software-controllable.
    /// </summary>
    private static int ListControls()
    {
        Computer c;
        try
        {
            c = new Computer
            {
                IsMotherboardEnabled = true,
                IsControllerEnabled = true,
                IsCpuEnabled = true,
                IsGpuEnabled = true,
            };
            c.Open();
        }
        catch (Exception e)
        {
            Console.WriteLine($"open failed: {e.Message}");
            return 1;
        }

        c.Accept(new UpdateVisitor());

        void Dump(IHardware hw, string indent)
        {
            Console.WriteLine($"{indent}[HW] {hw.HardwareType} : {hw.Name}");
            foreach (ISensor s in hw.Sensors)
            {
                if (s.SensorType is SensorType.Control or SensorType.Fan or SensorType.Temperature)
                {
                    string val = s.Value?.ToString("0.#", CultureInfo.InvariantCulture) ?? "null";
                    Console.WriteLine($"{indent}   {s.SensorType,-11} {s.Name,-26} val={val,-7} controllable={s.Control != null} id={s.Identifier}");
                }
            }
            foreach (IHardware sub in hw.SubHardware)
            {
                Dump(sub, indent + "  ");
            }
        }

        foreach (IHardware hw in c.Hardware)
        {
            Dump(hw, string.Empty);
        }

        try { c.Close(); } catch { /* ignore */ }
        return 0;
    }

    /// <summary>
    /// Collect every CPU power / voltage / clock / current / temperature / load
    /// sensor LHM exposes (per-core effective clocks, CCD temps, VDDCR / SoC
    /// voltages, package power, TDC / EDC, etc. — many sourced from the AMD SMU
    /// PM table). Read-only; degrades gracefully to whatever LHM provides.
    /// </summary>
    private static void CollectCpuSensors(IHardware cpu, List<CpuSensorReading> outList)
    {
        foreach (ISensor s in cpu.Sensors)
        {
            switch (s.SensorType)
            {
                case SensorType.Power:
                case SensorType.Voltage:
                case SensorType.Clock:
                case SensorType.Current:
                case SensorType.Temperature:
                case SensorType.Load:
                case SensorType.Factor:
                    outList.Add(new CpuSensorReading(s.Name, s.SensorType.ToString(), Finite(s.Value)));
                    break;
            }
        }
        foreach (IHardware sub in cpu.SubHardware)
            CollectCpuSensors(sub, outList);
    }

    // --- CPU/GPU sensor selection (unchanged behaviour) -----------------------

    private static float? FindCpuPower(IHardware hardware) =>
        FirstValue(hardware, ISensorType: SensorType.Power, predicate: static name =>
            name.Contains("Package", StringComparison.OrdinalIgnoreCase));

    private static float? FindCpuTemp(IHardware hardware) =>
        FindByNamePriority(hardware, SensorType.Temperature, new[]
        {
            "Core (Tctl/Tdie)",
            "CPU Package",
            "Core (Tctl)",
        });

    private static float? FindGpuPower(IHardware hardware) =>
        FirstValue(hardware, ISensorType: SensorType.Power, predicate: static name =>
            name.Contains("Package", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("GPU Power", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Total", StringComparison.OrdinalIgnoreCase));

    private static float? FindGpuTemp(IHardware hardware) =>
        FindByNamePriority(hardware, SensorType.Temperature, new[]
        {
            "GPU Core",
            "GPU Temperature",
            "Core",
        });

    private static float? FirstValue(
        IHardware hardware,
        SensorType ISensorType,
        Func<string, bool> predicate)
    {
        foreach (ISensor sensor in hardware.Sensors)
        {
            if (sensor.SensorType == ISensorType &&
                sensor.Name is { } name &&
                predicate(name))
            {
                return sensor.Value;
            }
        }
        return null;
    }

    private static float? FindByNamePriority(
        IHardware hardware,
        SensorType ISensorType,
        string[] names)
    {
        foreach (string wanted in names)
        {
            foreach (ISensor sensor in hardware.Sensors)
            {
                if (sensor.SensorType == ISensorType &&
                    string.Equals(sensor.Name, wanted, StringComparison.OrdinalIgnoreCase))
                {
                    return sensor.Value;
                }
            }
        }

        foreach (ISensor sensor in hardware.Sensors)
        {
            if (sensor.SensorType == ISensorType)
            {
                return sensor.Value;
            }
        }

        return null;
    }

    // --- JSON serialization ---------------------------------------------------

    private readonly record struct SensorReading(string id, string name, double? value);
    private readonly record struct ControlReading(string id, string name, double? pct, bool controllable, string hw);
    private readonly record struct CpuSensorReading(string name, string type, double? value);

    private static string BuildLine(
        float? cpuPower, float? cpuTemp, float? gpuPower, float? gpuTemp,
        List<SensorReading> fans, List<SensorReading> temps, List<ControlReading> controls,
        List<CpuSensorReading> cpuSensors)
    {
        var payload = new
        {
            cpuPower = Finite(cpuPower),
            cpuTemp = Finite(cpuTemp),
            gpuPower = Finite(gpuPower),
            gpuTemp = Finite(gpuTemp),
            fans = fans.ConvertAll(f => new { f.id, f.name, rpm = f.value }),
            temps = temps.ConvertAll(t => new { t.id, t.name, c = t.value }),
            controls = controls.ConvertAll(c => new { c.id, c.name, pct = c.pct, c.controllable, c.hw }),
            cpu = cpuSensors.ConvertAll(s => new { s.name, s.type, value = s.value }),
        };
        return JsonSerializer.Serialize(payload, JsonOpts);
    }

    private static string NullLine() =>
        "{\"cpuPower\":null,\"cpuTemp\":null,\"gpuPower\":null,\"gpuTemp\":null,\"fans\":[],\"temps\":[],\"controls\":[],\"cpu\":[]}";

    /// <summary>Return a finite double or null (NaN/Infinity -> null) so the
    /// emitted JSON stays strict.</summary>
    private static double? Finite(float? value)
    {
        if (value is not { } v || float.IsNaN(v) || float.IsInfinity(v))
        {
            return null;
        }
        return v;
    }
}
