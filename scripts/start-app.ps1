# 仓储产品台账 —— 一键启动脚本
# 双击「启动台账系统.cmd」即会执行本脚本：检查环境 → 必要时安装/构建 → 后台启动服务 → 打开浏览器
# 可选参数：
#   -Port 4399     指定端口（会通过 PORT 环境变量传给服务端）
#   -Rebuild       强制重新构建前端
#   -NoBrowser     不自动打开浏览器（脚本化/测试用）

param(
  [switch]$NoBrowser,
  [int]$Port = 4399,
  [switch]$Rebuild
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
$pidFile = Join-Path $logDir "server-$Port.pid"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-PortOpen([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $client.Connect('127.0.0.1', $p); return $true }
  catch { return $false }
  finally { $client.Dispose() }
}

# 端口通不代表是本系统：必须 /api/health 返回 200，且响应体带本系统标识
function Test-ServiceUp([int]$p) {
  try {
    $resp = Invoke-WebRequest "http://127.0.0.1:$p/api/health" -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -ne 200) { return $false }
    $body = $resp.Content | ConvertFrom-Json
    return ($body.ok -eq $true -and $body.app -eq 'product-ledger')
  } catch { return $false }
}

# 空库（从未执行过 seed）时任何账号都登不进去：先给可操作提示，再把用户送到登录页
function Test-NeedsSeed([int]$p) {
  try {
    $body = (Invoke-WebRequest "http://127.0.0.1:$p/api/health" -UseBasicParsing -TimeoutSec 2).Content | ConvertFrom-Json
    if (-not $body.db) { return $false }
    return ([int]$body.db.users -eq 0)
  } catch { return $false }
}

function Show-SeedHint {
  Write-Host ''
  Write-Host '！数据库里还没有任何账号，直接登录会失败。' -ForegroundColor Yellow
  Write-Host '  请在项目目录另开一个窗口执行一次： npm run seed' -ForegroundColor Yellow
  Write-Host '  执行完成后回到浏览器重新登录即可（服务会自动重新读取数据库，无需重启）。' -ForegroundColor Yellow
  Write-Host '  （若这里本该有正式数据，请先从备份恢复 server\data\db.json，不要执行 seed）' -ForegroundColor DarkGray
}

# 端口就绪后从监听套接字反查真实 PID，写进按端口隔离的 PID 文件
function Save-ListenerPid([int]$p, [string]$file) {
  $listener = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $listener.OwningProcess | Set-Content -Path $file -Encoding ASCII
    return $true
  }
  return $false
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

# 前端源文件是否比 dist 新（dist 不随代码更新分发，必须自己判断）
function Test-NeedBuild {
  $distIndex = Join-Path $root 'web\dist\index.html'
  if (-not (Test-Path $distIndex)) { return $true }
  $targets = @(
    (Join-Path $root 'web\src'),
    (Join-Path $root 'web\public'),
    (Join-Path $root 'web\index.html'),
    (Join-Path $root 'web\vite.config.ts'),
    (Join-Path $root 'web\package.json')
  ) | Where-Object { Test-Path $_ }
  if (-not $targets) { return $false }
  $newest = Get-ChildItem -Path $targets -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $newest) { return $false }
  return ($newest.LastWriteTime -gt (Get-Item $distIndex).LastWriteTime)
}

Write-Host '=======================================' -ForegroundColor DarkCyan
Write-Host '   仓储产品台账管理系统 · 本地启动' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor DarkCyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '没有找到 Node.js。请先安装 Node.js 20 或更高版本：https://nodejs.org/' -ForegroundColor Red
  Pause-IfNeeded
  exit 1
}

# 版本校验：Vite 6 / 本项目 engines 均要求 >= 20
$nodeVersion = (& node -p "process.versions.node" 2>$null)
$nodeMajor = 0
[void][int]::TryParse(($nodeVersion -split '\.')[0], [ref]$nodeMajor)
if ($nodeMajor -lt 20) {
  Write-Host "当前 Node.js 版本为 $nodeVersion，本项目需要 20 或更高版本。" -ForegroundColor Red
  Pause-IfNeeded
  exit 1
}

