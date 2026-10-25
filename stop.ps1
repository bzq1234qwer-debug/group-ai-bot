# 停止服务：先停控制台，再问要不要关 QQ
$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$statePath = Join-Path $root 'data\runtime.json'

Write-Host ''
Write-Host '  正在停止…'
Write-Host ''

# 先停看门狗，否则控制台刚被停就被它拉起来
$watchdogState = Join-Path $root 'data\watchdog.json'
if (Test-Path $watchdogState) {
    try {
        $ws = Get-Content $watchdogState -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($ws.pid) {
            $wp = Get-Process -Id $ws.pid -ErrorAction SilentlyContinue
            if ($wp) {
                Stop-Process -Id $ws.pid -Force
                Start-Sleep -Milliseconds 600
                Write-Host "  已停止看门狗（PID $($ws.pid)）"
            }
        }
        Remove-Item $watchdogState -Force
    } catch {
        # 状态文件坏了无所谓
    }
}

# 停控制台（只杀自己启动的那个 PID，不误伤别的 node 进程）
$stopped = $false
if (Test-Path $statePath) {
    try {
        $state = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($state.consolePid) {
            $p = Get-Process -Id $state.consolePid -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -eq 'node') {
                Stop-Process -Id $state.consolePid -Force
                Write-Host "  已停止控制台（PID $($state.consolePid)）"
                $stopped = $true
            }
        }
        Remove-Item $statePath -Force
    } catch {
        Write-Host '  读取运行状态失败，改用端口查找'
    }
}

# 兜底：记录里的 PID 可能过期（比如被看门狗重启过），按 7799 端口找真正在跑的那个
if (-not $stopped) {
    $conn = Get-NetTCPConnection -LocalPort 7799 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($conn) {
        $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($owner -and $owner.ProcessName -eq 'node') {
            Stop-Process -Id $owner.Id -Force
            Write-Host "  已停止控制台（占用 7799 的 PID $($owner.Id)）"
            $stopped = $true
        }
    }
}

if (-not $stopped) {
    Write-Host '  控制台本来就没在运行'
}

# QQ / NapCat
$qq = Get-Process QQ -ErrorAction SilentlyContinue
if ($qq) {
    Write-Host ''
    $answer = Read-Host '  要连 QQ 一起关掉吗？（NapCat 会跟着退出，下次要重新登录）[y/N]'
    if ($answer -eq 'y' -or $answer -eq 'Y') {
        Stop-Process -Name QQ -Force
        Write-Host '  QQ 已关闭'
    } else {
        Write-Host '  QQ 保持运行'
    }
}

Write-Host ''
Write-Host '  完成。'
Start-Sleep -Seconds 2
