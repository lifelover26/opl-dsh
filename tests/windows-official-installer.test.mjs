import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const windowsOnly = process.platform === 'win32' ? false : 'requires Windows PowerShell install.ps1'
const installer = fileURLToPath(new URL('../installer/install.ps1', import.meta.url))
const officialVersion = '0.2.2-rc.1'
const installedVersion = '0.2.1-rc.5'
const feedUrl = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml'

// Run the shipping script with only its external calls replaced. Every accepted
// file belongs to the fixture; unexpected network, registry and process calls fail.
const harness = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$script:fixture = Get-Content -LiteralPath $env:OPL_INSTALLER_TEST_FIXTURE -Raw -Encoding UTF8 | ConvertFrom-Json
$script:events = New-Object 'System.Collections.Generic.List[object]'
$script:version = $script:fixture.installedVersion

function Invoke-WebRequest {
  [CmdletBinding()]
  param([string]$Uri, [switch]$UseBasicParsing, [int]$TimeoutSec, [string]$OutFile)
  if ($Uri -cne $script:fixture.feedUrl -or $OutFile) { throw "Unexpected download: $Uri" }
  $script:events.Add(@{ kind = 'feed'; uri = $Uri })
  return [pscustomobject]@{ Content = $script:fixture.feed }
}

function Get-AuthenticodeSignature {
  [CmdletBinding()]
  param([string]$LiteralPath)
  if ($LiteralPath -notin @($script:fixture.exe, $script:fixture.archive)) {
    throw "Unexpected signature lookup: $LiteralPath"
  }
  $script:events.Add(@{ kind = 'signature'; path = $LiteralPath })
  return [pscustomobject]@{
    Status = 'Valid'
    SignerCertificate = [pscustomobject]@{ Subject = 'CN=Hangzhou DeepSeek Artificial Intelligence Co., Ltd.' }
  }
}

function Get-Process {
  [CmdletBinding()]
  param()
}

function Get-Item {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$Path, [string]$LiteralPath)
  $target = if ($LiteralPath) { $LiteralPath } else { $Path }
  if ($target -ne $script:fixture.exe) { throw "Unexpected version lookup: $target" }
  $script:events.Add(@{ kind = 'version'; value = $script:version })
  return [pscustomobject]@{ VersionInfo = [pscustomobject]@{ FileVersion = $script:version } }
}

function Test-Path {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$Path, [string]$LiteralPath)
  $target = if ($LiteralPath) { $LiteralPath } else { $Path }
  if ($target -notin @($script:fixture.receipt, $script:fixture.exe, $script:fixture.archive)) {
    throw "Unexpected path lookup: $target"
  }
  return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $target
}

function Get-ChildItem {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$Path)
  throw "Unexpected enumeration: $Path"
}

function Get-ItemProperty {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$Path)
  throw "Unexpected property lookup: $Path"
}

function Start-Process {
  [CmdletBinding()]
  param([string]$FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru)
  $phase = if ($FilePath -eq $script:fixture.archive) { 'official' }
    elseif ($FilePath -eq $script:fixture.exe -and $ArgumentList[0] -eq ('"' + $script:fixture.compare + '"')) { 'compare' }
    elseif ($FilePath -eq $script:fixture.exe -and $ArgumentList[0] -eq ('"' + $script:fixture.enhancement + '"')) { 'enhancement' }
    else { throw "Unexpected process: $FilePath $ArgumentList" }
  $script:events.Add(@{
    kind = 'start'; phase = $phase; path = $FilePath; arguments = @($ArgumentList)
    electronRunAsNode = $env:ELECTRON_RUN_AS_NODE
    hasElectronRunAsNode = Microsoft.PowerShell.Management\\Test-Path Env:ELECTRON_RUN_AS_NODE
    wait = [bool]$Wait; passThru = [bool]$PassThru
  })
  if ($phase -eq 'official') {
    if ($script:fixture.vendorExitCode -eq 0) { $script:version = $script:fixture.officialVersion }
    return [pscustomobject]@{ ExitCode = $script:fixture.vendorExitCode }
  }
  if ($phase -eq 'compare') { return [pscustomobject]@{ ExitCode = 1 } }
  return [pscustomobject]@{ ExitCode = 0 }
}

