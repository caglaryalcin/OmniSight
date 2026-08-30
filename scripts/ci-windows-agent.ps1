param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$serviceName = "OmniSightAgent"
$dataDir = Join-Path $env:ProgramData "OmniSight"
$installDir = Join-Path $env:ProgramFiles "OmniSight Agent"
$mockPath = Join-Path $env:RUNNER_TEMP "omnisight-agent-mock.js"
$reportPath = Join-Path $env:RUNNER_TEMP "omnisight-agent-report.json"
$verificationPath = Join-Path $env:RUNNER_TEMP "omnisight-agent-verification.txt"
$agentSourcePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\agent\OmniSight.Agent.cs")).Path
$installerPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\agent\install-windows.ps1")).Path
$mockProcess = $null

if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw "$serviceName already exists on the runner" }
if (Test-Path -LiteralPath $dataDir) { throw "$dataDir already exists on the runner" }
if (Test-Path -LiteralPath $installDir) { throw "$installDir already exists on the runner" }
$compiledVersion = [Reflection.AssemblyName]::GetAssemblyName($ExecutablePath).Version.ToString(3)
if ($compiledVersion -ne "1.4.3") { throw "Unexpected precompiled Windows agent version: $compiledVersion" }

try {
  $mockSource = @'
const fs = require('fs');
const http = require('http');
const reportPath = process.argv[2];
const verificationPath = process.argv[3];
const agentSourcePath = process.argv[4];
let lastReportAt = 0;
let lastAgentId = '';
http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.url === '/agent/OmniSight.Agent.cs') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(fs.readFileSync(agentSourcePath));
    }
    if (req.headers['x-agent-token'] !== 'ci-token') {
      res.statusCode = 401;
      return res.end('bad token');
    }
    if (req.url === '/api/agent/report') {
      fs.writeFileSync(reportPath, body);
      try { lastAgentId = String(JSON.parse(body).id || ''); } catch { lastAgentId = ''; }
      lastReportAt = Date.now();
      return res.end('');
    }
    if (req.url === '/api/agent/ping') {
      let requestedId = '';
      try { requestedId = String(JSON.parse(body).id || ''); } catch {}
      const known = lastReportAt > 0 && requestedId === lastAgentId;
      const ageSeconds = known ? Math.max(0, (Date.now() - lastReportAt) / 1000) : null;
      const fresh = known && ageSeconds < 30;
      if (fresh) fs.writeFileSync(verificationPath, requestedId);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        ok: true,
        id: requestedId,
        serverTime: new Date().toISOString(),
        report: { known, fresh, ageSeconds },
      }));
    }
    if (req.url.startsWith('/api/agent/commands')) return setTimeout(() => res.end(''), 1000);
    if (req.url === '/api/agent/result') return res.end('{"ok":true}');
    res.statusCode = 404;
    res.end('missing');
  });
}).listen(48767, '127.0.0.1');
'@
  [IO.File]::WriteAllText($mockPath, $mockSource, (New-Object Text.UTF8Encoding($false)))
  $mockArguments = @($mockPath, $reportPath, $verificationPath, $agentSourcePath) | ForEach-Object { "`"$_`"" }
  $mockProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList $mockArguments -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 1

  $env:OMNISIGHT_URL = "http://127.0.0.1:48767"
  $env:OMNISIGHT_TOKEN = "ci-token"
  $env:OMNISIGHT_INTERVAL = "5"
  $env:OMNISIGHT_AGENT_ROLE = "windows"
  $env:OMNISIGHT_AGENT_ID = "windows-service-ci"
  & $installerPath

  if (-not (Test-Path -LiteralPath $reportPath)) { throw "Windows service did not send a report" }
  if (-not (Test-Path -LiteralPath $verificationPath)) { throw "Windows installer did not verify a fresh dashboard report" }
  $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  if ($report.id -ne "windows-service-ci" -or $report.platform -ne "windows" -or $report.agentVersion -ne "1.4.3") { throw "Windows service report identity is invalid" }
  if ($null -eq $report.cpu -or $null -eq $report.mem -or $null -eq $report.disk -or $null -eq $report.services) { throw "Windows service report is missing required metrics" }
  Write-Host "Windows service install, lifecycle and fresh-report verification test passed"
} finally {
  foreach ($name in @("OMNISIGHT_URL", "OMNISIGHT_TOKEN", "OMNISIGHT_INTERVAL", "OMNISIGHT_AGENT_ROLE", "OMNISIGHT_AGENT_ID")) {
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
  }
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($service) {
    if ($service.Status -ne "Stopped") {
      Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
      try { $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30)) } catch {}
    }
    & "$env:SystemRoot\System32\sc.exe" delete $serviceName 2>&1 | Out-Null
  }
  try {
    Get-CimInstance Win32_Process -Filter "Name='OmniSight.Agent.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith(([IO.Path]::GetFullPath($installDir)), [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
  if ($mockProcess -and -not $mockProcess.HasExited) { Stop-Process -Id $mockProcess.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $mockPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $reportPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $verificationPath -Force -ErrorAction SilentlyContinue
  $resolvedData = [IO.Path]::GetFullPath($dataDir)
  $expectedData = [IO.Path]::GetFullPath((Join-Path $env:ProgramData "OmniSight"))
  if ($resolvedData -ne $expectedData) { throw "Unsafe Windows agent CI cleanup path: $resolvedData" }
  Remove-Item -LiteralPath $resolvedData -Recurse -Force -ErrorAction SilentlyContinue
  $resolvedInstall = [IO.Path]::GetFullPath($installDir)
  $expectedInstall = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles "OmniSight Agent"))
  if ($resolvedInstall -ne $expectedInstall) { throw "Unsafe Windows agent CI cleanup path: $resolvedInstall" }
  Remove-Item -LiteralPath $resolvedInstall -Recurse -Force -ErrorAction SilentlyContinue
}
