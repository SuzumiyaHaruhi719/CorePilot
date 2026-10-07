# Third-party notices

CorePilot's own source contains no third-party code. The `sensord` hardware
sidecar (`sensord.exe`) links and redistributes the libraries below,
**unmodified**, as published on NuGet. Their source is available at the URLs
given; the license texts ship inside each package.

| Component | Version | License | Source |
|---|---|---|---|
| LibreHardwareMonitorLib | 0.9.7-pre700 | MPL-2.0 | https://github.com/LibreHardwareMonitor/LibreHardwareMonitor |
| PawnIO modules (embedded as data in LibreHardwareMonitorLib, e.g. `RyzenSMU.bin`) | as bundled by LibreHardwareMonitorLib | LGPL-2.1 | https://github.com/namazso/PawnIO.Modules |
| BlackSharp.Core | 1.1.0 | MPL-2.0 | https://github.com/Blacktempel/BlackSharp |
| DiskInfoToolkit | 2.1.1 | MPL-2.0 | https://github.com/Blacktempel/DiskInfoToolkit |
| RAMSPDToolkit-NDD | 1.5.0 | MPL-2.0 | https://github.com/Blacktempel/RAMSPDToolkit |
| HidSharp | 2.6.4 | Apache-2.0 | https://software.seekye.com/hidsharp |
| Mono.Posix.NETStandard | 1.0.0 | MIT | https://github.com/mono/mono |
| System.Management, System.CodeDom, System.IO.Ports, System.Threading.AccessControl | 10.0.x | MIT | https://github.com/dotnet/runtime |

The **PawnIO driver** itself is not distributed with CorePilot: the user
installs it separately (https://pawnio.eu). sensord talks to it only through
its public device interface.

The Rust application's crate dependencies are listed in `src-tauri/Cargo.lock`;
each crate's license is declared in its own manifest.