$LASTEXITCODE = 0
try {
  . $script:fixture.installer -Root $script:fixture.root -Payload $script:fixture.payload -NoLaunch
} finally {
  $json = ConvertTo-Json -InputObject @($script:events.ToArray()) -Depth 8
  [IO.File]::WriteAllText($script:fixture.report, $json, (New-Object Text.UTF8Encoding($false)))
}
exit $LASTEXITCODE
`

function runInstaller(t, vendorExitCode) {
  const scratch = mkdtempSync(join(tmpdir(), 'opl-windows-official-installer-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const root = join(scratch, 'Suite root')
  const payload = join(scratch, 'Enhancement payload')
  const app = join(scratch, 'Official app with spaces')
  const temporary = join(scratch, 'tmp')
  for (const directory of [join(root, 'cache'), payload, app, temporary])
    mkdirSync(directory, { recursive: true })
  const exe = join(app, 'DeepSeek Harness.exe')
  const archive = join(root, 'cache', `deepseek-harness-${officialVersion}-win-x64.exe`)
  const receipt = join(root, 'installation.json')
  const compare = join(payload, 'compare.cjs')
  const enhancement = join(payload, 'install.mjs')
  const report = join(scratch, 'observations.json')
  const wrapper = join(scratch, 'run-installer.ps1')
  const fixturePath = join(scratch, 'fixture.json')
  const archiveBytes = Buffer.from('test-owned official installer fixture\n')
  writeFileSync(exe, 'not an executable\n')
  writeFileSync(archive, archiveBytes)
  writeFileSync(receipt, JSON.stringify({ app }))
  for (const script of [compare, enhancement])
    writeFileSync(script, 'throw new Error("stub only")\n')
  const sha512 = createHash('sha512').update(archiveBytes).digest('base64')
  writeFileSync(
    fixturePath,
    JSON.stringify({
      installer,
      root,
      payload,
      exe,
      archive,
      receipt,
      compare,
      enhancement,
      report,
      vendorExitCode,
      officialVersion,
      installedVersion,
      feedUrl,
      feed: `version: ${officialVersion}\npath: https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-${officialVersion}-win-x64.exe\nsha512: ${sha512}\n`,
    }),
  )
  writeFileSync(wrapper, '\ufeff' + harness)
  const env = { ...process.env }
  for (const name of Object.keys(env))
    if (
      /^GIT_|^(ELECTRON_RUN_AS_NODE|OPL_INSTALL_NO_LAUNCH|OPL_INSTALLER_TEST_FIXTURE|TEMP|TMP|TMPDIR)$/i.test(
        name,
      )
    )
      delete env[name]
  Object.assign(env, {
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    OPL_INSTALLER_TEST_FIXTURE: fixturePath,
  })
  const run = spawnSync(
    join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper],
    { cwd: scratch, env, encoding: 'utf8', windowsHide: true, timeout: 60000 },
  )
  assert.ifError(run.error)
  assert.equal(run.signal, null, 'PowerShell must finish without a signal or timeout')
  assert.ok(existsSync(report), run.stdout + run.stderr)
  const events = JSON.parse(readFileSync(report, 'utf8'))
  assert.deepEqual(
    events.filter((event) => event.kind === 'feed'),
    [{ kind: 'feed', uri: feedUrl }],
  )
  assert.deepEqual(readFileSync(archive), archiveBytes)
  assert.equal(readFileSync(exe, 'utf8'), 'not an executable\n')
  assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { app })
  return { run, events, root, payload, app, exe, archive, compare, enhancement }
}

function starts(events) {
  return events.filter((event) => event.kind === 'start')
}

test(
  'Windows installer clears Node mode for official NSIS and restores it for enhancements',
  { skip: windowsOnly },
  (t) => {
    const result = runInstaller(t, 0)
    assert.equal(result.run.status, 0, result.run.stdout + result.run.stderr)
    const launches = starts(result.events)
    assert.deepEqual(
      launches.map(({ phase, electronRunAsNode, hasElectronRunAsNode, wait, passThru }) => ({
        phase,
        electronRunAsNode,
        hasElectronRunAsNode,
        wait,
        passThru,
      })),
      [
        {
          phase: 'compare',
          electronRunAsNode: '1',
          hasElectronRunAsNode: true,
          wait: true,
          passThru: true,
        },
        {
          phase: 'official',
          electronRunAsNode: null,
          hasElectronRunAsNode: false,
          wait: true,
          passThru: true,
        },
        {
          phase: 'enhancement',
          electronRunAsNode: '1',
          hasElectronRunAsNode: true,
          wait: true,
          passThru: true,
        },
      ],
    )
    assert.deepEqual(
      launches.map(({ path, arguments: args }) => ({ path, args })),
      [
        {
          path: result.exe,
          args: [result.compare, result.app, installedVersion, officialVersion].map(
            (value) => `"${value}"`,
          ),
        },
        { path: result.archive, args: ['/S', `/D=${result.app}`] },
        {
          path: result.exe,
          args: [result.enhancement, result.app, result.root, result.payload, '--no-launch'].map(
            (value) => `"${value}"`,
          ),
        },
      ],
    )
    assert.deepEqual(
      result.events.filter((event) => event.kind === 'version').map((event) => event.value),
      [installedVersion, officialVersion],
    )
  },
)

test(
  'Windows installer reports the official installer exit code and stops before enhancements',
  { skip: windowsOnly },
  (t) => {
    const { run, events } = runInstaller(t, 23)
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stderr, /退出码\s+23/)
    assert.deepEqual(
      starts(events).map((event) => event.phase),
      ['compare', 'official'],
    )
  },
)
