# Timegate Windows Installer
# This launcher uses the project runtime in ..\src and the core packager in this folder.
# It never changes the source SCORM ZIP.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Crisper rendering and modern theming on high-DPI displays. Must run before any
# control is created.
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RuntimeSource = Join-Path $ProjectRoot 'src'
$CoreInstaller = Join-Path $PSScriptRoot 'install-timegate.ps1'
$CoreSupport = Join-Path $PSScriptRoot 'timegate_config.ps1'

function Show-Error([string]$Message) {
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        'Timegate Installer',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

function Show-Info([string]$Message) {
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        'Timegate Installer',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Find-ScormRoot([string]$ExtractedFolder) {
    $manifests = @(
        Get-ChildItem -LiteralPath $ExtractedFolder -Filter 'imsmanifest.xml' -File -Recurse |
        Sort-Object { $_.FullName.Length }
    )

    if ($manifests.Count -eq 0) {
        throw 'Timegate could not find imsmanifest.xml inside that ZIP. It does not appear to be a SCORM package.'
    }

    if ($manifests.Count -gt 1) {
        $found = ($manifests | ForEach-Object { $_.FullName }) -join "`n"
        throw "This ZIP contains more than one imsmanifest.xml, so Timegate cannot safely choose the course root.`n`n$found"
    }

    return $manifests[0].Directory.FullName
}


function Get-DefaultSettings {
    $settings = [ordered]@{
        enforceCompletion          = $true
        inactivityForceExitEnabled = $true
        inactivityForceExitMinutes = 5
        inactivityWarningSeconds   = 30
        gentleNudgeEnabled         = $true
        gentleNudgeSeconds         = 60
        countWhileMediaPlaying     = $true
        disableVideoSkip           = $true
        idleTimeoutSeconds         = 120
        backgroundGraceSeconds     = 30
        launchModalEnabled         = $true
        hideWhenComplete           = $false
        position                   = 'bottom-right'
        storageMode                = 'dual'
        debug                      = $false
    }
    return ,$settings
}

function New-TimegateConfig {
    param(
        [int]$Minutes,
        [Nullable[int]]$MaximumMinutes,
        [System.Collections.IDictionary]$Settings
    )

    $config = [ordered]@{
        minRequiredMinutes = $Minutes
        maxAllowedMinutes = $MaximumMinutes
    }

    foreach ($key in $Settings.Keys) {
        $config[$key] = $Settings[$key]
    }

    return ($config | ConvertTo-Json -Depth 3)
}

function Test-SettingsAreDefault {
    param([System.Collections.IDictionary]$Settings)

    $defaults = Get-DefaultSettings
    foreach ($key in $defaults.Keys) {
        if ($Settings[$key] -ne $defaults[$key]) {
            return $false
        }
    }
    return $true
}

function Get-ReviewText {
    param(
        [int]$Minutes,
        [Nullable[int]]$MaximumMinutes,
        [System.Collections.IDictionary]$Settings,
        [string]$OutputZip
    )

    $completion = if ($Settings['enforceCompletion']) { 'on' } else { 'off' }
    $mediaActivity = if ($Settings['countWhileMediaPlaying']) { 'on' } else { 'off' }
    $videoSkip = if ($Settings['disableVideoSkip']) { 'blocked' } else { 'allowed' }
    $launchModal = if ($Settings['launchModalEnabled']) { 'on' } else { 'off' }
    $hideWhenComplete = if ($Settings['hideWhenComplete']) { 'hidden' } else { 'shown' }
    $debug = if ($Settings['debug']) { 'on' } else { 'off' }

    if ($Settings['inactivityForceExitEnabled']) {
        $inactivity = "End idle session after $($Settings['inactivityForceExitMinutes']) minutes"
        $warning = "Warning countdown: $($Settings['inactivityWarningSeconds']) seconds"
        if ($Settings['gentleNudgeEnabled']) {
            $nudge = "Gentle nudge: $($Settings['gentleNudgeSeconds']) seconds before the warning"
        } else {
            $nudge = 'Gentle nudge: off'
        }
    } else {
        $inactivity = 'End idle session: off'
        $warning = 'Warning countdown: off'
        $nudge = 'Gentle nudge: off'
    }

    $advancedState = if (Test-SettingsAreDefault $Settings) { 'standard defaults' } else { 'customized' }
    $maximum = if ($null -eq $MaximumMinutes) { 'none' } else { "$MaximumMinutes minutes" }

    return @"
Floor time: $Minutes minutes
Maximum active time: $maximum

Completion gate: $completion
Resume storage: $($Settings['storageMode'])
Video/audio counts as activity: $mediaActivity
Forward video skipping: $videoSkip
Pause timer after idle: $($Settings['idleTimeoutSeconds']) seconds
Background grace: $($Settings['backgroundGraceSeconds']) seconds
$inactivity
$warning
$nudge
Launch acknowledgment: $launchModal
Timer after floor is met: $hideWhenComplete
Timer location: $($Settings['position'])
Debug logging: $debug
Advanced settings: $advancedState

A new ZIP will be created here:
$OutputZip

Use these settings?
"@
}

function Show-AdvancedSettingsDialog {
    param([System.Collections.IDictionary]$Settings)

    $advancedForm = New-Object System.Windows.Forms.Form
    $advancedForm.Text = 'Advanced Timegate Settings'
    $advancedForm.StartPosition = 'CenterParent'
    $advancedForm.Size = New-Object System.Drawing.Size(710, 665)
    $advancedForm.MinimumSize = New-Object System.Drawing.Size(710, 665)
    $advancedForm.MaximizeBox = $false
    $advancedForm.Font = New-Object System.Drawing.Font('Segoe UI', 9)
    $advancedForm.BackColor = [System.Drawing.Color]::White
    $advancedForm.Tag = $false

    $intro = New-Object System.Windows.Forms.Label
    $intro.Text = 'These are the settings that become the rest of timegate.config.json. Leave them alone unless this course has a specific reason to behave differently.'
    $intro.Location = New-Object System.Drawing.Point(24, 18)
    $intro.Size = New-Object System.Drawing.Size(640, 40)
    $intro.ForeColor = [System.Drawing.Color]::FromArgb(65, 65, 65)
    [void]$advancedForm.Controls.Add($intro)

    # Completion and resume
    $completionGroup = New-Object System.Windows.Forms.GroupBox
    $completionGroup.Text = 'Completion and resume'
    $completionGroup.Location = New-Object System.Drawing.Point(24, 68)
    $completionGroup.Size = New-Object System.Drawing.Size(645, 82)
    [void]$advancedForm.Controls.Add($completionGroup)

    $enforceCompletion = New-Object System.Windows.Forms.CheckBox
    $enforceCompletion.Text = 'Block course completion until the required floor time is met'
    $enforceCompletion.Location = New-Object System.Drawing.Point(16, 23)
    $enforceCompletion.Size = New-Object System.Drawing.Size(430, 24)
    $enforceCompletion.Checked = [bool]$Settings['enforceCompletion']
    [void]$completionGroup.Controls.Add($enforceCompletion)

    $storageLabel = New-Object System.Windows.Forms.Label
    $storageLabel.Text = 'Resume storage'
    $storageLabel.Location = New-Object System.Drawing.Point(16, 53)
    $storageLabel.AutoSize = $true
    [void]$completionGroup.Controls.Add($storageLabel)

    $storageMode = New-Object System.Windows.Forms.ComboBox
    $storageMode.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    $storageMode.Location = New-Object System.Drawing.Point(112, 49)
    $storageMode.Size = New-Object System.Drawing.Size(145, 26)
    @('dual', 'localStorage', 'suspend_data') | ForEach-Object { [void]$storageMode.Items.Add($_) }
    $storageMode.SelectedItem = [string]$Settings['storageMode']
    if ($storageMode.SelectedIndex -lt 0) { $storageMode.SelectedIndex = 0 }
    [void]$completionGroup.Controls.Add($storageMode)

    $storageHelp = New-Object System.Windows.Forms.Label
    $storageHelp.Text = 'Dual is recommended.'
    $storageHelp.Location = New-Object System.Drawing.Point(272, 53)
    $storageHelp.AutoSize = $true
    $storageHelp.ForeColor = [System.Drawing.Color]::FromArgb(95, 95, 95)
    [void]$completionGroup.Controls.Add($storageHelp)

    # Timer and media
    $timerGroup = New-Object System.Windows.Forms.GroupBox
    $timerGroup.Text = 'Timer and media'
    $timerGroup.Location = New-Object System.Drawing.Point(24, 160)
    $timerGroup.Size = New-Object System.Drawing.Size(645, 115)
    [void]$advancedForm.Controls.Add($timerGroup)

    $countMedia = New-Object System.Windows.Forms.CheckBox
    $countMedia.Text = 'Count hosted video/audio as activity'
    $countMedia.Location = New-Object System.Drawing.Point(16, 23)
    $countMedia.Size = New-Object System.Drawing.Size(280, 24)
    $countMedia.Checked = [bool]$Settings['countWhileMediaPlaying']
    [void]$timerGroup.Controls.Add($countMedia)

    $disableVideoSkip = New-Object System.Windows.Forms.CheckBox
    $disableVideoSkip.Text = 'Block forward-skipping hosted video'
    $disableVideoSkip.Location = New-Object System.Drawing.Point(330, 23)
    $disableVideoSkip.Size = New-Object System.Drawing.Size(280, 24)
    $disableVideoSkip.Checked = [bool]$Settings['disableVideoSkip']
    [void]$timerGroup.Controls.Add($disableVideoSkip)

    $idlePauseLabel = New-Object System.Windows.Forms.Label
    $idlePauseLabel.Text = 'Pause timer after'
    $idlePauseLabel.Location = New-Object System.Drawing.Point(16, 62)
    $idlePauseLabel.AutoSize = $true
    [void]$timerGroup.Controls.Add($idlePauseLabel)

    $idlePauseSeconds = New-Object System.Windows.Forms.NumericUpDown
    $idlePauseSeconds.Location = New-Object System.Drawing.Point(125, 58)
    $idlePauseSeconds.Size = New-Object System.Drawing.Size(80, 26)
    $idlePauseSeconds.Minimum = 1
    $idlePauseSeconds.Maximum = 3600
    $idlePauseSeconds.Value = [decimal][int]$Settings['idleTimeoutSeconds']
    [void]$timerGroup.Controls.Add($idlePauseSeconds)

    $idlePauseUnit = New-Object System.Windows.Forms.Label
    $idlePauseUnit.Text = 'seconds of idle'
    $idlePauseUnit.Location = New-Object System.Drawing.Point(214, 62)
    $idlePauseUnit.AutoSize = $true
    [void]$timerGroup.Controls.Add($idlePauseUnit)

    $backgroundLabel = New-Object System.Windows.Forms.Label
    $backgroundLabel.Text = 'Keep counting after tab loses focus'
    $backgroundLabel.Location = New-Object System.Drawing.Point(330, 62)
    $backgroundLabel.AutoSize = $true
    [void]$timerGroup.Controls.Add($backgroundLabel)

    $backgroundGrace = New-Object System.Windows.Forms.NumericUpDown
    $backgroundGrace.Location = New-Object System.Drawing.Point(538, 58)
    $backgroundGrace.Size = New-Object System.Drawing.Size(64, 26)
    $backgroundGrace.Minimum = 0
    $backgroundGrace.Maximum = 3600
    $backgroundGrace.Value = [decimal][int]$Settings['backgroundGraceSeconds']
    [void]$timerGroup.Controls.Add($backgroundGrace)

    $backgroundUnit = New-Object System.Windows.Forms.Label
    $backgroundUnit.Text = 'sec'
    $backgroundUnit.Location = New-Object System.Drawing.Point(607, 62)
    $backgroundUnit.AutoSize = $true
    [void]$timerGroup.Controls.Add($backgroundUnit)

    # Inactivity
    $inactivityGroup = New-Object System.Windows.Forms.GroupBox
    $inactivityGroup.Text = 'Inactivity flow'
    $inactivityGroup.Location = New-Object System.Drawing.Point(24, 285)
    $inactivityGroup.Size = New-Object System.Drawing.Size(645, 150)
    [void]$advancedForm.Controls.Add($inactivityGroup)

    $forceExit = New-Object System.Windows.Forms.CheckBox
    $forceExit.Text = 'End the SCORM session after prolonged inactivity'
    $forceExit.Location = New-Object System.Drawing.Point(16, 22)
    $forceExit.Size = New-Object System.Drawing.Size(360, 24)
    $forceExit.Checked = [bool]$Settings['inactivityForceExitEnabled']
    [void]$inactivityGroup.Controls.Add($forceExit)

    $endAfterLabel = New-Object System.Windows.Forms.Label
    $endAfterLabel.Text = 'End session after'
    $endAfterLabel.Location = New-Object System.Drawing.Point(16, 55)
    $endAfterLabel.AutoSize = $true
    [void]$inactivityGroup.Controls.Add($endAfterLabel)

    $endAfterMinutes = New-Object System.Windows.Forms.NumericUpDown
    $endAfterMinutes.Location = New-Object System.Drawing.Point(118, 51)
    $endAfterMinutes.Size = New-Object System.Drawing.Size(70, 26)
    $endAfterMinutes.Minimum = 1
    $endAfterMinutes.Maximum = 240
    $endAfterMinutes.Value = [decimal][int]$Settings['inactivityForceExitMinutes']
    [void]$inactivityGroup.Controls.Add($endAfterMinutes)

    $endAfterUnit = New-Object System.Windows.Forms.Label
    $endAfterUnit.Text = 'minutes'
    $endAfterUnit.Location = New-Object System.Drawing.Point(196, 55)
    $endAfterUnit.AutoSize = $true
    [void]$inactivityGroup.Controls.Add($endAfterUnit)

    $warningLabel = New-Object System.Windows.Forms.Label
    $warningLabel.Text = 'Firm warning'
    $warningLabel.Location = New-Object System.Drawing.Point(330, 55)
    $warningLabel.AutoSize = $true
    [void]$inactivityGroup.Controls.Add($warningLabel)

    $warningSeconds = New-Object System.Windows.Forms.NumericUpDown
    $warningSeconds.Location = New-Object System.Drawing.Point(415, 51)
    $warningSeconds.Size = New-Object System.Drawing.Size(70, 26)
    $warningSeconds.Minimum = 0
    $warningSeconds.Maximum = 600
    $warningSeconds.Value = [decimal][int]$Settings['inactivityWarningSeconds']
    [void]$inactivityGroup.Controls.Add($warningSeconds)

    $warningUnit = New-Object System.Windows.Forms.Label
    $warningUnit.Text = 'seconds'
    $warningUnit.Location = New-Object System.Drawing.Point(493, 55)
    $warningUnit.AutoSize = $true
    [void]$inactivityGroup.Controls.Add($warningUnit)

    $gentleNudge = New-Object System.Windows.Forms.CheckBox
    $gentleNudge.Text = 'Show a gentle nudge before the firm warning'
    $gentleNudge.Location = New-Object System.Drawing.Point(16, 92)
    $gentleNudge.Size = New-Object System.Drawing.Size(310, 24)
    $gentleNudge.Checked = [bool]$Settings['gentleNudgeEnabled']
    [void]$inactivityGroup.Controls.Add($gentleNudge)

    $gentleLabel = New-Object System.Windows.Forms.Label
    $gentleLabel.Text = 'Nudge duration'
    $gentleLabel.Location = New-Object System.Drawing.Point(330, 95)
    $gentleLabel.Size = New-Object System.Drawing.Size(112, 24)
    [void]$inactivityGroup.Controls.Add($gentleLabel)

    $gentleSeconds = New-Object System.Windows.Forms.NumericUpDown
    $gentleSeconds.Location = New-Object System.Drawing.Point(455, 91)
    $gentleSeconds.Size = New-Object System.Drawing.Size(70, 26)
    $gentleSeconds.Minimum = 0
    $gentleSeconds.Maximum = 600
    $gentleSeconds.Value = [decimal][int]$Settings['gentleNudgeSeconds']
    [void]$inactivityGroup.Controls.Add($gentleSeconds)

    $gentleUnit = New-Object System.Windows.Forms.Label
    $gentleUnit.Text = 'seconds'
    $gentleUnit.Location = New-Object System.Drawing.Point(533, 95)
    $gentleUnit.AutoSize = $true
    [void]$inactivityGroup.Controls.Add($gentleUnit)

    # Display and diagnostics
    $displayGroup = New-Object System.Windows.Forms.GroupBox
    $displayGroup.Text = 'Display and diagnostics'
    $displayGroup.Location = New-Object System.Drawing.Point(24, 445)
    $displayGroup.Size = New-Object System.Drawing.Size(645, 95)
    [void]$advancedForm.Controls.Add($displayGroup)

    $launchModal = New-Object System.Windows.Forms.CheckBox
    $launchModal.Text = 'Show the launch acknowledgment'
    $launchModal.Location = New-Object System.Drawing.Point(16, 22)
    $launchModal.Size = New-Object System.Drawing.Size(235, 24)
    $launchModal.Checked = [bool]$Settings['launchModalEnabled']
    [void]$displayGroup.Controls.Add($launchModal)

    $hideWhenComplete = New-Object System.Windows.Forms.CheckBox
    $hideWhenComplete.Text = 'Hide timer once the floor is met'
    $hideWhenComplete.Location = New-Object System.Drawing.Point(330, 22)
    $hideWhenComplete.Size = New-Object System.Drawing.Size(250, 24)
    $hideWhenComplete.Checked = [bool]$Settings['hideWhenComplete']
    [void]$displayGroup.Controls.Add($hideWhenComplete)

    $positionLabel = New-Object System.Windows.Forms.Label
    $positionLabel.Text = 'Timer location'
    $positionLabel.Location = New-Object System.Drawing.Point(16, 58)
    $positionLabel.AutoSize = $true
    [void]$displayGroup.Controls.Add($positionLabel)

    $position = New-Object System.Windows.Forms.ComboBox
    $position.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    $position.Location = New-Object System.Drawing.Point(105, 54)
    $position.Size = New-Object System.Drawing.Size(130, 26)
    @('bottom-right', 'bottom-left') | ForEach-Object { [void]$position.Items.Add($_) }
    $position.SelectedItem = [string]$Settings['position']
    if ($position.SelectedIndex -lt 0) { $position.SelectedIndex = 0 }
    [void]$displayGroup.Controls.Add($position)

    $debug = New-Object System.Windows.Forms.CheckBox
    $debug.Text = 'Enable debug logging'
    $debug.Location = New-Object System.Drawing.Point(330, 56)
    $debug.Size = New-Object System.Drawing.Size(180, 24)
    $debug.Checked = [bool]$Settings['debug']
    [void]$displayGroup.Controls.Add($debug)

    $reset = New-Object System.Windows.Forms.Button
    $reset.Text = 'Reset Defaults'
    $reset.Location = New-Object System.Drawing.Point(24, 562)
    $reset.Size = New-Object System.Drawing.Size(120, 32)
    [void]$advancedForm.Controls.Add($reset)

    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.Location = New-Object System.Drawing.Point(450, 562)
    $cancel.Size = New-Object System.Drawing.Size(100, 32)
    [void]$advancedForm.Controls.Add($cancel)

    $save = New-Object System.Windows.Forms.Button
    $save.Text = 'Save Settings'
    $save.Location = New-Object System.Drawing.Point(560, 562)
    $save.Size = New-Object System.Drawing.Size(110, 32)
    $save.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
    [void]$advancedForm.Controls.Add($save)

    $syncGentle = {
        $gentleSeconds.Enabled = ($forceExit.Checked -and $gentleNudge.Checked)
    }

    $syncInactivity = {
        $enabled = $forceExit.Checked
        $endAfterMinutes.Enabled = $enabled
        $warningSeconds.Enabled = $enabled
        $gentleNudge.Enabled = $enabled
        & $syncGentle
    }

    $forceExit.Add_CheckedChanged({ & $syncInactivity })
    $gentleNudge.Add_CheckedChanged({ & $syncGentle })
    & $syncInactivity

    $reset.Add_Click({
        $defaults = Get-DefaultSettings
        $enforceCompletion.Checked = [bool]$defaults['enforceCompletion']
        $storageMode.SelectedItem = [string]$defaults['storageMode']
        $countMedia.Checked = [bool]$defaults['countWhileMediaPlaying']
        $disableVideoSkip.Checked = [bool]$defaults['disableVideoSkip']
        $idlePauseSeconds.Value = [decimal][int]$defaults['idleTimeoutSeconds']
        $backgroundGrace.Value = [decimal][int]$defaults['backgroundGraceSeconds']
        $forceExit.Checked = [bool]$defaults['inactivityForceExitEnabled']
        $endAfterMinutes.Value = [decimal][int]$defaults['inactivityForceExitMinutes']
        $warningSeconds.Value = [decimal][int]$defaults['inactivityWarningSeconds']
        $gentleNudge.Checked = [bool]$defaults['gentleNudgeEnabled']
        $gentleSeconds.Value = [decimal][int]$defaults['gentleNudgeSeconds']
        $launchModal.Checked = [bool]$defaults['launchModalEnabled']
        $hideWhenComplete.Checked = [bool]$defaults['hideWhenComplete']
        $position.SelectedItem = [string]$defaults['position']
        $debug.Checked = [bool]$defaults['debug']
        & $syncInactivity
    })

    $cancel.Add_Click({ $advancedForm.Close() })

    $save.Add_Click({
        $Settings['enforceCompletion'] = [bool]$enforceCompletion.Checked
        $Settings['storageMode'] = [string]$storageMode.SelectedItem
        $Settings['countWhileMediaPlaying'] = [bool]$countMedia.Checked
        $Settings['disableVideoSkip'] = [bool]$disableVideoSkip.Checked
        $Settings['idleTimeoutSeconds'] = [int]$idlePauseSeconds.Value
        $Settings['backgroundGraceSeconds'] = [int]$backgroundGrace.Value
        $Settings['inactivityForceExitEnabled'] = [bool]$forceExit.Checked
        $Settings['inactivityForceExitMinutes'] = [int]$endAfterMinutes.Value
        $Settings['inactivityWarningSeconds'] = [int]$warningSeconds.Value
        $Settings['gentleNudgeEnabled'] = [bool]$gentleNudge.Checked
        $Settings['gentleNudgeSeconds'] = [int]$gentleSeconds.Value
        $Settings['launchModalEnabled'] = [bool]$launchModal.Checked
        $Settings['hideWhenComplete'] = [bool]$hideWhenComplete.Checked
        $Settings['position'] = [string]$position.SelectedItem
        $Settings['debug'] = [bool]$debug.Checked

        $advancedForm.Tag = $true
        $advancedForm.Close()
    })

    [void]$advancedForm.ShowDialog()
    $saved = ($advancedForm.Tag -eq $true)
    $advancedForm.Dispose()
    return $saved
}


function Invoke-CoreInstaller([string]$PackageRoot) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command powershell.exe).Source
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$CoreInstaller`" -Package `"$PackageRoot`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    [void]$process.Start()

    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    if ($process.ExitCode -ne 0) {
        $details = ($stdout + "`n" + $stderr).Trim()
        if ([string]::IsNullOrWhiteSpace($details)) {
            $details = 'The internal installer exited without an explanation.'
        }
        throw "Timegate could not be added to this package.`n`n$details"
    }
}

