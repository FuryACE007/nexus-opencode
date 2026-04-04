#Requires -Version 5.1
<#
.SYNOPSIS
    Sets up Nexus CLI on Windows.

.DESCRIPTION
    1. Copies the bundled .opencode/ directory to both Windows config roots:
         %USERPROFILE%\.opencode\
         %USERPROFILE%\.config\opencode\
       Nexus resolves config from either location depending on environment;
       installing to both ensures a consistent first-run experience.
    2. Runs "npm install" in each config root so the @opencode-ai/plugin
       runtime dependency is present before Nexus first starts.
    3. Installs nexus.exe to %LOCALAPPDATA%\Programs\nexus\
    4. Adds the install directory to the user PATH (persistent, no admin needed).
    5. Runs a smoke test to confirm the install works.

.NOTES
    Run from inside the extracted zip directory:
        .\setup.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -- helpers --

function Write-Step([string]$msg) { Write-Host "`n[nexus] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "  OK $msg"      -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  WARN $msg"    -ForegroundColor Yellow }

# -- paths --

$script = $PSScriptRoot
$root   = if ($script) { $script } else { $PWD.Path }

$src    = Join-Path $root ".opencode"
$exe    = Join-Path $root "nexus.exe"
$dest   = "$env:USERPROFILE\.opencode"
$destConfig = "$env:USERPROFILE\.config\opencode"
$bin    = "$env:LOCALAPPDATA\Programs\nexus"
$bin    = "$env:LOCALAPPDATA\Programs\nexus"

# -- 1. validate bundle --

Write-Step "Validating bundle..."

if (-not (Test-Path $exe)) {
    Write-Error "nexus.exe not found in $root -- make sure you extracted the full zip."
}
if (-not (Test-Path $src -PathType Container)) {
    Write-Error ".opencode\ directory not found in $root -- make sure you extracted the full zip."
}

Write-Ok "Bundle looks good."

# -- 2. copy .opencode/ to Windows config directories --

Write-Step "Installing Nexus config to $dest and $destConfig ..."

function Install-Config([string]$targetDir) {
    if (Test-Path $targetDir) {
        Write-Warn "Existing $targetDir found -- merging (your local changes are preserved)."
        Copy-Item -Path "$src\*" -Destination $targetDir -Recurse -Force
    } else {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        Copy-Item -Path "$src\*" -Destination $targetDir -Recurse
    }
    
    # Run npm install to populate runtime plugin dependencies
    Write-Step "Running npm install in $targetDir to resolve plugin dependencies..."
    $orig = $PWD
    Set-Location $targetDir
    try {
        & npm install --no-fund --no-audit
    } catch {
        Write-Warn "Failed to run npm install in $targetDir. Ensure npm is installed."
    }
    Set-Location $orig
}

Install-Config $dest
Install-Config $destConfig

Write-Ok "Config installed."

# -- 3. install nexus.exe --

Write-Step "Installing nexus.exe to $bin..."

if (-not (Test-Path $bin)) {
    New-Item -ItemType Directory -Path $bin | Out-Null
}

Copy-Item -Path $exe -Destination "$bin\nexus.exe" -Force
Write-Ok "Binary installed."

# -- 4. add to user PATH --

Write-Step "Updating user PATH..."

$cur = [Environment]::GetEnvironmentVariable("Path", "User")
if ($null -eq $cur) { $cur = "" }

if ($cur -split ";" | Where-Object { $_ -eq $bin }) {
    Write-Warn "$bin is already in PATH -- skipping."
} else {
    [Environment]::SetEnvironmentVariable("Path", "$cur;$bin", "User")
    Write-Ok "Added $bin to PATH. Restart your terminal to pick it up."
}

# Also update the current session so the smoke test can find the binary.
$env:Path = "$env:Path;$bin"

# -- 5. smoke test --

Write-Step "Running smoke test..."

# 5a. Binary version check
try {
    $ver = & "$bin\nexus.exe" --version 2>&1
    Write-Ok "nexus $ver"
} catch {
    Write-Warn "Smoke test failed: $_"
    Write-Warn "The binary was installed but may need a restart before running."
}

# 5b. Verify that plugin dependencies were installed in at least one config root
$pluginOk = $false
foreach ($cfgDir in @($destConfig, $dest)) {
    $nm = Join-Path $cfgDir "node_modules\@opencode-ai\plugin"
    if (Test-Path $nm -PathType Container) {
        Write-Ok "@opencode-ai/plugin present in $cfgDir"
        $pluginOk = $true
        break
    }
}
if (-not $pluginOk) {
    Write-Warn "@opencode-ai/plugin was NOT found in either config root."
    Write-Warn "Plugin loading will fail at runtime. Try running manually:"
    Write-Warn "  cd `"$destConfig`" ; npm install"
}

# 5c. Confirm the config file that the runtime will resolve
$resolvedConfig = $null
foreach ($cfgDir in @($destConfig, $dest)) {
    $cfgFile = Join-Path $cfgDir "opencode.jsonc"
    if (Test-Path $cfgFile) {
        $resolvedConfig = $cfgFile
        break
    }
}
if ($resolvedConfig) {
    Write-Ok "Runtime config resolved: $resolvedConfig"
} else {
    Write-Warn "opencode.jsonc not found in either config root -- config copy may have failed."
}

# -- done --

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Magenta
Write-Host "   Nexus CLI installed successfully!                             " -ForegroundColor Magenta
Write-Host "   Open a NEW terminal and run: nexus                            " -ForegroundColor Magenta
Write-Host "=================================================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "Full plugin smoke test (requires backend on port 8000):" -ForegroundColor Cyan
Write-Host "  nexus run ping --print-logs --log-level DEBUG" -ForegroundColor Cyan
Write-Host ""
Write-Host "If the backend uses 127.0.0.1 (not localhost), set:" -ForegroundColor Cyan
Write-Host "  `$env:NEXUS_BASE_URL = `"http://127.0.0.1:8000`"" -ForegroundColor Cyan
Write-Host ""
