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
        'ARM64' { return 'aarch64-pc-windows-msvc' }
        default {
            throw "Unsupported architecture: $arch"
        }
    }
}

function Get-LatestVersion {
    Write-Host 'Fetching latest version...'
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
    } catch {
        throw "Failed to query latest release: $_"
    }
    if (-not $release.tag_name) {
        throw 'Could not determine latest version'
    }
    Write-Host "Latest version: $($release.tag_name)"
    return $release.tag_name
}

# Try to fetch SHA256SUMS for the release and look up the entry for $assetName.
# Returns the lowercase hex digest, or $null if no checksum file is published.
function Get-ExpectedSha256 {
    param(
        [string]$Version,
        [string]$AssetName
    )

    $candidates = @(
        "https://github.com/$Repo/releases/download/$Version/SHA256SUMS",
        "https://github.com/$Repo/releases/download/$Version/sha256sums.txt",
        "https://github.com/$Repo/releases/download/$Version/$AssetName.sha256"
    )

    foreach ($url in $candidates) {
        try {
            $content = (Invoke-WebRequest -Uri $url -UseBasicParsing -ErrorAction Stop).Content
        } catch {
            continue
        }

        # `<asset>.sha256` files are typically just `<digest>  <name>` or even just `<digest>`.
        # SHA256SUMS-style files MUST list the filename — never accept a bare digest from them,
        # otherwise an unrelated 64-hex token (a commit SHA-256 etc.) could be promoted to the
        # asset's expected hash.
        $isAssetSpecific = $url.EndsWith("$AssetName.sha256")
        foreach ($line in ($content -split "`n")) {
            $line = $line.Trim()
            if (-not $line -or $line.StartsWith('#')) { continue }
            if ($line -match '^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$') {
                $digest = $matches[1].ToLowerInvariant()
                $name = if ($matches[2]) { $matches[2].Trim() } else { '' }
                if ($name -ieq $AssetName) {
                    return $digest
                }
                if (-not $name -and $isAssetSpecific) {
                    return $digest
                }
            }
        }
    }

    return $null
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

        # SHA256 verification (best-effort: if the release publishes a SHA256SUMS file
        # we MUST match it; if no checksum file is published we warn and proceed).
        $expected = Get-ExpectedSha256 -Version $Version -AssetName $assetName
        if ($expected) {
            $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $expected) {
                throw "SHA256 mismatch for $assetName.`n  expected: $expected`n  actual:   $actual"
            }
            Write-Host "SHA256 verified." -ForegroundColor Green
        } else {
            Write-Warning "No SHA256SUMS file found for $Version. Skipping checksum verification."
        }

        Write-Host 'Extracting archive...'
        Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force

        $extractedBinary = Join-Path $tmpDir $BinaryName
        if (-not (Test-Path $extractedBinary)) {
            throw "Binary '$BinaryName' not found in archive"
        }

        # Ensure install directory exists
        if (-not (Test-Path $InstallDir)) {
            New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        }

        $targetPath = Join-Path $InstallDir $BinaryName

        # If grove.exe is currently running, Windows holds the file open and a direct
        # overwrite fails. We can usually still RENAME the running binary, then drop
        # the new one in place — the old handle keeps working until the process exits,
        # and the leftover .old file is cleaned on next install.
        $oldBackup = "$targetPath.old"
        if (Test-Path $targetPath) {
            # Try to clear out a stale backup (left over from a prior install).
            if (Test-Path $oldBackup) {
                try {
                    Remove-Item -Path $oldBackup -Force -ErrorAction Stop
                } catch {
                    throw "Failed to remove stale backup $oldBackup. Another Grove process may be holding it open. ($_)"
                }
            }
            # Move existing binary aside. If this fails AND the file is still there,
            # the install Move-Item below would surface a confusing "in use" error;
            # surface a clear message instead.
            try {
                Move-Item -Path $targetPath -Destination $oldBackup -Force -ErrorAction Stop
            } catch {
                if (Test-Path $targetPath) {
                    throw "Failed to replace $targetPath. A running Grove process is holding the binary — please close it and retry. ($_)"
                }
                # else: target vanished between Test-Path and Move-Item — fine, fall through.
            }
        }
        try {
            Move-Item -Path $extractedBinary -Destination $targetPath -Force
        } catch {
            # Restore the original if we moved it aside but couldn't drop in the new one.
            if ((Test-Path $oldBackup) -and -not (Test-Path $targetPath)) {
                Move-Item -Path $oldBackup -Destination $targetPath -Force -ErrorAction SilentlyContinue
            }
            throw "Failed to install to $targetPath. If Grove is running, close it and retry. ($_)"
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

    # Windows PATH is conventionally case-insensitive — normalize before comparing
    # so we don't end up with duplicate entries that differ only in casing or
    # trailing backslash.
    $normalizedTarget = $Dir.TrimEnd('\').ToLowerInvariant()
    $segments = $userPath -split ';' | Where-Object { $_ -ne '' }
    $alreadyPresent = $false
    foreach ($s in $segments) {
        if ($s.TrimEnd('\').ToLowerInvariant() -eq $normalizedTarget) {
            $alreadyPresent = $true
            break
        }
    }
    if ($alreadyPresent) {
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
