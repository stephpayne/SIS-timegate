Param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

# Patch the SCORM manifest and launch HTML, then zip the package.
$manifest = Join-Path $Root 'imsmanifest.xml'
if (!(Test-Path $manifest)) {
  Write-Host "imsmanifest.xml not found in $Root"
  exit 1
}

[xml]$xml = Get-Content $manifest
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace('imscp', 'http://www.imsproject.org/xsd/imscp_rootv1p1p2')
$ns.AddNamespace('adlcp', 'http://www.adlnet.org/xsd/adlcp_rootv1p2')

$resource = $xml.SelectSingleNode('//imscp:resource[@adlcp:scormtype="sco"]', $ns)
if ($null -eq $resource) {
  Write-Host 'No SCO resource found in manifest.'
  exit 1
}

$launchHref = $resource.GetAttribute('href')
if ([string]::IsNullOrWhiteSpace($launchHref)) {
  Write-Host 'SCO resource does not specify href.'
  exit 1
}

$launchPath = Join-Path $Root $launchHref
if (!(Test-Path $launchPath)) {
  Write-Host "Launch file not found: $launchPath"
  exit 1
}

$launchDir = Split-Path $launchPath -Parent
$launchDirUri = New-Object System.Uri(($launchDir + [System.IO.Path]::DirectorySeparatorChar), [System.UriKind]::Absolute)
$jsPath = (Resolve-Path (Join-Path $Root 'timegate-overhaul/timegate.js')).Path
$cssPath = (Resolve-Path (Join-Path $Root 'timegate-overhaul/timegate.css')).Path
$jsUri = New-Object System.Uri($jsPath, [System.UriKind]::Absolute)
$cssUri = New-Object System.Uri($cssPath, [System.UriKind]::Absolute)
$relJs = $launchDirUri.MakeRelativeUri($jsUri).ToString() -replace '\\','/'
$relCss = $launchDirUri.MakeRelativeUri($cssUri).ToString() -replace '\\','/'

$html = Get-Content $launchPath -Raw
if ($html -notmatch 'data-timegate="true"') {
  $inject = @"
  <link rel="stylesheet" href="$relCss" data-timegate="true">
  <script defer src="$relJs" data-timegate="true"></script>
"@
  if ($html -match '</head>') {
    $html = $html -replace '</head>', ($inject + "`n</head>")
  } elseif ($html -match '</body>') {
    $html = $html -replace '</body>', ($inject + "`n</body>")
  } else {
    $html = $html + "`n" + $inject + "`n"
  }
  Set-Content -Path $launchPath -Value $html -Encoding utf8
}

# Update manifest text without reserializing the XML.
$hrefs = @('timegate-overhaul/timegate.js', 'timegate-overhaul/timegate.css', 'timegate-overhaul/timegate.config.json')
$rawBytes = [System.IO.File]::ReadAllBytes($manifest)
$hasBom = $false
if ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
  $hasBom = $true
}
$manifestText = [System.Text.Encoding]::UTF8.GetString($rawBytes)
if ($manifestText.Length -gt 0 -and $manifestText[0] -eq [char]0xFEFF) {
  $manifestText = $manifestText.Substring(1)
}
$newline = if ($manifestText -match "`r`n") { "`r`n" } else { "`n" }

$resourcePattern = '<(?<prefix>\w+:)?resource\b[^>]*>'
$scormPattern = "\b[\w:]*scormtype\s*=\s*[""']sco[""']"
$hrefPattern = "\bhref\s*=\s*[""']{0}[""']" -f [regex]::Escape($launchHref)

$resourceMatch = $null
foreach ($match in [regex]::Matches($manifestText, $resourcePattern, 'IgnoreCase')) {
  $tag = $match.Value
  if (-not [regex]::IsMatch($tag, $scormPattern, 'IgnoreCase')) { continue }
  if ($launchHref -and -not [regex]::IsMatch($tag, $hrefPattern, 'IgnoreCase')) { continue }
  $resourceMatch = $match
  break
}
if ($null -eq $resourceMatch) {
  Write-Host 'Failed to locate SCO resource in manifest text.'
  exit 1
}

