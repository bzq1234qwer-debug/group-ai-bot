# 把 Node.js 下载到 runtime\ 目录，让启动器不再依赖用户自己装 Node
#
# 用法：双击「准备运行环境.bat」，或 powershell -File prepare-runtime.ps1

param(
    [string]$Version = 'v24.18.0'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeDir = Join-Path $root 'runtime'
$zip = Join-Path $env:TEMP "node-$Version-win-x64.zip"

if (Test-Path (Join-Path $runtimeDir 'node.exe')) {
    Write-Host ''
    Write-Host "  已经准备好：$runtimeDir\node.exe"
    Write-Host ''
    Start-Sleep -Seconds 2
    exit 0
}

$url = "https://nodejs.org/dist/$Version/node-$Version-win-x64.zip"
Write-Host ''
Write-Host "  正在下载 Node $Version（约 30MB，可能几分钟）"
Write-Host "  来源：$url"
Write-Host ''

try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 1800
    Write-Host '  下载完成，解压中…'
    $tmp = Join-Path $env:TEMP "node-extract-$Version"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force

    $inner = Join-Path $tmp "node-$Version-win-x64"
    if (-not (Test-Path (Join-Path $inner 'node.exe'))) {
        throw "解压后没找到 node.exe"
    }

    if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
    Move-Item $inner $runtimeDir

    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host ''
    Write-Host "  完成：$runtimeDir\node.exe"
    Write-Host '  以后启动.bat 会优先用它，不需要系统装 Node'
} catch {
    Write-Host ''
    Write-Host "  失败：$($_.Exception.Message)"
    Write-Host '  可以手动下载： https://nodejs.org/dist/'
    Write-Host "  解压后把 node-v*-win-x64 里的内容放进 $runtimeDir"
}

Write-Host ''
Read-Host '  按回车退出'
