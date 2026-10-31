# 仓储产品台账 —— 启用局域网访问
# 作用：在 Windows 防火墙放行 4399 端口（仅"专用网络/域网络"），并打印其他电脑的访问地址。
# 建议：公司/家庭 WiFi 在「设置 → 网络和 Internet → 属性」里把网络配置文件设为「专用」。

param([int]$Port = 4399)

$ErrorActionPreference = 'Stop'
$ruleName = "仓储产品台账 $Port"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Host '需要管理员权限才能修改防火墙规则。' -ForegroundColor Red
  Write-Host '请右键点击本脚本 → 以管理员身份运行，或用「以管理员身份运行」的 PowerShell 执行。'
  Read-Host '按回车键关闭'
  exit 1
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "防火墙规则已存在：$ruleName" -ForegroundColor Yellow
} else {
  New-NetFirewallRule -DisplayName $ruleName `
    -Description '允许局域网访问仓储产品台账系统（TCP 4399）' `
    -Direction Inbound -Protocol TCP -LocalPort $Port `
    -Action Allow -Profile Private, Domain | Out-Null
  Write-Host "✓ 已放行 TCP $Port（专用/域网络）" -ForegroundColor Green
}

$profiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue
$publicProfiles = $profiles | Where-Object { $_.NetworkCategory -eq 'Public' }
if ($publicProfiles) {
  Write-Host ''
  Write-Host '注意：当前网络被识别为「公用网络」，防火墙默认拦截入站连接。' -ForegroundColor Yellow
  Write-Host '可选做法（任选其一）：' -ForegroundColor Yellow
  Write-Host '  1) 在 Windows 设置里把该 WiFi 改为「专用网络」（推荐，最安全）'
  Write-Host '  2) 再执行一次本脚本并加参数 -AllowPublic：.\enable-lan.ps1 -AllowPublic'
}

if ($PSBoundParameters.ContainsKey('AllowPublic')) {
  $pub = Get-NetFirewallRule -DisplayName "$ruleName (公用)" -ErrorAction SilentlyContinue
  if (-not $pub) {
    New-NetFirewallRule -DisplayName "$ruleName (公用)" `
      -Direction Inbound -Protocol TCP -LocalPort $Port `
      -Action Allow -Profile Public | Out-Null
    Write-Host "✓ 已放行 TCP $Port（公用网络）" -ForegroundColor Green
  }
}

Write-Host ''
Write-Host "本机（服务器）访问：http://localhost:$Port" -ForegroundColor Cyan
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -ExpandProperty IPAddress -Unique
foreach ($ip in $ips) {
  Write-Host ("其他电脑访问：http://{0}:{1}" -f $ip, $Port) -ForegroundColor White
}
Write-Host ''
Write-Host '如果其他电脑仍打不开，依次检查：' -ForegroundColor DarkGray
Write-Host '  1) 两台电脑是否连的同一个路由器/WiFi；' -ForegroundColor DarkGray
Write-Host '  2) 本机服务是否在运行（先双击「仓储产品台账」）；' -ForegroundColor DarkGray
Write-Host '  3) 路由器是否开启了「AP 隔离/访客网络」（会禁止设备互访）；' -ForegroundColor DarkGray
Write-Host '  4) 直接在浏览器地址栏输入 http://IP:4399，不要用 https。' -ForegroundColor DarkGray
Start-Sleep -Seconds 3