function Test-TimegateZip([string]$ZipPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        $required = @(
            'timegate/timegate.js',
            'timegate/timegate.css',
            'timegate/timegate.config.json'
        )

        $missing = @($required | Where-Object { $entries -cnotcontains $_ })
        if ($missing.Count -gt 0) {
            throw "The output ZIP was created, but it is missing: $($missing -join ', ')"
        }

        $manifestEntry = @($archive.Entries | Where-Object {
            $_.FullName.Replace('\', '/') -ceq 'imsmanifest.xml'
        })
        if ($manifestEntry.Count -ne 1) {
            throw 'The output ZIP must contain one root imsmanifest.xml.'
        }
        $manifestReader = New-Object System.IO.StreamReader($manifestEntry[0].Open())
        try {
            [xml]$manifestXml = $manifestReader.ReadToEnd()
        }
        finally {
            $manifestReader.Dispose()
        }
        $namespaces = New-Object System.Xml.XmlNamespaceManager($manifestXml.NameTable)
        $packageNamespace = $manifestXml.DocumentElement.NamespaceURI
        $adlcpNamespace = $manifestXml.DocumentElement.GetNamespaceOfPrefix('adlcp')
        $namespaces.AddNamespace('imscp', $packageNamespace)
        $namespaces.AddNamespace('adlcp', $adlcpNamespace)
        $scoResources = @($manifestXml.SelectNodes(
            '//imscp:resource[@adlcp:scormtype="sco" or @adlcp:scormType="sco"]',
            $namespaces
        ))
        if ($scoResources.Count -ne 1) {
            throw 'The output ZIP must contain exactly one SCO resource.'
        }
        $launchHref = $scoResources[0].GetAttribute('href').Replace('\', '/')
        $launchEntry = @($archive.Entries | Where-Object {
            $_.FullName.Replace('\', '/') -ceq $launchHref
        })
        if ($launchEntry.Count -ne 1) {
            throw "The output ZIP is missing its exact SCO launch file: $launchHref"
        }
        $launchReader = New-Object System.IO.StreamReader($launchEntry[0].Open())
        try {
            $launchHtml = $launchReader.ReadToEnd()
        }
        finally {
            $launchReader.Dispose()
        }
        $packageBase = New-Object System.Uri('https://timegate.invalid/')
        $launchUri = New-Object System.Uri($packageBase, $launchHref)
        $launchDirectoryUri = New-Object System.Uri($launchUri, '.')
        $expectedJs = $launchDirectoryUri.MakeRelativeUri(
            (New-Object System.Uri($packageBase, 'timegate/timegate.js'))
        ).ToString()
        $expectedCss = $launchDirectoryUri.MakeRelativeUri(
            (New-Object System.Uri($packageBase, 'timegate/timegate.css'))
        ).ToString()
        if ((Get-TimegateReferenceState $launchHtml $expectedJs $expectedCss) -ne 'complete') {
            throw 'The output ZIP launch file does not reference the exact packaged Timegate assets.'
        }
    }
    finally {
        $archive.Dispose()
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $RuntimeSource 'timegate.js'))) {
    Show-Error "The project runtime is missing from:`n$RuntimeSource`n`nDo not move this launcher out of the timegate\installer folder."
    exit 1
}

if (-not (Test-Path -LiteralPath $CoreInstaller)) {
    Show-Error "The core installer is missing:`n$CoreInstaller"
    exit 1
}

if (-not (Test-Path -LiteralPath $CoreSupport)) {
    Show-Error "The installer configuration validator is missing:`n$CoreSupport"
    exit 1
}

. $CoreSupport

$advancedSettings = Get-DefaultSettings

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Timegate Installer'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(735, 430)
$form.MinimumSize = New-Object System.Drawing.Size(735, 430)
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.BackColor = [System.Drawing.Color]::White

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Add Timegate to a SCORM package'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(28, 22)
$title.AutoSize = $true
[void]$form.Controls.Add($title)

$sub = New-Object System.Windows.Forms.Label
$sub.Text = 'Your original ZIP is never changed. Timegate creates a separate ready-to-upload copy beside it.'
$sub.Location = New-Object System.Drawing.Point(30, 58)
$sub.Size = New-Object System.Drawing.Size(650, 38)
$sub.ForeColor = [System.Drawing.Color]::FromArgb(70, 70, 70)
[void]$form.Controls.Add($sub)

$courseLabel = New-Object System.Windows.Forms.Label
$courseLabel.Text = 'SCORM ZIP'
$courseLabel.Location = New-Object System.Drawing.Point(30, 111)
$courseLabel.AutoSize = $true
[void]$form.Controls.Add($courseLabel)

$coursePath = New-Object System.Windows.Forms.TextBox
$coursePath.Location = New-Object System.Drawing.Point(30, 135)
$coursePath.Size = New-Object System.Drawing.Size(545, 28)
$coursePath.ReadOnly = $true
[void]$form.Controls.Add($coursePath)

$browse = New-Object System.Windows.Forms.Button
$browse.Text = 'Browse...'
$browse.Location = New-Object System.Drawing.Point(590, 133)
$browse.Size = New-Object System.Drawing.Size(105, 30)
[void]$form.Controls.Add($browse)

$floorLabel = New-Object System.Windows.Forms.Label
$floorLabel.Text = 'Required floor time'
$floorLabel.Location = New-Object System.Drawing.Point(30, 190)
$floorLabel.AutoSize = $true
[void]$form.Controls.Add($floorLabel)

$minutes = New-Object System.Windows.Forms.NumericUpDown
$minutes.Location = New-Object System.Drawing.Point(30, 215)
$minutes.Size = New-Object System.Drawing.Size(100, 28)
$minutes.Minimum = 1
$minutes.Maximum = 600
$minutes.Value = 20
[void]$form.Controls.Add($minutes)

$minutesLabel = New-Object System.Windows.Forms.Label
$minutesLabel.Text = 'minutes'
$minutesLabel.Location = New-Object System.Drawing.Point(140, 218)
$minutesLabel.AutoSize = $true
[void]$form.Controls.Add($minutesLabel)

$maxEnabled = New-Object System.Windows.Forms.CheckBox
$maxEnabled.Text = 'Set maximum active time'
$maxEnabled.Location = New-Object System.Drawing.Point(275, 190)
$maxEnabled.Size = New-Object System.Drawing.Size(190, 24)
$maxEnabled.Checked = $false
[void]$form.Controls.Add($maxEnabled)

$maxMinutes = New-Object System.Windows.Forms.NumericUpDown
$maxMinutes.Location = New-Object System.Drawing.Point(275, 215)
$maxMinutes.Size = New-Object System.Drawing.Size(100, 28)
$maxMinutes.Minimum = 1
$maxMinutes.Maximum = 600
$maxMinutes.Value = 60
$maxMinutes.Enabled = $false
[void]$form.Controls.Add($maxMinutes)

$maxMinutesLabel = New-Object System.Windows.Forms.Label
$maxMinutesLabel.Text = 'minutes'
$maxMinutesLabel.Location = New-Object System.Drawing.Point(385, 218)
$maxMinutesLabel.AutoSize = $true
$maxMinutesLabel.Enabled = $false
[void]$form.Controls.Add($maxMinutesLabel)

$advancedButton = New-Object System.Windows.Forms.Button
$advancedButton.Text = 'Advanced Settings...'
$advancedButton.Location = New-Object System.Drawing.Point(520, 213)
$advancedButton.Size = New-Object System.Drawing.Size(155, 32)
[void]$form.Controls.Add($advancedButton)

$maxEnabled.Add_CheckedChanged({
    $maxMinutes.Enabled = $maxEnabled.Checked
    $maxMinutesLabel.Enabled = $maxEnabled.Checked
})

$advancedHeading = New-Object System.Windows.Forms.Label
$advancedHeading.Text = 'Standard settings are already selected.'
$advancedHeading.Location = New-Object System.Drawing.Point(30, 270)
$advancedHeading.AutoSize = $true
$advancedHeading.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
[void]$form.Controls.Add($advancedHeading)

$advancedSummary = New-Object System.Windows.Forms.Label
$advancedSummary.Text = 'Completion gate, reliable resume, video protection, and the standard inactivity flow are on. Use Advanced Settings only for a course-specific exception.'
$advancedSummary.Location = New-Object System.Drawing.Point(30, 294)
$advancedSummary.Size = New-Object System.Drawing.Size(650, 42)
$advancedSummary.ForeColor = [System.Drawing.Color]::FromArgb(70, 70, 70)
[void]$form.Controls.Add($advancedSummary)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Choose a SCORM ZIP to begin.'
$status.Location = New-Object System.Drawing.Point(30, 348)
$status.Size = New-Object System.Drawing.Size(430, 36)
$status.ForeColor = [System.Drawing.Color]::FromArgb(70, 70, 70)
[void]$form.Controls.Add($status)

$install = New-Object System.Windows.Forms.Button
$install.Text = 'Review and Create ZIP'
$install.Location = New-Object System.Drawing.Point(492, 344)
$install.Size = New-Object System.Drawing.Size(203, 38)
$install.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
[void]$form.Controls.Add($install)

$advancedButton.Add_Click({
    $saved = Show-AdvancedSettingsDialog -Settings $advancedSettings
    if ($saved) {
        if (Test-SettingsAreDefault $advancedSettings) {
            $advancedHeading.Text = 'Standard settings are selected.'
            $advancedSummary.Text = 'Completion gate, reliable resume, video protection, and the standard inactivity flow are on. Use Advanced Settings only for a course-specific exception.'
        } else {
            $advancedHeading.Text = 'Advanced settings have been customized.'
            $advancedSummary.Text = 'Your custom values will be used in the package. Select Advanced Settings again to review, change, or reset them.'
        }
    }
})


$browse.Add_Click({
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Choose a SCORM package'
    $dialog.Filter = 'ZIP files (*.zip)|*.zip|All files (*.*)|*.*'
    $dialog.Multiselect = $false

    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $coursePath.Text = $dialog.FileName
        $status.Text = "Output will be saved beside: $([System.IO.Path]::GetFileName($dialog.FileName))"
    }
})

