[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$RuntimeDirectory,
 [ValidateSet('Check','Once','Watch','Recover')][string]$Mode='Check'
)
$ErrorActionPreference='Stop'
$runtimeRoot=(Resolve-Path -LiteralPath $RuntimeDirectory).Path
$installation=Get-Content -LiteralPath (Join-Path $runtimeRoot 'installation.json') -Raw | ConvertFrom-Json
$runtimeFile=Join-Path $runtimeRoot 'runtime.json'
& $installation.node_path $installation.launcher_path ('--'+$Mode.ToLowerInvariant()) --config $runtimeFile
exit $LASTEXITCODE
