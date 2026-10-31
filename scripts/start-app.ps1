# 仓储产品台账 —— 一键启动脚本
# 双击「启动台账系统.cmd」即会执行本脚本：检查环境 → 必要时安装/构建 → 后台启动服务 → 打开浏览器

param(
  [switch]$NoBrowser,      # 内部测试用：不自动打开浏览器
  [int]$Port = 4399
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 出错时停住窗口让用户看到原因；脚本化调用（-NoBrowser）时不阻塞
function Pause-IfNeeded {
  if (-not $NoBrowser -and [Environment]::UserInteractive) { Read-Host '按回车键关闭' | Out-Null }
}

$url    = "http://127.0.0.1:$Port"
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-PortOpen([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $client.Connect('127.0.0.1', $p); return $true }
  catch { return $false }
  finally { $client.Dispose() }
}

function Get-LanIps {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Select-Object -ExpandProperty IPAddress -Unique
}

function Show-Lan {
  $ips = Get-LanIps
  if (-not $ips) { return }
  Write-Host ''
  Write-Host '同一局域网（同一个 WiFi / 路由器）的其他电脑，浏览器打开：' -ForegroundColor Cyan
  foreach ($ip in $ips) {
    Write-Host ("    http://{0}:{1}" -f $ip, $Port) -ForegroundColor White
  }
  Write-Host '（对方打不开时，请看 README「局域网共享」一节，或用「启用局域网访问.cmd」放行防火墙）' -ForegroundColor DarkGray
}

Write-Host '=======================================' -ForegroundColor DarkCyan
Write-Host '   仓储产品台账管理系统 · 本地启动' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor DarkCyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '没有找到 Node.js。请先安装 Node.js 18 或更高版本：https://nodejs.org/' -ForegroundColor Red
  Pause-IfNeeded
  exit 1
}

if (Test-PortOpen $Port) {
  Write-Host "服务已经在运行（端口 $Port），直接打开页面。" -ForegroundColor Yellow
  if (-not $NoBrowser) { Start-Process $url }
  Show-Lan
  Start-Sleep -Seconds 2
  exit 0
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host '首次运行，正在安装依赖（大约 1-3 分钟，请耐心等待）…' -ForegroundColor Yellow
  npm install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) {
    Write-Host '依赖安装失败，请检查网络后重试。' -ForegroundColor Red
    Pause-IfNeeded
    exit 1
  }
}

if (-not (Test-Path (Join-Path $root 'web\dist\index.html'))) {
  Write-Host '正在构建前端页面…' -ForegroundColor Yellow
  npm run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host '前端构建失败，请查看上面的报错。' -ForegroundColor Red
    Pause-IfNeeded
    exit 1
  }
}

Write-Host '正在启动服务…' -ForegroundColor Yellow
$outLog = Join-Path $logDir 'server.log'
$errLog = Join-Path $logDir 'server.err.log'
$node   = (Get-Command node).Source

Start-Process -FilePath $node `
  -ArgumentList 'src/index.js' `
  -WorkingDirectory (Join-Path $root 'server') `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError  $errLog

$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $resp = Invoke-WebRequest "$url/api/health" -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}

if (-not $ok) {
  Write-Host '启动失败，最后几行日志如下：' -ForegroundColor Red
  if (Test-Path $errLog) { Get-Content $errLog -Tail 20 -Encoding UTF8 }
  if (Test-Path $outLog) { Get-Content $outLog -Tail 20 -Encoding UTF8 }
  Pause-IfNeeded
  exit 1
}

Write-Host ''
Write-Host '✓ 启动成功' -ForegroundColor Green
Write-Host "  本机地址：$url" -ForegroundColor White
if (-not $NoBrowser) { Start-Process $url }
Show-Lan
Write-Host ''
Write-Host '服务在后台运行，关闭本窗口不影响使用。' -ForegroundColor DarkGray
Write-Host '停止服务：双击「停止台账系统.cmd」' -ForegroundColor DarkGray
Start-Sleep -Seconds 3
