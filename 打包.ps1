# 打包发布：生成一个可以发给别人的压缩包
#
# 关键约束：绝不能把你的 Key、聊天记录、日志打进去。
# 只发代码和启动脚本，对方第一次运行会自己生成 data\。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 同时存在 NO_PROXY 和 no_proxy 时 Start-Process 会抛异常，先清掉
foreach ($name in @('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$out = Join-Path $root "群聊AI-$stamp.zip"
$temp = Join-Path ([System.IO.Path]::GetTempPath()) "ship-$stamp"

Write-Host ''
Write-Host '  打包发布包'
Write-Host '  ─────────────────────────────'

# 只复制需要发布的东西：白名单比黑名单安全
$include = @(
    'src', 'tools', 'docs', 'test',
    'launcher.ps1', 'watchdog.ps1', 'stop.ps1', 'autostart.ps1',
    'prepare-runtime.ps1', '启动.bat', '停止.bat', '准备运行环境.bat', '打包.ps1',
    '开机自启.bat', '取消自启.bat', '打包.bat',
    'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
    'README.md', '使用说明.txt', '.gitignore',
    'Dockerfile', 'docker-compose.yml', 'deploy.sh',
    '.env.example', 'config.example.json'
)

New-Item -ItemType Directory -Path $temp -Force | Out-Null
$copied = 0
foreach ($item in $include) {
    $from = Join-Path $root $item
    if (-not (Test-Path $from)) { continue }
    $to = Join-Path $temp $item
    if ((Get-Item $from).PSIsContainer) {
        robocopy $from $to /E /NFL /NDL /NJH /NJS /NP | Out-Null
    } else {
        Copy-Item $from $to -Force
    }
    $copied += 1
}
Write-Host "  [1/3] 已收集 $copied 项"

# 发布包里不应该有这些：再扫一遍，防止手滑
$danger = @('console.json', 'runtime.json', 'watchdog.json', '*.log', '*.db', '*.db-wal', '*.db-shm')
foreach ($pattern in $danger) {
    Get-ChildItem -Path $temp -Recurse -Filter $pattern -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            Write-Host ("  清理: " + $_.FullName.Substring($temp.Length + 1))
            Remove-Item $_.FullName -Force
        }
}
foreach ($dir in @('data', 'runtime', 'node_modules', '.git')) {
    $p = Join-Path $temp $dir
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Write-Host '  [2/3] 已清理个人数据'

# 自查：包里还有没有像是 Key 的东西
$leak = Get-ChildItem $temp -Recurse -File |
    Select-String -Pattern 'sk-[0-9a-f]{20,}' -ErrorAction SilentlyContinue
if ($leak) {
    Write-Host '  !! 发现疑似 API Key，已中止打包：'
    $leak | ForEach-Object { Write-Host ("     " + $_.Path) }
    Remove-Item $temp -Recurse -Force
    exit 1
}
Write-Host '  [3/3] 敏感信息自查通过'

Compress-Archive -Path (Join-Path $temp '*') -DestinationPath $out -Force
Remove-Item $temp -Recurse -Force

$sizeMb = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host ''
Write-Host "  完成：$out"
Write-Host "  大小：$sizeMb MB"
Write-Host ''
Write-Host '  对方拿到后：解压 → 双击「准备运行环境.bat」→ 双击「启动.bat」'
Write-Host '  不需要 Node、不需要命令行。'
Write-Host ''
