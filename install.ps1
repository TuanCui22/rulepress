<#
.SYNOPSIS
    rulepress installer for Windows.

.DESCRIPTION
    Installs rulepress globally with npm so the `rulepress` command works from
    any directory. Checks the Node version first and tells you exactly what to
    do if it is too old.

.EXAMPLE
    # from a clone
    .\install.ps1

.EXAMPLE
    # one-liner (run in PowerShell)
    irm https://raw.githubusercontent.com/TuanCui22/rulepress/master/install.ps1 | iex

.NOTES
    If PowerShell blocks the script, run it with:
      powershell -ExecutionPolicy Bypass -File .\install.ps1
#>

[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$MinNode = 18
$RepoUrl = 'https://github.com/TuanCui22/rulepress.git'

function Write-Ok   { param($m) Write-Host "  " -NoNewline; Write-Host "[OK]" -ForegroundColor Green -NoNewline; Write-Host " $m" }
function Write-Warn { param($m) Write-Host "  " -NoNewline; Write-Host "[!]"  -ForegroundColor Yellow -NoNewline; Write-Host " $m" }
function Write-Err  { param($m) Write-Host "  " -NoNewline; Write-Host "[X]"  -ForegroundColor Red -NoNewline; Write-Host " $m" }
function Write-Step { param($m) Write-Host "  $m" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "rulepress installer" -ForegroundColor Cyan
Write-Host "Elastic detection-rule TOML -> Kibana NDJSON" -ForegroundColor DarkGray
Write-Host ""

# ---- 1. Node present and new enough -------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Err "Node.js is not installed."
    Write-Host ""
    Write-Host "  Install Node $MinNode or newer:"
    Write-Host "    https://nodejs.org  (choose LTS)"
    Write-Host "    or with winget:  winget install OpenJS.NodeJS.LTS"
    Write-Host ""
    exit 1
}

$nodeVersion = (& node --version).Trim()
$nodeMajor = [int]($nodeVersion -replace '^v', '' -split '\.')[0]

if ($nodeMajor -lt $MinNode) {
    Write-Err "Node $nodeVersion is too old. rulepress needs $MinNode or newer."
    Write-Host ""
    Write-Host "  Upgrade with one of:"
    Write-Host "    winget upgrade OpenJS.NodeJS.LTS"
    Write-Host "    or download from https://nodejs.org"
    Write-Host ""
    exit 1
}
Write-Ok "Node $nodeVersion"

# ---- 2. npm present ------------------------------------------------------
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    Write-Err "npm not found. It ships with Node; reinstall Node from https://nodejs.org"
    exit 1
}
Write-Ok "npm $(& npm --version)"

# ---- 3. locate the package ----------------------------------------------
$pkgDir = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'package.json'))) {
    $pkgDir = $PSScriptRoot
    Write-Ok "using local checkout: $pkgDir"
} else {
    $tmp = Join-Path $env:TEMP ("rulepress-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    Write-Step "downloading source..."

    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        & git clone --depth 1 $RepoUrl (Join-Path $tmp 'rulepress') 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Err "git clone failed. Check your network."; exit 1 }
    } else {
        $zip = Join-Path $tmp 'rulepress.zip'
        try {
            Invoke-WebRequest -Uri 'https://github.com/TuanCui22/rulepress/archive/refs/heads/master.zip' `
                -OutFile $zip -UseBasicParsing
            Expand-Archive -Path $zip -DestinationPath $tmp -Force
            $extracted = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like 'rulepress-*' } | Select-Object -First 1
            if ($extracted) { Rename-Item $extracted.FullName (Join-Path $tmp 'rulepress') }
        } catch {
            Write-Err "download failed: $($_.Exception.Message)"
            exit 1
        }
    }
    $pkgDir = Join-Path $tmp 'rulepress'
    if (-not (Test-Path (Join-Path $pkgDir 'package.json'))) {
        Write-Err "download did not produce a package. Aborting."
        exit 1
    }
    Write-Ok "downloaded"
}

# ---- 4. install dependencies --------------------------------------------
Write-Step "installing dependencies..."
Push-Location $pkgDir
try {
    & npm install --omit=dev --no-audit --no-fund 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed inside $pkgDir"; exit 1 }
    Write-Ok "dependencies installed"

    # ---- 5. link the command --------------------------------------------
    Write-Step "installing the rulepress command..."
    & npm install -g . --no-audit --no-fund 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "global install failed; trying npm link"
        & npm link 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "could not link. Run it directly instead:"
            Write-Host "      node `"$pkgDir\bin\rulepress.js`" --help"
        } else {
            Write-Ok "linked with npm link"
        }
    } else {
        Write-Ok "installed globally"
    }
} finally {
    Pop-Location
}

# ---- 6. verify -----------------------------------------------------------
Write-Host ""
$rp = Get-Command rulepress -ErrorAction SilentlyContinue
if ($rp) {
    $ver = (& rulepress --version) 2>$null
    Write-Ok "rulepress $ver is on your PATH"
    Write-Host ""
    Write-Host "Try it:" -ForegroundColor Cyan
    Write-Host "    rulepress --help"
    Write-Host "    rulepress C:\path\to\elastic-rules\rules --bundle rules.ndjson"
    Write-Host ""
    Write-Host "Then: Kibana -> Security -> Detection rules -> Import -> rules.ndjson" -ForegroundColor DarkGray
} else {
    Write-Warn "rulepress is installed but not on your PATH."
    Write-Host "  Add npm's global bin directory to PATH:"
    $npmPrefix = (& npm prefix -g) 2>$null
    Write-Host "    `$env:Path += `";$npmPrefix`""
    Write-Host "  To make it permanent:"
    Write-Host "    [Environment]::SetEnvironmentVariable('Path', `$env:Path, 'User')"
}
Write-Host ""
