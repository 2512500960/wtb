$ErrorActionPreference = 'Stop'

$portableRoot = Split-Path -Parent $PSScriptRoot
$yggExe = Join-Path $portableRoot 'bin\yggdrasil\yggdrasil.exe'
$confDir = Join-Path $portableRoot 'config\yggdrasil'
$confPath = Join-Path $confDir 'yggdrasil.conf'

if (-not (Test-Path $yggExe)) {
  throw "Missing yggdrasil binary: $yggExe`nPut your compiled yggdrasil.exe into portable\\bin\\yggdrasil\\"
}

New-Item -ItemType Directory -Force -Path $confDir | Out-Null

& $yggExe -genconf | Out-File -FilePath $confPath -Encoding utf8

Write-Host "Generated: $confPath"
