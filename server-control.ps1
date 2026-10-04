param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Status', 'Start', 'Stop', 'AllowNetwork')]
  [string]$Action,
  [ValidateSet('Local', 'Shared')]
  [string]$Mode = 'Local',
  [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$controlScriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$serverPath = [IO.Path]::GetFullPath((Join-Path $projectRoot 'server.mjs'))
$distIndex = Join-Path $projectRoot 'dist\index.html'
$pidFile = Join-Path $projectRoot '.echolink-server.pid'
$port = [int](Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'server.port')).Trim()
$url = "http://127.0.0.1:$port/"
$firewallRuleName = "EchoLink local network (TCP $port)"

function Get-PortConnections {
  try { return @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
  catch { throw "Could not inspect TCP port $port. $($_.Exception.Message)" }
}

function Get-ProcessInfo([int]$ProcessId) {
  return Get-WmiObject Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Test-EchoLinkServer([int]$ProcessId) {
  $process = Get-ProcessInfo $ProcessId
  if (-not $process -or $process.Name -ine 'node.exe' -or -not $process.CommandLine) { return $false }
  return $process.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-ServerMode([int]$ProcessId) {
  $addresses = @(Get-PortConnections | Where-Object { $_.OwningProcess -eq $ProcessId } | Select-Object -ExpandProperty LocalAddress -Unique)
  if ($addresses | Where-Object { $_ -notin @('127.0.0.1', '::1') }) { return 'Shared' }
  return 'Local'
}

function Get-EchoLinkProcesses {
  return @(Get-PortConnections | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { Test-EchoLinkServer ([int]$_) })
}

function Remove-TrackedPid {
  if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
}

function Get-NetworkAddresses {
  $configurations = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.NetAdapter.Status -eq 'Up' -and $null -ne $_.IPv4Address })
  $routed = @($configurations | Where-Object { $null -ne $_.IPv4DefaultGateway })
  if ($routed.Count -gt 0) { $configurations = $routed }
  return @($configurations |
    Sort-Object -Property @{ Expression = { $_.NetAdapter.InterfaceMetric } } |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { $_ -ne '127.0.0.1' -and $_ -notlike '169.254.*' } |
    Select-Object -Unique | ForEach-Object { "http://${_}:$port/" })
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-LocalFirewallRule {
  $rules = @(Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
    Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })
  foreach ($rule in $rules) {
    $ports = @($rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue)
    $addresses = @($rule | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue)
    if (($ports | Where-Object { $_.Protocol -in @('TCP', 6, 'Any') -and ($_.LocalPort -eq [string]$port -or $_.LocalPort -eq 'Any') }) -and
        ($addresses | Where-Object { 'LocalSubnet' -in $_.RemoteAddress -or 'Any' -in $_.RemoteAddress })) { return $true }
  }
  return $false
}

function Add-LocalFirewallRule {
  if (Test-LocalFirewallRule) { return }
  New-NetFirewallRule -DisplayName $firewallRuleName -Group 'EchoLink' -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $port -Profile Any -RemoteAddress LocalSubnet | Out-Null
  if (-not (Test-LocalFirewallRule)) { throw 'Windows Firewall did not confirm the EchoLink local-subnet rule.' }
}

function Ensure-LocalFirewallRule {
  if (Test-LocalFirewallRule) { Write-Output 'Windows Firewall already allows this port from the local subnet.'; return }
  if (Test-IsAdministrator) { Add-LocalFirewallRule; Write-Output 'Windows Firewall now allows this port from the local subnet.'; return }
  Write-Output 'Requesting administrator approval to allow EchoLink on this local subnet only...'
  try {
    $elevated = Start-Process -FilePath 'powershell.exe' `
      -ArgumentList "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$controlScriptPath`" -Action AllowNetwork" `
      -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  } catch {
    throw 'Windows Firewall approval was cancelled or could not be opened. Run EchoLink.cmd as administrator or approve the Windows prompt; shared mode was not started by this request.'
  }
  if ($elevated.ExitCode -ne 0 -or -not (Test-LocalFirewallRule)) {
    throw 'Firewall permission was not added. Shared mode was not started; choose Local mode or retry Shared and approve the Windows prompt.'
  }
  Write-Output 'Windows Firewall allows EchoLink from the local subnet.'
}

function Stop-EchoLink {
  $targets = @(Get-EchoLinkProcesses)
  foreach ($id in $targets) {
    if (Test-EchoLinkServer ([int]$id)) { & taskkill.exe /PID $id /T /F 2>$null | Out-Null }
  }
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (@(Get-EchoLinkProcesses).Count -eq 0) { break }
    Start-Sleep -Milliseconds 125
  }
  Remove-TrackedPid
  $remaining = @(Get-EchoLinkProcesses)
  if ($remaining.Count -gt 0) { throw "EchoLink did not release port $port." }
}

switch ($Action) {
  'AllowNetwork' {
    if (-not (Test-IsAdministrator)) { throw 'AllowNetwork must run as administrator.' }
    Add-LocalFirewallRule
    Write-Output "Firewall rule ready: $firewallRuleName (LocalSubnet only)."
    exit 0
  }
  'Status' {
    $listeners = @(Get-PortConnections)
    $own = @(Get-EchoLinkProcesses)
    $others = @($listeners | Where-Object { $own -notcontains $_.OwningProcess })
    if ($own.Count -eq 0) {
      if ($listeners.Count -eq 0) { Write-Output 'Server: STOPPED' }
      else { Write-Output "Server: CONFLICT (port held by PID(s) $(@($others.OwningProcess | Select-Object -Unique) -join ', '))" }
    } else {
      $activeMode = Get-ServerMode ([int]$own[0])
      Write-Output "Server: RUNNING ($($activeMode.ToUpperInvariant()))"
      Write-Output "Local:  $url"
      if ($activeMode -eq 'Shared') {
        $addresses = @(Get-NetworkAddresses)
        if ($addresses.Count) { Write-Output "LAN:    $($addresses -join '  |  ')" }
      }
    }
    Write-Output "Port:   $port"
    if ($others.Count) { Write-Output "Other listeners: $(@($others.OwningProcess | Select-Object -Unique) -join ', ')" }
    exit 0
  }
  'Start' {
    if (-not (Test-Path -LiteralPath $distIndex)) { Write-Output 'Start failed: dist\index.html is missing. Run setup.bat first.'; exit 1 }
    if ($Mode -eq 'Shared' -and -not $SkipFirewall) { Ensure-LocalFirewallRule }

    $existing = @(Get-EchoLinkProcesses)
    if ($existing.Count -gt 0) {
      $existingMode = Get-ServerMode ([int]$existing[0])
      if ($existingMode -eq $Mode) {
        $lan = if ($Mode -eq 'Shared') { (Get-NetworkAddresses) -join ' | ' } else { '' }
        Write-Output "Already running in $Mode mode. Local: $url$(if ($lan) { "; LAN: $lan" })"
        exit 0
      }
      Stop-EchoLink
    }

    $listeners = @(Get-PortConnections)
    if ($listeners.Count -gt 0) {
      Write-Output "Start blocked: port $port is occupied by another process. No unrelated process was stopped."
      exit 2
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { Write-Output 'Start failed: node.exe was not found on PATH.'; exit 1 }

    $previousHost = $env:ECHOLINK_HOST
    try {
      $env:ECHOLINK_HOST = if ($Mode -eq 'Shared') { '0.0.0.0' } else { '127.0.0.1' }
      $process = Start-Process -FilePath $node.Source -ArgumentList @("`"$serverPath`"") `
        -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    } finally {
      if ($null -eq $previousHost) { Remove-Item Env:ECHOLINK_HOST -ErrorAction SilentlyContinue }
      else { $env:ECHOLINK_HOST = $previousHost }
    }
    Set-Content -LiteralPath $pidFile -Value ([string]$process.Id) -NoNewline
    $ready = $false
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
      Start-Sleep -Milliseconds 150
      $connections = @(Get-PortConnections | Where-Object { $_.OwningProcess -eq $process.Id })
      if ($connections.Count -gt 0 -and (Test-EchoLinkServer $process.Id)) {
        $actualMode = Get-ServerMode $process.Id
        if ($actualMode -ne $Mode) { Stop-EchoLink; throw "Server opened in $actualMode mode; $Mode mode was requested." }
        $ready = $true; break
      }
      if ($process.HasExited) { break }
    }
    if (-not $ready) {
      if (Test-EchoLinkServer $process.Id) { & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null }
      Remove-TrackedPid
      Write-Output "Start failed: the server did not begin listening on port $port."
      exit 1
    }
    if ($Mode -eq 'Shared') {
      $addresses = @(Get-NetworkAddresses)
      if ($addresses.Count -eq 0) { Write-Output "Started shared (PID $($process.Id)); no LAN IPv4 address was detected. Local: $url" }
      else { Write-Output "Started shared (PID $($process.Id)). Local: $url. LAN: $($addresses -join ' | ')" }
    } else { Write-Output "Started local-only (PID $($process.Id)): $url" }
    exit 0
  }
  'Stop' {
    Stop-EchoLink
    $listeners = @(Get-PortConnections)
    if ($listeners.Count -gt 0) { Write-Output "Stop blocked: unrelated process(es) still use port $port; they were left untouched."; exit 2 }
    Write-Output "Stopped. Port $port is free."
    exit 0
  }
}
