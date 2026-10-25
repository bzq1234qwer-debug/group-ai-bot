# 看门狗：控制台或 NapCat 掉了就自己拉起来
#
# 由 launcher.ps1 以隐藏窗口启动；停止.bat 会先杀掉它，否则停了又被拉起来。
# 如果短时间内反复崩溃（说明有真 bug），连续 5 次就停手，避免无限重启刷日志。

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 同 launcher：大小写重复的代理变量会让 Start-Process 抛异常
foreach ($name in @('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
$dataDir = Join-Path $root 'data'
$statePath = Join-Path $dataDir 'watchdog.json'
$logPath = Join-Path $dataDir 'watchdog.log'
# 不要写死安装位置：别人可能装在 D 盘或项目目录下
$napcatDir = ''
foreach ($candidate in @($env:NAPCAT_DIR, (Join-Path $root 'napcat'), 'C:\napcat', 'D:\napcat')) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'launcher.bat'))) { $napcatDir = $candidate; break }
}

if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Force $dataDir | Out-Null }

function Write-Log([string]$message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $message"
    Add-Content -Path $logPath -Value $line -Encoding UTF8
}

function Test-Port([int]$port) {
    try {
        $client = New-Object Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $port)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

function Get-NodePath {
    $bundled = Join-Path $root 'runtime\node.exe'
    if (Test-Path $bundled) { return $bundled }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

@{ pid = $PID; startedAt = (Get-Date).ToString('s') } | ConvertTo-Json | Set-Content $statePath -Encoding UTF8
Write-Log "看门狗启动（PID $PID）"

$restarts = New-Object System.Collections.ArrayList

while ($true) {
    Start-Sleep -Seconds 10

    # NapCat / QQ
    if (-not (Test-Port 3001) -and $napcatDir) {
        # 关键：QQ 已经在跑但 3001 不通，通常是在等扫码登录。
        # 这时候如果再拉一次 NapCat，就会开第二个 QQ —— 越拉越多，内存被吃光。
        $qqRunning = Get-Process -Name QQ -ErrorAction SilentlyContinue
        if ($qqRunning) {
            if (-not $script:waitingLoginLogged) {
                Write-Log 'QQ 在运行但未连上 3001：多在登录页等待扫码，不再重复启动'
                $script:waitingLoginLogged = $true
            }
        } elseif (-not $script:lastNapcatTry -or ((Get-Date) - $script:lastNapcatTry).TotalMinutes -ge 2) {
            $script:lastNapcatTry = Get-Date
            $script:waitingLoginLogged = $false
            Write-Log 'NapCat 没在跑，尝试启动'
        $uin = ''
        $cfgPath = Join-Path $dataDir 'console.json'
        if (Test-Path $cfgPath) {
            try {
                $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($cfg.channels -and $cfg.channels.Count -gt 0) { $uin = [string]$cfg.channels[0].selfId }
            } catch { }
        }
        $napcatArgs = @()
        if ($uin -ne '') { $napcatArgs += $uin }
        Start-Process -FilePath (Join-Path $napcatDir 'launcher.bat') -ArgumentList $napcatArgs `
            -WorkingDirectory $napcatDir -WindowStyle Minimized
        }
    }

    # 控制台
    if (-not (Test-Port 7799)) {
        $now = Get-Date
        [void]$restarts.Add($now)
        $recent = $restarts | Where-Object { ($now - $_) -lt [TimeSpan]::FromMinutes(10) }
        if ($recent.Count -ge 5) {
            Write-Log '10 分钟内崩了 5 次，停止自动重启（多半是真 bug）'
            exit 1
        }

        $node = Get-NodePath
        if (-not $node) {
            Write-Log '找不到 node，无法重启控制台'
        } else {
            $proc = Start-Process -FilePath $node -ArgumentList 'tools/console.ts' `
                -WorkingDirectory $root -WindowStyle Hidden -PassThru
            Write-Log "控制台不在，已重启（PID $($proc.Id)）"

            # 必须把新 PID 写回去：否则「停止.bat」会去杀一个早就死掉的进程，
            # 结果显示"已停止"，其实还在跑
            $runtimePath = Join-Path $dataDir 'runtime.json'
            try {
                if (Test-Path $runtimePath) {
                    $runtime = Get-Content $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
                } else {
                    $runtime = [pscustomobject]@{}
                }
                $runtime | Add-Member -NotePropertyName consolePid -NotePropertyValue $proc.Id -Force
                $runtime | Add-Member -NotePropertyName startedAt -NotePropertyValue (Get-Date).ToString('s') -Force
                # 先写临时文件再替换，避免正写着被打断留下半截 JSON
                $tmpRuntime = "$runtimePath.tmp"
                $runtime | ConvertTo-Json | Set-Content $tmpRuntime -Encoding UTF8
                Move-Item -Force $tmpRuntime $runtimePath
            } catch {
                Write-Log '更新 runtime.json 失败，停止时可能杀错进程'
            }
        }
    }
}
