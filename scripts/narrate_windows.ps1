param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$request=Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$speaker=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speaker.Rate=0
    $format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
    $speaker.SetOutputToWaveFile([string]$request.output,$format)
    # Treat the supplied script as literal text, never as PowerShell or SSML.
    $speaker.Speak([string]$request.text)
    $speaker.SetOutputToNull()
    @{voice=$speaker.Voice.Name;culture=$speaker.Voice.Culture.Name} | ConvertTo-Json -Compress
} finally { $speaker.Dispose() }
