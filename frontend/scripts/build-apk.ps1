# Build a sideloadable Presence debug APK (no Play Store).
$ErrorActionPreference = "Stop"
$FrontendRoot = Split-Path $PSScriptRoot -Parent
$RepoRoot = Split-Path $FrontendRoot -Parent
$Tools = Join-Path $RepoRoot "tools"
$JdkDir = Join-Path $Tools "jdk"
$JdkHome = $null
if (Test-Path $JdkDir) {
  $JdkHome = Get-ChildItem $JdkDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName "bin\java.exe") } |
    Select-Object -First 1 -ExpandProperty FullName
}
$SdkHome = Join-Path $Tools "android-sdk"

if (-not $JdkHome -or -not (Test-Path "$JdkHome\bin\java.exe")) {
  throw @"
JDK not found under tools/jdk.

One-time setup (downloads Temurin JDK 21 + Android SDK into tools/):
  powershell -ExecutionPolicy Bypass -File frontend/scripts/setup-android-tools.ps1

Then re-run: npm run apk:debug
"@
}
if (-not (Test-Path $SdkHome) -or -not (Test-Path "$SdkHome\platform-tools")) {
  throw @"
Android SDK not found at tools/android-sdk.

One-time setup:
  powershell -ExecutionPolicy Bypass -File frontend/scripts/setup-android-tools.ps1

Then re-run: npm run apk:debug
"@
}

$env:JAVA_HOME = $JdkHome
$env:ANDROID_HOME = $SdkHome
$env:ANDROID_SDK_ROOT = $SdkHome
$env:Path = "$JdkHome\bin;$SdkHome\platform-tools;$env:Path"

$sdkDirProp = ($SdkHome -replace '\\', '\\')
Set-Content -Path (Join-Path $FrontendRoot "android\local.properties") -Value "sdk.dir=$sdkDirProp" -Encoding ASCII

Set-Location $FrontendRoot
Write-Host ">> npm run build"
npm run build
if ($LASTEXITCODE -ne 0) { throw "web build failed" }

Write-Host ">> npx cap sync android"
npx cap sync android
if ($LASTEXITCODE -ne 0) { throw "cap sync failed" }

Set-Location (Join-Path $FrontendRoot "android")
Write-Host ">> gradlew assembleDebug"
.\gradlew.bat assembleDebug --no-daemon
if ($LASTEXITCODE -ne 0) { throw "gradle build failed" }

$built = Join-Path $FrontendRoot "android\app\build\outputs\apk\debug\app-debug.apk"
$outDir = Join-Path $RepoRoot "releases"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$dest = Join-Path $outDir "presence-debug.apk"
Copy-Item $built $dest -Force
Write-Host ""
Write-Host "APK ready: $dest"
Write-Host "Install: copy to phone and open, or: adb install -r `"$dest`""