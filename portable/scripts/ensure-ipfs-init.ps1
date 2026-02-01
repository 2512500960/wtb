$ErrorActionPreference = 'Stop'

$portableRoot = Split-Path -Parent $PSScriptRoot
$ipfsExe = Join-Path $portableRoot 'bin\ipfs\ipfs.exe'
$ipfsPath = Join-Path $portableRoot 'data\ipfs'
$configPath = Join-Path $ipfsPath 'config'

if (-not (Test-Path $ipfsExe)) {
  throw "Missing IPFS(Kubo) binary: $ipfsExe`nPut kubo ipfs.exe into portable\\bin\\ipfs\\"
}

New-Item -ItemType Directory -Force -Path $ipfsPath | Out-Null

if (-not (Test-Path $configPath)) {
  $env:IPFS_PATH = $ipfsPath
  & $ipfsExe init --profile=lowpower
  Write-Host "Initialized IPFS repo at: $ipfsPath"
} else {
  Write-Host "IPFS repo already initialized: $ipfsPath"
}
