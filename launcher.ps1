# 一键启动：NapCat + 控制台 + 浏览器
#
# 双击「启动.bat」即可，不需要命令行。
# 逻辑：能起来就起，已经在跑就跳过，绝不重复启动。

$ErrorActionPreference = 'Stop'

# Windows 上如果同时存在 NO_PROXY 和 no_proxy，PowerShell 5.1 的 Start-Process
# 会直接抛"字典中已添加项"导致启动器起不来。清掉重复的小写版本。
foreach ($name in @('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root 'data'
$statePath = Join-Path $dataDir 'runtime.json'
# 不要写死安装位置：别人可能装在 D 盘或项目目录下
$napcatDir = ''
foreach ($candidate in @($env:NAPCAT_DIR, (Join-Path $root 'napcat'), 'C:\napcat', 'D:\napcat')) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'launcher.bat'))) { $napcatDir = $candidate; break }
}

if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Force $dataDir | Out-Null }

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

Write-Host ''
Write-Host '  群聊 AI · 启动中'
Write-Host '  ─────────────────────────────'
Write-Host ''

# ---- 读取上次配置的 QQ 号（用于快速登录，免得每次扫码）----
$uin = ''
$cfgPath = Join-Path $dataDir 'console.json'
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.channels -and $cfg.channels.Count -gt 0) { $uin = [string]$cfg.channels[0].selfId }
    } catch { }
}

# ---- 1. NapCat ----
if (Test-Port 3001) {
    Write-Host '  [1/3] NapCat 已在运行'
} elseif (-not $napcatDir) {
    Write-Host '  [1/3] 找不到 NapCat（可设环境变量 NAPCAT_DIR 指定位置）'
    Write-Host '        请先按教程安装 NapCat，或修改 launcher.ps1 里的 napcatDir'
} elseif (Get-Process -Name QQ -ErrorAction SilentlyContinue) {
    # QQ 已开但 3001 不通：多半停在登录页，再拉一次会开第二个 QQ
    Write-Host '  [1/3] QQ 已在运行但没连上，请看屏幕是否停在登录页（扫码后会自动连上）'
} else {
    $napcatArgs = @()
    if ($uin -ne '') { $napcatArgs += $uin }
    Start-Process -FilePath (Join-Path $napcatDir 'launcher.bat') `
        -ArgumentList $napcatArgs -WorkingDirectory $napcatDir -WindowStyle Minimized
    if ($uin -ne '') { Write-Host "  [1/3] 已启动 NapCat（快速登录 $uin）" }
    else { Write-Host '  [1/3] 已启动 NapCat（需要扫码登录）' }
}

# ---- 2. 控制台 ----
if (Test-Port 7799) {
    Write-Host '  [2/3] 控制台已在运行'
} else {
    $bundled = Join-Path $root 'runtime\node.exe'
    $node = if (Test-Path $bundled) { $bundled } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
    if (-not $node) {
        Write-Host '  [2/3] 找不到 Node.js'
        Write-Host '        双击「准备运行环境.bat」自动下载，或手动装： https://nodejs.org/'
        Write-Host ''
        Read-Host '  按回车退出'
        exit 1
    }

    # 版本检查：低于 24 会在加载 .ts 时抛一句看不懂的错，不如在这里说清楚
    try {
        $versionText = (& $node -v 2>$null).Trim()
        $major = [int](($versionText -replace '^v', '') -split '\.')[0]
        if ($major -lt 24) {
            Write-Host "  [2/3] Node.js 版本太旧（当前 $versionText，需要 24 或更高）"
            Write-Host '        双击「准备运行环境.bat」会自动装一个可用的版本'
            Write-Host ''
            Read-Host '  按回车退出'
            exit 1
        }
    } catch {
        # 版本号读不出来就继续，交给后面启动时的报错兜底
    }

    $proc = Start-Process -FilePath $node -ArgumentList 'tools/console.ts' `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru

    @{ consolePid = $proc.Id; startedAt = (Get-Date).ToString('s'); qq = $uin } |
        ConvertTo-Json | Set-Content $statePath -Encoding UTF8

    Write-Host "  [2/3] 控制台已启动（PID $($proc.Id)）"
}

# ---- 2.5 看门狗：崩了自动拉起 ----
$watchdogState = Join-Path $dataDir 'watchdog.json'
$watchdogAlive = $false
if (Test-Path $watchdogState) {
    try {
        $ws = Get-Content $watchdogState -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($ws.pid) {
            $p = Get-Process -Id $ws.pid -ErrorAction SilentlyContinue
            if ($p) { $watchdogAlive = $true }
        }
    } catch { }
}

if (-not $watchdogAlive) {
    Start-Process -FilePath 'powershell' `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'watchdog.ps1') `
        -WorkingDirectory $root -WindowStyle Hidden
    Write-Host '  [2/3] 看门狗已启动（崩了会自动拉起）'
}

# ---- 3. 等就绪，开浏览器 ----
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    if (Test-Port 7799) { $ready = $true; break }
    Start-Sleep -Milliseconds 400
}

if ($ready) {
    Start-Process 'http://127.0.0.1:7799'
    Write-Host '  [3/3] 浏览器已打开 http://127.0.0.1:7799'
} else {
    Write-Host '  [3/3] 控制台没起来，请检查是否被安全软件拦截'
}

Write-Host ''
Write-Host '  ─────────────────────────────'
Write-Host '  关掉浏览器不影响运行；要停止请双击「停止.bat」'
Write-Host ''
Start-Sleep -Seconds 2
