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

. (Join-Path $PSScriptRoot 'timegate_config.ps1')

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

# ---- 1. Validate the effective configuration before mutating the package ----
$dest = Join-Path $Root $DeployDir
$configPath = Join-Path $dest 'timegate.config.json'
$effectiveConfig = if (Test-Path -LiteralPath $configPath) {
  $configPath
} else {
  Join-Path $SrcDir 'timegate.config.json'
}
try {
  $effectiveConfigObject = Assert-TimegateConfig $effectiveConfig
} catch {
  Write-Host "Invalid Timegate configuration: $($_.Exception.Message)"
  exit 1
}

# ---- 2. Inject + register in manifest ---------------------------------------
[xml]$xml = Get-Content $manifest
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$packageNamespace = $xml.DocumentElement.NamespaceURI
$adlcpNamespace = $xml.DocumentElement.GetNamespaceOfPrefix('adlcp')
if ([string]::IsNullOrWhiteSpace($packageNamespace) -or [string]::IsNullOrWhiteSpace($adlcpNamespace)) {
  Write-Host 'Manifest is missing its package or ADL namespace.'
  exit 1
}
$ns.AddNamespace('imscp', $packageNamespace)
$ns.AddNamespace('adlcp', $adlcpNamespace)
$resources = @($xml.SelectNodes(
  '//imscp:resource[@adlcp:scormtype="sco" or @adlcp:scormType="sco"]',
  $ns
))
if ($resources.Count -ne 1) {
  Write-Host "Expected exactly one SCO resource; found $($resources.Count)."
  exit 1
}
$resource = $resources[0]
$launchHref = $resource.GetAttribute('href')
if ([string]::IsNullOrWhiteSpace($launchHref)) { Write-Host 'SCO resource does not specify href.'; exit 1 }
$launchPath = Join-Path $Root $launchHref
if (!(Test-Path $launchPath)) { Write-Host "Launch file not found: $launchPath"; exit 1 }

$launchDir = Split-Path $launchPath -Parent
$launchDirUri = New-Object System.Uri(($launchDir + [System.IO.Path]::DirectorySeparatorChar), [System.UriKind]::Absolute)
$jsUri  = New-Object System.Uri([System.IO.Path]::GetFullPath((Join-Path $dest 'timegate.js')),  [System.UriKind]::Absolute)
$cssUri = New-Object System.Uri([System.IO.Path]::GetFullPath((Join-Path $dest 'timegate.css')), [System.UriKind]::Absolute)
$relJs  = $launchDirUri.MakeRelativeUri($jsUri).ToString()  -replace '\\','/'
$relCss = $launchDirUri.MakeRelativeUri($cssUri).ToString() -replace '\\','/'

$html = Get-Content $launchPath -Raw
$lmsOpeningPattern = "<script\b(?=[^>]*\bsrc\s*=\s*[""'][^""']*lms-interface\.js[""'])[^>]*>"
$lmsOpeningTags = @([regex]::Matches(
  $html,
  $lmsOpeningPattern,
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
))
if (
  $lmsOpeningTags.Count -ne 1 -or
  [regex]::IsMatch(
    $lmsOpeningTags[0].Value,
    '\s(?:async|defer)(?=\s|=|/?>)',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
) {
  Write-Host 'lms-interface.js must appear exactly once and execute synchronously without async or defer.'
  exit 1
}
$lmsPattern = "<script\b(?=[^>]*\bsrc\s*=\s*[""'][^""']*lms-interface\.js[""'])[^>]*>\s*</script>"
$regexOptions = (
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
  [System.Text.RegularExpressions.RegexOptions]::Singleline
)
$lmsScripts = @([regex]::Matches($html, $lmsPattern, $regexOptions))
if ($lmsScripts.Count -ne 1) {
  Write-Host 'Expected exactly one empty lms-interface.js bootstrap script.'
  exit 1
}
try {
  $manifestIdentifier = $xml.DocumentElement.GetAttribute('identifier')
  $resourceIdentifier = $resource.GetAttribute('identifier')
  $packageVersion = Get-TimegateDriverPackageVersion $html
  $derivedCourseKey = New-TimegateCourseKey `
    $manifestIdentifier `
    $resourceIdentifier `
    ($launchHref.Replace('\', '/')) `
    $packageVersion `
    (Join-Path $Root 'scormcontent/runtime-data.js')
} catch {
  Write-Host "Could not derive a stable Timegate courseKey: $($_.Exception.Message)"
  exit 1
}
$courseKeyProperty = Get-TimegateProperty $effectiveConfigObject 'courseKey'
$generatedCourseKey = $null -eq $courseKeyProperty -or $null -eq $courseKeyProperty.Value
if ($generatedCourseKey) {
  if ($null -eq $courseKeyProperty) {
    $effectiveConfigObject | Add-Member -NotePropertyName 'courseKey' -NotePropertyValue $derivedCourseKey
  } else {
    $courseKeyProperty.Value = $derivedCourseKey
  }
}

$referenceState = Get-TimegateReferenceState $html $relJs $relCss
if ($referenceState -eq 'invalid') {
  Write-Host 'The package contains stale, incomplete, or duplicate Timegate markers. Start from a clean package or repair the marked asset paths.'
  exit 1
}
if ($referenceState -eq 'complete') {
  try {
    Assert-TimegateSynchronousPlacement $html $relJs $relCss
  } catch {
    Write-Host "The existing Timegate injection is not safe: $($_.Exception.Message)"
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $SrcDir 'timegate.js')  (Join-Path $dest 'timegate.js')  -Force
Copy-Item (Join-Path $SrcDir 'timegate.css') (Join-Path $dest 'timegate.css') -Force
if ($generatedCourseKey) {
  $renderedConfig = ($effectiveConfigObject | ConvertTo-Json -Depth 20) + "`n"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($configPath, $renderedConfig, $utf8NoBom)
} elseif (!(Test-Path -LiteralPath $configPath)) {
  Copy-Item (Join-Path $SrcDir 'timegate.config.json') $configPath -Force
}
try {
  $installedConfig = Assert-TimegateConfig $configPath
  $installedCourseKey = Get-TimegateProperty $installedConfig 'courseKey'
  if ($null -eq $installedCourseKey -or [string]::IsNullOrWhiteSpace($installedCourseKey.Value)) {
    throw 'courseKey was not written to the packaged configuration'
  }
} catch {
  Write-Host "Installed Timegate configuration is invalid: $($_.Exception.Message)"
  exit 1
}

if ($referenceState -eq 'absent') {
  $inject = "`n  <link rel=`"stylesheet`" href=`"$relCss`" data-timegate=`"true`">`n  <script src=`"$relJs`" data-timegate=`"true`"></script>"
  $insertAt = $lmsScripts[0].Index + $lmsScripts[0].Length
  $html = $html.Insert($insertAt, $inject)
  Set-Content -Path $launchPath -Value $html -Encoding utf8
}
try {
  Assert-TimegateSynchronousPlacement $html $relJs $relCss
} catch {
  Write-Host "Timegate injection is not safe: $($_.Exception.Message)"
  exit 1
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
