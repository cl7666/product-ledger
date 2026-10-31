# 仓储产品台账 —— 创建桌面快捷方式
# 运行一次即可：脚本会在桌面生成「仓储产品台账」快捷方式（图标为应用图标），
# 双击它 = 启动服务 + 自动打开浏览器。需要的话可以再生成「停止台账系统」。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$startCmd  = Join-Path $root '启动台账系统.cmd'
$stopCmd   = Join-Path $root '停止台账系统.cmd'
$icon      = Join-Path $root 'web\public\favicon.ico'
$desktop   = [Environment]::GetFolderPath('Desktop')

if (-not (Test-Path $startCmd)) { throw "找不到启动脚本：$startCmd" }
if (-not (Test-Path $icon))     { $icon = "$env:SystemRoot\System32\imageres.dll,73" }

$shell = New-Object -ComObject WScript.Shell

function New-Shortcut {
  param($Path, $Target, $Description, $IconLocation, $WindowStyle = 1)

  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath       = $Target
  $shortcut.WorkingDirectory = $root
  $shortcut.Description      = $Description
  $shortcut.IconLocation     = $IconLocation
  $shortcut.WindowStyle      = $WindowStyle
  $shortcut.Save()
  Write-Host "已创建：$Path" -ForegroundColor Green
}

New-Shortcut -Path (Join-Path $desktop '仓储产品台账.lnk') `
  -Target $startCmd `
  -Description '启动仓储产品台账管理系统并打开浏览器' `
  -IconLocation $icon

New-Shortcut -Path (Join-Path $desktop '停止台账系统.lnk') `
  -Target $stopCmd `
  -Description '停止仓储产品台账管理系统的后台服务' `
  -IconLocation "$env:SystemRoot\System32\imageres.dll,101" `
  -WindowStyle 7

Write-Host ''
Write-Host '完成。现在可以回到桌面双击「仓储产品台账」启动系统。' -ForegroundColor Cyan
Start-Sleep -Seconds 2
