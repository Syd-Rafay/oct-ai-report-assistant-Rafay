param(
  [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$BackupRoot = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path "AFIO_BACKUPS")
)

$ErrorActionPreference = "Stop"

$git = "C:\Users\DELL\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe"
if (-not (Test-Path $git)) {
  $git = "git"
}

$commit = ""
try {
  $commit = (& $git -C $SourceRoot rev-parse --short HEAD 2>$null).Trim()
} catch {
  $commit = ""
}
if (-not $commit) {
  $commit = "nogit"
}
$commit = ($commit -replace '[^a-zA-Z0-9._-]', '')
if (-not $commit) {
  $commit = "nogit"
}

$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$snapshotName = "${timestamp}_${commit}"
$snapshotName = ($snapshotName -replace '[^a-zA-Z0-9._-]', '_')
$snapshotRoot = [System.IO.Path]::Combine($BackupRoot, $snapshotName)
$latestRoot = [System.IO.Path]::Combine($BackupRoot, "latest")

New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
if (Test-Path $latestRoot) {
  Remove-Item -LiteralPath $latestRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $snapshotRoot | Out-Null

$robocopyArgs = @(
  $SourceRoot,
  $snapshotRoot,
  "/MIR",
  "/NFL",
  "/NDL",
  "/NJH",
  "/NJS",
  "/NP",
  "/R:1",
  "/W:1",
  "/XD", ".git", ".next", "node_modules", "out", "dist", "coverage", "__pycache__",
  "/XF", "*.pyc", "*.log", "*.tsbuildinfo"
)

& robocopy @robocopyArgs
$snapshotCopyCode = $LASTEXITCODE
if ($snapshotCopyCode -ge 8) {
  throw "Robocopy failed while creating the snapshot copy. Exit code: $snapshotCopyCode"
}

New-Item -ItemType Directory -Force -Path $latestRoot | Out-Null
$latestArgs = @(
  $snapshotRoot,
  $latestRoot,
  "/MIR",
  "/NFL",
  "/NDL",
  "/NJH",
  "/NJS",
  "/NP",
  "/R:1",
  "/W:1"
)

& robocopy @latestArgs
$latestCopyCode = $LASTEXITCODE
if ($latestCopyCode -ge 8) {
  throw "Robocopy failed while updating latest snapshot. Exit code: $latestCopyCode"
}

$manifest = [ordered]@{
  timestamp = $timestamp
  commit = $commit
  source_root = $SourceRoot
  backup_root = $BackupRoot
  snapshot = $snapshotName
  notes = "Generated from the current AFIO working tree. Secrets are excluded by convention."
}

$manifestPath = [System.IO.Path]::Combine($snapshotRoot, "snapshot-manifest.json")
$latestManifestPath = [System.IO.Path]::Combine($latestRoot, "snapshot-manifest.json")
$manifestJson = $manifest | ConvertTo-Json -Depth 4
Set-Content -LiteralPath $manifestPath -Value $manifestJson -Encoding UTF8
Set-Content -LiteralPath $latestManifestPath -Value $manifestJson -Encoding UTF8

$logLine = "{0}`t{1}`t{2}" -f $timestamp, $commit, $snapshotName
$auditLog = [System.IO.Path]::Combine($BackupRoot, "snapshot-log.tsv")
Add-Content -LiteralPath $auditLog -Value $logLine -Encoding UTF8

Write-Host "Snapshot saved to $snapshotRoot"
Write-Host "Latest snapshot updated at $latestRoot"
Write-Host "Commit: $commit"
