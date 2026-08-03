# One-time: download portable JDK 21 + Android SDK into repo tools/ (gitignored).
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Tools = Join-Path $RepoRoot "tools"
$JdkRoot = Join-Path $Tools "jdk"
$SdkHome = Join-Path $Tools "android-sdk"
$Tmp = Join-Path $env:TEMP "presence-android-tools"
if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Tools, $Tmp | Out-Null

function Download-File([string]$Url, [string]$OutFile) {
  Write-Host ">> Downloading $Url"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $dir = Split-Path $OutFile -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -L --fail --retry 3 --retry-delay 2 -o $OutFile $Url
    if ($LASTEXITCODE -ne 0) { throw "curl download failed ($LASTEXITCODE): $Url" }
  } else {
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
  }
  if (-not (Test-Path $OutFile) -or (Get-Item $OutFile).Length -lt 1MB) {
    throw "Download incomplete: $OutFile"
  }
}

# --- JDK 21 (Temurin) ---
$existingJdk = Get-ChildItem $JdkRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName "bin\java.exe") } |
  Select-Object -First 1
if (-not $existingJdk) {
  $jdkZip = Join-Path $Tmp "jdk21.zip"
  $jdkUrl = "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk"
  Download-File $jdkUrl $jdkZip
  New-Item -ItemType Directory -Force -Path $JdkRoot | Out-Null
  Write-Host ">> Extracting JDK"
  Expand-Archive -Path $jdkZip -DestinationPath $JdkRoot -Force
  Remove-Item $jdkZip -Force
} else {
  Write-Host ">> JDK already present: $($existingJdk.FullName)"
}

$JdkHome = Get-ChildItem $JdkRoot -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName "bin\java.exe") } |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $JdkHome) { throw "JDK extract failed under $JdkRoot" }
Write-Host "JAVA_HOME → $JdkHome"
& "$JdkHome\bin\java.exe" -version

# --- Android SDK command-line tools ---
$CmdTools = Join-Path $SdkHome "cmdline-tools\latest"
if (-not (Test-Path (Join-Path $CmdTools "bin\sdkmanager.bat"))) {
  $clZip = Join-Path $Tmp "cmdline-tools.zip"
  # Pin a known-good cmdline-tools package
  $clUrl = "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
  Download-File $clUrl $clZip
  $clExtract = Join-Path $Tmp "cmdline-tools-extract"
  if (Test-Path $clExtract) { Remove-Item $clExtract -Recurse -Force }
  Expand-Archive -Path $clZip -DestinationPath $clExtract -Force
  New-Item -ItemType Directory -Force -Path $CmdTools | Out-Null
  $inner = Get-ChildItem $clExtract -Directory | Select-Object -First 1
  if (-not $inner) { throw "cmdline-tools zip layout unexpected" }
  Copy-Item -Path (Join-Path $inner.FullName "*") -Destination $CmdTools -Recurse -Force
  Remove-Item $clZip, $clExtract -Recurse -Force
} else {
  Write-Host ">> Android cmdline-tools already present"
}

$env:JAVA_HOME = $JdkHome
$env:ANDROID_HOME = $SdkHome
$env:ANDROID_SDK_ROOT = $SdkHome
$SdkManager = Join-Path $CmdTools "bin\sdkmanager.bat"
if (-not (Test-Path $SdkManager)) { throw "sdkmanager missing at $SdkManager" }

Write-Host ">> Installing Android SDK packages (platform-tools, android-36, build-tools)"
$packages = @(
  "platform-tools",
  "platforms;android-36",
  "build-tools;36.0.0"
)
# Accept licenses non-interactively
$yes = ("y`n" * 40)
$yes | & $SdkManager --sdk_root=$SdkHome --licenses | Out-Host
& $SdkManager --sdk_root=$SdkHome $packages | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "sdkmanager failed with exit $LASTEXITCODE"
}

# Sanity
if (-not (Test-Path (Join-Path $SdkHome "platform-tools\adb.exe"))) {
  throw "platform-tools not installed"
}
if (-not (Test-Path (Join-Path $SdkHome "platforms\android-36"))) {
  throw "platforms;android-36 not installed"
}

Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Toolchain ready:"
Write-Host "  JDK: $JdkHome"
Write-Host "  SDK: $SdkHome"
Write-Host "Next: cd frontend; npm run apk:debug"
