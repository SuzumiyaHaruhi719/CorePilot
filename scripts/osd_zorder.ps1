# Diagnostic: where does the CorePilot OSD overlay sit in the window z-order?
# Prints every VISIBLE top-level window from the top of the z-order down to the
# OSD, flagging WS_EX_TOPMOST. Healthy = the OSD is first (or only cloaked 1x1
# shell helper windows precede it). Demoted = ordinary windows above it while it
# still reports topmost=True (the fullscreen-app demotion osd.rs guards against).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\osd_zorder.ps1
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class Z {
 [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
}
"@
$h = [Z]::GetTopWindow([IntPtr]::Zero); $i = 0; $found = $false
while ($h -ne [IntPtr]::Zero -and -not $found) {
  if ([Z]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256; [void][Z]::GetWindowText($h,$sb,256)
    $cn = New-Object System.Text.StringBuilder 256; [void][Z]::GetClassName($h,$cn,256)
    $pp = 0; [void][Z]::GetWindowThreadProcessId($h,[ref]$pp)
    $ex = [Z]::GetWindowLongPtr($h,-20).ToInt64(); $cl = 0; [void][Z]::DwmGetWindowAttribute($h,14,[ref]$cl,4)
    $isOsd = ($sb.ToString() -eq "CorePilot OSD")
    "{0,3} topmost={1,-5} cloaked={2} pid={3,-6} [{4}] class=[{5}]{6}" -f $i, (($ex -band 8) -ne 0), $cl, $pp, $sb.ToString(), $cn.ToString(), $(if ($isOsd) { "  <== OSD" } else { "" })
    $i++; if ($isOsd) { $found = $true }
  }
  $h = [Z]::GetWindow($h, 2)
}
if (-not $found) { "CorePilot OSD window not found (app not running, or OSD not created)" }
