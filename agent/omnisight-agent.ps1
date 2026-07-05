Set-StrictMode -Version 2.0
$ErrorActionPreference = "SilentlyContinue"

$Version = "1.2.4"
$Url = [string]$env:OMNISIGHT_URL
$Url = $Url.TrimEnd("/")
$Token = $env:OMNISIGHT_TOKEN
$Interval = 15
if ($env:OMNISIGHT_INTERVAL) { $Interval = [int]$env:OMNISIGHT_INTERVAL }
$Role = $env:OMNISIGHT_AGENT_ROLE
if (-not $Role) { $Role = "windows" }
if ($Interval -lt 5) { $Interval = 5 }
if ($Interval -gt 300) { $Interval = 300 }
$Insecure = "$env:OMNISIGHT_INSECURE_TLS" -match "^(1|true|yes)$"

if (-not $Url -or -not $Token) {
  Write-Error "OMNISIGHT_URL and OMNISIGHT_TOKEN are required"
  exit 1
}

if ($Insecure) {
  try {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
  } catch {}
}

function Get-AgentId {
  if ($env:OMNISIGHT_AGENT_ID) { return $env:OMNISIGHT_AGENT_ID }
  $dir = Join-Path $env:ProgramData "OmniSight"
  $file = Join-Path $dir "agent.id"
  if (Test-Path $file) {
    $existing = (Get-Content $file -Raw).Trim()
    if ($existing) { return $existing }
  }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $id = "$($env:COMPUTERNAME)-$([guid]::NewGuid().ToString("N").Substring(0,8))"
  Set-Content -Path $file -Value $id -Encoding ASCII
  return $id
}

$AgentId = Get-AgentId
$RestartAfterCommand = $false

function Invoke-OmniSight {
  param([string]$Method, [string]$Path, $Body = $null, [int]$TimeoutSec = 20)
  $headers = @{ "X-Agent-Token" = $Token }
  $uri = "$Url$Path"
  $args = @{
    Method = $Method
    Uri = $uri
    Headers = $headers
    TimeoutSec = $TimeoutSec
    UseBasicParsing = $true
  }
  if ($Body -ne $null) {
    $args.ContentType = "application/json"
    $args.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
  }
  if ($Insecure -and $PSVersionTable.PSVersion.Major -ge 7) { $args.SkipCertificateCheck = $true }
  Invoke-RestMethod @args
}

function NumberOrNull($value) {
  if ($null -eq $value) { return $null }
  $n = 0.0
  if ([double]::TryParse([string]$value, [ref]$n)) { return [math]::Round($n, 2) }
  return $null
}

function Get-CounterValue {
  param([string[]]$Counter)
  try {
    $sample = Get-Counter -Counter $Counter -SampleInterval 1 -MaxSamples 1
    return $sample.CounterSamples
  } catch {
    return @()
  }
}

function Get-DiskIo {
  $samples = Get-CounterValue @("\PhysicalDisk(_Total)\Disk Read Bytes/sec", "\PhysicalDisk(_Total)\Disk Write Bytes/sec")
  $read = ($samples | Where-Object { $_.Path -like "*Disk Read Bytes/sec" } | Select-Object -First 1).CookedValue
  $write = ($samples | Where-Object { $_.Path -like "*Disk Write Bytes/sec" } | Select-Object -First 1).CookedValue
  if ($null -eq $read -and $null -eq $write) { return $null }
  $readValue = 0
  $writeValue = 0
  if ($null -ne $read) { $readValue = [double]$read }
  if ($null -ne $write) { $writeValue = [double]$write }
  return @{
    readBps = [math]::Max(0, [math]::Round($readValue))
    writeBps = [math]::Max(0, [math]::Round($writeValue))
  }
}

function Get-Bandwidth {
  $samples = Get-CounterValue @("\Network Interface(*)\Bytes Received/sec", "\Network Interface(*)\Bytes Sent/sec")
  if (-not $samples.Count) { return $null }
  $rx = 0.0
  $tx = 0.0
  foreach ($s in $samples) {
    $path = [string]$s.Path
    if ($path -match "loopback|isatap|teredo|bluetooth|tunnel|pseudo") { continue }
    if ($path -like "*Bytes Received/sec") { $rx += [double]$s.CookedValue }
    if ($path -like "*Bytes Sent/sec") { $tx += [double]$s.CookedValue }
  }
  return @{
    rxBps = [math]::Max(0, [math]::Round($rx))
    txBps = [math]::Max(0, [math]::Round($tx))
  }
}

function Get-ServicesPayload {
  try {
    Get-Service |
      Where-Object { $_.Status -eq "Running" -or $_.StartType -eq "Automatic" } |
      Select-Object -First 500 |
      ForEach-Object {
        @{
          name = $_.Name
          active = $_.Status -eq "Running"
          state = [string]$_.Status
        }
      }
  } catch {
    @()
  }
}