$prefix = $resourceMatch.Groups['prefix'].Value
$closeTag = "</$prefix" + "resource>"
$closeIdx = $manifestText.IndexOf($closeTag, $resourceMatch.Index + $resourceMatch.Length)
if ($closeIdx -lt 0) {
  Write-Host 'Failed to locate closing tag for SCO resource in manifest text.'
  exit 1
}

$resourceBlock = $manifestText.Substring($resourceMatch.Index + $resourceMatch.Length, $closeIdx - ($resourceMatch.Index + $resourceMatch.Length))
$missing = @()
foreach ($href in $hrefs) {
  $hrefPatternLocal = "\bhref\s*=\s*[""']{0}[""']" -f [regex]::Escape($href)
  if (-not [regex]::IsMatch($resourceBlock, $hrefPatternLocal)) {
    $missing += $href
  }
}

if ($missing.Count -gt 0) {
  $filePattern = "(?m)^(?<indent>[ \t]*)<${prefix}file\b"
  $indent = $null
  foreach ($match in [regex]::Matches($resourceBlock, $filePattern)) {
    $indent = $match.Groups['indent'].Value
  }
  if ($null -eq $indent) { $indent = '  ' }

  $samplePattern = "<${prefix}file\b[^>]*?/>"
  $sampleMatch = $null
  foreach ($match in [regex]::Matches($resourceBlock, $samplePattern)) {
    $sampleMatch = $match
  }
  $spaceBeforeSlash = $true
  if ($sampleMatch) { $spaceBeforeSlash = $sampleMatch.Value -match ' />' }

  function Make-FileTag([string]$hrefValue, [string]$indentValue, [string]$prefixValue, [bool]$spaceSlash) {
    if ($spaceSlash) {
      return "$indentValue<${prefixValue}file href=`"$hrefValue`" />"
    }
    return "$indentValue<${prefixValue}file href=`"$hrefValue`"/>"
  }

  $tailWsMatch = [regex]::Match($resourceBlock, '[ \t]*$')
  $tailWs = $tailWsMatch.Value
  $insertPos = $closeIdx - $tailWs.Length
  $beforeInsert = $manifestText.Substring(0, $insertPos)
  $needsLeadingNewline = -not ($beforeInsert.EndsWith("`n") -or $beforeInsert.EndsWith("`r`n"))

  $insertionLines = $missing | ForEach-Object { Make-FileTag $_ $indent $prefix $spaceBeforeSlash }
  $leading = $(if ($needsLeadingNewline) { $newline } else { '' })
  $insertion = ($leading + ($insertionLines -join $newline) + $newline)

  $manifestText = $manifestText.Insert($insertPos, $insertion)
  $utf8 = New-Object System.Text.UTF8Encoding($hasBom)
  [System.IO.File]::WriteAllText($manifest, $manifestText, $utf8)
}
Write-Host "Timegate installed into: $launchHref"

# Zip the SCORM package contents if zip or Compress-Archive is available.
$baseName = Split-Path $Root -Leaf
$parentDir = Split-Path $Root -Parent
$outputZip = Join-Path $parentDir "$baseName-timegate.zip"

$zip = Get-Command zip -ErrorAction SilentlyContinue
if ($null -ne $zip) {
  Write-Host "Creating zip: $outputZip"
  Push-Location $Root
  & $zip.Path -r -q $outputZip . -x "*.DS_Store" -x "__MACOSX/*"
  Pop-Location
  Write-Host "Zip complete."
  exit 0
}

if (Get-Command Compress-Archive -ErrorAction SilentlyContinue) {
  Write-Host "Creating zip (Compress-Archive): $outputZip"
  if (Test-Path $outputZip) {
    Remove-Item $outputZip -Force
  }
  $items = Get-ChildItem -Path $Root -Force | Where-Object { $_.Name -ne '__MACOSX' -and $_.Name -ne '.DS_Store' }
  Compress-Archive -Path $items.FullName -DestinationPath $outputZip
  Write-Host "Zip complete."
  exit 0
}

Write-Host "zip command not found and Compress-Archive unavailable; skipping zip step."
