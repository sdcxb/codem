// Generated from EAC computer-user (MIT). PowerShell backends for capture/input.
// Kept as template literals so Vite bundles them without extra asset handling.

export const CAPTURE_PS1 = String.raw`# computer-user / capture.ps1 — full-virtual-screen (multi-monitor) screenshot.
# DPI-aware so pixel coordinates match the physical screen (no drift on scaled displays).
# Input:  -Json <base64(UTF8 JSON)>  { "outPath": string, "region": [x0,y0,x1,y1]|null (0..1), "scale": 0.1..1 }
# Output: stdout { ok, path, width, height, virtual_offset:[vx,vy], scale } | { ok:false, error }
param([string]$Json = "")
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Fail($msg) { Write-Output (ConvertTo-Json -Compress @{ ok = $false; error = $msg }); exit 2 }

try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction Stop
} catch { Fail("cannot load System.Windows.Forms/System.Drawing: $($_.Exception.Message)") }

# DPI awareness (before reading screen bounds so coordinates match pixels).
try {
  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class CUdpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' -ErrorAction Stop
  [CUdpi]::SetProcessDPIAware() | Out-Null
} catch { /* non-fatal: falls back to virtualized coords */ }

if ([string]::IsNullOrWhiteSpace($Json)) { Fail("missing -Json parameter") }
$cfg = $null
try {
  $raw = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
  $cfg = $raw | ConvertFrom-Json
} catch { Fail("bad -Json: $($_.Exception.Message)") }

$outPath = [string]$cfg.outPath
if ([string]::IsNullOrWhiteSpace($outPath)) { Fail("outPath is required") }
try {
  $dir = [System.IO.Path]::GetDirectoryName($outPath)
  if (-not [string]::IsNullOrWhiteSpace($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
} catch { Fail("cannot create output dir: $($_.Exception.Message)") }

$scale = 1.0
if ($null -ne $cfg.scale) { $scale = [double]$cfg.scale; if ($scale -le 0 -or $scale -gt 1) { $scale = 1.0 } }

$vb = [System.Windows.Forms.SystemInformation]::VirtualScreen
$vx = [int]$vb.X; $vy = [int]$vb.Y
$vw = [int]$vb.Width; $vh = [int]$vb.Height

$bmp = $null
try {
  $bmp = New-Object System.Drawing.Bitmap($vw, $vh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($vx, $vy, 0, 0, (New-Object System.Drawing.Size($vw, $vh)))
  } finally { $g.Dispose() }
} catch { if ($bmp) { $bmp.Dispose() }; Fail("CopyFromScreen failed: $($_.Exception.Message)") }

# Optional fractional region crop [x0, y0, x1, y1] (0..1) -> pixel box.
$dst = $bmp; $ownedDst = $false
try {
  if ($null -ne $cfg.region -and $cfg.region.Count -eq 4) {
    $rx0 = [double]$cfg.region[0]; $ry0 = [double]$cfg.region[1]
    $rx1 = [double]$cfg.region[2]; $ry1 = [double]$cfg.region[3]
    $px0 = [int][Math]::Floor($rx0 * $vw); $py0 = [int][Math]::Floor($ry0 * $vh)
    $px1 = [int][Math]::Ceiling($rx1 * $vw); $py1 = [int][Math]::Ceiling($ry1 * $vh)
    if ($px1 -gt $px0 -and $py1 -gt $py0 -and $px0 -ge 0 -and $py0 -ge 0) {
      $pw = $px1 - $px0; $ph = $py1 - $py0
      $crop = New-Object System.Drawing.Bitmap($pw, $ph)
      $cg = [System.Drawing.Graphics]::FromImage($crop)
      try { $cg.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $pw, $ph)), (New-Object System.Drawing.Rectangle($px0, $py0, $pw, $ph)), [System.Drawing.GraphicsUnit]::Pixel) }
      finally { $cg.Dispose(); $bmp.Dispose() }
      $dst = $crop; $ownedDst = $true
      $vw = $pw; $vh = $ph
      $vx += $px0; $vy += $py0
    }
  }
  if ($scale -lt 1.0) {
    $sw = [int][Math]::Round($vw * $scale); $sh = [int][Math]::Round($vh * $scale)
    if ($sw -gt 0 -and $sh -gt 0 -and $sw -ne $vw) {
      $scaled = New-Object System.Drawing.Bitmap($sw, $sh)
      $sg = [System.Drawing.Graphics]::FromImage($scaled)
      try { $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $sg.DrawImage($dst, 0, 0, $sw, $sh) }
      finally { $sg.Dispose(); if ($ownedDst) { $dst.Dispose() } }
      $dst = $scaled; $ownedDst = $true
      $vw = $sw; $vh = $sh
    }
  }
  $ext = [System.IO.Path]::GetExtension($outPath).ToLowerInvariant()
  if ($ext -eq ".jpg" -or $ext -eq ".jpeg") {
    $dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  } else {
    $dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  }
} catch { Fail("image save failed: $($_.Exception.Message)") }
finally { if ($dst) { $dst.Dispose() } }

$result = @{ ok = $true; path = $outPath; width = $vw; height = $vh; virtual_offset = @($vx, $vy); scale = $scale }
Write-Output ([System.Text.Encoding]::UTF8.GetString([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress $result))))
exit 0
`;