function Get-Payload {
  $os = Get-CimInstance Win32_OperatingSystem
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Sort-Object DeviceID | Select-Object -First 1
  $ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254\.)" -and $_.PrefixOrigin -ne "WellKnown" } |
    Select-Object -First 1 -ExpandProperty IPAddress)
  $memTotal = if ($null -ne $os.TotalVisibleMemorySize) { [double]$os.TotalVisibleMemorySize } else { 0 }
  $memFree = if ($null -ne $os.FreePhysicalMemory) { [double]$os.FreePhysicalMemory } else { 0 }
  $diskTotal = if ($null -ne $disk.Size) { [double]$disk.Size } else { 0 }
  $diskFree = if ($null -ne $disk.FreeSpace) { [double]$disk.FreeSpace } else { 0 }
  $uptime = 0
  try { $uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds } catch {}
  $memPayload = $null
  if ($memTotal -gt 0) {
    $memPayload = @{ totalKB = [math]::Round($memTotal); usedKB = [math]::Round($memTotal - $memFree) }
  }
  $diskPayload = $null
  if ($diskTotal -gt 0) {
    $diskPayload = @{ totalKB = [math]::Round($diskTotal / 1024); usedKB = [math]::Round(($diskTotal - $diskFree) / 1024) }
  }
  return @{
    id = $AgentId
    hostname = $env:COMPUTERNAME
    ip = $ip
    os = $os.Caption
    kernel = $os.BuildNumber
    platform = "windows"
    role = $Role
    agentVersion = $Version
    interval = $Interval
    uptime = $uptime
    cpu = NumberOrNull $cpu.LoadPercentage
    cores = NumberOrNull $cpu.NumberOfLogicalProcessors
    mem = $memPayload
    disk = $diskPayload
    metrics = @{
      diskIO = Get-DiskIo
      bandwidth = Get-Bandwidth
    }
    services = @(Get-ServicesPayload)
  }
}

function Send-CommandResult {
  param([string]$Id, [string]$Output)
  if ($null -eq $Output) { $Output = "" }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Output)
  $body = @{ id = $Id; output = [Convert]::ToBase64String($bytes) }
  try { Invoke-OmniSight -Method "POST" -Path "/api/agent/result" -Body $body -TimeoutSec 20 | Out-Null } catch {}
}

function Invoke-AgentCommand {
  param([string]$Action, [string]$Target)
  try {
    if ($Action -eq "status") {
      $svc = Get-Service -Name $Target -ErrorAction Stop
      return "$($svc.Name) $($svc.Status)"
    }
    if ($Action -eq "start") {
      Start-Service -Name $Target -ErrorAction Stop
      return "started $Target"
    }
    if ($Action -eq "stop") {
      Stop-Service -Name $Target -Force -ErrorAction Stop
      return "stopped $Target"
    }
    if ($Action -eq "restart") {
      Restart-Service -Name $Target -Force -ErrorAction Stop
      return "restarted $Target"
    }
    if ($Action -eq "agent_update") {
      $targetPath = $PSCommandPath
      if (-not $targetPath) { $targetPath = Join-Path $env:ProgramData "OmniSight\omnisight-agent.ps1" }
      $tmp = Join-Path $env:TEMP "omnisight-agent-$([guid]::NewGuid().ToString("N")).ps1"
      $downloadArgs = @{
        Uri = "$Url/agent/omnisight-agent.ps1"
        OutFile = $tmp
        UseBasicParsing = $true
        TimeoutSec = 30
      }
      if ($Insecure -and $PSVersionTable.PSVersion.Major -ge 7) { $downloadArgs.SkipCertificateCheck = $true }
      Invoke-WebRequest @downloadArgs
      if (-not (Test-Path $tmp) -or ((Get-Content $tmp -TotalCount 1) -notmatch "Set-StrictMode")) {
        throw "downloaded payload is not the OmniSight Windows agent"
      }
      Copy-Item -LiteralPath $tmp -Destination $targetPath -Force
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      $script:RestartAfterCommand = $true
      return "Windows agent updated; restart scheduled"
    }
    return "unsupported action $Action"
  } catch {
    return "error: $($_.Exception.Message)"
  }
}

function Handle-CommandText {
  param([string]$Text)
  if ($null -eq $Text) { $Text = "" }
  foreach ($line in ($Text -split "`n")) {
    $parts = $line.Trim() -split "`t"
    if ($parts.Count -lt 4 -or $parts[0] -ne "CMD") { continue }
    $cmdId = $parts[1]
    $action = $parts[2]
    $target = $parts[3]
    $out = Invoke-AgentCommand -Action $action -Target $target
    Send-CommandResult -Id $cmdId -Output $out
  }
  if ($script:RestartAfterCommand) {
    Start-Sleep -Seconds 1
    exit 1
  }
}

while ($true) {
  try {
    $payload = Get-Payload
    $response = Invoke-OmniSight -Method "POST" -Path "/api/agent/report" -Body $payload -TimeoutSec 30
    Handle-CommandText -Text ([string]$response)
  } catch {
    Write-Host "report failed: $($_.Exception.Message)"
  }
  try {
    $cmdText = Invoke-OmniSight -Method "GET" -Path "/api/agent/commands?id=$([uri]::EscapeDataString($AgentId))&wait=$Interval" -TimeoutSec ($Interval + 10)
    Handle-CommandText -Text ([string]$cmdText)
  } catch {}
  Start-Sleep -Seconds $Interval
}
