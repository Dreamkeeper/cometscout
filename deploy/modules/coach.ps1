# Optional module: the interview coach by Noam Segal (https://github.com/noamseg/interview-coach-skill, MIT).
# Installs it from its own upstream into a folder next to the CometScout home (default <home>\..\interview-coach, or
# modules.coach.path in settings.json), or updates it there. Its files are never copied into this repository, and
# nothing the coach writes in its folder (coaching_state.md, materials\) is ever deleted.
#   powershell -ExecutionPolicy Bypass -File deploy\modules\coach.ps1
# The work is done by lib\coach.mjs (the same code runs on Linux through coach.sh).
$ErrorActionPreference = 'Stop'
$code = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $env:GIT -and -not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Output 'git is needed: winget install --id Git.Git'
  exit 1
}
& node (Join-Path $code 'lib\coach.mjs') install @args
exit $LASTEXITCODE
