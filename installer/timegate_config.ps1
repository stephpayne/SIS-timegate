function Remove-TimegateJsonComments([string]$Text) {
  $result = New-Object System.Text.StringBuilder
  $inString = $false
  $escaped = $false
  $inLineComment = $false
  $inBlockComment = $false

  for ($index = 0; $index -lt $Text.Length; $index++) {
    $character = $Text[$index]
    $following = if ($index + 1 -lt $Text.Length) { $Text[$index + 1] } else { [char]0 }

    if ($inLineComment) {
      if ($character -eq "`r" -or $character -eq "`n") {
        $inLineComment = $false
        [void]$result.Append($character)
      }
      continue
    }
    if ($inBlockComment) {
      if ($character -eq '*' -and $following -eq '/') {
        $inBlockComment = $false
        $index++
      } elseif ($character -eq "`r" -or $character -eq "`n") {
        [void]$result.Append($character)
      }
      continue
    }
    if ($inString) {
      [void]$result.Append($character)
      if ($escaped) {
        $escaped = $false
      } elseif ($character -eq '\') {
        $escaped = $true
      } elseif ($character -eq '"') {
        $inString = $false
      }
      continue
    }
    if ($character -eq '"') {
      $inString = $true
      [void]$result.Append($character)
    } elseif ($character -eq '/' -and $following -eq '/') {
      $inLineComment = $true
      $index++
    } elseif ($character -eq '/' -and $following -eq '*') {
      $inBlockComment = $true
      $index++
    } else {
      [void]$result.Append($character)
    }
  }

  if ($inBlockComment) { throw 'contains an unterminated block comment' }
  return $result.ToString()
}

function Remove-TimegateJsonTrailingCommas([string]$Text) {
  $result = New-Object System.Text.StringBuilder
  $inString = $false
  $escaped = $false

  for ($index = 0; $index -lt $Text.Length; $index++) {
    $character = $Text[$index]
    if ($inString) {
      [void]$result.Append($character)
      if ($escaped) {
        $escaped = $false
      } elseif ($character -eq '\') {
        $escaped = $true
      } elseif ($character -eq '"') {
        $inString = $false
      }
      continue
    }
    if ($character -eq '"') {
      $inString = $true
      [void]$result.Append($character)
      continue
    }
    if ($character -eq ',') {
      $following = $index + 1
      while ($following -lt $Text.Length -and [char]::IsWhiteSpace($Text[$following])) {
        $following++
      }
      if ($following -lt $Text.Length -and ($Text[$following] -eq '}' -or $Text[$following] -eq ']')) {
        continue
      }
    }
    [void]$result.Append($character)
  }
  return $result.ToString()
}

function Get-TimegateProperty($Config, [string]$Name) {
  $properties = @($Config.PSObject.Properties | Where-Object { $_.Name -ceq $Name })
  if ($properties.Count -eq 0) { return $null }
  return $properties[0]
}

function Test-TimegateNumber($Value) {
  return (
    $Value -is [byte] -or $Value -is [sbyte] -or
    $Value -is [int16] -or $Value -is [uint16] -or
    $Value -is [int32] -or $Value -is [uint32] -or
    $Value -is [int64] -or $Value -is [uint64] -or
    $Value -is [single] -or $Value -is [double] -or $Value -is [decimal]
  )
}

function Assert-TimegateNumber(
  $Config,
  [string]$Name,
  [double]$Minimum,
  [double]$Maximum,
  [bool]$Required = $false
) {
  $property = Get-TimegateProperty $Config $Name
  if ($null -eq $property) {
    if ($Required) { throw "$Name is required" }
    return
  }
  if (-not (Test-TimegateNumber $property.Value)) { throw "$Name must be a number" }
  $number = [double]$property.Value
  if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt $Minimum -or $number -gt $Maximum) {
    throw "$Name must be between $Minimum and $Maximum"
  }
}

function Read-TimegateConfig([string]$Path) {
  try {
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    $json = Remove-TimegateJsonTrailingCommas (Remove-TimegateJsonComments $raw)
    $config = $json | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "is not valid JSON: $($_.Exception.Message)"
  }
  if (
    -not $json.TrimStart().StartsWith('{') -or
    $null -eq $config -or $config -is [array] -or
    $config -is [string] -or $config -is [ValueType]
  ) {
    throw 'must contain a JSON object'
  }
  return $config
}

