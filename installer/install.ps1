param([string]$Root = $(if ($env:OPL_SUITE_ROOT) { $env:OPL_SUITE_ROOT } else { Join-Path $env:APPDATA 'OPL DSH Suite' }),[string]$Payload = $PSScriptRoot,[switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'cache') | Out-Null
Start-Transcript -Path (Join-Path $Root 'installer.log') -Append | Out-Null
$lock = $null
try {
  $lock = [IO.File]::Open((Join-Path $Root 'install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
  function Assert-OfficialSignature([string]$Path) {
    try {
      $s = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction SilentlyContinue
      if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match '^CN="?Hangzhou DeepSeek Artificial Intelligence Co\., Ltd\.') { return }
    } catch {}
    $legacy = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $legacy) {
      $env:OPL_SIGNED_PATH = $Path
      try {
        $code = '$s=Get-AuthenticodeSignature -LiteralPath $env:OPL_SIGNED_PATH; if($s.Status -eq "Valid"){"OPL_SIGNATURE_OK"}'
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
        $result = & $legacy -NoProfile -NonInteractive -EncodedCommand $encoded 2>$null
        if ($result -contains 'OPL_SIGNATURE_OK') { return }
      } finally {
        Remove-Item Env:OPL_SIGNED_PATH -ErrorAction SilentlyContinue
      }
    }
    $certutil = Get-Command certutil.exe -ErrorAction SilentlyContinue
    if ($certutil) {
      & $certutil.Source -verify -urlfetch $Path *> $null
      if ($LASTEXITCODE -eq 0) { return }
      & $certutil.Source -verify $Path *> $null
      if ($LASTEXITCODE -eq 0) { return }
    }
    $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($signtool) {
      & $signtool.Source verify /pa /all $Path *> $null
      if ($LASTEXITCODE -eq 0) { return }
    }
    throw 'DeepSeek 官方签名验证失败。'
  }
  function Get-HashHex([string]$Path, [string]$Algorithm) {
    $hasher = [Security.Cryptography.HashAlgorithm]::Create($Algorithm)
    if (-not $hasher) { throw ('无法创建校验算法：' + $Algorithm) }
    try {
      return [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($Path))).Replace('-', '').ToLowerInvariant()
    } finally {
      $hasher.Dispose()
    }
  }
  function Feed-Scalar([string]$Text,[string]$Name) {
    $m = [regex]::Matches($Text, '(?m)^' + $Name + ':\s*(?:[>|]-?\r?\n[ \t]+)?([^\r\n]+)\r?$')
    if ($m.Count -ne 1) { throw '官方更新清单无效。' }
    return $m[0].Groups[1].Value.Trim()
  }
  Write-Output '正在检查 DeepSeek 官方桌面更新…'
  $content = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml').Content
  $feed = if ($content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($content) } else { [string]$content }
  $officialVersion = Feed-Scalar $feed 'version'
  $url = Feed-Scalar $feed 'path'
  $sha512 = Feed-Scalar $feed 'sha512'
  if ($officialVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or $sha512 -notmatch '^[A-Za-z0-9+/]{86}==$') { throw '官方版本或校验信息无效。' }
  if ($url -cne ('https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-' + $officialVersion + '-win-x64.exe')) { throw '官方更新地址无效。' }
  $app = $null
  $needsInstall = $true
  $previous = Join-Path $Root 'installation.json'
  if (Test-Path -LiteralPath $previous) {
    $installed = Get-Content -LiteralPath $previous -Raw -Encoding UTF8 | ConvertFrom-Json
    $app = $installed.app
    if (-not (Test-Path -LiteralPath (Join-Path $app 'DeepSeek Harness.exe'))) {
      $app = Join-Path $Root 'runtime\DeepSeek Harness'
    }
  } else {
    # Reuse the vendor's registered per-user desktop. Avoid a second installation
    # and preserve its official updater's directory and uninstall registration.
    $registrations = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ItemProperty $_.PSPath } |
      Where-Object { $_.DisplayName -match '^DeepSeek Harness( |$)' -and $_.InstallLocation })
    $registered = $registrations | Select-Object -First 1
    if ($registered) { $app = $registered.InstallLocation.TrimEnd('\') }
  }
  if (-not $app) { $app = Join-Path ${env:LOCALAPPDATA} 'Programs\DeepSeek Harness' }
  $oldExe = Join-Path $app 'DeepSeek Harness.exe'
  if (Test-Path -LiteralPath $oldExe) {
    Assert-OfficialSignature $oldExe
    if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $oldExe }) { throw '请先退出 DeepSeek Harness，再运行安装器。' }
    $env:ELECTRON_RUN_AS_NODE='1'
    $args = @((Join-Path $Payload 'compare.cjs'), $app, (Get-Item $oldExe).VersionInfo.FileVersion, $officialVersion) | ForEach-Object { '"' + $_ + '"' }
    $comparison = Start-Process -FilePath $oldExe -ArgumentList $args -Wait -PassThru
    if ($comparison.ExitCode -eq 0) { $needsInstall = $false }
  }
  $exe = Join-Path $app 'DeepSeek Harness.exe'
  if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) { throw '请先退出 DeepSeek Harness，再运行安装器。' }
  if ($needsInstall) {
    $archive = Join-Path $Root ('cache\deepseek-harness-' + $officialVersion + '-win-x64.exe')
    if (-not (Test-Path -LiteralPath $archive)) {
      Write-Output ('正在下载官方 DeepSeek Harness ' + $officialVersion + '…')
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile ($archive + '.part')
      Move-Item -LiteralPath ($archive + '.part') -Destination $archive
    }
    $expected = [BitConverter]::ToString([Convert]::FromBase64String($sha512)).Replace('-', '')
    if ((Get-HashHex $archive 'SHA512') -ne $expected.ToLowerInvariant()) { throw '官方安装文件校验失败。' }
    Assert-OfficialSignature $archive
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $archive -ArgumentList @('/S', "/D=$app") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw ('官方运行环境安装失败（退出码 ' + $process.ExitCode + '）。') }
    if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne $officialVersion) { throw '官方版本与清单不符。' }
  }
  Assert-OfficialSignature $exe
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:NODE_USE_SYSTEM_CA = '1'
  $installArgs = @((Join-Path $Payload 'install.mjs'), $app, $Root, $Payload)
  if ($NoLaunch -or $env:OPL_INSTALL_NO_LAUNCH -eq '1') { $installArgs += '--no-launch' }
  $installArgs = $installArgs | ForEach-Object { '"' + $_ + '"' }
  $installed = Start-Process -FilePath $exe -ArgumentList $installArgs -Wait -PassThru
  if ($installed.ExitCode -ne 0) { throw 'OPL 增强安装失败。' }
} catch {
  Write-Error $_ -ErrorAction Continue
  exit 1
} finally {
  if ($lock) { $lock.Dispose() }
  Stop-Transcript | Out-Null
}
