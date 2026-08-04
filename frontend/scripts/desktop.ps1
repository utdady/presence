# Ensure Rust/cargo is on PATH (conda shells often miss USERPROFILE\.cargo\bin).
$ErrorActionPreference = "Stop"
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
$cargoExe = Join-Path $cargoBin "cargo.exe"
if (Test-Path $cargoExe) {
  $env:Path = "$cargoBin;" + $env:Path
} else {
  Write-Error "cargo not found at $cargoBin. Install with: winget install Rustlang.Rustup then open a new terminal."
}

$mode = if ($args.Count -gt 0) { $args[0] } else { "dev" }
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "Using cargo:" (Get-Command cargo).Source

if ($mode -eq "build") {
  npx tauri build
} else {
  npx tauri dev
}
