# 开机自启：在"启动"文件夹里放一个快捷方式
param(
    [switch]$Disable
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$linkPath = Join-Path $startup '群聊AI.lnk'

if ($Disable) {
    if (Test-Path $linkPath) {
        Remove-Item $linkPath -Force
        Write-Host ''
        Write-Host '  已取消开机自启'
        Write-Host ''
    } else {
        Write-Host ''
        Write-Host '  本来就没开'
        Write-Host ''
    }
    Start-Sleep -Seconds 2
    exit 0
}

$target = Join-Path $root '启动.bat'
if (-not (Test-Path $target)) {
    Write-Host "  找不到启动.bat，路径不对？$target"
    Start-Sleep -Seconds 3
    exit 1
}

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($linkPath)
$lnk.TargetPath = $target
$lnk.WorkingDirectory = $root
$lnk.WindowStyle = 7          # 最小化启动
$lnk.Description = '开机自动启动群聊 AI'
$lnk.Save()

Write-Host ''
Write-Host '  已设置开机自启'
Write-Host "  快捷方式：$linkPath"
Write-Host ''
Write-Host '  下次开机会自动启动（最小化，不弹黑窗口）'
Write-Host '  要取消请双击「取消自启.bat」'
Write-Host ''
Start-Sleep -Seconds 3
