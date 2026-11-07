# 仓储产品台账 —— 停止服务
# 双击「停止台账系统.cmd」即可停止后台运行的 Node 服务
# 优先使用 logs/server.pid（且必须与 -Port 一致）；否则按端口查找，并校验确实是本项目的 Node 进程

param(
  [int]$Port = 4399,
  [switch]$NonInteractive
)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
$pidFile = Join-Path $logDir 'server.pid'

Write-Host '=======================================' -ForegroundColor DarkCyan
Write-Host '   仓储产品台账管理系统 · 停止服务' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor DarkCyan

# 只允许停止 node.exe 且命令行包含 server/src/index.js 的进程，避免误杀端口上的其他服务
function Test-OurServer([int]$procId) {
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  if (-not $info) { return $false }
  if ($info.Name -ne 'node.exe') { return $false }
  return ($info.CommandLine -match 'src[\\/]index\.js')
}

$targets = @()
$savedPid = 0
$savedIsOurs = $false

if (Test-Path $pidFile) {
  [void][int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$savedPid)
  if ($savedPid -gt 0 -and (Get-Process -Id $savedPid -ErrorAction SilentlyContinue)) {
    if (Test-OurServer $savedPid) {
      $savedIsOurs = $true
      # PID 文件里的进程必须在本次指定的端口上监听，否则它可能是另一个端口的实例
      $onPort = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -eq $savedPid }
      if ($onPort) {
        $targets += $savedPid
      } else {
        Write-Host "PID 文件记录的服务（PID $savedPid）不在端口 $Port 上监听，改为按端口查找。" -ForegroundColor Yellow
      }
    } else {
      Write-Host "PID 文件中的进程（$savedPid）不是本项目的 Node 服务，已忽略。" -ForegroundColor Yellow
    }
  }
}

if (-not $targets) {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($procId in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if (Test-OurServer $procId) {
      $targets += $procId
    } else {
      Write-Host "端口 $Port 被其他程序占用（PID $procId），不是本项目服务，已跳过。" -ForegroundColor Yellow
    }
  }
}

if (-not $targets) {
  Write-Host "端口 $Port 上没有运行中的本系统服务，可能已经停止。" -ForegroundColor Yellow
  # 只有确认 PID 文件对应的进程确实不在了才清理，避免误删仍在其他端口运行的服务记录
  if (-not ($savedIsOurs -and (Get-Process -Id $savedPid -ErrorAction SilentlyContinue))) {
    Remove-Item -Path $pidFile -ErrorAction SilentlyContinue
  }
  if ([Environment]::UserInteractive -and -not $NonInteractive) { Read-Host '按回车键关闭' | Out-Null }
  exit 0
}

foreach ($procId in ($targets | Select-Object -Unique)) {
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  try {
    # Windows 下无法向无控制台进程投递 SIGTERM，这里是强制终止；
    # 服务端已把落盘防抖缩短到单次事件循环，最多丢失毫秒级改动
    Stop-Process -Id $procId -Force -ErrorAction Stop
    Write-Host ("已停止进程：{0}（PID {1}）" -f $proc.ProcessName, $procId) -ForegroundColor Green
  } catch {
    Write-Host ("停止进程 {0} 失败：{1}" -f $procId, $_.Exception.Message) -ForegroundColor Red
  }
}

Remove-Item -Path $pidFile -ErrorAction SilentlyContinue

Start-Sleep -Milliseconds 800
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "端口 $Port 仍在监听，请稍后重试或在任务管理器结束 node.exe。" -ForegroundColor Yellow
} else {
  Write-Host '服务已停止。' -ForegroundColor Green
}
if (-not $NonInteractive) { Start-Sleep -Seconds 2 }