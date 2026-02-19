Param(
  [string]$Version = "latest"
)

$ErrorActionPreference = 'Stop'

function Get-RepoLatestRelease() {
  $headers = @{ 'User-Agent' = 'wtb-fetch-cinny' }
  return Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/cinnyapp/cinny/releases/latest'
}

function Get-RepoReleaseByTag([string]$tag) {
  $headers = @{ 'User-Agent' = 'wtb-fetch-cinny' }
  return Invoke-RestMethod -Headers $headers -Uri ("https://api.github.com/repos/cinnyapp/cinny/releases/tags/{0}" -f $tag)
}

$release = if ($Version -eq 'latest' -or [string]::IsNullOrWhiteSpace($Version)) {
  Get-RepoLatestRelease
} else {
  Get-RepoReleaseByTag $Version
}

if (-not $release -or -not $release.assets) {
  throw "No release/assets found for version '$Version'."
}

$asset = $release.assets | Where-Object { $_.name -match '\.tar\.gz$' -or $_.name -match '\.tgz$' } | Select-Object -First 1
if (-not $asset) {
  throw "No .tar.gz/.tgz asset found in release '$($release.tag_name)'."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$targetDir = Join-Path $repoRoot 'assets\cinny'

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("wtb-cinny-{0}" -f ([System.Guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Path $tempDir | Out-Null

$archivePath = Join-Path $tempDir $asset.name
Write-Host ("Downloading {0}..." -f $asset.browser_download_url)
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archivePath

Write-Host 'Extracting...'
# Windows 10+ ships bsdtar as `tar`
Push-Location $tempDir
try {
  tar -xf $archivePath
} finally {
  Pop-Location
}

# Find dist directory inside extracted content
$distDir = Get-ChildItem -Path $tempDir -Recurse -Directory -Filter 'dist' | Select-Object -First 1
if (-not $distDir) {
  throw "Could not find 'dist' directory in extracted archive."
}

Write-Host ("Copying dist -> {0}" -f $targetDir)
if (Test-Path $targetDir) {
  Remove-Item -Recurse -Force $targetDir
}
New-Item -ItemType Directory -Path $targetDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $distDir.FullName '*') $targetDir

# Best-effort patch: enable hashRouter for file:// usage
$configPath = Join-Path $targetDir 'config.json'
if (Test-Path $configPath) {
  try {
    $json = Get-Content $configPath -Raw | ConvertFrom-Json
    if (-not $json.hashRouter) { $json | Add-Member -NotePropertyName hashRouter -NotePropertyValue (@{}) }
    $json.hashRouter.enabled = $true
    if (-not $json.hashRouter.basename) { $json.hashRouter.basename = '/' }
    $json | ConvertTo-Json -Depth 50 | Out-File -FilePath $configPath -Encoding utf8
  } catch {
    Write-Warning "Failed to patch config.json: $($_.Exception.Message)"
  }
}

Write-Host ("Done. Cinny version: {0}, asset: {1}" -f $release.tag_name, $asset.name)
Write-Host 'You can now run the app and click Matrix (Cinny).'
