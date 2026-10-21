Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ForEach-Object {
  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  $t = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }
  $ext = if ($_.CommandLine -match 'extension-process') { 'EXT' } else { '' }
  [PSCustomObject]@{ type = $t; ext = $ext; mb = [math]::Round($p.WorkingSet64 / 1MB, 0); id = $_.ProcessId }
} | Sort-Object mb -Descending | Format-Table -AutoSize | Out-String -Width 120
