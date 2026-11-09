# 仓储产品台账 —— 停止服务
# 双击「停止台账系统.cmd」即可停止后台运行的 Node 服务
# PID 文件按端口隔离（logs/server-<端口>.pid，兼容旧的 logs/server.pid）；
# 没有 PID 文件时按端口查找，并校验进程确实是本项目启动的 node。

param(
  [int]$Port = 4399,
  [switch]$NonInteractive
)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
$pidFile = Join-Path $logDir "server-$Port.pid"
$legacyPidFile = Join-Path $logDir 'server.pid'
$serverEntry = Join-Path $root 'server\src\index.js'

Write-Host '=======================================' -ForegroundColor DarkCyan
Write-Host '   仓储产品台账管理系统 · 停止服务' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor DarkCyan

# 只允许停止本项目的 node.exe：
#   1) 命令行包含本项目 server\src\index.js 的绝对路径（run-server.cmd 的启动方式）；
#   2) 或带 --app product-ledger 标记（npm start 也带这个标记）。
# 其他目录下恰好也叫 src/index.js 的 Node 项目不会被误杀。
function Test-OurServer([int]$procId) {
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  if (-not $info) { return $false }
  if ($info.Name -ne 'node.exe') { return $false }
  if (-not $info.CommandLine) { return $false }
  if ($info.CommandLine -match [regex]::Escape($serverEntry)) { return $true }
  return ($info.CommandLine -match '--app\s+product-ledger')
}

function Test-IsNode([int]$procId) {
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  return [bool]($info -and $info.Name -eq 'node.exe')
}

# 兼容旧版启动方式（相对路径、没有 --app 标记）：端口上的服务若返回本系统的
# /api/health 标识（{ ok: true, app: "product-ledger" }），也可以确认是自己人。
function Test-AppHealth([int]$port) {
  try {
    $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/health" -f $port) -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -ne 200) { return $false }
    $body = $resp.Content | ConvertFrom-Json
    return ($body.ok -eq $true -and $body.app -eq 'product-ledger')
  } catch {
    return $false
  }
}

$targets = @()
$savedPid = 0
$savedIsOurs = $false

# 优先按端口读取 PID 文件；旧版本只写过 logs/server.pid，保留兼容读取
$pidFileToUse = $null
if (Test-Path $pidFile) { $pidFileToUse = $pidFile }
elseif (Test-Path $legacyPidFile) { $pidFileToUse = $legacyPidFile }

if ($pidFileToUse) {
  [void][int]::TryParse((Get-Content $pidFileToUse -Raw).Trim(), [ref]$savedPid)
  if ($savedPid -gt 0 -and (Get-Process -Id $savedPid -ErrorAction SilentlyContinue)) {
    $onPort = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -eq $savedPid }
    if ($onPort -and (Test-IsNode $savedPid)) {
      # PID 文件由启动脚本在服务就绪后写入，且该进程确实监听指定端口，可以信任
      $savedIsOurs = $true
      $targets += $savedPid
    } elseif ($onPort) {
      Write-Host "PID 文件中的进程（$savedPid）不是 Node 服务，已忽略。" -ForegroundColor Yellow
    } else {
      if (Test-OurServer $savedPid) { $savedIsOurs = $true }
      Write-Host "PID 文件记录的服务（PID $savedPid）不在端口 $Port 上监听，改为按端口查找。" -ForegroundColor Yellow
    }
  }
}

if (-not $targets) {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($procId in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if (Test-OurServer $procId) {
      $targets += $procId
    } elseif ((Test-IsNode $procId) -and (Test-AppHealth $Port)) {
      Write-Host "PID $procId 未带项目路径标记（可能是旧版启动），但 /api/health 返回本系统标识，按本系统处理。" -ForegroundColor Yellow
      $targets += $procId
    } else {
      Write-Host "端口 $Port 被其他程序占用（PID $procId），不是本系统服务，已跳过。" -ForegroundColor Yellow
    }
  }
}

if (-not $targets) {
  Write-Host "端口 $Port 上没有运行中的本系统服务，可能已经停止。" -ForegroundColor Yellow
  # 只有确认 PID 文件对应的进程确实不在了才清理，避免误删仍在其他端口运行的服务记录
  if (-not ($savedIsOurs -and (Get-Process -Id $savedPid -ErrorAction SilentlyContinue))) {
    Remove-Item -Path $pidFileToUse -ErrorAction SilentlyContinue
  }
  if ([Environment]::UserInteractive -and -not $NonInteractive) { Read-Host '按回车键关闭' | Out-Null }
  exit 0
}

foreach ($procId in ($targets | Select-Object -Unique)) {
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  try {
    # Windows 下无法向无控制台进程投递 SIGTERM，这里是强制终止；
    # 服务端已把落盘合并窗口缩短到 50ms，最多丢失毫秒级改动
    Stop-Process -Id $procId -Force -ErrorAction Stop
    Write-Host ("已停止进程：{0}（PID {1}）" -f $proc.ProcessName, $procId) -ForegroundColor Green
  } catch {
    Write-Host ("停止进程 {0} 失败：{1}" -f $procId, $_.Exception.Message) -ForegroundColor Red
  }
}

# 清理本端口的 PID 文件；旧版全局文件只在它指向的进程已消失时删除
Remove-Item -Path $pidFile -ErrorAction SilentlyContinue
if ((Test-Path $legacyPidFile) -and -not (Get-Process -Id $savedPid -ErrorAction SilentlyContinue)) {
  Remove-Item -Path $legacyPidFile -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 800
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "端口 $Port 仍在监听，请稍后重试或在任务管理器结束 node.exe。" -ForegroundColor Yellow
} else {
  Write-Host '服务已停止。' -ForegroundColor Green
}
if (-not $NonInteractive) { Start-Sleep -Seconds 2 }
