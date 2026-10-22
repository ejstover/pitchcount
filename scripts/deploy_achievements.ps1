param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$taskRepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRepoRoot
$script:workerSecret = $null
function Invoke-Supabase([string[]]$CliArgs) {
    $result = & npx --no-install supabase @CliArgs 2>&1
    $taskExit = $LASTEXITCODE
    $output = $result | Out-String
    if ($script:workerSecret) { $output = $output.Replace($script:workerSecret, '[redacted]') }
    Write-Output $output.Trim()
    if ($taskExit -ne 0) { throw "Supabase command failed: $($CliArgs[0]) $($CliArgs[1])" }
}
$preview = Invoke-Supabase -CliArgs @('db','push','--dry-run')
Write-Output $preview
$metadata = ($preview -split '\r?\n' | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json
$expected = @('202610220001_achievements.sql','202610220002_player_usernames.sql','202610220003_achievement_restore.sql')
if ($null -eq $metadata -or @($metadata.migrations | Where-Object { $_ -notin $expected }).Count -gt 0) {
    throw 'Unexpected pending migrations. Review the dry run before deployment.'
}
if ($DryRun) { return }
Invoke-Supabase -CliArgs @('db','push','--yes')
$taskArtifacts = Join-Path $taskRepoRoot '.test-artifacts'
New-Item -ItemType Directory -Path $taskArtifacts -Force | Out-Null
$taskEnvPath = Join-Path $taskArtifacts 'achievement-worker.env.local'
$taskSqlPath = Join-Path $taskArtifacts 'achievement-worker-private.sql'
$projectRef = (Get-Content -LiteralPath (Join-Path $taskRepoRoot 'supabase/.temp/project-ref') -Raw).Trim()
if ($projectRef -notmatch '^[a-z0-9]{20}$') { throw 'Invalid linked Supabase project reference.' }
$script:workerSecret = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
try {
    [System.IO.File]::WriteAllText($taskEnvPath, "ACHIEVEMENT_WORKER_SECRET=$($script:workerSecret)`n")
    Invoke-Supabase -CliArgs @('secrets','set','--env-file',$taskEnvPath)
    Invoke-Supabase -CliArgs @('functions','deploy','accounts','--use-api')
    Invoke-Supabase -CliArgs @('functions','deploy','achievements','--use-api')
    $template = @'
create extension if not exists supabase_vault;
do $setup$
declare secret_id uuid;
begin
 select id into secret_id from vault.secrets where name='achievement_worker_secret';
 if secret_id is null then perform vault.create_secret('{{SECRET}}','achievement_worker_secret');
 else perform vault.update_secret(secret_id,'{{SECRET}}','achievement_worker_secret');end if;
 select id into secret_id from vault.secrets where name='achievement_worker_url';
 if secret_id is null then perform vault.create_secret('https://{{PROJECT}}.supabase.co/functions/v1/achievements','achievement_worker_url');
 else perform vault.update_secret(secret_id,'https://{{PROJECT}}.supabase.co/functions/v1/achievements','achievement_worker_url');end if;
end $setup$;
'@
    $sql = $template.Replace('{{SECRET}}',$script:workerSecret).Replace('{{PROJECT}}',$projectRef)
    $sql += "`n" + (Get-Content -LiteralPath (Join-Path $taskRepoRoot 'supabase/achievement-scheduler.sql') -Raw)
    $sql += @'

select net.http_post(
 url:=(select decrypted_secret from vault.decrypted_secrets where name='achievement_worker_url'),
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='achievement_worker_secret')),
 body:='{}'::jsonb,
 timeout_milliseconds:=120000
) as backfill_request;
'@
    [System.IO.File]::WriteAllText($taskSqlPath,$sql)
    Invoke-Supabase -CliArgs @('db','query','--linked','--file',$taskSqlPath)
    Write-Output 'Achievement backend deployed. Frontend publishing is separate.'
} finally {
    Remove-Item -LiteralPath $taskEnvPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $taskSqlPath -Force -ErrorAction SilentlyContinue
    $script:workerSecret = $null
}