if (Test-PortOpen $Port) {
  if (Test-ServiceUp $Port) {
    Write-Host "服务已经在运行（端口 $Port），直接打开页面。" -ForegroundColor Yellow
    [void](Save-ListenerPid $Port $pidFile)
    if (Test-NeedsSeed $Port) { Show-SeedHint }
    if (-not $NoBrowser) { Start-Process $url }
    Show-Lan
    Start-Sleep -Seconds 2
    exit 0
  }
  Write-Host "端口 $Port 已被其他程序占用（/api/health 不是本系统），无法启动。" -ForegroundColor Red
  Write-Host '请关闭占用该端口的程序，或用 -Port 指定其他端口。' -ForegroundColor DarkGray
  Pause-IfNeeded
  exit 1
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

if ($Rebuild -or (Test-NeedBuild)) {
  if ($Rebuild) { Write-Host '按要求重新构建前端页面…' -ForegroundColor Yellow }
  else { Write-Host '检测到前端源码已更新，正在重新构建页面…' -ForegroundColor Yellow }
  npm run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host '前端构建失败，请查看上面的报错。' -ForegroundColor Red
    Pause-IfNeeded
    exit 1
  }
}

Write-Host '正在启动服务…' -ForegroundColor Yellow
# 日志按端口区分：多个实例（例如 4399 生产 + 4409 测试）不会互相占用日志文件
$outLog = Join-Path $logDir "server-$Port.log"
$errLog = Join-Path $logDir "server-$Port.err.log"
# 覆盖式重定向会丢失上次排障线索，启动前保留一份上一版日志
foreach ($file in @($outLog, $errLog)) {
  if (-not (Test-Path $file)) { continue }
  try {
    Move-Item -Path $file -Destination "$file.prev" -Force -ErrorAction Stop
  } catch {
    # 日志正被已有服务占用时轮转会失败；这不应该阻断本次启动
    Write-Host ("日志文件被占用，跳过轮转：{0}" -f (Split-Path $file -Leaf)) -ForegroundColor DarkGray
  }
}
$node = (Get-Command node).Source

# 通过 scripts\run-server.cmd（ShellExecute 启动）拉起服务：
# 不走 -RedirectStandardOutput，避免常驻 node 继承本脚本的输出句柄，
# 否则脚本被管道 / 计划任务调用时会「服务已启动但调用方一直不返回」。
# 端口作为参数传给 cmd，由它设置子进程的 PORT，避免污染当前 PowerShell 会话。
$runner = Join-Path $PSScriptRoot 'run-server.cmd'
Start-Process -FilePath $env:ComSpec -ArgumentList '/c', "`"$runner`" $Port" -WindowStyle Hidden

$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if (-not (Test-PortOpen $Port)) { continue }
  if (Test-ServiceUp $Port) { $ok = $true; break }
}

if (-not $ok) {
  Write-Host '启动失败，最后几行日志如下：' -ForegroundColor Red
  if (Test-Path $errLog) { Get-Content $errLog -Tail 20 -Encoding UTF8 }
  if (Test-Path $outLog) { Get-Content $outLog -Tail 20 -Encoding UTF8 }
  # 清理残留进程，避免占用端口
  $stale = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($stale) { Stop-Process -Id $stale.OwningProcess -Force -ErrorAction SilentlyContinue }
  Remove-Item -Path $pidFile -ErrorAction SilentlyContinue
  Pause-IfNeeded
  exit 1
}

# 端口起来了再从监听套接字反查真实 PID，写进按端口隔离的 PID 文件供停止脚本使用
[void](Save-ListenerPid $Port $pidFile)

Write-Host ''
Write-Host '✓ 启动成功' -ForegroundColor Green
Write-Host "  本机地址：$url" -ForegroundColor White
if (Test-NeedsSeed $Port) { Show-SeedHint }
if (-not $NoBrowser) { Start-Process $url }
Show-Lan
Write-Host ''
Write-Host '服务在后台运行，关闭本窗口不影响使用。' -ForegroundColor DarkGray
Write-Host '停止服务：双击「停止台账系统.cmd」' -ForegroundColor DarkGray
Start-Sleep -Seconds 3
