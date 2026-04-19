# Grove installer script for Windows
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/GarrickZ2/grove/master/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$Repo = 'GarrickZ2/grove'
$BinaryName = 'grove.exe'

# Default install dir: %LOCALAPPDATA%\Programs\Grove (no admin required)
if (-not $env:GROVE_INSTALL_DIR) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Grove'
} else {
    $InstallDir = $env:GROVE_INSTALL_DIR
}

function Detect-Platform {
    $arch = $env:PROCESSOR_ARCHITECTURE
    # PROCESSOR_ARCHITEW6432 is set for 32-bit processes on 64-bit Windows
    if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }

    switch ($arch) {
        'AMD64' { return 'x86_64-pc-windows-msvc' }
        default {
            Write-Error "Unsupported architecture: $arch (only x86_64 is currently supported on Windows)"
        }
    }
}

function Get-LatestVersion {
    Write-Host 'Fetching latest version...'
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
    } catch {
        Write-Error "Failed to query latest release: $_"
    }
    if (-not $release.tag_name) {
        Write-Error 'Could not determine latest version'
    }
    Write-Host "Latest version: $($release.tag_name)"
    return $release.tag_name
}

function Install-Grove {
    param(
        [string]$Version,
        [string]$Platform
    )

    $assetName = "grove-$Version-$Platform.zip"
    $downloadUrl = "https://github.com/$Repo/releases/download/$Version/$assetName"

    Write-Host "Downloading from: $downloadUrl"

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "grove-install-$([guid]::NewGuid().Guid)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    try {
        $zipPath = Join-Path $tmpDir $assetName
        Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing

        Write-Host 'Extracting archive...'
        Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force

        $extractedBinary = Join-Path $tmpDir $BinaryName
        if (-not (Test-Path $extractedBinary)) {
            Write-Error "Binary '$BinaryName' not found in archive"
        }

        # Ensure install directory exists
        if (-not (Test-Path $InstallDir)) {
            New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        }

        $targetPath = Join-Path $InstallDir $BinaryName

        # If grove is currently running, the move will fail. Hint the user.
        try {
            Move-Item -Path $extractedBinary -Destination $targetPath -Force
        } catch {
            Write-Error "Failed to install to $targetPath. If Grove is running, close it and retry. ($_)"
        }

        Write-Host ''
        Write-Host "Grove installed to: $targetPath" -ForegroundColor Green
        return $targetPath
    } finally {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Update-UserPath {
    param([string]$Dir)

    # Read user PATH (not the merged process PATH)
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }

    $segments = $userPath -split ';' | Where-Object { $_ -ne '' }
    if ($segments -contains $Dir) {
        Write-Host "$Dir is already on your user PATH."
        return $false
    }

    $newPath = if ($userPath) { "$userPath;$Dir" } else { $Dir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')

    # Also update current session
    $env:Path = "$env:Path;$Dir"

    Write-Host "Added $Dir to your user PATH." -ForegroundColor Green
    Write-Host 'Restart your terminal for the PATH change to take effect in new shells.'
    return $true
}

function Main {
    Write-Host 'Installing Grove...'
    Write-Host ''

    $platform = Detect-Platform
    Write-Host "Detected platform: $platform"

    $version = Get-LatestVersion
    $binaryPath = Install-Grove -Version $version -Platform $platform

    Update-UserPath -Dir $InstallDir | Out-Null

    Write-Host ''
    Write-Host "Run 'grove' to get started." -ForegroundColor Cyan
    Write-Host "Binary location: $binaryPath"
}

Main
