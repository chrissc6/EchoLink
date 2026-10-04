param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Status', 'Start', 'Stop')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = [IO.Path]::GetFullPath((Join-Path $projectRoot 'server.mjs'))
$distIndex = Join-Path $projectRoot 'dist\index.html'
$pidFile = Join-Path $projectRoot '.echolink-server.pid'
$port = [int](Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'server.port')).Trim()
$url = "http://127.0.0.1:$port"

function Get-PortPids {
  try {
    return @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    throw "Could not inspect TCP port $port. $($_.Exception.Message)"
  }
}

function Get-ProcessInfo([int]$ProcessId) {
  # Windows PowerShell's WMI cmdlet is available on the supported Windows hosts
  # and avoids depending on the Get-CimInstance executable shim in PATH.
  return Get-WmiObject Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Test-EchoLinkServer([int]$ProcessId) {
  $process = Get-ProcessInfo $ProcessId
  if (-not $process -or $process.Name -ine 'node.exe' -or -not $process.CommandLine) { return $false }
  return $process.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Read-TrackedPid {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $value = (Get-Content -Raw -LiteralPath $pidFile).Trim()
  $tracked = 0
  if ([int]::TryParse($value, [ref]$tracked) -and $tracked -gt 0) { return $tracked }
  return $null
}

function Remove-TrackedPid {
  if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
}

function Show-Status {
  $listeners = @(Get-PortPids)
  $own = @($listeners | Where-Object { Test-EchoLinkServer ([int]$_) })
  $other = @($listeners | Where-Object { -not (Test-EchoLinkServer ([int]$_)) })
  if ($listeners.Count -eq 0) {
    Write-Output 'Server: STOPPED'
  } elseif ($other.Count -eq 0 -and $own.Count -gt 0) {
    Write-Output 'Server: RUNNING'
  } elseif ($own.Count -gt 0) {
    Write-Output "Server: RUNNING (port also has unrelated listener PID $($other -join ', '))"
  } else {
    $details = foreach ($id in $other) {
      $process = Get-ProcessInfo ([int]$id)
      if ($process) { "$($process.Name) PID $id" } else { "PID $id" }
    }
    Write-Output "Server: CONFLICT ($($details -join ', ') is using the port)"
  }
  Write-Output "URL:    $url"
  Write-Output "Port:   $port"
}

function Stop-VerifiedProcess([int]$ProcessId) {
  if (-not (Test-EchoLinkServer $ProcessId)) { return $false }
  # The PID is verified against this app's exact server.mjs path before taskkill.
  # /T also stops any child process tree owned by that server process.
  & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
  return $true
}

switch ($Action) {
  'Status' {
    Show-Status
    exit 0
  }
  'Start' {
    if (-not (Test-Path -LiteralPath $distIndex)) {
      Write-Output 'Start failed: dist\index.html is missing. Run setup.bat first.'
      exit 1
    }
    $listeners = @(Get-PortPids)
    if ($listeners.Count -gt 0) {
      $own = @($listeners | Where-Object { Test-EchoLinkServer ([int]$_) })
      if ($own.Count -eq $listeners.Count) {
        if ($own.Count -gt 0) { Set-Content -LiteralPath $pidFile -Value ([string]$own[0]) -NoNewline }
        Write-Output "Already running at $url."
        exit 0
      }
      Write-Output "Start blocked: port $port is occupied by another process. No process was stopped."
      exit 2
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { Write-Output 'Start failed: node.exe was not found on PATH.'; exit 1 }
    $process = Start-Process -FilePath $node.Source -ArgumentList @("`"$serverPath`"") -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath $pidFile -Value ([string]$process.Id) -NoNewline
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      Start-Sleep -Milliseconds 125
      $listeners = @(Get-PortPids)
      if ($listeners -contains $process.Id) {
        if (Test-EchoLinkServer $process.Id) { Write-Output "Started at $url (PID $($process.Id))."; exit 0 }
        Remove-TrackedPid
        Write-Output "Start failed: PID $($process.Id) is not identified as this app's server."
        exit 1
      }
      if ($listeners.Count -gt 0) {
        Write-Output "Start blocked: port $port was claimed by another process. No unrelated process was stopped."
        exit 2
      }
      if ($process.HasExited) { break }
    }
    if (Test-EchoLinkServer $process.Id) { Stop-VerifiedProcess $process.Id | Out-Null }
    Remove-TrackedPid
    Write-Output "Start failed: the server did not begin listening on port $port."
    exit 1
  }
  'Stop' {
    $targets = @{}
    foreach ($id in @(Get-PortPids)) {
      if (Test-EchoLinkServer ([int]$id)) { $targets[[int]$id] = $true }
    }
    $tracked = Read-TrackedPid
    if ($tracked -and (Test-EchoLinkServer $tracked)) { $targets[$tracked] = $true }
    if ($targets.Count -eq 0) {
      Remove-TrackedPid
      $listeners = @(Get-PortPids)
      if ($listeners.Count -gt 0) {
        Write-Output "Stop blocked: port $port is occupied by an unrelated process; it was left untouched."
        exit 2
      }
      Write-Output "Stopped. Port $port is free."
      exit 0
    }
    foreach ($id in $targets.Keys) { Stop-VerifiedProcess ([int]$id) | Out-Null }
    $released = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      Start-Sleep -Milliseconds 125
      if (@(Get-PortPids).Count -eq 0) { $released = $true; break }
    }
    Remove-TrackedPid
    if ($released) { Write-Output "Stopped. Port $port is free."; exit 0 }
    $remaining = @(Get-PortPids)
    $details = foreach ($id in $remaining) {
      $process = Get-ProcessInfo ([int]$id)
      if ($process) { "$($process.Name) PID $id" } else { "PID $id" }
    }
    Write-Output "Stop incomplete: port $port remains occupied by $($details -join ', '). No unrelated process was stopped."
    exit 2
  }
}
