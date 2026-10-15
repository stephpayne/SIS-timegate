# Native interface and Python discovery only. The engine owns all package logic.
param([switch]$Cli, [Parameter(ValueFromRemainingArguments=$true)][string[]]$EngineArgs)
$ErrorActionPreference = 'Stop'
$Root = if ($env:TIMEGATE_PROJECT_ROOT) { $env:TIMEGATE_PROJECT_ROOT } else { Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
$Engine = Join-Path $Root 'installer/timegate.py'
$Python = $null
$Prefix = @()
foreach ($name in @('python3', 'python', 'py')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if (!$command) { continue }
    $options = if ($name -eq 'py') { @('-3') } else { @() }
    & $command.Source @options -c 'import sys; sys.exit(sys.version_info < (3,10))' 2>$null
    if ($LASTEXITCODE -eq 0) { $Python = $command.Source; $Prefix = $options; break }
}
if (!$Python) { throw 'Timegate requires Python 3.10 or newer. Install Python and retry.' }
if ($Cli) { & $Python @Prefix -B $Engine @EngineArgs; exit $LASTEXITCODE }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
function Invoke-Engine([string[]]$Arguments) {
    $errorFile = [System.IO.Path]::GetTempFileName()
    try {
        $result = & $Python @Prefix -B $Engine @Arguments 2>$errorFile
        if ($LASTEXITCODE -ne 0) { throw (Get-Content $errorFile -Raw) }
        return ($result -join "`n" | ConvertFrom-Json)
    } finally { Remove-Item $errorFile -ErrorAction SilentlyContinue }
}
$defaults = Invoke-Engine @('defaults')
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Timegate Installer'
$form.Size = New-Object System.Drawing.Size(650, 480)
$form.StartPosition = 'CenterScreen'
function Add-Label($text, $x, $y, $width=540) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text=$text; $label.Location=New-Object System.Drawing.Point($x,$y)
    $label.Size=New-Object System.Drawing.Size($width,40); $form.Controls.Add($label)
    return $label
}
function Add-Text($x,$y,$width=460) {
    $field=New-Object System.Windows.Forms.TextBox
    $field.Location=New-Object System.Drawing.Point($x,$y); $field.Width=$width
    $form.Controls.Add($field); return $field
}
function Add-Button($text,$x,$y) {
    $button=New-Object System.Windows.Forms.Button
    $button.Text=$text; $button.Location=New-Object System.Drawing.Point($x,$y)
    $button.Size=New-Object System.Drawing.Size(120,30); $form.Controls.Add($button); return $button
}
$null=Add-Label 'Original SCORM ZIP' 20 15
$inputBox=Add-Text 20 45 450; $browse=Add-Button 'Choose ZIP' 485 42
$identity=Add-Label '' 20 80
$null=Add-Label 'Minimum minutes' 20 125 200; $minimum=Add-Text 220 125 100; $minimum.Text=[string]$defaults.minRequiredMinutes
$null=Add-Label 'Maximum (blank = none)' 20 165 200; $maximum=Add-Text 220 165 100
$null=Add-Label 'Timegate persistence' 20 205 200
$storage=New-Object System.Windows.Forms.ComboBox
$storage.Location=New-Object System.Drawing.Point(220,205); $storage.Width=230
$storage.DropDownStyle='DropDownList'
[void]$storage.Items.AddRange(@('Local storage only','LMS + browser')); $storage.SelectedIndex=0; $form.Controls.Add($storage)
$null=Add-Label 'Local storage resume requires the same browser and device. Completion still reports to the LMS.' 20 240
$profile=Add-Text 20 300 450; $advanced=Add-Button 'Advanced…' 485 297
$null=Add-Label 'Optional JSON profile. Telemetry is off unless explicitly enabled.' 20 330
$build=Add-Button 'Review & build' 350 380; $cancel=Add-Button 'Cancel' 485 380
$cancel.Add_Click({$form.Close()})
$browse.Add_Click({
    $picker=New-Object System.Windows.Forms.OpenFileDialog; $picker.Filter='SCORM ZIP|*.zip'
    if ($picker.ShowDialog() -eq 'OK') {
        $inputBox.Text=$picker.FileName
        try { $info=Invoke-Engine @('inspect',$inputBox.Text); $identity.Text="$($info.title) (SCORM $($info.scormVersion))" }
        catch { [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Timegate') }
    }
})
$advanced.Add_Click({
    $picker=New-Object System.Windows.Forms.OpenFileDialog; $picker.Filter='Advanced JSON profile|*.json'
    if ($picker.ShowDialog() -eq 'OK') { $profile.Text=$picker.FileName }
})
$build.Add_Click({
    try {
        $build.Enabled=$false
        $mode=if ($storage.SelectedIndex -eq 0) {'localStorage'} else {'dual'}
        $cap=if ([string]::IsNullOrWhiteSpace($maximum.Text)) {'none'} else {$maximum.Text}
        $options=@($inputBox.Text,'--minutes',$minimum.Text,'--maximum',$cap,'--storage',$mode)
        if ($profile.Text) { $options+=@('--profile',$profile.Text) }
        $preview=Invoke-Engine (@('preview')+$options)
        $review="$($preview.title) (SCORM $($preview.scormVersion))`nMinimum: $($preview.settings.minRequiredMinutes)`nMaximum: $($preview.settings.maxAllowedMinutes)`nPersistence: $($preview.settings.storageMode)`nTelemetry: $($preview.telemetryEnabled)`n`nOutput: $($preview.output)"
        if ([System.Windows.Forms.MessageBox]::Show($review,'Create package?','OKCancel') -ne 'OK') { return }
        if (Test-Path -LiteralPath $preview.output) {
            if ([System.Windows.Forms.MessageBox]::Show('Replace the existing output ZIP?','Timegate','YesNo') -ne 'Yes') { return }
            $options+='--replace'
        }
        $result=Invoke-Engine (@('build')+$options)
        [void][System.Windows.Forms.MessageBox]::Show("Verified package: $($result.output)",'Timegate')
        Start-Process explorer.exe -ArgumentList ('/select,"' + $result.output + '"')
    } catch { [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Timegate') }
    finally { $build.Enabled=$true }
})
[void]$form.ShowDialog()