export const INPUT_PS1 = String.raw`# computer-user / input.ps1 — mouse & keyboard automation via SendInput.
# DPI-aware (SetProcessDPIAware) so virtual-screen pixel coordinates map to physical pixels.
# Input:  -Json <base64(UTF8 JSON)>
#    { "action": "move|click|rightclick|double|drag|scroll|type|keypress|getpos",
#      "coordinate": [x,y], "from": [x,y], "to": [x,y],
#      "action2": "click|right_click|double_click",
#      "text": string, "sendEnter": bool,
#      "keys": [names], "holdKeys": [names],
#      "direction": "up|down|left|right", "clicks": int,
#      "typingIntervalMs": int }
# Output: stdout JSON { ok, cursor:[x,y], ... } | { ok:false, error }
param([string]$Json = "")
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Fail($msg) { Write-Output (ConvertTo-Json -Compress @{ ok = $false; error = $msg }); exit 2 }
function To-U32([int]$v) { if ($v -lt 0) { return [uint32]($v + 4294967296) }; return [uint32]$v }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CU {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static INPUT K(ushort vk, ushort scan, uint flags) { INPUT i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; i.U.ki.time = 0; i.U.ki.dwExtraInfo = IntPtr.Zero; return i; }
  public static INPUT M(uint mouseData, uint flags) { INPUT i = new INPUT(); i.type = 0; i.U.mi.dx = 0; i.U.mi.dy = 0; i.U.mi.mouseData = mouseData; i.U.mi.dwFlags = flags; i.U.mi.time = 0; i.U.mi.dwExtraInfo = IntPtr.Zero; return i; }
  public static void Send(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  public static void Wheel(uint signedDelta) { INPUT[] a = new INPUT[1]; a[0] = M(signedDelta, 0x0800); Send(a); }
  public static void KeyDown(ushort vk) { INPUT[] a = new INPUT[1]; a[0] = K(vk, 0, 0); Send(a); }
  public static void KeyUp(ushort vk)   { INPUT[] a = new INPUT[1]; a[0] = K(vk, 0, 0x0002); Send(a); }
  public static void CharDown(char c)   { INPUT[] a = new INPUT[1]; a[0] = K(0, (ushort)c, 0x0004); Send(a); }
  public static void CharUp(char c)     { INPUT[] a = new INPUT[1]; a[0] = K(0, (ushort)c, 0x0004 | 0x0002); Send(a); }
}
'@ -ErrorAction Stop

# DPI awareness so coordinates = physical pixels.
try { Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class CUdpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' -ErrorAction Stop; [CUdpi]::SetProcessDPIAware() | Out-Null } catch {}

if ([string]::IsNullOrWhiteSpace($Json)) { Fail("missing -Json parameter") }
$cfg = $null
try { $cfg = ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json)) | ConvertFrom-Json) } catch { Fail("bad -Json: $($_.Exception.Message)") }
$action = [string]$cfg.action
if ([string]::IsNullOrWhiteSpace($action)) { Fail("action is required") }

$VK = @{
  'ctrl'=0x11; 'control'=0x11; 'shift'=0x10; 'alt'=0x12; 'super'=0x5B; 'meta'=0x5B; 'win'=0x5B; 'cmd'=0x5B;
  'enter'=0x0D; 'return'=0x0D; 'tab'=0x09; 'esc'=0x1B; 'escape'=0x1B; 'space'=0x20; 'backspace'=0x08;
  'delete'=0x2E; 'del'=0x2E; 'insert'=0x2D; 'home'=0x24; 'end'=0x23; 'pageup'=0x21; 'pagedown'=0x22;
  'up'=0x26; 'down'=0x28; 'left'=0x25; 'right'=0x27; 'clear'=0x0C;
  'pause'=0x13; 'prtsc'=0x2C; 'printscreen'=0x2C; 'scrolllock'=0x91; 'numlock'=0x90; 'capslock'=0x14;
}
for ($i = 1; $i -le 24; $i++) { $VK["f$i"] = 0x6F + $i }   # F1=0x70
for ($i = 0; $i -lt 26; $i++) { $VK[[char](0x61 + $i)] = 0x41 + $i } # a-z -> A..Z VK
for ($i = 0; $i -lt 10; $i++) { $VK[[string]$i] = 0x30 + $i }        # 0-9

function Get-CursorJson { $p = New-Object CU+POINT; [CU]::GetCursorPos([ref]$p) | Out-Null; return @($p.X, $p.Y) }

function Resolve-Key($name) {
  $n = ([string]$name).Trim().ToLowerInvariant()
  if ($VK.ContainsKey($n)) { return @{ vk = [UInt16]$VK[$n] } }
  # single letters/digits map to VIRTUAL KEYS so they combine with modifiers
  # (ctrl+a must be VK_A, not an injected Unicode 'a' which never triggers shortcuts).
  if ($n.Length -eq 1) {
    $c = $n[0]
    if ($c -ge 'a' -and $c -le 'z') { return @{ vk = [UInt16](0x41 + ([int]$c - 97)) } }
    if ($c -ge '0' -and $c -le '9') { return @{ vk = [UInt16](0x30 + ([int]$c - 48)) } }
    return @{ ch = [char]$c }
  }
  return $null
}

switch ($action) {
  "getpos" {
    $c = Get-CursorJson
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; cursor = $c })
    exit 0
  }
  "move" {
    $x = [int]$cfg.coordinate[0]; $y = [int]$cfg.coordinate[1]
    [CU]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 30
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; cursor = @($x, $y) })
    exit 0
  }
  "click" {
    $x = [int]$cfg.coordinate[0]; $y = [int]$cfg.coordinate[1]
    $a = [string]$cfg.action2; if ([string]::IsNullOrWhiteSpace($a)) { $a = "click" }
    [CU]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 30
    if ($a -eq "right_click") {
      [CU]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
      [CU]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
    } elseif ($a -eq "double_click") {
      [CU]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
      [CU]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
      [CU]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
      [CU]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    } else {
      [CU]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
      [CU]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    }
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; cursor = @($x, $y); action = $a })
    exit 0
  }
  "drag" {
    $sx = [int]$cfg.from[0]; $sy = [int]$cfg.from[1]
    $tx = [int]$cfg.to[0];   $ty = [int]$cfg.to[1]
    [CU]::SetCursorPos($sx, $sy) | Out-Null; Start-Sleep -Milliseconds 30
    if ($null -ne $cfg.holdKeys -and $cfg.holdKeys.Count -gt 0) {
      foreach ($hk in $cfg.holdKeys) { $r = Resolve-Key $hk; if ($null -ne $r -and $r.ContainsKey("vk")) { [CU]::KeyDown($r.vk) } }
      Start-Sleep -Milliseconds 40
    }
    [CU]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
      $px = [int]($sx + ($tx - $sx) * $i / $steps); $py = [int]($sy + ($ty - $sy) * $i / $steps)
      [CU]::SetCursorPos($px, $py) | Out-Null
      Start-Sleep -Milliseconds 12
    }
    [CU]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    if ($null -ne $cfg.holdKeys -and $cfg.holdKeys.Count -gt 0) {
      Start-Sleep -Milliseconds 30
      $rev = @($cfg.holdKeys); [array]::Reverse($rev)
      foreach ($hk in $rev) { $r = Resolve-Key $hk; if ($null -ne $r -and $r.ContainsKey("vk")) { [CU]::KeyUp($r.vk) } }
    }
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; from = @($sx, $sy); to = @($tx, $ty); cursor = @($tx, $ty) })
    exit 0
  }
  "scroll" {
    $x = [int]$cfg.coordinate[0]; $y = [int]$cfg.coordinate[1]
    $dir = [string]$cfg.direction; if ([string]::IsNullOrWhiteSpace($dir)) { $dir = "down" }
    $clicks = [int]$cfg.clicks; if ($clicks -le 0) { $clicks = 1 }
    [CU]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 20
    $notches = 120 * $clicks
    $vy = if ($dir -eq "down") { -$notches } else { $notches }
    $hz = if ($dir -eq "right") { -$notches } else { $notches }
    if ($dir -eq "left" -or $dir -eq "right") { [CU]::Wheel((To-U32 $hz)) }   # SendInput HWHEEL
    if ($dir -eq "up" -or $dir -eq "down")   { [CU]::Wheel((To-U32 $vy)) }     # SendInput WHEEL
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; cursor = @($x, $y); direction = $dir; clicks = $clicks })
    exit 0
  }
  "type" {
    $text = [string]$cfg.text
    $interval = [int]$cfg.typingIntervalMs; if ($interval -lt 0) { $interval = 0 }
    $count = 0
    foreach ($ch in $text.ToCharArray()) {
      [CU]::CharDown($ch); Start-Sleep -Milliseconds 8; [CU]::CharUp($ch)
      $count++
      if ($interval -gt 0) { Start-Sleep -Milliseconds $interval }
    }
    if ($cfg.sendEnter) { [CU]::KeyDown(0x0D); Start-Sleep -Milliseconds 20; [CU]::KeyUp(0x0D) }
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; chars = $count; sendEnter = [bool]$cfg.sendEnter; cursor = (Get-CursorJson) })
    exit 0
  }
  "wait" {
    $ms = [int]$cfg.ms; if ($ms -lt 0) { $ms = 0 }
    Start-Sleep -Milliseconds $ms
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; waited = $ms })
    exit 0
  }
  "keypress" {
    $keys = @($cfg.keys)
    if ($keys.Count -eq 0) { Fail("keypress requires at least one key") }
    $down = @()
    foreach ($k in $keys) { $r = Resolve-Key $k; if ($null -eq $r) { Fail("unknown key: $k") }; $down += ,$r }
    # press modifiers/specials first (VK), then each remaining (char for punctuation)
    foreach ($r in $down) { if ($r.ContainsKey("vk")) { [CU]::KeyDown($r.vk) } else { [CU]::CharDown($r.ch) } }
    Start-Sleep -Milliseconds 50
    $up = @($down); [array]::Reverse($up)
    foreach ($r in $up) { if ($r.ContainsKey("vk")) { [CU]::KeyUp($r.vk) } else { [CU]::CharUp($r.ch) } }
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; keys = ($keys -join "+"); cursor = (Get-CursorJson) })
    exit 0
  }
  default { Fail("unknown action: $action") }
}
`;
