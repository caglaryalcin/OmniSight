Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$script:ServiceName = "OmniSightAgent"
$script:TaskName = "OmniSightAgent"
$script:DataDir = Join-Path $env:ProgramData "OmniSight"
$script:ConfigPath = Join-Path $script:DataDir "agent.json"
$script:InstallDir = Join-Path $env:ProgramFiles "OmniSight Agent"
$script:ExecutablePath = Join-Path $script:InstallDir "OmniSight.Agent.exe"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Remove-LegacyAgentTask {
  try {
    if (Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
  } catch {
    try { & "$env:SystemRoot\System32\schtasks.exe" /End /TN $script:TaskName 2>&1 | Out-Null } catch {}
    try { & "$env:SystemRoot\System32\schtasks.exe" /Delete /TN $script:TaskName /F 2>&1 | Out-Null } catch {}
  }
}

function Remove-DirectoryWithRetry([string]$Path) {
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if (Test-Path -LiteralPath $Path) { throw "Could not remove $Path" }
}

function Test-DirectoryEntry([string]$Path) {
  if (Test-Path -LiteralPath $Path -ErrorAction SilentlyContinue) { return $true }
  $parent = Split-Path -Parent $Path
  $leaf = Split-Path -Leaf $Path
  return $null -ne (Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $leaf } | Select-Object -First 1)
}

function Invoke-Icacls([string[]]$Arguments, [string]$FailureMessage) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & "$env:SystemRoot\System32\icacls.exe" @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) { throw "$FailureMessage (exit $exitCode): $($output -join ' ')" }
}

function Repair-AgentDataAccess {
  if (-not (Test-DirectoryEntry $script:DataDir)) { return }
  $adminGrant = "*S-1-5-32-544:(OI)(CI)F"
  $systemGrant = "*S-1-5-18:(OI)(CI)F"
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $takeownOutput = & "$env:SystemRoot\System32\takeown.exe" /F $script:DataDir /A /R /D Y 2>&1
    $takeownExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($takeownExitCode -ne 0) { throw "Could not recover OmniSight data ownership (exit $takeownExitCode): $($takeownOutput -join ' ')" }
  Invoke-Icacls @($script:DataDir, "/grant:r", $adminGrant, "/T") "Could not restore Administrators access to the OmniSight data directory"
  Invoke-Icacls @($script:DataDir, "/grant:r", $systemGrant, "/T") "Could not restore SYSTEM access to the OmniSight data directory"
}

function Protect-AgentDataAcl {
  $adminGrant = "*S-1-5-32-544:(OI)(CI)F"
  $systemGrant = "*S-1-5-18:(OI)(CI)F"
  Invoke-Icacls @($script:DataDir, "/inheritance:r") "Could not disable inherited access on the OmniSight data directory"
  Invoke-Icacls @($script:DataDir, "/grant:r", $systemGrant) "Could not grant SYSTEM access to the OmniSight data directory"
  Invoke-Icacls @($script:DataDir, "/grant:r", $adminGrant) "Could not grant Administrators access to the OmniSight data directory"
  $children = Get-ChildItem -LiteralPath $script:DataDir -Force -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Invoke-Icacls @($child.FullName, "/reset", "/T") "Could not reset $($child.FullName) to the protected OmniSight data ACL"
  }
}

function Start-OmniSightService {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $startOutput = & "$env:SystemRoot\System32\sc.exe" start $script:ServiceName 2>&1
    $startExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($startExitCode -ne 0) {
    throw "Could not start $($script:ServiceName) (sc.exe exit $startExitCode): $($startOutput -join ' ')"
  }
  $service = Get-Service -Name $script:ServiceName
  $service.WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
}

