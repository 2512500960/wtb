Param(
  # 也可以在命令行覆盖：
  #   powershell -ExecutionPolicy Bypass -File .\build_tools\fetch_element_release.ps1 -Version v1.12.10
  [string]$Version = 'v1.12.10'
)

$ErrorActionPreference = 'Stop'

# 版本号要求：release tag 形式（例如 v1.12.10）。
if ([string]::IsNullOrWhiteSpace($Version)) {
  throw 'Version is required (e.g. v1.12.10).'
}
if (-not $Version.StartsWith('v')) {
  $Version = 'v' + $Version
}

$assetName = "element-$Version.tar.gz"
$downloadUrl = "https://github.com/element-hq/element-web/releases/download/$Version/$assetName"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$targetDir = Join-Path $repoRoot 'assets\element'

# Preserve an existing config.json if user customized it.
$existingConfigJson = $null
try {
  $existingConfigPath = Join-Path $targetDir 'config.json'
  if (Test-Path $existingConfigPath) {
    $existingConfigJson = Get-Content -Raw -Path $existingConfigPath
  }
} catch {
  $existingConfigJson = $null
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("wtb-element-{0}" -f ([System.Guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Path $tempDir | Out-Null

$archivePath = Join-Path $tempDir $assetName

Write-Host ("Downloading Element Web {0}..." -f $Version)
Write-Host ("URL: {0}" -f $downloadUrl)
Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath

Write-Host 'Extracting...'
# tarball 一般会包含一个顶层目录：element-vX.Y.Z/
$extractDir = Join-Path $tempDir 'extract'
New-Item -ItemType Directory -Path $extractDir | Out-Null

Push-Location $extractDir
try {
  # Windows 10+ ships bsdtar as `tar`
  tar -xf $archivePath
} finally {
  Pop-Location
}

$topDir = Join-Path $extractDir "element-$Version"
if (-not (Test-Path $topDir)) {
  # 兼容 archive 顶层目录命名不完全一致的情况：要求“只有一个顶层目录”
  $dirs = Get-ChildItem -Path $extractDir -Directory
  if ($dirs.Count -ne 1) {
    throw "Unexpected archive layout. Expected a single top-level directory, got $($dirs.Count)."
  }
  $topDir = $dirs[0].FullName
}

$indexPath = Join-Path $topDir 'index.html'
if (-not (Test-Path $indexPath)) {
  throw "Extracted content does not look like Element Web (missing index.html under $topDir)."
}

Write-Host ("Installing into {0}" -f $targetDir)
if (Test-Path $targetDir) {
  Remove-Item -Recurse -Force $targetDir
}
New-Item -ItemType Directory -Path $targetDir | Out-Null

# 将整个 web root（顶层目录内的全部文件）完整拷贝到 assets/element/
Copy-Item -Recurse -Force (Join-Path $topDir '*') $targetDir

# Ensure Element has config.json (otherwise it errors: "default server not specified").
try {
  $configPath = Join-Path $targetDir 'config.json'
  if ($existingConfigJson) {
    $existingConfigJson | Out-File -FilePath $configPath -Encoding utf8
  } elseif (-not (Test-Path $configPath)) {
    $samplePath = Join-Path $targetDir 'config.sample.json'
    if (Test-Path $samplePath) {
      Copy-Item -Force $samplePath $configPath
    } else {
      @(
        '{',
        '  "default_server_config": {',
        '    "m.homeserver": { "base_url": "https://matrix.org", "server_name": "matrix.org" }',
        '  },',
        '  "disable_custom_urls": false',
        '}'
      ) | Out-File -FilePath $configPath -Encoding utf8
    }
  }

  # Element may request host-specific config first: config.<hostname>.json
  # Our offline integration serves from 127.0.0.1, so create these aliases.
  if (Test-Path $configPath) {
    $cfg = Get-Content -Raw -Path $configPath
    foreach ($name in @('config.127.0.0.1.json', 'config.localhost.json')) {
      $p = Join-Path $targetDir $name
      if (-not (Test-Path $p)) {
        $cfg | Out-File -FilePath $p -Encoding utf8
      }
    }
  }
} catch {
  # ignore
}

Write-Host ("Done. Element version: {0}" -f $Version)
Write-Host 'You can now run the app and click Matrix (Element).'

# Best-effort cleanup
try {
  if (Test-Path $tempDir) {
    Remove-Item -Recurse -Force $tempDir
  }
} catch {
  # ignore
}