function Assert-TimegateConfig([string]$Path) {
  $config = Read-TimegateConfig $Path

  $booleanFields = @(
    'countWhileMediaPlaying', 'debug', 'disableVideoSkip',
    'enforceCompletion', 'gentleNudgeEnabled', 'hideWhenComplete',
    'inactivityForceExitEnabled', 'launchModalEnabled'
  )
  $numericFields = @(
    'minRequiredMinutes', 'idleTimeoutSeconds', 'backgroundGraceSeconds',
    'inactivityForceExitMinutes', 'inactivityWarningSeconds', 'gentleNudgeSeconds'
  )
  $allowedFields = @($booleanFields + $numericFields + @(
    'courseKey', 'maxAllowedMinutes', 'position', 'storageMode'
  ))
  $unknown = @($config.PSObject.Properties | Where-Object {
    $candidate = $_.Name
    -not @($allowedFields | Where-Object { $_ -ceq $candidate }).Count
  } | ForEach-Object { $_.Name } | Sort-Object)
  if ($unknown.Count -gt 0) {
    throw "contains unsupported fields: $($unknown -join ', ')"
  }

  Assert-TimegateNumber $config 'minRequiredMinutes' 0 600 $true
  Assert-TimegateNumber $config 'idleTimeoutSeconds' 1 3600
  Assert-TimegateNumber $config 'backgroundGraceSeconds' 0 3600
  Assert-TimegateNumber $config 'inactivityForceExitMinutes' 1 240
  Assert-TimegateNumber $config 'inactivityWarningSeconds' 0 600
  Assert-TimegateNumber $config 'gentleNudgeSeconds' 0 600

  foreach ($name in $booleanFields) {
    $property = Get-TimegateProperty $config $name
    if ($null -ne $property -and $property.Value -isnot [bool]) {
      throw "$name must be true or false"
    }
  }

  $position = Get-TimegateProperty $config 'position'
  if ($null -ne $position -and @('bottom-left', 'bottom-right') -cnotcontains $position.Value) {
    throw 'position must be one of: bottom-left, bottom-right'
  }
  $storageMode = Get-TimegateProperty $config 'storageMode'
  if ($null -ne $storageMode -and @('dual', 'localStorage', 'suspend_data') -cnotcontains $storageMode.Value) {
    throw 'storageMode must be one of: dual, localStorage, suspend_data'
  }

  $courseKey = Get-TimegateProperty $config 'courseKey'
  if ($null -ne $courseKey -and $null -ne $courseKey.Value) {
    if ($courseKey.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($courseKey.Value)) {
      throw 'courseKey must be a non-empty string'
    }
    if ($courseKey.Value.Length -gt 256) {
      throw 'courseKey must not exceed 256 characters'
    }
  }

  $maximum = Get-TimegateProperty $config 'maxAllowedMinutes'
  if ($null -ne $maximum -and $null -ne $maximum.Value) {
    if (-not (Test-TimegateNumber $maximum.Value)) {
      throw 'maxAllowedMinutes must be a number or null'
    }
    $maximumNumber = [double]$maximum.Value
    if ([double]::IsNaN($maximumNumber) -or [double]::IsInfinity($maximumNumber) -or $maximumNumber -lt 0 -or $maximumNumber -gt 600) {
      throw 'maxAllowedMinutes must be between 0 and 600 or null'
    }
    $minimum = (Get-TimegateProperty $config 'minRequiredMinutes').Value
    if ($maximumNumber -le [double]$minimum) {
      throw 'maxAllowedMinutes must be greater than minRequiredMinutes'
    }
  }
  return $config
}

