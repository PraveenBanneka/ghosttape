# Phase 1 acceptance: reset the ESP32, confirm it verified its radio (true-random condition), then check
# 1,000 consecutive packets with no gaps. Uses Windows' built-in .NET SerialPort (no installs).
# Usage: powershell -File tools/phase1-check.ps1 [-Port COM5] [-Target 1000] [-NoReset]
# Close Arduino's Serial Monitor first (only one program can hold the port).
param([string]$Port = 'COM5', [int]$Target = 1000, [int]$TimeoutSec = 300, [switch]$NoReset)
$out = Join-Path $env:TEMP "ghosttape-phase1-packets.txt"
# Signed packets (GT1S): verify every HMAC with the key from the git-ignored secrets.h (never printed).
$secretsPath = Join-Path $PSScriptRoot '..\firmware\ghosttape_esp32\secrets.h'
$hmac = $null
if (Test-Path $secretsPath) {
  $m = Select-String -Path $secretsPath -Pattern '#define DEVICE_SECRET "([^"]+)"'
  if ($m) { $hmac = New-Object System.Security.Cryptography.HMACSHA256 (,[Text.Encoding]::UTF8.GetBytes($m.Matches[0].Groups[1].Value)) }
}
$signed = 0; $badSig = 0
$sp = New-Object System.IO.Ports.SerialPort $Port, 115200, 'None', 8, 'One'
$sp.ReadTimeout = 2000; $sp.NewLine = "`n"; $sp.DtrEnable = $false; $sp.RtsEnable = $false
$sp.Open()
if (-not $NoReset) {   # RTS drives EN on DevKit auto-reset circuits: pulse it to reboot and catch the boot lines
  $sp.RtsEnable = $true; Start-Sleep -Milliseconds 120; $sp.RtsEnable = $false; $sp.DiscardInBuffer()
}
$lines = New-Object System.Collections.Generic.List[string]
$valid = 0; $malformed = 0; $gaps = 0; $restarts = 0; $hello = 0; $info = 0; $err = 0; $lastSeq = $null
$lastInfo = ''; $lastErr = ''
$ones = [int64]0; $bits = [int64]0
$sw = [Diagnostics.Stopwatch]::StartNew(); $firstAt = $null
try {
  while ($valid -lt $Target -and $sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    try { $l = $sp.ReadLine().Trim() } catch [TimeoutException] { continue }
    $lines.Add($l)
    if ($l -eq 'GT1,HELLO') { $hello++; continue }
    if ($l -like 'GT1,INFO,*') { $info++; $lastInfo = $l; continue }
    if ($l -like 'GT1,ERR,*') { $err++; $lastErr = $l; continue }
    if ($l -notmatch '^GT1S?,(\d+),([0-9a-fA-F]{8}),([0-9a-fA-F]{8}),([0-9a-fA-F]{8})(?:,([0-9a-fA-F]{8}))?$') { $malformed++; continue }
    if ($Matches[5]) {
      $signed++
      if ($hmac) {
        $msg = "$($Matches[1]),$($Matches[2]),$($Matches[3]),$($Matches[4])"
        $mac = -join ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($msg))[0..3] | ForEach-Object { $_.ToString('x2') })
        if ($mac -ne $Matches[5].ToLower()) { $badSig++ }
      }
    }
    $seq = [int64]$Matches[1]
    if ($null -ne $lastSeq) {
      if ($seq -lt $lastSeq) { $restarts++ } elseif ($seq -gt $lastSeq + 1) { $gaps += $seq - $lastSeq - 1 }
    }
    $lastSeq = $seq; $valid++
    if ($null -eq $firstAt) { $firstAt = $sw.Elapsed.TotalSeconds }
    foreach ($h in $Matches[2], $Matches[3], $Matches[4]) {
      $v = [Convert]::ToUInt32($h, 16)
      for ($i = 0; $i -lt 32; $i++) { if (($v -shr $i) -band 1) { $ones++ } }
      $bits += 32
    }
  }
} finally { $sp.Close() }
$lines | Set-Content -Encoding ascii $out
$rate = if ($valid -gt 1) { ($valid - 1) / ($sw.Elapsed.TotalSeconds - $firstAt) } else { 0 }
$z = if ($bits) { ($ones - $bits / 2) / [math]::Sqrt($bits * 0.25) } else { 0 }
"radio         : $info INFO line(s), $err ERR line(s)"
if ($lastInfo) { "  last INFO   : $lastInfo" }
if ($lastErr)  { "  last ERR    : $lastErr" }
"valid packets : $valid / $Target"
"gaps          : $gaps"
"restarts      : $restarts"
"malformed     : $malformed (a partial line right after reset is normal)"
"HELLO lines   : $hello"
"signed        : $signed of $valid ($(if ($hmac) { "$badSig bad signatures" } else { "no secrets.h: not checked" }))"
"rate          : {0:N2} packets/s (expected ~6 at 160 ms)" -f $rate
"bit balance   : {0:N0} ones of {1:N0} bits = {2:N4} (z = {3:N2}; |z| < 3 is normal)" -f $ones, $bits, ($ones / [math]::Max(1,$bits)), $z
"first lines   :"; $lines | Select-Object -First 4
"saved to      : $out"
$radioOk = $info -ge 1 -and $err -eq 0
if ($radioOk -and $valid -ge $Target -and $gaps -eq 0 -and $restarts -eq 0 -and $badSig -eq 0) { 'RESULT: PASS' } else { 'RESULT: FAIL' }
