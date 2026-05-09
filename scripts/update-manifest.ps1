<#
.SYNOPSIS
Compresses *.ndjson to *.ndjson.gz and regenerates snapshots/manifest.json.

.DESCRIPTION
- Any plain *.ndjson found in snapshots/ is gzipped in place. The original
  is removed; only the .ndjson.gz remains. (TraceLogging-aware NDJSONs
  routinely exceed GitHub's 100 MB file limit; gzip cuts them ~4-6x to
  comfortably under it.)
- Then scans snapshots/*.ndjson.gz, reads each file's header line to extract
  OSVersion (decompressing as it goes), sorts entries by OSVersion, and
  writes the manifest.

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

function Compress-NdjsonInPlace {
    param([string]$Path)
    $gz = $Path + '.gz'
    $inStream = [System.IO.File]::OpenRead($Path)
    try {
        $outStream = [System.IO.File]::Create($gz)
        try {
            $gzStream = New-Object System.IO.Compression.GZipStream(
                $outStream, [System.IO.Compression.CompressionLevel]::Optimal)
            try {
                $inStream.CopyTo($gzStream)
            } finally {
                $gzStream.Dispose()
            }
        } finally {
            $outStream.Dispose()
        }
    } finally {
        $inStream.Dispose()
    }
    Remove-Item -LiteralPath $Path -Force
}

function Read-FirstLineFromGzip {
    param([string]$Path)
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $gz = New-Object System.IO.Compression.GZipStream(
            $fs, [System.IO.Compression.CompressionMode]::Decompress)
        try {
            $reader = New-Object System.IO.StreamReader($gz)
            try {
                return $reader.ReadLine()
            } finally {
                $reader.Dispose()
            }
        } finally {
            $gz.Dispose()
        }
    } finally {
        $fs.Dispose()
    }
}

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

# Compress any plain .ndjson files first so we only ever ship .ndjson.gz.
$plain = Get-ChildItem -Path $Root -Filter '*.ndjson' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*.ndjson.gz' }
foreach ($p in $plain) {
    Write-Host ("Compressing {0}..." -f $p.Name)
    try {
        Compress-NdjsonInPlace -Path $p.FullName
    } catch {
        Write-Warning ("Failed to compress {0}: {1}" -f $p.Name, $_.Exception.Message)
    }
}

# Preserve any existing custom labels (keyed by current filename, including .gz)
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
$files = Get-ChildItem -Path $Root -Filter '*.ndjson.gz' -File -ErrorAction SilentlyContinue
foreach ($f in $files) {
    try {
        $firstLine = Read-FirstLineFromGzip -Path $f.FullName
    } catch {
        Write-Warning ("Skipping {0}: cannot read header ({1})" -f $f.Name, $_.Exception.Message)
        continue
    }
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
        $base = $f.Name -replace '\.ndjson\.gz$', ''
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
    Write-Host ("  {0,-36} {1,-22} {2}" -f $e.file, $e.osVersion, $e.label)
}
