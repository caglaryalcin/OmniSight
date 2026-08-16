param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$serviceName = "OmniSightAgent"
$dataDir = Join-Path $env:ProgramData "OmniSight"
$configPath = Join-Path $dataDir "agent.json"
$mockPath = Join-Path $env:RUNNER_TEMP "omnisight-agent-mock.js"
$reportPath = Join-Path $env:RUNNER_TEMP "omnisight-agent-report.json"
$mockProcess = $null

if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw "$serviceName already exists on the runner" }
if (Test-Path -LiteralPath $dataDir) { throw "$dataDir already exists on the runner" }

try {
  $mockSource = @'
const fs = require('fs');
const http = require('http');
const reportPath = process.argv[2];
http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.headers['x-agent-token'] !== 'ci-token') {
      res.statusCode = 401;
      return res.end('bad token');
    }
    if (req.url === '/api/agent/report') {
      fs.writeFileSync(reportPath, body);
      return res.end('');
    }
    if (req.url.startsWith('/api/agent/commands')) return setTimeout(() => res.end(''), 1000);
    if (req.url === '/api/agent/result') return res.end('{"ok":true}');
    res.statusCode = 404;
    res.end('missing');
  });
}).listen(48767, '127.0.0.1');
'@
  [IO.File]::WriteAllText($mockPath, $mockSource, (New-Object Text.UTF8Encoding($false)))
  $mockProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList @($mockPath, $reportPath) -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 1

  New-Item -ItemType Directory -Path $dataDir | Out-Null
  $config = [ordered]@{
    url = "http://127.0.0.1:48767"
    token = "ci-token"
    interval = 5
    role = "windows"
    agentId = "windows-service-ci"
    insecureTls = $false
  }
  [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  New-Service -Name $serviceName -BinaryPathName "`"$ExecutablePath`"" -DisplayName "OmniSight Agent CI" -StartupType Manual | Out-Null
  Start-Service -Name $serviceName
  (Get-Service -Name $serviceName).WaitForStatus("Running", [TimeSpan]::FromSeconds(30))

  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (-not (Test-Path -LiteralPath $reportPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Path -LiteralPath $reportPath)) { throw "Windows service did not send a report" }
  $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  if ($report.id -ne "windows-service-ci" -or $report.platform -ne "windows" -or $report.agentVersion -ne "1.4.2") { throw "Windows service report identity is invalid" }
  if ($null -eq $report.cpu -or $null -eq $report.mem -or $null -eq $report.disk -or $null -eq $report.services) { throw "Windows service report is missing required metrics" }
  Write-Host "Windows service lifecycle and report test passed"
} finally {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($service) {
    if ($service.Status -ne "Stopped") {
      Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
      try { $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30)) } catch {}
    }
    & "$env:SystemRoot\System32\sc.exe" delete $serviceName 2>&1 | Out-Null
  }
  if ($mockProcess -and -not $mockProcess.HasExited) { Stop-Process -Id $mockProcess.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $mockPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $reportPath -Force -ErrorAction SilentlyContinue
  $resolvedData = [IO.Path]::GetFullPath($dataDir)
  $expectedData = [IO.Path]::GetFullPath((Join-Path $env:ProgramData "OmniSight"))
  if ($resolvedData -ne $expectedData) { throw "Unsafe Windows agent CI cleanup path: $resolvedData" }
  Remove-Item -LiteralPath $resolvedData -Recurse -Force -ErrorAction SilentlyContinue
}
