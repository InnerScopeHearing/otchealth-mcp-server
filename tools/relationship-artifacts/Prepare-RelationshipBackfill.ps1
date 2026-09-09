[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$InstallDirectory,
 [Parameter(Mandatory)][string]$NodePath,
 [Parameter(Mandatory)][string]$CtoRoot,
 [Parameter(Mandatory)][string]$CfoProjectConfig,
 [Parameter(Mandatory)][string]$CodexPath,
 [Parameter(Mandatory)][string]$CohortId,
 [Parameter(Mandatory)][string]$Producer,
 [ValidateSet('signed-review','candidate-only')][string]$ReviewMode='candidate-only',
 [string]$RegistryId,
 [string]$RegistryVersion,
 [string]$RegistryPublicKeyFile,
 [string]$RegistryAuthorityFile
)
$ErrorActionPreference='Stop'
function Write-Utf8File {param([Parameter(ValueFromPipeline)][string]$Text,[string]$Path) process{[IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($false))}}
foreach($label in @($CohortId,$Producer)){if($label -cnotmatch '^[a-z][a-z0-9-]{0,63}$'){throw 'Invalid runtime identity'}}
$nodeBinary=(Resolve-Path -LiteralPath $NodePath).Path
$codexBinary=(Resolve-Path -LiteralPath $CodexPath).Path
$ctoDirectory=(Resolve-Path -LiteralPath $CtoRoot).Path
$cfoConfig=(Resolve-Path -LiteralPath $CfoProjectConfig).Path
if(([IO.Path]::GetFileName($cfoConfig) -ine 'config.toml') -or ([IO.Path]::GetFileName((Split-Path -Parent $cfoConfig)) -ine '.codex') -or ([IO.Path]::GetFileName((Split-Path -Parent (Split-Path -Parent $cfoConfig))) -ine 'CFO')){throw 'CFO project config required'}
$registryConfig=$null
if($ReviewMode -eq 'signed-review'){
$registryKey=(Resolve-Path -LiteralPath $RegistryPublicKeyFile).Path
$authority=Get-Content -LiteralPath (Resolve-Path -LiteralPath $RegistryAuthorityFile).Path -Raw | ConvertFrom-Json
$registryConfig=@{id=$RegistryId;version=$RegistryVersion;public_key_file=$registryKey;authority=$authority}
}
if([IO.Path]::GetFileName($codexBinary) -ine 'codex.exe'){throw 'Codex executable required'}
$runtimeRoot=[IO.Path]::GetFullPath($InstallDirectory)
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$hostFile=Join-Path $runtimeRoot 'host.json'
@{schema='company-catalog-controller-host-v1';seat='cfo';binary=$codexBinary;cohort_id=$CohortId} | ConvertTo-Json | Write-Utf8File -Path $hostFile
@{schema='relationship-backfill-runtime-v1';cto_root=$ctoDirectory;host_config=$hostFile;outbox_directory=(Join-Path $runtimeRoot 'outbox');cfo_project_config=$cfoConfig;producer=$Producer;review_mode=$ReviewMode;registry=$registryConfig} | ConvertTo-Json -Depth 8 | Write-Utf8File -Path (Join-Path $runtimeRoot 'runtime.json')
@{node_path=$nodeBinary;launcher_path=(Join-Path $PSScriptRoot 'full-backfill-cli.mjs')} | ConvertTo-Json | Write-Utf8File -Path (Join-Path $runtimeRoot 'installation.json')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Start-RelationshipBackfill.ps1') -Destination (Join-Path $runtimeRoot 'Start-RelationshipBackfill.ps1') -Force
# Preparation performs local validation only. It does not register or start a scheduled job.
& $nodeBinary (Join-Path $PSScriptRoot 'full-backfill-cli.mjs') --check --config (Join-Path $runtimeRoot 'runtime.json')
if($LASTEXITCODE -ne 0){throw 'Relationship runtime is not ready'}
Write-Output 'Prepared only. Scheduler not registered or activated. CFO authorization is read in memory from the designated CFO project at runtime.'
