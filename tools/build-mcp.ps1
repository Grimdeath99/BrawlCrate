[CmdletBinding()]
param(
    [string]$OutputDirectory = 'artifacts/BrawlCrate-MCP',
    [string]$MSBuildPath,
    [switch]$SkipRestore,
    [switch]$BuildColorSmash,
    [switch]$NoZip
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoPrefix = $repoRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$packagePath = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
    [IO.Path]::GetFullPath($OutputDirectory)
} else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
}
if (!$packagePath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be inside this repository.'
}
if ($packagePath -eq $repoRoot -or (Test-Path -LiteralPath $packagePath)) {
    throw "Output already exists: $packagePath. Choose a new OutputDirectory to preserve prior packages."
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command exited with code $LASTEXITCODE" }
}

if (!$MSBuildPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $MSBuildPath = & $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild/Current/Bin/MSBuild.exe' | Select-Object -First 1
    }
}
if (!$MSBuildPath -or !(Test-Path -LiteralPath $MSBuildPath)) {
    throw 'Visual Studio MSBuild is required for legacy .NET Framework binary resources. Supply -MSBuildPath if it is not auto-detected.'
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = & $nodePath --version
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node.js 22 or later is required.' }
$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
$msbuildVersion = (& $MSBuildPath -version -nologo | Select-Object -Last 1).Trim()
$dotnetSdkVersion = (& dotnet --version).Trim()
$npmVersion = (& $npmPath --version).Trim()
$safeTargets = Join-Path $PSScriptRoot 'Mcp.Build.targets'
$stagePath = Join-Path $repoRoot ('artifacts/mcp-build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagePath -Force | Out-Null
$buildProperties = @('-p:Configuration=Release', '-p:Platform=x86', "-p:CustomAfterMicrosoftCommonTargets=$safeTargets", '-p:AppendTargetFrameworkToOutputPath=false')

Push-Location $repoRoot
try {
    $projects = @('BrawlCrate/BrawlCrate.csproj', 'Updater/Updater.csproj', 'BrawlCrate.Mcp.Worker/BrawlCrate.Mcp.Worker.csproj')
    if (!$SkipRestore) {
        foreach ($project in $projects) {
            Invoke-Checked 'dotnet' @('restore', $project, '--locked-mode', '-p:Configuration=Release', '-p:Platform=x86', '--nologo')
        }
    }
    foreach ($entry in @(@{Project=$projects[0]; Name='app'}, @{Project=$projects[1]; Name='updater'}, @{Project=$projects[2]; Name='worker'})) {
        $buildOutput = (Join-Path $stagePath $entry.Name) + [IO.Path]::DirectorySeparatorChar
        Invoke-Checked $MSBuildPath (@($entry.Project, '-t:Build', '-nologo', '-verbosity:minimal') + $buildProperties + @("-p:OutputPath=$buildOutput"))
    }

    if ($BuildColorSmash) {
        Push-Location (Join-Path $repoRoot 'ColorSmash')
        try {
            Invoke-Checked 'cargo' @('build', '--locked', '--release', '--target', 'i686-pc-windows-msvc')
        } finally { Pop-Location }
        Copy-Item -LiteralPath (Join-Path $repoRoot 'ColorSmash/target/i686-pc-windows-msvc/release/color_smash.exe') -Destination (Join-Path $stagePath 'app')
    }

    # Fresh outputs contain project runtime dependencies, never developer plugins.
    New-Item -ItemType Directory -Path $packagePath -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $stagePath 'app') -Destination $packagePath -Recurse
    Copy-Item -LiteralPath (Join-Path $stagePath 'worker') -Destination $packagePath -Recurse
    Get-ChildItem -LiteralPath (Join-Path $stagePath 'updater') -File | Where-Object { $_.Extension -in @('.dll', '.exe', '.config') } | Copy-Item -Destination (Join-Path $packagePath 'app')
    $appPath = Join-Path $packagePath 'app'
    $apiPath = Join-Path $appPath 'BrawlAPI'
    New-Item -ItemType Directory -Path (Join-Path $apiPath 'Lib'), (Join-Path $apiPath 'Plugins'), (Join-Path $apiPath 'Loaders') -Force | Out-Null
    $trackedResources = & git -c "safe.directory=$($repoRoot.Replace('\','/'))" ls-files -- 'BrawlCrate/API/Resources'
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate tracked API resources.' }
    foreach ($relativeFile in $trackedResources) {
        $resourceTarget = Join-Path $apiPath $relativeFile.Substring('BrawlCrate/API/'.Length)
        New-Item -ItemType Directory -Path (Split-Path $resourceTarget) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repoRoot $relativeFile) -Destination $resourceTarget
    }
    if (Test-Path -LiteralPath (Join-Path $appPath 'lib')) {
        # Unlike legacy packaging, preserve the source copy and avoid deletion.
        Copy-Item -LiteralPath (Join-Path $appPath 'lib') -Destination (Join-Path $apiPath 'Lib/Python') -Recurse
    }
    # Package only repository-tracked documentation, excluding local module maps.
    $internalDocs = & git -c "safe.directory=$($repoRoot.Replace('\','/'))" ls-files -- 'BrawlLib/InternalDocumentation'
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate tracked application documentation.' }
    foreach ($relativeFile in $internalDocs) {
        $docTarget = Join-Path $appPath $relativeFile.Substring('BrawlLib/'.Length)
        New-Item -ItemType Directory -Path (Split-Path $docTarget) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repoRoot $relativeFile) -Destination $docTarget
    }

    $serverPath = Join-Path $packagePath 'server'
    New-Item -ItemType Directory -Path $serverPath -Force | Out-Null
    foreach ($serverFile in @('server.mjs', 'package.json', 'package-lock.json')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot "mcp/$serverFile") -Destination $serverPath
    }
    if (Test-Path -LiteralPath (Join-Path $repoRoot 'mcp/lib')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot 'mcp/lib') -Destination $serverPath -Recurse
    }
    Push-Location $serverPath
    try {
        Invoke-Checked $npmPath @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', (Join-Path $repoRoot '.cache/npm'))
    } finally { Pop-Location }

    $docsPath = Join-Path $packagePath 'docs'
    New-Item -ItemType Directory -Path $docsPath -Force | Out-Null
    Get-ChildItem -Path (Join-Path $repoRoot 'docs/mcp*') -File | Copy-Item -Destination $docsPath
    foreach ($folder in @('tests', 'config')) {
        $sourcePath = Join-Path $repoRoot "mcp/$folder"
        $targetPath = if ($folder -eq 'tests') { $serverPath } else { $packagePath }
        if (Test-Path -LiteralPath $sourcePath) { Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Recurse }
    }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $packagePath
    Copy-Item -LiteralPath (Join-Path $repoRoot 'BrawlCrate/packages.lock.json') -Destination (Join-Path $docsPath 'BrawlCrate.packages.lock.json')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'BrawlLib/packages.lock.json') -Destination (Join-Path $docsPath 'BrawlLib.packages.lock.json')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'Updater/packages.lock.json') -Destination (Join-Path $docsPath 'Updater.packages.lock.json')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'BrawlCrate.Mcp.Worker/packages.lock.json') -Destination (Join-Path $docsPath 'Worker.packages.lock.json')

    # Include the integration source for review; rebuilding still requires the
    # full repository's existing BrawlLib and GUI source projects.
    $workerSourcePath = Join-Path $packagePath 'source/BrawlCrate.Mcp.Worker'
    $toolsSourcePath = Join-Path $packagePath 'source/tools'
    New-Item -ItemType Directory -Path $workerSourcePath, $toolsSourcePath -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $repoRoot 'BrawlCrate.Mcp.Worker') -File | Where-Object {
        $_.Extension -in @('.cs', '.csproj') -or $_.Name -eq 'packages.lock.json'
    } | Copy-Item -Destination $workerSourcePath
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-mcp.ps1'), (Join-Path $PSScriptRoot 'finalize-mcp.ps1'), $safeTargets -Destination $toolsSourcePath
    'These are the MCP integration source additions. Rebuilding requires the complete BrawlCrate repository, including BrawlLib, BrawlCrate, Updater, and mcp. Server JavaScript source is in ../server.' | Set-Content -LiteralPath (Join-Path $packagePath 'source/README.txt') -Encoding UTF8

    $limitations = @('Node.js 22+ and .NET Framework 4.7.2+ are external runtime prerequisites.', 'MCP operates a dedicated worker document, independent of any GUI document.', 'Interactive GUI editing and native audio/graphics workflows require user verification.')
    if (!$BuildColorSmash) { $limitations += 'Optional color_smash.exe is omitted. Build with -BuildColorSmash and the i686-pc-windows-msvc Rust target to include it.' }
    [ordered]@{
        package='BrawlCrate-MCP'; createdUtc=[DateTime]::UtcNow.ToString('o'); applicationVersion='0.42.0.1'; architecture='Windows x86 worker and GUI'; nodeBuildVersion=$nodeVersion;
        msbuildPath=$MSBuildPath; msbuildVersion=$msbuildVersion; dotnetSdkVersion=$dotnetSdkVersion; npmVersion=$npmVersion; colorSmashIncluded=[bool]$BuildColorSmash; limitations=$limitations
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $packagePath 'package-manifest.json') -Encoding UTF8
    # -NoZip leaves the directory ready for validation and final evidence.
    # Generate final checksums only when producing the delivery archive.
    if (!$NoZip) {
        & (Join-Path $PSScriptRoot 'finalize-mcp.ps1') -PackageDirectory $packagePath
    }
    Write-Host "Package: $packagePath"
    Write-Host "Build intermediates retained: $stagePath"
} finally { Pop-Location }
