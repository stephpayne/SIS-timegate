# =============================================================================
# Timegate installer (PowerShell)
#
#   Usage:  .\install-timegate.ps1 -Package C:\path\to\unzipped-scorm-folder
#
# Deploys ..\src into the package under ONE version-free folder name (DeployDir).
# No path here is named after a version. See ..\MAINTAINING.md.
# =============================================================================
Param(
  [Parameter(Mandatory = $true)][string]$Package
)

# ---- The ONE place the in-package folder name is defined --------------------
$DeployDir = 'timegate'

$SrcDir = (Resolve-Path (Join-Path $PSScriptRoot '..\src')).Path
$Root   = (Resolve-Path $Package).Path
$manifest = Join-Path $Root 'imsmanifest.xml'
if (!(Test-Path $manifest)) {
  Write-Host "imsmanifest.xml not found in $Root"
  Write-Host "(Point this at the UNZIPPED SCORM folder, where imsmanifest.xml lives.)"
  exit 1
}

# ---- 1. Copy runtime into <scorm>\<DeployDir>\ ------------------------------
$dest = Join-Path $Root $DeployDir
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $SrcDir 'timegate.js')  (Join-Path $dest 'timegate.js')  -Force
Copy-Item (Join-Path $SrcDir 'timegate.css') (Join-Path $dest 'timegate.css') -Force
if (!(Test-Path (Join-Path $dest 'timegate.config.json'))) {
  Copy-Item (Join-Path $SrcDir 'timegate.config.json') (Join-Path $dest 'timegate.config.json') -Force
}

# ---- 2. Inject + register in manifest ---------------------------------------
[xml]$xml = Get-Content $manifest
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace('imscp', 'http://www.imsproject.org/xsd/imscp_rootv1p1p2')
$ns.AddNamespace('adlcp', 'http://www.adlnet.org/xsd/adlcp_rootv1p2')
$resource = $xml.SelectSingleNode('//imscp:resource[@adlcp:scormtype="sco"]', $ns)
if ($null -eq $resource) { Write-Host 'No SCO resource found in manifest.'; exit 1 }
$launchHref = $resource.GetAttribute('href')
if ([string]::IsNullOrWhiteSpace($launchHref)) { Write-Host 'SCO resource does not specify href.'; exit 1 }
$launchPath = Join-Path $Root $launchHref
if (!(Test-Path $launchPath)) { Write-Host "Launch file not found: $launchPath"; exit 1 }

$launchDir = Split-Path $launchPath -Parent
$launchDirUri = New-Object System.Uri(($launchDir + [System.IO.Path]::DirectorySeparatorChar), [System.UriKind]::Absolute)
$jsUri  = New-Object System.Uri((Resolve-Path (Join-Path $dest 'timegate.js')).Path,  [System.UriKind]::Absolute)
$cssUri = New-Object System.Uri((Resolve-Path (Join-Path $dest 'timegate.css')).Path, [System.UriKind]::Absolute)
$relJs  = $launchDirUri.MakeRelativeUri($jsUri).ToString()  -replace '\\','/'
$relCss = $launchDirUri.MakeRelativeUri($cssUri).ToString() -replace '\\','/'

$html = Get-Content $launchPath -Raw
if ($html -notmatch 'data-timegate="true"') {
  $inject = "  <link rel=`"stylesheet`" href=`"$relCss`" data-timegate=`"true`">`n  <script defer src=`"$relJs`" data-timegate=`"true`"></script>"
  if ($html -match '</head>') { $html = $html -replace '</head>', ($inject + "`n</head>") }
  elseif ($html -match '</body>') { $html = $html -replace '</body>', ($inject + "`n</body>") }
  else { $html = $html + "`n" + $inject + "`n" }
  Set-Content -Path $launchPath -Value $html -Encoding utf8
}

$hrefs = @("$DeployDir/timegate.js", "$DeployDir/timegate.css", "$DeployDir/timegate.config.json")
$rawBytes = [System.IO.File]::ReadAllBytes($manifest)
$hasBom = ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF)
$manifestText = [System.Text.Encoding]::UTF8.GetString($rawBytes)
if ($manifestText.Length -gt 0 -and $manifestText[0] -eq [char]0xFEFF) { $manifestText = $manifestText.Substring(1) }
$newline = if ($manifestText -match "`r`n") { "`r`n" } else { "`n" }

