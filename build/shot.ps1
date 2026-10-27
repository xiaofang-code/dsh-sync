Add-Type -AssemblyName System.Windows.Forms,System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  public struct RECT { public int L, T, R, B; }
}
'@ -ErrorAction SilentlyContinue

$outDir = $args[0]
$mode = $args[1]

$proc = Get-Process | Where-Object { $_.ProcessName -like "*DSH*" -and $_.MainWindowTitle -ne '' } | Select-Object -First 1
if (-not $proc) { Write-Output "NO WINDOW"; exit 1 }
$h = $proc.MainWindowHandle

[Win]::ShowWindow($h, 9) | Out-Null
[Win]::MoveWindow($h, 60, 40, 1180, 820, $true) | Out-Null
[Win]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 900

$r = New-Object Win+RECT
[Win]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L
$ht = $r.B - $r.T

function Click($x, $y) {
  [Win]::SetCursorPos([int]$x, [int]$y) | Out-Null
  Start-Sleep -Milliseconds 120
  [Win]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [Win]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 700
}

function Shot($name) {
  $bmp = New-Object System.Drawing.Bitmap($w, $ht)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $ht)))
  $p = Join-Path $outDir "$name.png"
  $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "saved $p"
}

# 侧栏导航项 y 坐标（brand 约 68px 高，nav 从 ~86 开始，每项 ~37px）
$nav = @{ home = 104; backup = 141; restore = 178; browse = 215; doctor = 252; settings = 289 }

if ($mode -eq "all") {
  foreach ($k in @('home','backup','restore','browse','doctor','settings')) {
    Click ($r.L + 100) ($r.T + $nav[$k])
    Shot $k
  }
} elseif ($mode -eq "backup-run") {
  Click ($r.L + 100) ($r.T + $nav['backup'])
  Start-Sleep -Milliseconds 400
  # 「开始备份」按钮
  Click ($r.L + 208 + 30 + 60) ($r.T + 262)
  Start-Sleep -Seconds 5
  Shot "backup-running"
} elseif ($mode -eq "doctor-run") {
  Click ($r.L + 100) ($r.T + $nav['doctor'])
  Start-Sleep -Milliseconds 400
  Click ($r.L + 208 + 30 + 60) ($r.T + 190)
  Start-Sleep -Seconds 4
  Shot "doctor-result"
} elseif ($mode -eq "one") {
  Click ($r.L + 100) ($r.T + $nav[$args[2]])
  Shot $args[2]
}