function Get-TimegateSha256Hex([byte[]]$Bytes) {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha256.ComputeHash($Bytes)
    return (($digest | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $sha256.Dispose()
  }
}

function Get-TimegateDriverPackageVersion([string]$Html) {
  $pattern = '<script\b(?=[^>]*\bid\s*=\s*(?:"__DRIVER_CONFIG__"|''__DRIVER_CONFIG__''))[^>]*>(?<json>.*?)</script>'
  $options = (
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
    [System.Text.RegularExpressions.RegexOptions]::Singleline
  )
  $match = [regex]::Match($Html, $pattern, $options)
  if (-not $match.Success) {
    throw 'Could not find the Rise driver package configuration'
  }
  try {
    $driverConfig = $match.Groups['json'].Value | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Could not parse the Rise driver package configuration: $($_.Exception.Message)"
  }
  $version = Get-TimegateProperty $driverConfig 'coursePackageVersion'
  if ($null -eq $version -or $version.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($version.Value)) {
    throw 'The Rise driver package configuration has no coursePackageVersion'
  }
  return $version.Value
}

function New-TimegateCourseKey(
  [string]$ManifestIdentifier,
  [string]$ScoResourceIdentifier,
  [string]$ScoLaunchPath,
  [string]$PackageVersion,
  [string]$RuntimeDataPath
) {
  $identityValues = @(
    $ManifestIdentifier,
    $ScoResourceIdentifier,
    $ScoLaunchPath.Replace('\', '/'),
    $PackageVersion
  )
  if (@($identityValues | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
    throw 'Cannot derive courseKey from incomplete package identity'
  }
  if (-not (Test-Path -LiteralPath $RuntimeDataPath -PathType Leaf)) {
    throw "Cannot derive courseKey because Rise runtime data is missing: $RuntimeDataPath"
  }

  $runtimeDigest = Get-TimegateSha256Hex ([System.IO.File]::ReadAllBytes($RuntimeDataPath))
  $componentHashes = @($identityValues + $runtimeDigest | ForEach-Object {
    Get-TimegateSha256Hex ([System.Text.Encoding]::UTF8.GetBytes([string]$_))
  })
  $material = "timegate-course-key-v1`n" + ($componentHashes -join "`n")
  return 'tg-pkg-v1-' + (
    Get-TimegateSha256Hex ([System.Text.Encoding]::UTF8.GetBytes($material))
  )
}

function Get-TimegateHtmlAttribute([string]$Tag, [string]$Name) {
  $pattern = '\b' + [regex]::Escape($Name) + '\s*=\s*(?:"(?<double>[^"]*)"|''(?<single>[^'']*)''|(?<bare>[^\s>]+))'
  $match = [regex]::Match(
    $Tag,
    $pattern,
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if (-not $match.Success) { return $null }
  foreach ($groupName in @('double', 'single', 'bare')) {
    if ($match.Groups[$groupName].Success) {
      return $match.Groups[$groupName].Value
    }
  }
  return $null
}

function Get-TimegateTags([string]$Html, [string]$TagName) {
  $tagPattern = '<' + [regex]::Escape($TagName) + '\b[^>]*>'
  $markerPattern = '\bdata-timegate\b'
  return @([regex]::Matches(
    $Html,
    $tagPattern,
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  ) | Where-Object {
    [regex]::IsMatch(
      $_.Value,
      $markerPattern,
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
  })
}

function Get-TimegateReferenceState(
  [string]$Html,
  [string]$ExpectedJs,
  [string]$ExpectedCss
) {
  $scripts = @(Get-TimegateTags $Html 'script')
  $stylesheets = @(Get-TimegateTags $Html 'link')
  if ($scripts.Count -eq 0 -and $stylesheets.Count -eq 0) {
    return 'absent'
  }
  if (
    $scripts.Count -eq 1 -and $stylesheets.Count -eq 1 -and
    (Get-TimegateHtmlAttribute $scripts[0].Value 'data-timegate') -ieq 'true' -and
    (Get-TimegateHtmlAttribute $stylesheets[0].Value 'data-timegate') -ieq 'true' -and
    (Get-TimegateHtmlAttribute $stylesheets[0].Value 'rel') -imatch '(^|\s)stylesheet(\s|$)' -and
    (Get-TimegateHtmlAttribute $scripts[0].Value 'src') -ceq $ExpectedJs -and
    (Get-TimegateHtmlAttribute $stylesheets[0].Value 'href') -ceq $ExpectedCss
  ) {
    return 'complete'
  }
  return 'invalid'
}

function Assert-TimegateSynchronousPlacement(
  [string]$Html,
  [string]$ExpectedJs,
  [string]$ExpectedCss
) {
  if ((Get-TimegateReferenceState $Html $ExpectedJs $ExpectedCss) -ne 'complete') {
    throw 'Timegate does not reference the exact packaged assets'
  }
  $scripts = @(Get-TimegateTags $Html 'script')
  if ([regex]::IsMatch(
    $scripts[0].Value,
    '\s(?:async|defer)(?=\s|=|/?>)',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )) {
    throw 'Timegate must execute synchronously without async or defer'
  }

  $lmsPattern = "<script\b(?=[^>]*\bsrc\s*=\s*[""'][^""']*lms-interface\.js[""'])[^>]*>\s*</script>"
  $options = (
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
    [System.Text.RegularExpressions.RegexOptions]::Singleline
  )
  $lmsScripts = @([regex]::Matches($Html, $lmsPattern, $options))
  if ($lmsScripts.Count -ne 1) {
    throw 'Expected exactly one lms-interface.js bootstrap script'
  }
  $lmsOpeningTag = [regex]::Match(
    $lmsScripts[0].Value,
    '^<script\b[^>]*>',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  ).Value
  if ([regex]::IsMatch(
    $lmsOpeningTag,
    '\s(?:async|defer)(?=\s|=|/?>)',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )) {
    throw 'lms-interface.js must execute synchronously without async or defer'
  }
  $lmsEnd = $lmsScripts[0].Index + $lmsScripts[0].Length
  if ($scripts[0].Index -lt $lmsEnd) {
    throw 'Timegate must follow the lms-interface.js bootstrap'
  }
  $between = $Html.Substring($lmsEnd, $scripts[0].Index - $lmsEnd)
  if ([regex]::IsMatch(
    $between,
    '<script\b',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )) {
    throw 'No course script may execute between lms-interface.js and Timegate'
  }
}
