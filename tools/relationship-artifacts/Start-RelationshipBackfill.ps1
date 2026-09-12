[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$RuntimeDirectory,
 [ValidateSet('Check','Once','Watch','Recover','ResumeReview')][string]$Mode='Check'
)
$ErrorActionPreference='Stop'
$runtimeRoot=(Resolve-Path -LiteralPath $RuntimeDirectory).Path
$installation=Get-Content -LiteralPath (Join-Path $runtimeRoot 'installation.json') -Raw | ConvertFrom-Json
$runtimeFile=Join-Path $runtimeRoot 'runtime.json'
$argument=if($Mode -eq 'ResumeReview'){'--resume-review'}else{'--'+$Mode.ToLowerInvariant()}
& $installation.node_path $installation.launcher_path $argument --config $runtimeFile
exit $LASTEXITCODE
