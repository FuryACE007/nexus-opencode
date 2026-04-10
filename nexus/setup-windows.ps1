#Requires -Version 5.1
<#
.SYNOPSIS
    Sets up Nexus CLI on Windows.

.DESCRIPTION
    1. Validates the extracted bundle (nexus.exe + .opencode/).
    2. Copies .opencode/ to the Windows config root:
         %USERPROFILE%\.config\opencode\
       This is where the runtime resolves config via XDG conventions.
    3. Ensures plugin dependencies are present (pre-installed in bundle;
       falls back to npm/bun install if node_modules are missing).
    4. Installs nexus.exe to %LOCALAPPDATA%\Programs\nexus\
    5. Adds the install directory to the user PATH (no admin needed).
    6. Runs a smoke test to confirm the install works.

.NOTES
    Run from inside the extracted zip directory:
        .\setup.ps1
    Or double-click install.bat for automatic ExecutionPolicy bypass.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -- helpers --

function Write-Step([string]$msg) { Write-Host "`n[nexus] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "  OK  $msg"    -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  WARN $msg"   -ForegroundColor Yellow }

# -- paths --

$root       = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD.Path }
$src        = Join-Path $root ".opencode"
$exe        = Join-Path $root "nexus.exe"
$dest       = "$env:USERPROFILE\.config\opencode"
$bin        = "$env:LOCALAPPDATA\Programs\nexus"

# -- 1. validate bundle --

Write-Step "Validating bundle..."

if (-not (Test-Path $exe)) {
    Write-Error "nexus.exe not found in $root — make sure you extracted the full zip."
}
if (-not (Test-Path $src -PathType Container)) {
    Write-Error ".opencode\ directory not found in $root — make sure you extracted the full zip."
}

$requiredFiles = @(
    (Join-Path $src "opencode.jsonc"),
    (Join-Path $src "plugins\nexus.ts"),
    (Join-Path $src "package.json")
)
foreach ($f in $requiredFiles) {
    if (-not (Test-Path $f)) {
        Write-Error "Bundle is incomplete — missing: $f`nRe-download the zip from the release page."
    }
}

Write-Ok "Bundle is complete."

# -- 2. copy .opencode/ to config directory --

Write-Step "Installing Nexus config to $dest ..."

if (Test-Path $dest) {
    Write-Warn "Existing $dest found — merging (local changes preserved)."
    Copy-Item -Path "$src\*" -Destination $dest -Recurse -Force
} else {
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item -Path "$src\*" -Destination $dest -Recurse
}

Write-Ok "Config installed."

# -- 3. ensure plugin dependencies --

Write-Step "Checking plugin dependencies..."

$pluginDir = Join-Path $dest "node_modules\@opencode-ai\plugin"

if (Test-Path $pluginDir -PathType Container) {
    Write-Ok "@opencode-ai/plugin already present (pre-installed in bundle)."
} else {
    Write-Warn "node_modules not found — attempting install..."

    # Find a package manager
    $pm = $null
    if (Get-Command bun  -ErrorAction SilentlyContinue) { $pm = "bun" }
    elseif (Get-Command npm -ErrorAction SilentlyContinue) { $pm = "npm" }

    if (-not $pm) {
        Write-Error @"
Plugin dependencies are missing and no package manager (npm or bun) was found.

Install Node.js from https://nodejs.org (includes npm), then re-run this script.
Alternatively, install Bun from https://bun.sh
"@
    }

    $orig = $PWD
    Set-Location $dest
    try {
        if ($pm -eq "bun") {
            & bun install --no-save 2>&1
        } else {
            & npm install --no-fund --no-audit 2>&1
        }
    } catch {
        Set-Location $orig
        Write-Error "Plugin install failed: $_`nEnsure $pm is working correctly, then re-run this script."
    }
    Set-Location $orig

    if (-not (Test-Path $pluginDir -PathType Container)) {
        Write-Error "@opencode-ai/plugin was not installed. Check $pm output above and retry."
    }

    Write-Ok "@opencode-ai/plugin installed via $pm."
}

# -- 4. install nexus.exe --

Write-Step "Installing nexus.exe to $bin ..."

if (-not (Test-Path $bin)) {
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
}

Copy-Item -Path $exe -Destination "$bin\nexus.exe" -Force
Write-Ok "Binary installed."

# -- 5. add to user PATH --

Write-Step "Updating user PATH..."

$cur = [Environment]::GetEnvironmentVariable("Path", "User")
if ($null -eq $cur) { $cur = "" }

if ($cur -split ";" | Where-Object { $_ -eq $bin }) {
    Write-Warn "$bin already in PATH — skipping."
} else {
    [Environment]::SetEnvironmentVariable("Path", "$cur;$bin", "User")
    Write-Ok "Added $bin to PATH. Open a new terminal to pick it up."
}

# Update current session so smoke test can find the binary
$env:Path = "$env:Path;$bin"

# -- 6. smoke test --

Write-Step "Running smoke test..."

try {
    $ver = & "$bin\nexus.exe" --version 2>&1
    Write-Ok "nexus $ver"
} catch {
    Write-Warn "Binary smoke test failed: $_"
    Write-Warn "The binary was installed but may need a terminal restart."
}

$cfgFile = Join-Path $dest "opencode.jsonc"
if (Test-Path $cfgFile) {
    Write-Ok "Runtime config found: $cfgFile"
} else {
    Write-Warn "opencode.jsonc not found at $cfgFile — config copy may have failed."
}

# -- done --

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Magenta
Write-Host "   Nexus CLI installed!                                          " -ForegroundColor Magenta
Write-Host "   Open a NEW terminal and run: nexus                            " -ForegroundColor Magenta
Write-Host "=================================================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "Full smoke test (requires backend on port 8000):" -ForegroundColor Cyan
Write-Host "  nexus run ping --print-logs --log-level DEBUG" -ForegroundColor Cyan
Write-Host ""
Write-Host "Custom backend URL:" -ForegroundColor Cyan
Write-Host "  `$env:NEXUS_BASE_URL = `"http://127.0.0.1:8000`"" -ForegroundColor Cyan
Write-Host ""
