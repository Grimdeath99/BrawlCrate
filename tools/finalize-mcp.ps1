[CmdletBinding()]
param([string]$PackageDirectory = 'artifacts/BrawlCrate-MCP')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\', '/')
$repoPrefix = $repoRoot + [IO.Path]::DirectorySeparatorChar
$packagePath = if ([IO.Path]::IsPathRooted($PackageDirectory)) {
    [IO.Path]::GetFullPath($PackageDirectory).TrimEnd('\', '/')
} else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot $PackageDirectory)).TrimEnd('\', '/')
}
if (!$packagePath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'PackageDirectory must be an existing package directory inside this repository.'
}
$packageInfo = Get-Item -LiteralPath $packagePath -Force
if (!$packageInfo.PSIsContainer) { throw 'PackageDirectory must be a directory.' }

# Check every ancestor before descending, then check every descendant before
# following it. No junction or symlink can redirect hashing or archive output.
for ($ancestor = $packageInfo; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Reparse-point package ancestor is not allowed: $($ancestor.FullName)"
    }
}
$zipPath = $packagePath + '.zip'
if (Test-Path -LiteralPath $zipPath) { throw "Archive already exists: $zipPath" }
$manifestPath = Join-Path $packagePath 'package-manifest.json'
if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The package manifest is missing.' }

$directories = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
$files = [Collections.Generic.List[IO.FileInfo]]::new()
$directories.Push($packageInfo)
while ($directories.Count -gt 0) {
    foreach ($entry in Get-ChildItem -LiteralPath $directories.Pop().FullName -Force) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse-point package entry is not allowed: $($entry.FullName)"
        }
        if ($entry.PSIsContainer) { $directories.Push($entry) }
        else { $files.Add($entry) }
    }
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.package -ne 'BrawlCrate-MCP') { throw 'The manifest does not identify a BrawlCrate-MCP package.' }

$checksumPath = Join-Path $packagePath 'SHA256SUMS.txt'
$lines = foreach ($file in ($files | Sort-Object FullName)) {
    if ($file.FullName -eq $checksumPath) { continue }
    $relative = $file.FullName.Substring($packagePath.Length + 1).Replace('\', '/')
    '{0}  {1}' -f (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
}
# Finish enumerating and hashing before creating the checksum file, and
# exclude a previous checksum explicitly when refreshing an unarchived package.
[IO.File]::WriteAllLines($checksumPath, [string[]]$lines, [Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($packagePath, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $true)
Write-Host "Checksums: $checksumPath"
Write-Host "Archive: $zipPath"
