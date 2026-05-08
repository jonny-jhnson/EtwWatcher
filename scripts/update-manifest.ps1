<#
.SYNOPSIS
Regenerates snapshots/manifest.json from the .ndjson files in snapshots/.

.DESCRIPTION
Scans snapshots/*.ndjson, reads each file's header line to extract OSVersion,
sorts entries by OSVersion (numeric segments), and writes the manifest.

Existing labels are preserved so customizations like "(Insider)" survive
re-runs. Files no longer present are dropped from the manifest. New files
get a default label of "Build <OSVersion>".

.EXAMPLE
PS> .\scripts\update-manifest.ps1

Run from the repo root after dropping a new .ndjson into snapshots/.
#>
[CmdletBinding()]
param(
    [string]$Root,
    [string]$ManifestPath
)

if (-not $Root) { $Root = Join-Path $PSScriptRoot '../snapshots' }
if (-not $ManifestPath) { $ManifestPath = Join-Path $Root 'manifest.json' }

if (-not (Test-Path $Root)) {
    throw "Snapshots directory not found: $Root"
}
$Root = (Resolve-Path $Root).Path

function Get-VersionSortKey {
    param([string]$Version)
    # Pad each numeric segment so 10.0.26200.7171 sorts before 10.0.28020.1921
    $sb = New-Object System.Text.StringBuilder
    foreach ($p in ($Version -split '\.')) {
        $n = 0
        if ([int]::TryParse($p, [ref]$n)) {
            [void]$sb.Append($n.ToString('D10')).Append('.')
        } else {
            [void]$sb.Append($p).Append('.')
        }
    }
    return $sb.ToString()
}

# Preserve any existing custom labels
$existingLabels = @{}
if (Test-Path $ManifestPath) {
    try {
        $existing = Get-Content $ManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        foreach ($s in @($existing.snapshots)) {
            if ($s.file) { $existingLabels[$s.file] = $s.label }
        }
    } catch {
        Write-Warning "Could not parse existing manifest at ${ManifestPath}: $($_.Exception.Message). Starting fresh."
    }
}

$entries = @()
$files = Get-ChildItem -Path $Root -Filter '*.ndjson' -File -ErrorAction SilentlyContinue
foreach ($f in $files) {
    $firstLine = Get-Content -Path $f.FullName -TotalCount 1 -ErrorAction SilentlyContinue
    if ([string]::IsNullOrWhiteSpace($firstLine)) {
        Write-Warning "Skipping empty file: $($f.Name)"
        continue
    }
    try {
        $header = $firstLine | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-Warning "Skipping $($f.Name): first line is not valid JSON"
        continue
    }
    if (-not $header.OSVersion) {
        Write-Warning "Skipping $($f.Name): header has no OSVersion"
        continue
    }
    $label = $existingLabels[$f.Name]
    if (-not $label) {
        $label = "Build $($header.OSVersion)"
        # Filename-driven annotations. Add more here as needed.
        $base = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
        if ($base -match '(?i)_Server')  { $label += ' (Server)' }
        if ($base -match '(?i)_Insider') { $label += ' (Insider)' }
    }

    $entries += [pscustomobject]@{
        file = $f.Name
        label = $label
        osVersion = [string]$header.OSVersion
        _sortKey = Get-VersionSortKey ([string]$header.OSVersion)
    }
}

if ($entries.Count -eq 0) {
    Write-Warning "No valid snapshots found in $Root. Manifest not written."
    exit 1
}

$sorted = @($entries | Sort-Object _sortKey)

# Write JSON by hand for clean 2-space indentation. PS 5.1's ConvertTo-Json
# produces an awkward deeply-aligned format that's valid but ugly to read.
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('{')
$lines.Add('  "snapshots": [')
for ($i = 0; $i -lt $sorted.Count; $i++) {
    $e = $sorted[$i]
    $sep = if ($i -lt $sorted.Count - 1) { ',' } else { '' }
    $lines.Add('    {')
    $lines.Add('      "file": ' + (ConvertTo-Json $e.file -Compress) + ',')
    $lines.Add('      "label": ' + (ConvertTo-Json $e.label -Compress) + ',')
    $lines.Add('      "osVersion": ' + (ConvertTo-Json $e.osVersion -Compress))
    $lines.Add('    }' + $sep)
}
$lines.Add('  ]')
$lines.Add('}')

$json = ($lines -join [Environment]::NewLine) + [Environment]::NewLine
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ManifestPath, $json, $utf8NoBom)

Write-Host ("Wrote {0} entries to {1}" -f $sorted.Count, $ManifestPath)
foreach ($e in $sorted) {
    Write-Host ("  {0,-32} {1,-22} {2}" -f $e.file, $e.osVersion, $e.label)
}