$install.Add_Click({
    $inputZip = $coursePath.Text.Trim()
    $floorMinutes = [int]$minutes.Value
    $maximumMinutes = if ($maxEnabled.Checked) { [int]$maxMinutes.Value } else { $null }

    if ([string]::IsNullOrWhiteSpace($inputZip) -or -not (Test-Path -LiteralPath $inputZip -PathType Leaf)) {
        Show-Error 'Choose a SCORM ZIP first.'
        return
    }

    if ([System.IO.Path]::GetExtension($inputZip).ToLowerInvariant() -ne '.zip') {
        Show-Error 'Choose a ZIP file.'
        return
    }

    if ($null -ne $maximumMinutes -and $maximumMinutes -le $floorMinutes) {
        Show-Error 'Maximum active time must be greater than the required floor time.'
        return
    }

    $inputFolder = Split-Path -Parent $inputZip
    $inputStem = [System.IO.Path]::GetFileNameWithoutExtension($inputZip)
    if ($inputStem -match '(?i)-timegate$') {
        $outputStem = $inputStem
    } else {
        $outputStem = "$inputStem-timegate"
    }
    $outputZip = Join-Path $inputFolder "$outputStem.zip"

    $review = Get-ReviewText -Minutes $floorMinutes -MaximumMinutes $maximumMinutes -Settings $advancedSettings -OutputZip $outputZip

    $decision = [System.Windows.Forms.MessageBox]::Show(
        $review,
        'Confirm Timegate settings',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question
    )

    if ($decision -ne [System.Windows.Forms.DialogResult]::Yes) {
        return
    }

    if (Test-Path -LiteralPath $outputZip) {
        $replace = [System.Windows.Forms.MessageBox]::Show(
            "A Timegate ZIP already exists here:`n$outputZip`n`nReplace it?",
            'Replace existing output?',
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        if ($replace -ne [System.Windows.Forms.DialogResult]::Yes) {
            return
        }
    }

    $tempRoot = $null
    try {
        $install.Enabled = $false
        $browse.Enabled = $false
        $status.Text = 'Unzipping the SCORM package...'
        $form.Refresh()
        [System.Windows.Forms.Application]::DoEvents()

        $tempRoot = Join-Path $env:TEMP ("Timegate-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        Expand-Archive -LiteralPath $inputZip -DestinationPath $tempRoot -Force

        $scormRoot = Find-ScormRoot $tempRoot

        $existingTimegate = Join-Path $scormRoot 'timegate'
        if (Test-Path -LiteralPath $existingTimegate) {
            $updateExisting = [System.Windows.Forms.MessageBox]::Show(
                "This package already appears to contain Timegate.`n`nThe current timer files and settings will be refreshed in the new output ZIP. Continue?",
                'Timegate already found',
                [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Warning
            )
            if ($updateExisting -ne [System.Windows.Forms.DialogResult]::Yes) {
                $status.Text = 'Canceled. No files were changed.'
                return
            }
        }

        $status.Text = 'Writing the confirmed Timegate settings...'
        $form.Refresh()
        [System.Windows.Forms.Application]::DoEvents()

        New-Item -ItemType Directory -Path $existingTimegate -Force | Out-Null
        $packageConfig = Join-Path $existingTimegate 'timegate.config.json'
        Write-Utf8NoBom $packageConfig (New-TimegateConfig -Minutes $floorMinutes -MaximumMinutes $maximumMinutes -Settings $advancedSettings)

        $status.Text = 'Adding Timegate and rebuilding the ZIP...'
        $form.Refresh()
        [System.Windows.Forms.Application]::DoEvents()

        Invoke-CoreInstaller $scormRoot

        $generatedZip = Join-Path (Split-Path -Parent $scormRoot) ("$(Split-Path -Leaf $scormRoot)-timegate.zip")
        if (-not (Test-Path -LiteralPath $generatedZip -PathType Leaf)) {
            throw "The internal installer finished but did not create its output ZIP:`n$generatedZip"
        }

        $status.Text = 'Verifying the new package...'
        $form.Refresh()
        [System.Windows.Forms.Application]::DoEvents()

        if (Test-Path -LiteralPath $outputZip) {
            Remove-Item -LiteralPath $outputZip -Force
        }
        Copy-Item -LiteralPath $generatedZip -Destination $outputZip -Force
        Test-TimegateZip $outputZip

        $status.Text = "Done: $([System.IO.Path]::GetFileName($outputZip))"

        $openFolder = [System.Windows.Forms.MessageBox]::Show(
            "Timegate is installed.`n`nCreated:`n$outputZip`n`nYour original SCORM ZIP was not changed.`n`nOpen the folder containing the new ZIP?",
            'Timegate package ready',
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
        if ($openFolder -eq [System.Windows.Forms.DialogResult]::Yes) {
            Start-Process explorer.exe -ArgumentList "/select,`"$outputZip`""
        }
    }
    catch {
        $status.Text = 'Stopped before creating a usable output ZIP.'
        Show-Error $_.Exception.Message
    }
    finally {
        if ($tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        $install.Enabled = $true
        $browse.Enabled = $true
    }
})

[void]$form.ShowDialog()
