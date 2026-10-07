# Optional module: speech to text on this machine's CPU with faster-whisper (https://github.com/SYSTRAN/faster-whisper, MIT).
# Creates a Python virtual environment next to the CometScout home (default <home>\..\cometscout-transcribe, or
# modules.transcribe.path in settings.json) and installs the pinned faster-whisper there; run it again to repair or
# move to a newer pin. No model is downloaded here: the first job downloads the configured one into the module folder.
#   powershell -ExecutionPolicy Bypass -File deploy\modules\transcribe.ps1
#   $env:PYTHON = 'C:\Python312\python.exe'; powershell -ExecutionPolicy Bypass -File deploy\modules\transcribe.ps1
# The work is done by lib\transcribe.mjs (the same code runs on Linux through transcribe.sh). It installs with the
# pinned libraries in deploy\modules\transcribe\constraints.txt (pip -c) and needs Python 3.11 to 3.14.
$ErrorActionPreference = 'Stop'
$code = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $env:PYTHON -and -not (Get-Command py -ErrorAction SilentlyContinue) -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
  Write-Output 'Python 3 is needed: winget install --id Python.Python.3.12'
  exit 1
}
& node (Join-Path $code 'lib\transcribe.mjs') install @args
exit $LASTEXITCODE
