param()
$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$target = Join-Path $env:LOCALAPPDATA 'Programs\ompw'
$parent = Split-Path $target
$stage = Join-Path $parent ('ompw-stage-' + [guid]::NewGuid().ToString('N'))
$backup = Join-Path $parent ('ompw-backup-' + [guid]::NewGuid().ToString('N'))
if (-not (Test-Path -LiteralPath (Join-Path $source 'ompw.exe'))) { throw 'Run the installer from the complete ompw program directory.' }
$check = Start-Process -FilePath (Join-Path $source 'ompw.exe') -ArgumentList '--help' -NoNewWindow -Wait -PassThru
if ($check.ExitCode -ne 0) { throw 'Packaged program validation failed.' }
if ([IO.Path]::GetFullPath($source).TrimEnd('\') -ne [IO.Path]::GetFullPath($target).TrimEnd('\')) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    try {
        Copy-Item -LiteralPath $source -Destination $stage -Recurse
        if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup }
        try { Move-Item -LiteralPath $stage -Destination $target }
        catch {
            if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $target }
            throw
        }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    } finally {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Continue }
    }
}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_ })
$present = $entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $target.TrimEnd('\') }
if (-not $present) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $target) -join ';'), 'User')
}
Write-Host "Installed: $target\ompw.exe"
Write-Host 'Open a new terminal, enter a project directory, and run: ompw'
Write-Host 'First launch prompts for local password and authenticator enrollment.'
