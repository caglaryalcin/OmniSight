Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Uninstall-OmniSightAgent {
  $taskName = "OmniSightAgent"
  $dir = Join-Path $env:ProgramData "OmniSight"
  try {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
  } catch {}
  try {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
      Where-Object { $_.CommandLine -like "*OmniSight*omnisight-agent.ps1*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
  Remove-Item -LiteralPath (Join-Path $dir "omnisight-agent.ps1") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $dir "run-agent.ps1") -Force -ErrorAction SilentlyContinue
  Write-Host "OmniSight Windows agent removed"
}

if ($args.Count -gt 0 -and $args[0] -eq "uninstall") {
  if (-not (Test-Admin)) { throw "Run PowerShell as Administrator" }
  Uninstall-OmniSightAgent
  return
}

if (-not (Test-Admin)) { throw "Run PowerShell as Administrator" }

$Url = [string]$env:OMNISIGHT_URL
$Url = $Url.TrimEnd("/")
$Token = $env:OMNISIGHT_TOKEN
$Interval = if ($env:OMNISIGHT_INTERVAL) { [int]$env:OMNISIGHT_INTERVAL } else { 15 }
$Role = if ($env:OMNISIGHT_AGENT_ROLE) { $env:OMNISIGHT_AGENT_ROLE } else { "windows" }
$Insecure = "$env:OMNISIGHT_INSECURE_TLS" -match "^(1|true|yes)$"

if (-not $Url) { throw "OMNISIGHT_URL is required" }
if (-not $Token) { throw "OMNISIGHT_TOKEN is required" }
if ($Token -in @("__set__", "__encrypted__", "<token>")) { throw "OMNISIGHT_TOKEN must be the real agent token, not a masked placeholder" }
if ($Interval -lt 5) { $Interval = 5 }
if ($Interval -gt 300) { $Interval = 300 }

if ($Insecure) {
  try {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
  } catch {}
}

$pingArgs = @{
  Method = "POST"
  Uri = "$Url/api/agent/ping"
  Headers = @{ "X-Agent-Token" = $Token }
  ContentType = "application/json"
  Body = '{"id":"windows-install-check"}'
  TimeoutSec = 15
  UseBasicParsing = $true
  ErrorAction = "Stop"
}
if ($Insecure -and $PSVersionTable.PSVersion.Major -ge 7) { $pingArgs.SkipCertificateCheck = $true }
try {
  Invoke-RestMethod @pingArgs | Out-Null
} catch {
  throw "OmniSight agent token check failed: $($_.Exception.Message)"
}

$dir = Join-Path $env:ProgramData "OmniSight"
$agentPath = Join-Path $dir "omnisight-agent.ps1"
$runnerPath = Join-Path $dir "run-agent.ps1"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$downloadArgs = @{
  Uri = "$Url/agent/omnisight-agent.ps1"
  OutFile = $agentPath
  UseBasicParsing = $true
}
if ($Insecure -and $PSVersionTable.PSVersion.Major -ge 7) { $downloadArgs.SkipCertificateCheck = $true }
Invoke-WebRequest @downloadArgs

if (-not (Test-Path $agentPath) -or ((Get-Content $agentPath -TotalCount 1) -notmatch "Set-StrictMode")) {
  throw "Downloaded payload is not the OmniSight Windows agent"
}

$agentId = $env:OMNISIGHT_AGENT_ID
$idPath = Join-Path $dir "agent.id"
if (-not $agentId -and (Test-Path $idPath)) {
  $agentId = (Get-Content $idPath -Raw).Trim()
}
if (-not $agentId) {
  $agentId = "$($env:COMPUTERNAME)-$([guid]::NewGuid().ToString("N").Substring(0,8))"
  Set-Content -Path $idPath -Value $agentId -Encoding ASCII
}

$runner = @"
`$env:OMNISIGHT_URL = "$Url"
`$env:OMNISIGHT_TOKEN = "$Token"
`$env:OMNISIGHT_INTERVAL = "$Interval"
`$env:OMNISIGHT_AGENT_ROLE = "$Role"
`$env:OMNISIGHT_AGENT_ID = "$agentId"
`$env:OMNISIGHT_INSECURE_TLS = "$(if ($Insecure) { "1" } else { "" })"
& "$agentPath"
"@
Set-Content -Path $runnerPath -Value $runner -Encoding UTF8

$taskName = "OmniSightAgent"
try {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
} catch {}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "OmniSight Windows monitoring agent" | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "OmniSight Windows agent installed and started (id: $agentId, interval: ${Interval}s)"
Write-Host "Task: $taskName"