$resourcePattern = '<(?<prefix>\w+:)?resource\b[^>]*>'
$scormPattern = "\b[\w:]*scormtype\s*=\s*[""']sco[""']"
$hrefPattern = "\bhref\s*=\s*[""']{0}[""']" -f [regex]::Escape($launchHref)
$resourceMatch = $null
foreach ($m in [regex]::Matches($manifestText, $resourcePattern, 'IgnoreCase')) {
  if (-not [regex]::IsMatch($m.Value, $scormPattern, 'IgnoreCase')) { continue }
  if ($launchHref -and -not [regex]::IsMatch($m.Value, $hrefPattern, 'IgnoreCase')) { continue }
  $resourceMatch = $m; break
}
if ($null -eq $resourceMatch) { Write-Host 'Failed to locate SCO resource in manifest text.'; exit 1 }
$prefix = $resourceMatch.Groups['prefix'].Value
$closeTag = "</$prefix" + "resource>"
$closeIdx = $manifestText.IndexOf($closeTag, $resourceMatch.Index + $resourceMatch.Length)
if ($closeIdx -lt 0) { Write-Host 'Failed to locate closing tag.'; exit 1 }
$resourceBlock = $manifestText.Substring($resourceMatch.Index + $resourceMatch.Length, $closeIdx - ($resourceMatch.Index + $resourceMatch.Length))
$missing = @()
foreach ($href in $hrefs) {
  $p = "\bhref\s*=\s*[""']{0}[""']" -f [regex]::Escape($href)
  if (-not [regex]::IsMatch($resourceBlock, $p)) { $missing += $href }
}
if ($missing.Count -gt 0) {
  $indent = '  '
  foreach ($m in [regex]::Matches($resourceBlock, "(?m)^(?<indent>[ \t]*)<${prefix}file\b")) { $indent = $m.Groups['indent'].Value }
  $spaceBeforeSlash = $true
  $sample = $null
  foreach ($m in [regex]::Matches($resourceBlock, "<${prefix}file\b[^>]*?/>")) { $sample = $m }
  if ($sample) { $spaceBeforeSlash = $sample.Value -match ' />' }
  $tail = [regex]::Match($resourceBlock, '[ \t]*$').Value
  $insertPos = $closeIdx - $tail.Length
  $before = $manifestText.Substring(0, $insertPos)
  $lead = if (-not ($before.EndsWith("`n") -or $before.EndsWith("`r`n"))) { $newline } else { '' }
  $lines = $missing | ForEach-Object {
    if ($spaceBeforeSlash) { "$indent<${prefix}file href=`"$_`" />" } else { "$indent<${prefix}file href=`"$_`"/>" }
  }
  $insertion = $lead + ($lines -join $newline) + $newline
  $manifestText = $manifestText.Insert($insertPos, $insertion)
  $utf8 = New-Object System.Text.UTF8Encoding($hasBom)
  [System.IO.File]::WriteAllText($manifest, $manifestText, $utf8)
}
Write-Host "Timegate runtime installed into $DeployDir/ and registered in manifest (launch: $launchHref)"

# ---- 3. Zip ------------------------------------------------------------------
$baseName = Split-Path $Root -Leaf
$outputZip = Join-Path (Split-Path $Root -Parent) "$baseName-timegate.zip"
if (Test-Path $outputZip) { Remove-Item $outputZip -Force }
$zip = Get-Command zip -ErrorAction SilentlyContinue
if ($null -ne $zip) {
  Push-Location $Root; & $zip.Path -r -q $outputZip . -x "*.DS_Store" -x "__MACOSX/*"; Pop-Location
} elseif (Get-Command Compress-Archive -ErrorAction SilentlyContinue) {
  $items = Get-ChildItem -Path $Root -Force | Where-Object { $_.Name -ne '__MACOSX' -and $_.Name -ne '.DS_Store' }
  Compress-Archive -Path $items.FullName -DestinationPath $outputZip
} else { Write-Host "No zip tool available; runtime installed but no zip produced."; exit 0 }
Write-Host "Done: $outputZip"
