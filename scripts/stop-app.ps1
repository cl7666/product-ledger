# 仓储产品台账 —— 停止服务
# 双击「停止台账系统.cmd」即可停止后台运行的 Node 服务

param([int]$Port = 4399)

$ErrorActionPreference = 'SilentlyContinue'

Write-Host '=======================================' -ForegroundColor DarkCyan
Write-Host '   仓储产品台账管理系统 · 停止服务' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor DarkCyan

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
  Write-Host "端口 $Port 上没有运行中的服务，可能已经停止。" -ForegroundColor Yellow
  Read-Host '按回车键关闭'
  exit 0
}

$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($pidValue in $pids) {
  $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($proc) {
    try {
      Stop-Process -Id $pidValue -Force
      Write-Host ("已停止进程：{0}（PID {1}）" -f $proc.ProcessName, $pidValue) -ForegroundColor Green
    } catch {
      Write-Host ("停止进程 {0} 失败：{1}" -f $pidValue, $_.Exception.Message) -ForegroundColor Red
    }
  }
}

Start-Sleep -Milliseconds 800
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "端口 $Port 仍在监听，请稍后重试或在任务管理器结束 node.exe。" -ForegroundColor Yellow
} else {
  Write-Host '服务已停止。' -ForegroundColor Green
}
Start-Sleep -Seconds 2
