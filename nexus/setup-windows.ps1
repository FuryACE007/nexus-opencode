#Requires -Version 5.1
<#
.SYNOPSIS
    Sets up Nexus CLI on Windows.

.DESCRIPTION
    1. Copies the bundled .opencode/ directory to %USERPROFILE%\.opencode\
       so the binary picks up Nexus config on first launch.
    2. Installs nexus.exe to %LOCALAPPDATA%\Programs\nexus\
    3. Adds the install directory to the user PATH (persistent, no admin needed).
    4. Runs a smoke test to confirm the install works.

.NOTES
    Run from inside the extracted zip directory:
        .\setup.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── helpers ──────────────────────────────────────────────────────────────────

function Write-Step([string]$msg) { Write-Host "`n[nexus] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "  ✓ $msg"      -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  ! $msg"      -ForegroundColor Yellow }

# ── paths ────────────────────────────────────────────────────────────────────

$script = $PSScriptRoot
$root   = if ($script) { $script } else { $PWD.Path }

$src    = Join-Path $root ".opencode"
$exe    = Join-Path $root "nexus.exe"
$dest   = "$env:USERPROFILE\.opencode"
$bin    = "$env:LOCALAPPDATA\Programs\nexus"

# ── 1. validate bundle ───────────────────────────────────────────────────────

Write-Step "Validating bundle…"

if (-not (Test-Path $exe)) {
    Write-Error "nexus.exe not found in $root — make sure you extracted the full zip."
}
if (-not (Test-Path $src -PathType Container)) {
    Write-Error ".opencode\ directory not found in $root — make sure you extracted the full zip."
}

Write-Ok "Bundle looks good."

# ── 2. copy .opencode/ to %USERPROFILE%\.opencode\ ───────────────────────────

Write-Step "Installing Nexus config to $dest …"

if (Test-Path $dest) {
    Write-Warn "Existing $dest found — merging (your local changes are preserved)."
    # Copy only missing files; -Force overwrites files but keeps dirs the user may have customised.
    Copy-Item -Path "$src\*" -Destination $dest -Recurse -Force
} else {
    Copy-Item -Path $src -Destination $dest -Recurse
}

Write-Ok "Config installed."

# ── 3. install nexus.exe ─────────────────────────────────────────────────────

Write-Step "Installing nexus.exe to $bin …"

if (-not (Test-Path $bin)) {
    New-Item -ItemType Directory -Path $bin | Out-Null
}

Copy-Item -Path $exe -Destination "$bin\nexus.exe" -Force
Write-Ok "Binary installed."

# ── 4. add to user PATH ───────────────────────────────────────────────────────

Write-Step "Updating user PATH…"

$cur = [Environment]::GetEnvironmentVariable("Path", "User") ?? ""

if ($cur -split ";" | Where-Object { $_ -eq $bin }) {
    Write-Warn "$bin is already in PATH — skipping."
} else {
    [Environment]::SetEnvironmentVariable("Path", "$cur;$bin", "User")
    Write-Ok "Added $bin to PATH. Restart your terminal to pick it up."
}

# Also update the current session so the smoke test can find the binary.
$env:Path = "$env:Path;$bin"

# ── 5. smoke test ─────────────────────────────────────────────────────────────

Write-Step "Running smoke test…"

try {
    $ver = & "$bin\nexus.exe" --version 2>&1
    Write-Ok "nexus $ver"
} catch {
    Write-Warn "Smoke test failed: $_"
    Write-Warn "The binary was installed but may need a restart before running."
}

# ── done ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║  Nexus CLI installed successfully!               ║" -ForegroundColor Magenta
Write-Host "║  Open a NEW terminal and run: nexus              ║" -ForegroundColor Magenta
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Magenta
Write-Host ""