function Uninstall-OmniSightAgent {
  if (-not (Test-Admin)) { throw "Run PowerShell as Administrator" }
  try {
    $service = Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue
    if ($service) {
      if ($service.Status -ne "Stopped") {
        Stop-Service -Name $script:ServiceName -Force -ErrorAction SilentlyContinue
        $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
      }
      & "$env:SystemRoot\System32\sc.exe" delete $script:ServiceName 2>&1 | Out-Null
    }
  } catch {}
  Remove-LegacyAgentTask
  try {
    $selfPid = $PID
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
      Where-Object { $_.ProcessId -ne $selfPid -and $_.CommandLine -like "*OmniSight*omnisight-agent.ps1*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
  Remove-DirectoryWithRetry $script:InstallDir
  Remove-DirectoryWithRetry $script:DataDir
  Write-Host "OmniSight Windows service agent removed"
}

function Read-ExistingConfig {
  if (-not (Test-Path -LiteralPath $script:ConfigPath)) { return $null }
  try { return Get-Content -LiteralPath $script:ConfigPath -Raw | ConvertFrom-Json }
  catch { return $null }
}

function Get-ExistingConfigValue($Config, [string]$Name) {
  if (-not $Config) { return $null }
  $property = $Config.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}

function Get-CscPath {
  $candidates = @(
    (Join-Path $env:SystemRoot "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:SystemRoot "Microsoft.NET\Framework\v4.0.30319\csc.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw ".NET Framework C# compiler is unavailable"
}

function Compile-OmniSightService([string]$SourcePath, [string]$OutputPath) {
  $csc = Get-CscPath
  $frameworkDir = Split-Path -Parent $csc
  $references = @(
    "System.dll",
    "System.Core.dll",
    "System.Management.dll",
    "System.ServiceProcess.dll",
    "System.Web.Extensions.dll",
    "Microsoft.CSharp.dll"
  ) | ForEach-Object { Join-Path $frameworkDir $_ }
  foreach ($reference in $references) {
    if (-not (Test-Path -LiteralPath $reference)) { throw "Required .NET Framework assembly is missing: $reference" }
  }
  $compilerArgs = @(
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/platform:anycpu",
    "/out:$OutputPath"
  ) + ($references | ForEach-Object { "/reference:$_" }) + @($SourcePath)
  $compilerOutput = & $csc @compilerArgs 2>&1
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputPath)) {
    throw "Windows service compilation failed: $($compilerOutput -join ' ')"
  }
  $assembly = [Reflection.AssemblyName]::GetAssemblyName($OutputPath)
  if (-not $assembly.Version -or $assembly.Version.Major -lt 1) { throw "Compiled Windows service version is invalid" }
  return $assembly.Version.ToString()
}

function Write-AgentConfig([string]$Url, [string]$Token, [int]$Interval, [string]$Role, [string]$AgentId, [bool]$Insecure) {
  New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null
  $config = [ordered]@{
    url = $Url
    token = $Token
    interval = $Interval
    role = $Role
    agentId = $AgentId
    insecureTls = $Insecure
  }
  $tempConfig = Join-Path $script:DataDir "agent.json.tmp"
  [IO.File]::WriteAllText($tempConfig, ($config | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tempConfig -Destination $script:ConfigPath -Force
  $agentIdPath = Join-Path $script:DataDir "agent.id"
  $tempAgentIdPath = Join-Path $script:DataDir "agent.id.tmp"
  [IO.File]::WriteAllText($tempAgentIdPath, $AgentId, [Text.Encoding]::ASCII)
  Move-Item -LiteralPath $tempAgentIdPath -Destination $agentIdPath -Force
}

function Test-AgentApi([string]$Url, [string]$Token, [bool]$Insecure) {
  $pingArgs = @{
    Method = "POST"
    Uri = "$Url/api/agent/ping"
    Headers = @{ "X-Agent-Token" = $Token }
    ContentType = "application/json"
    Body = '{"id":"windows-service-install-check"}'
    TimeoutSec = 15
    UseBasicParsing = $true
    ErrorAction = "Stop"
  }
  if ($Insecure -and $PSVersionTable.PSVersion.Major -ge 7) { $pingArgs.SkipCertificateCheck = $true }
  try { Invoke-RestMethod @pingArgs | Out-Null }
  catch { throw "OmniSight agent token check failed: $($_.Exception.Message)" }
}

function Install-OmniSightService {
  if (-not (Test-Admin)) { throw "Run PowerShell as Administrator" }
  Repair-AgentDataAccess
  $existing = Read-ExistingConfig
  $url = [string]$env:OMNISIGHT_URL
  if (-not $url) { $url = [string](Get-ExistingConfigValue $existing "url") }
  $url = $url.TrimEnd("/")
  $token = [string]$env:OMNISIGHT_TOKEN
  if (-not $token) { $token = [string](Get-ExistingConfigValue $existing "token") }
  $existingInterval = Get-ExistingConfigValue $existing "interval"
  $existingRole = Get-ExistingConfigValue $existing "role"
  $existingInsecure = Get-ExistingConfigValue $existing "insecureTls"
  $interval = if ($env:OMNISIGHT_INTERVAL) { [int]$env:OMNISIGHT_INTERVAL } elseif ($null -ne $existingInterval) { [int]$existingInterval } else { 15 }
  $role = if ($env:OMNISIGHT_AGENT_ROLE) { [string]$env:OMNISIGHT_AGENT_ROLE } elseif ($existingRole) { [string]$existingRole } else { "windows" }
  $insecureValue = [string]$env:OMNISIGHT_INSECURE_TLS
  $insecure = if ($insecureValue) { $insecureValue -match "^(1|true|yes)$" } elseif ($null -ne $existingInsecure) { [bool]$existingInsecure } else { $false }
  if (-not $url) { throw "OMNISIGHT_URL is required" }
  if (-not $token) { throw "OMNISIGHT_TOKEN is required" }
  if ($token -in @("__set__", "__encrypted__", "<token>")) { throw "OMNISIGHT_TOKEN must be the real agent token, not a masked placeholder" }
  if ($interval -lt 5) { $interval = 5 }
  if ($interval -gt 300) { $interval = 300 }

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {}
  if ($insecure) {
    try { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } } catch {}
  }
  Test-AgentApi $url $token $insecure

  $agentId = [string]$env:OMNISIGHT_AGENT_ID
  if (-not $agentId) { $agentId = [string](Get-ExistingConfigValue $existing "agentId") }
  $idPath = Join-Path $script:DataDir "agent.id"
  if (-not $agentId -and (Test-Path -LiteralPath $idPath)) { $agentId = (Get-Content -LiteralPath $idPath -Raw).Trim() }
  if (-not $agentId) { $agentId = "$($env:COMPUTERNAME)-$([guid]::NewGuid().ToString('N').Substring(0,8))" }

  $sourcePath = Join-Path $env:TEMP "OmniSight.Agent-$([guid]::NewGuid().ToString('N')).cs"
  $stagingPath = Join-Path $env:TEMP "OmniSight.Agent-$([guid]::NewGuid().ToString('N')).exe"
  $downloadArgs = @{
    Uri = "$url/agent/OmniSight.Agent.cs"
    OutFile = $sourcePath
    UseBasicParsing = $true
    TimeoutSec = 45
  }
  if ($insecure -and $PSVersionTable.PSVersion.Major -ge 7) { $downloadArgs.SkipCertificateCheck = $true }
  try {
    Invoke-WebRequest @downloadArgs
    if (-not (Test-Path -LiteralPath $sourcePath) -or ((Get-Content -LiteralPath $sourcePath -Raw) -notmatch "namespace OmniSight\.Agent")) {
      throw "Downloaded payload is not the OmniSight Windows service agent"
    }
    $version = Compile-OmniSightService $sourcePath $stagingPath
  } catch {
    Remove-Item -LiteralPath $sourcePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stagingPath -Force -ErrorAction SilentlyContinue
    throw
  }
  $serviceExisted = $null -ne (Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue)
  $executableBackup = Join-Path $env:TEMP "OmniSight.Agent-backup-$([guid]::NewGuid().ToString('N')).exe"
  $configBackup = Join-Path $env:TEMP "OmniSight.Agent-config-$([guid]::NewGuid().ToString('N')).json"
  $hadExecutable = Test-Path -LiteralPath $script:ExecutablePath
  $hadConfig = Test-Path -LiteralPath $script:ConfigPath
  $startupDiagnosticPath = Join-Path $env:SystemRoot "Temp\OmniSightAgent-startup.log"
  if ($hadExecutable) { Copy-Item -LiteralPath $script:ExecutablePath -Destination $executableBackup -Force }
  if ($hadConfig) { Copy-Item -LiteralPath $script:ConfigPath -Destination $configBackup -Force }

  try {
    if ($serviceExisted) {
      $service = Get-Service -Name $script:ServiceName
      if ($service.Status -ne "Stopped") {
        Stop-Service -Name $script:ServiceName -Force
        $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
      }
    }
    New-Item -ItemType Directory -Force -Path $script:InstallDir | Out-Null
    Copy-Item -LiteralPath $stagingPath -Destination $script:ExecutablePath -Force
    Write-AgentConfig $url $token $interval $role $agentId $insecure
    Protect-AgentDataAcl
    $binaryPath = "`"$script:ExecutablePath`""
    if (-not $serviceExisted) {
      New-Service -Name $script:ServiceName -BinaryPathName $binaryPath -DisplayName "OmniSight Agent" -Description "OmniSight Windows monitoring agent" -StartupType Automatic | Out-Null
    } else {
      & "$env:SystemRoot\System32\sc.exe" config $script:ServiceName "binPath=" $binaryPath "start=" "delayed-auto" 2>&1 | Out-Null
    }
    & "$env:SystemRoot\System32\sc.exe" config $script:ServiceName "start=" "delayed-auto" 2>&1 | Out-Null
    & "$env:SystemRoot\System32\sc.exe" description $script:ServiceName "OmniSight Windows monitoring agent" 2>&1 | Out-Null
    & "$env:SystemRoot\System32\sc.exe" failure $script:ServiceName "reset=" "86400" "actions=" "restart/5000/restart/15000/restart/60000" 2>&1 | Out-Null
    & "$env:SystemRoot\System32\sc.exe" failureflag $script:ServiceName "1" 2>&1 | Out-Null
    Remove-Item -LiteralPath $startupDiagnosticPath -Force -ErrorAction SilentlyContinue
    Start-OmniSightService
    Remove-LegacyAgentTask
    Remove-Item -LiteralPath (Join-Path $script:DataDir "run-agent.ps1") -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $script:DataDir "omnisight-agent.ps1") -Force -ErrorAction SilentlyContinue
  } catch {
    $installFailure = $_
    $agentLogPath = Join-Path $script:DataDir "logs\agent.log"
    $agentLogTail = ""
    try {
      if (Test-Path -LiteralPath $agentLogPath) {
        $agentLogTail = ((Get-Content -LiteralPath $agentLogPath -Tail 20 -ErrorAction Stop) -join " | ").Trim()
      }
    } catch {}
    try {
      if (-not $serviceExisted -and (Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue)) {
        Stop-Service -Name $script:ServiceName -Force -ErrorAction SilentlyContinue
        & "$env:SystemRoot\System32\sc.exe" delete $script:ServiceName 2>&1 | Out-Null
      }
      if ($hadExecutable -and (Test-Path -LiteralPath $executableBackup)) {
        New-Item -ItemType Directory -Force -Path $script:InstallDir | Out-Null
        Copy-Item -LiteralPath $executableBackup -Destination $script:ExecutablePath -Force
      } elseif (-not $hadExecutable) {
        Remove-Item -LiteralPath $script:ExecutablePath -Force -ErrorAction SilentlyContinue
      }
      if ($hadConfig -and (Test-Path -LiteralPath $configBackup)) {
        Copy-Item -LiteralPath $configBackup -Destination $script:ConfigPath -Force
      } elseif (-not $hadConfig) {
        Remove-Item -LiteralPath $script:ConfigPath -Force -ErrorAction SilentlyContinue
      }
      if ($serviceExisted) { Start-Service -Name $script:ServiceName -ErrorAction SilentlyContinue }
    } catch {}
    $failureMessage = "Windows service installation failed: $($installFailure.Exception.Message)"
    if ($agentLogTail) { $failureMessage += " Agent log: $agentLogTail" }
    try {
      if (Test-Path -LiteralPath $startupDiagnosticPath) {
        $startupDiagnosticTail = ((Get-Content -LiteralPath $startupDiagnosticPath -Tail 20 -ErrorAction Stop) -join " | ").Trim()
        if ($startupDiagnosticTail) { $failureMessage += " Startup diagnostic: $startupDiagnosticTail" }
      }
    } catch {}
    throw $failureMessage
  } finally {
    Remove-Item -LiteralPath $sourcePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stagingPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $executableBackup -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $configBackup -Force -ErrorAction SilentlyContinue
  }

  Write-Host "OmniSight Windows service agent installed and started (id: $agentId, version: $version, interval: ${interval}s)"
  Write-Host "Service: $script:ServiceName"
  Write-Host "Logs: $script:DataDir\logs\agent.log"
}

$requestedAction = if ($args.Count -gt 0) { [string]$args[0] } else { [string]$env:OMNISIGHT_ACTION }
if ($requestedAction -eq "uninstall") {
  Uninstall-OmniSightAgent
  return
}

Install-OmniSightService
