# Phase 1 acceptance: read GT1 packets from the ESP32 and check 1,000 consecutive packets with no gaps.
param([string]$Port = 'COM5', [int]$Target = 1000, [int]$TimeoutSec = 300)
$out = Join-Path $env:TEMP "ghosttape-phase1-packets.txt"
$sp = New-Object System.IO.Ports.SerialPort $Port, 115200, 'None', 8, 'One'
$sp.ReadTimeout = 2000; $sp.NewLine = "`n"
$sp.Open()
$lines = New-Object System.Collections.Generic.List[string]
$valid = 0; $malformed = 0; $gaps = 0; $restarts = 0; $hello = 0; $lastSeq = $null
$ones = [int64]0; $bits = [int64]0
$sw = [Diagnostics.Stopwatch]::StartNew(); $firstAt = $null
try {
  while ($valid -lt $Target -and $sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    try { $l = $sp.ReadLine().Trim() } catch [TimeoutException] { continue }
    $lines.Add($l)
    if ($l -eq 'GT1,HELLO') { $hello++; continue }
    if ($l -notmatch '^GT1,(\d+),([0-9a-fA-F]{8}),([0-9a-fA-F]{8}),([0-9a-fA-F]{8})$') { $malformed++; continue }
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
"valid packets : $valid / $Target"
"gaps          : $gaps"
"restarts      : $restarts"
"malformed     : $malformed (partial first line after port open is normal)"
"HELLO lines   : $hello"
"rate          : {0:N2} packets/s (expected ~6.1 at 160 ms)" -f $rate
"bit balance   : {0:N4} ones fraction over {1:N0} bits (ideal 0.5)" -f ($ones / [math]::Max(1,$bits)), $bits
"first lines   :"; $lines | Select-Object -First 4
"saved to      : $out"
if ($valid -ge $Target -and $gaps -eq 0 -and $restarts -eq 0) { 'RESULT: PASS' } else { 'RESULT: FAIL' }
