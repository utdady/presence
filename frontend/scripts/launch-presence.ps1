# Launch Presence desktop. Prefers a built EXE; otherwise opens desktop:dev.
$ErrorActionPreference = "Stop"
$frontend = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$exeCandidates = @(
  (Join-Path $frontend "src-tauri\target\release\presence-desktop.exe"),
  (Join-Path $frontend "src-tauri\target\debug\presence-desktop.exe")
)

foreach ($exe in $exeCandidates) {
  if (Test-Path $exe) {
    Start-Process -FilePath $exe -WorkingDirectory $frontend
    exit 0
  }
}

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path (Join-Path $cargoBin "cargo.exe")) {
  $env:Path = "$cargoBin;" + $env:Path
}

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $frontend "scripts\desktop.ps1"),
  "dev"
)
