// sensord — CorePilot hardware sensor sidecar.
//
// Reads CPU/GPU power and temperature via LibreHardwareMonitorLib (MPL-2.0) and
// emits one compact JSON object per line to stdout, once per second:
//   {"cpuPower":<W|null>,"cpuTemp":<C|null>,"gpuPower":<W|null>,"gpuTemp":<C|null>}
//
// Opening the Computer loads a kernel driver to read MSRs / hardware sensors,
// which requires elevation. Every read is wrapped so that a failure emits a
// fully-null line and the process keeps running rather than crashing.

using System.Globalization;
using System.Text;
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

    private static int Main(string[] args)
    {
        // Diagnostic: enumerate motherboard Control/Fan/Temperature sensors to
        // determine whether software fan control is possible on this board.
        if (args.Length > 0 && args[0] == "--list")
        {
            return ListControls();
        }

        // stdout is line-based; the Rust reader parses one JSON object per line.
        var stdout = Console.Out;

        Computer? computer = null;
        try
        {
            computer = new Computer
            {
                IsCpuEnabled = true,
                IsGpuEnabled = true,
                IsMotherboardEnabled = false,
            };
            computer.Open();
        }
        catch
        {
            // Driver failed to load (e.g. blocked, not elevated). We still run so
            // the consumer keeps getting (null) lines instead of a dead pipe.
            computer = null;
        }

        var visitor = new UpdateVisitor();

        while (true)
        {
            string line;
            try
            {
                line = BuildSample(computer, visitor);
            }
            catch
            {
                // Any unexpected read failure: emit nulls, keep the loop alive.
                line = NullLine();
            }

            try
            {
                stdout.WriteLine(line);
                stdout.Flush();
            }
            catch
            {
                // stdout closed (parent exited): nothing left to do.
                break;
            }

            Thread.Sleep(PollIntervalMs);
        }

        try
        {
            computer?.Close();
        }
        catch
        {
            // ignore shutdown errors
        }

        return 0;
    }

    /// <summary>
    /// Diagnostic enumeration: open the board with motherboard + controller
    /// support and list every Control / Fan / Temperature sensor, noting which
    /// ones are software-controllable (`sensor.Control != null`). Read-only.
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
    /// Update all hardware and scan for the four target sensor values.
    /// </summary>
    private static string BuildSample(Computer? computer, UpdateVisitor visitor)
    {
        if (computer is null)
        {
            return NullLine();
        }

        computer.Accept(visitor);

        float? cpuPower = null;
        float? cpuTemp = null;
        float? gpuPower = null;
        float? gpuTemp = null;

        foreach (IHardware hardware in computer.Hardware)
        {
            switch (hardware.HardwareType)
            {
                case HardwareType.Cpu:
                    cpuPower ??= FindCpuPower(hardware);
                    cpuTemp ??= FindCpuTemp(hardware);
                    break;
                case HardwareType.GpuNvidia:
                case HardwareType.GpuAmd:
                case HardwareType.GpuIntel:
                    gpuPower ??= FindGpuPower(hardware);
                    gpuTemp ??= FindGpuTemp(hardware);
                    break;
            }
        }

        return BuildLine(cpuPower, cpuTemp, gpuPower, gpuTemp);
    }

    // --- CPU sensor selection -------------------------------------------------

    // Power: SensorType.Power, name containing "Package" (e.g. "CPU Package",
    // "Package", "Package Power").
    private static float? FindCpuPower(IHardware hardware) =>
        FirstValue(hardware, ISensorType: SensorType.Power, predicate: static name =>
            name.Contains("Package", StringComparison.OrdinalIgnoreCase));

    // Temp: prefer "Core (Tctl/Tdie)", then "CPU Package", then "Core (Tctl)".
    private static float? FindCpuTemp(IHardware hardware)
    {
        return FindByNamePriority(hardware, SensorType.Temperature, new[]
        {
            "Core (Tctl/Tdie)",
            "CPU Package",
            "Core (Tctl)",
        });
    }

    // --- GPU sensor selection -------------------------------------------------

    // Power: SensorType.Power, name containing "Package" / "GPU Power" / "Total".
    private static float? FindGpuPower(IHardware hardware) =>
        FirstValue(hardware, ISensorType: SensorType.Power, predicate: static name =>
            name.Contains("Package", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("GPU Power", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Total", StringComparison.OrdinalIgnoreCase));

    // Temp: prefer "GPU Core", then "GPU Temperature", then "Core".
    private static float? FindGpuTemp(IHardware hardware)
    {
        return FindByNamePriority(hardware, SensorType.Temperature, new[]
        {
            "GPU Core",
            "GPU Temperature",
            "Core",
        });
    }

    // --- sensor lookup helpers ------------------------------------------------

    /// <summary>
    /// Return the value of the first sensor of <paramref name="ISensorType"/>
    /// whose name satisfies <paramref name="predicate"/>, or null.
    /// </summary>
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

    /// <summary>
    /// Return the value of the first sensor of the given type whose name matches
    /// the highest-priority entry in <paramref name="names"/> (exact, case-
    /// insensitive). Falls back through the list in order, then to any sensor of
    /// the type if none of the preferred names are present.
    /// </summary>
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

        // Fallback: any sensor of this type (better than null when names differ
        // across drivers/hardware revisions).
        foreach (ISensor sensor in hardware.Sensors)
        {
            if (sensor.SensorType == ISensorType)
            {
                return sensor.Value;
            }
        }

        return null;
    }

    // --- JSON serialization (manual, to keep it dependency-free & compact) ----

    private static string BuildLine(float? cpuPower, float? cpuTemp, float? gpuPower, float? gpuTemp)
    {
        var sb = new StringBuilder(96);
        sb.Append("{\"cpuPower\":").Append(Num(cpuPower));
        sb.Append(",\"cpuTemp\":").Append(Num(cpuTemp));
        sb.Append(",\"gpuPower\":").Append(Num(gpuPower));
        sb.Append(",\"gpuTemp\":").Append(Num(gpuTemp));
        sb.Append('}');
        return sb.ToString();
    }

    private static string NullLine() => "{\"cpuPower\":null,\"cpuTemp\":null,\"gpuPower\":null,\"gpuTemp\":null}";

    /// <summary>Format a nullable float as a JSON number or the literal null.</summary>
    private static string Num(float? value)
    {
        if (value is not { } v || float.IsNaN(v) || float.IsInfinity(v))
        {
            return "null";
        }
        return v.ToString("0.##", CultureInfo.InvariantCulture);
    }
}
