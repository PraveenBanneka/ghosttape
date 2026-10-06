# GhostTape USB -> Cloudflare bridge. Forwards the ESP32's signed lines (GT1S, HELLO, INFO, ERR) to the online relay
# the moment each arrives, so anyone with the link can watch the real hardware randomness ("Watch online" / TRNG on).
# No buffering: every line is sent as soon as it is read (the no-entropy-stock rule applies to the bridge too).
# The bridge never sees the key: the ESP32 signs each packet itself, the relay verifies it.
#
# Usage:  powershell -File tools/bridge.ps1            (Ctrl+C to stop)
#         powershell -File tools/bridge.ps1 -Port COM5 -Url wss://ghosttape.teamkestrel.workers.dev/api/ingest
# Close any serial monitor / browser tab using the board first (only one program can hold the port).
# The relay enforces the owner's daily caps (limits.jsonc) and tells the bridge to pause at a cap.
param(
  [string]$Port = 'COM5',
  [string]$Url = 'wss://ghosttape.teamkestrel.workers.dev/api/ingest',
  [switch]$NoReset
)
$ErrorActionPreference = 'Stop'
$none = [Threading.CancellationToken]::None

$ws = New-Object System.Net.WebSockets.ClientWebSocket
try { $ws.ConnectAsync([Uri]$Url, $none).Wait() } catch { "could not connect to $Url : $($_.Exception.InnerException.Message)"; exit 1 }
"connected to $Url"

$sp = New-Object System.IO.Ports.SerialPort $Port, 115200, 'None', 8, 'One'
$sp.ReadTimeout = 1000; $sp.NewLine = "`n"; $sp.DtrEnable = $false; $sp.RtsEnable = $false
$sp.Open()
if (-not $NoReset) {   # reboot the board so the relay sees GT1,HELLO before its counter restarts at 0
  $sp.RtsEnable = $true; Start-Sleep -Milliseconds 120; $sp.RtsEnable = $false
}
"reading $Port (board rebooting, radio check takes ~3 s)"

$buf = New-Object byte[] 2048
$seg = New-Object System.ArraySegment[byte] -ArgumentList (, $buf)
$recv = $ws.ReceiveAsync($seg, $none)
$sent = 0; $packets = 0; $rejects = 0
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
  while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
    if ($recv.IsCompleted) {                       # messages from the relay
      $r = $recv.Result
      if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { "relay closed the bridge: $($ws.CloseStatusDescription)"; break }
      $msg = [Text.Encoding]::UTF8.GetString($buf, 0, $r.Count)
      if ($msg -like 'GT1,CMD,pause,*') { "relay asked the bridge to pause ($($msg.Split(',')[3])). Stopping."; break }
      if ($msg -like 'GT1,REJECT,*') { $rejects++; "relay rejected a line: $msg" }
      $recv = $ws.ReceiveAsync($seg, $none)
    }
    try { $line = $sp.ReadLine().Trim() } catch [TimeoutException] { continue }
    if (-not $line.StartsWith('GT1')) { continue }   # boot noise from the chip
    $bytes = [Text.Encoding]::UTF8.GetBytes($line)
    $ws.SendAsync((New-Object System.ArraySegment[byte] -ArgumentList (, $bytes)), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $none).Wait()
    $sent++
    if ($line.StartsWith('GT1S,')) { $packets++ }
    elseif ($line.StartsWith('GT1,')) { "board: $line" }      # HELLO / INFO / ERR
    if ($clock.Elapsed.TotalSeconds -ge 15) { "live: $packets signed packets forwarded, $rejects rejected"; $clock.Restart() }
  }
} finally {
  $sp.Close()
  if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
    try { $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bridge stopped', $none).Wait(2000) | Out-Null } catch {}
  }
  "bridge stopped: $packets packets forwarded, $rejects rejected"
}
