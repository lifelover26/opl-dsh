/**
 * Grok Build permission mapping — focused behaviour tests.
 *
 * The code under test lives in `src/execution/host/adapters/grok.ts`. These run
 * under plain `node --test`, which cannot import that module directly (its
 * import graph uses TypeScript parameter properties), so the module is
 * transpiled here with the repository's own esbuild and imported with only
 * its collaborators stubbed. Every assertion therefore runs against the real
 * source file, and a stale `dist/` cannot make them pass.
 *
 * The launch flags are asserted by calling the real `prepare()`, not by
 * pattern-matching its source. The source is still read for two safety
 * properties that a behavioural test cannot see: no hard-coded permission flag,
 * and no sandbox value passed straight through from the record.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'

const source = fileURLToPath(new URL('../src/execution/host/adapters/grok.ts', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'opl-grok-perm-'))

/** Stub only the collaborators; every line of grok.ts itself is the real source. */
const STUBS = {
  '../../../gateway/host/config.ts': "export const GROK_API_KEY_REF = 'OPL_GATEWAY_GROK_API_KEY'",
  '../../../gateway/host/opl-credentials.ts':
    "export const OPL_GATEWAY_INFERENCE_BASE_URL = 'https://gateway.medopl.com/v1'",
  '../../../gateway/host/execution-access.ts':
    'export async function resolveGatewayExecution() { return { apiKey: "fake", baseURL: "https://gateway.medopl.com/v1", model: "grok-4.7", credential: "stub" } }',
  '../harness-registry.ts':
    'export async function executablePath() { return true }\nexport function commandLaunch(command, args = []) { return { command, args } }',
  '../multimodal-prompt.ts': `export { agentSupportsPromptImages } from ${JSON.stringify(new URL('../src/execution/host/multimodal-prompt.ts', import.meta.url).href)}`,
  './environment.ts': 'export function systemEnvironment() { return {} }',
  './grok-bash.ts':
    "export async function grokBashEnvironment(env) { return { ...env, GROK_SHELL: 'bash' } }",
  '../acp.ts': 'export class HarnessConfigurationError extends Error {}',
  './types.ts': 'export {}',
}

async function loadAdapter() {
  for (const [specifier, code] of Object.entries(STUBS))
    writeFileSync(join(root, `${specifier.replace(/[^a-z]/gi, '_')}.mjs`), code)
  let code = readFileSync(source, 'utf8')
  for (const specifier of Object.keys(STUBS))
    code = code.replaceAll(`'${specifier}'`, `'./${specifier.replace(/[^a-z]/gi, '_')}.mjs'`)
  const transpiled = transformSync(code, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  }).code
  const file = join(root, 'grok.mjs')
  writeFileSync(file, transpiled)
  return import(pathToFileURL(file).href)
}

const grok = await loadAdapter()
const isConfigurationError = (error) => error?.constructor?.name === 'HarnessConfigurationError'

/** Drive the real prepare() against a chosen home, so repeat calls share one profile. */
async function prepareIn(home, tier = 'full-access', cwd) {
  const record = {
    sandbox: tier,
    cwd: cwd ?? join(home, 'workspace with spaces'),
    modelRef: { provider: 'opl-gateway', model: 'grok::grok-4.7' },
  }
  return grok.grokAdapter.prepare({}, record, { home, grokCommand: 'grok', nativeBridgePath: '' })
}

/** Drive the real prepare() and report the flags it actually produced. */
async function launch(tier) {
  const home = mkdtempSync(join(tmpdir(), 'opl-grok-home-'))
  const launch = await prepareIn(home, tier)
  return { launch, configPath: join(home, 'harnesses', 'grok-build', 'config.toml') }
}

/** The two values the adapter passes to the CLI, as a pair. */
const flagPair = (args, flag) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

test('full-access maps to the real off-sandbox plus no-ask mode', () => {
  for (const platform of ['win32', 'darwin', 'linux'])
    assert.deepEqual(grok.grokPermissionPlan('full-access', platform), {
      sandbox: 'off',
      permissionMode: 'bypassPermissions',
      isolation: 'none',
    })
})

test('full-access never passes a full-access sandbox profile through', () => {
  const plan = grok.grokPermissionPlan('full-access', 'win32')
  assert.notEqual(plan.sandbox, 'full-access')
  assert.ok(['off', 'workspace', 'read-only'].includes(plan.sandbox))
})

test('restricted tiers pass the built-in profile through without claiming enforcement', () => {
  // The official documentation states a built-in profile that fails to apply only
  // warns and continues unenforced, so no platform may be reported as enforced.
  assert.deepEqual(grok.grokPermissionPlan('workspace', 'darwin'), {
    sandbox: 'workspace',
    permissionMode: 'default',
    isolation: 'unverified',
  })
  assert.deepEqual(grok.grokPermissionPlan('read-only', 'linux'), {
    sandbox: 'read-only',
    permissionMode: 'default',
    isolation: 'unverified',
  })
})

test('Windows refuses restricted tiers instead of pretending they are isolated', () => {
  for (const tier of ['workspace', 'read-only'])
    assert.throws(
      () => grok.grokPermissionPlan(tier, 'win32'),
      (error) => {
        assert.equal(error.constructor.name, 'HarnessConfigurationError')
        assert.match(error.message, /Windows/)
        assert.match(error.message, /full-access/)
        return true
      },
      `${tier} must not be accepted on Windows`,
    )
})

test('a restricted tier is never escalated into full access', () => {
  try {
    grok.grokPermissionPlan('read-only', 'win32')
    assert.fail('expected a refusal')
  } catch (error) {
    assert.doesNotMatch(error.message, /bypassPermissions/)
  }
})

test('an unknown tier fails instead of falling back to something permissive', () => {
  for (const tier of ['', 'unknown', 'FULL-ACCESS', 'danger-full-access'])
    assert.throws(() => grok.grokPermissionPlan(tier, 'win32'), isConfigurationError)
})

test('prepare() really launches full-access with the off-sandbox and no-ask flags', async () => {
  const { launch: result, configPath } = await launch('full-access')
  assert.equal(flagPair(result.args, '--sandbox'), 'off')
  assert.equal(flagPair(result.args, '--permission-mode'), 'bypassPermissions')
  assert.ok(!result.args.includes('full-access'), 'no unknown profile name may reach the CLI')
  assert.ok(existsSync(configPath), 'the profile is still written for an accepted tier')
  assert.equal(result.env.GROK_SHELL, 'bash')
})

test(
  'prepare() refuses a restricted Windows tier before writing any profile',
  { skip: process.platform !== 'win32' },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'opl-grok-home-'))
    const record = {
      sandbox: 'workspace',
      cwd: join(home, 'workspace with spaces'),
      modelRef: { provider: 'opl-gateway', model: 'grok::grok-4.7' },
    }
    await assert.rejects(
      grok.grokAdapter.prepare({}, record, { home, grokCommand: 'grok', nativeBridgePath: '' }),
      isConfigurationError,
    )
    assert.ok(
      !existsSync(join(home, 'harnesses', 'grok-build', 'config.toml')),
      'a refused tier must not leave a written profile behind',
    )
    assert.ok(!existsSync(join(home, 'harnesses')), 'and must not create the profile directory')
  },
)

test('prepare() never hard-codes a permission flag or passes the tier through', () => {
  const code = readFileSync(source, 'utf8')
  assert.doesNotMatch(code, /'--permission-mode',\s*\n\s*'default'/)
  assert.doesNotMatch(code, /'--sandbox',\s*\n\s*record\.sandbox/)
  assert.match(code, /grokPermissionPlan\(record\.sandbox\)/)
})

test('the suite configuration stays byte-stable and free of shell and permission keys', () => {
  const config = grok.grokConfiguration()
  assert.match(config, /env_key = "OPL_GATEWAY_GROK_API_KEY"/)
  assert.doesNotMatch(config, /GROK_SHELL/)
  assert.doesNotMatch(config, /^\s*shell\s*=/mu)
  assert.doesNotMatch(config, /permission_mode/)
  assert.deepEqual(grok.grokConfigLayouts(), [
    config,
    grok.grokConfigurationWithCliMarker(),
    grok.grokLegacyConfiguration(),
    `${grok.grokLegacyConfiguration()}\n[marketplace]\ndefault_skills_installs_purged = true\n`,
  ])
})

test('an externally edited configuration is never part of the known layouts', () => {
  const edited = `${grok.grokConfiguration()}\n# user added this\n`
  assert.ok(!grok.grokConfigLayouts().includes(edited))
})

// The official CLI appends this block to a profile it did not write itself, on
// first start. These pin the exact bytes measured against the installed CLI, so
// the accepted variant cannot silently drift into "any TOML the suite can parse".
const CLI_MARKER = '\n[marketplace]\ndefault_skills_installs_purged = true\n'

test('the accepted CLI-owned marker matches the bytes the installed CLI actually wrote', () => {
  const marked = grok.grokConfigurationWithCliMarker()
  assert.equal(marked, `${grok.grokConfiguration()}${CLI_MARKER}`)
  // 540 written by the suite, 53 appended by the CLI, 593 measured on disk.
  assert.equal(Buffer.byteLength(grok.grokLegacyConfiguration()), 540)
  assert.equal(Buffer.byteLength(marked) - Buffer.byteLength(grok.grokConfiguration()), 53)
  assert.ok(!marked.includes('\r'), 'the profile stays LF throughout')
  assert.equal(marked.split(CLI_MARKER).length, 2, 'the marker appears exactly once')
})

test('only the exact CLI block is accepted, not a similar-looking table', () => {
  const config = grok.grokConfiguration()
  for (const impostor of [
    `${config}${CLI_MARKER}\n[marketplace]\ndefault_skills_installs_purged = true\n`,
    `${config}\n[marketplace]\ndefault_skills_installs_purged = false\n\n`,
    `${config}\n[marketplace]\n`,
    `${config}${CLI_MARKER}# user added this\n`,
    `${config}${CLI_MARKER.trimStart()}`,
  ])
    assert.ok(
      !grok.grokConfigLayouts().includes(impostor),
      `an outside edit must stay refused: ${JSON.stringify(impostor.slice(-60))}`,
    )
})

/** Read a profile straight off disk so assertions cannot be fooled by the writer. */
const profileOf = (home) =>
  readFileSync(join(home, 'harnesses', 'grok-build', 'config.toml'), 'utf8')

test('prepare() writes the profile on first start and leaves it alone afterwards', async () => {
  const home = mkdtempSync(join(tmpdir(), 'opl-grok-home-'))
  const first = await prepareIn(home)
  assert.equal(flagPair(first.args, '--permission-mode'), 'bypassPermissions')
  assert.equal(profileOf(home), grok.grokConfiguration())

  // A second start against the same home must not rewrite an already-valid file.
  await prepareIn(home)
  assert.equal(profileOf(home), grok.grokConfiguration())
})

test('prepare() succeeds once the CLI has appended its marker, and keeps it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'opl-grok-home-'))
  await prepareIn(home)
  // Reproduce what the official CLI does on first start with a profile it did
  // not create, then ask prepare() again. This is the user's reported failure.
  const marked = `${profileOf(home)}${CLI_MARKER}`
  writeFileSync(join(home, 'harnesses', 'grok-build', 'config.toml'), marked)

  const launch = await prepareIn(home)
  assert.equal(flagPair(launch.args, '--sandbox'), 'off')
  assert.equal(profileOf(home), marked, 'the CLI-owned marker must survive')
  assert.ok(profileOf(home).includes('default_skills_installs_purged = true'))
})

test('prepare() keeps the CLI marker across repeated tasks in the same home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'opl-grok-home-'))
  await prepareIn(home)
  const configPath = join(home, 'harnesses', 'grok-build', 'config.toml')
  const marked = `${profileOf(home)}${CLI_MARKER}`
  writeFileSync(configPath, marked)

  // Cross-task preparation: different working directories, same profile.
  for (const dir of ['first', 'second', 'third']) {
    const launch = await prepareIn(home, 'full-access', join(home, dir))
    assert.equal(flagPair(launch.args, '--permission-mode'), 'bypassPermissions')
    assert.equal(profileOf(home), marked, `task ${dir} must not rewrite the profile`)
  }
})

test('prepare() still refuses an edited profile, for base_url, env_key and user text', async () => {
  const configPath = (home) => join(home, 'harnesses', 'grok-build', 'config.toml')
  const cases = [
    [
      'base_url',
      (t) =>
        t.replace(
          'base_url = "https://gateway.medopl.com/v1"',
          'base_url = "https://elsewhere.invalid/v1"',
        ),
    ],
    ['env_key', (t) => t.replace('env_key = "OPL_GATEWAY_GROK_API_KEY"', 'env_key = "OTHER_KEY"')],
    ['user text', (t) => `${t}\n# user added this\n`],
    [
      'a user-authored marketplace table',
      (t) => `${t}\n[marketplace]\ndefault_skills_installs_purged = true\n\n`,
    ],
  ]
  for (const [name, edit] of cases) {
    const home = mkdtempSync(join(tmpdir(), 'opl-grok-home-'))
    await prepareIn(home)
    const config = join(home, 'harnesses', 'grok-build', 'config.toml')
    // Start from the marked profile: that is the state a real, already-used
    // installation is in, so the refusal is checked against it and not a
    // pristine one.
    const tampered = edit(`${profileOf(home)}${CLI_MARKER}`)
    writeFileSync(config, tampered)

    await assert.rejects(
      grok.grokAdapter.prepare(
        {},
        {
          sandbox: 'full-access',
          cwd: join(home, 'w'),
          modelRef: { provider: 'opl-gateway', model: 'grok::grok-4.7' },
        },
        { home, grokCommand: 'grok', nativeBridgePath: '' },
      ),
      (error) => {
        assert.match(error.message, /套件的 Grok 配置已被修改/)
        return true
      },
      `${name} must be refused`,
    )
    assert.equal(readFileSync(configPath(home), 'utf8'), tampered, `${name} must be preserved`)
  }
})

const cli = process.env.OPL_GROK_CLI || join(homedir(), '.grok/bin/grok.exe')
const cliMissing = existsSync(cli)
  ? false
  : '未安装官方 Grok Build CLI（~/.grok/bin/grok.exe），跳过官方词表核对'

const runCli = (args) =>
  spawnSync(cli, args, {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, GROK_HOME: mkdtempSync(join(tmpdir(), 'opl-grok-cli-')) },
    input: '',
  })

test(
  'the installed CLI accepts exactly the permission modes this adapter emits',
  { skip: cliMissing },
  () => {
    for (const mode of ['default', 'bypassPermissions']) {
      const result = runCli([
        '--permission-mode',
        mode,
        '--sandbox',
        'off',
        'agent',
        '--no-leader',
        'stdio',
      ])
      assert.equal(result.status, 0, `${mode} must start the agent`)
      assert.doesNotMatch(result.stderr || '', /error:|invalid value/, `${mode} must be accepted`)
    }
  },
)

test(
  'the installed CLI rejects a permission mode this adapter never emits',
  { skip: cliMissing },
  () => {
    const result = runCli(['--permission-mode', 'full-access', 'agent', '--no-leader', 'stdio'])
    assert.match(result.stderr || '', /invalid value 'full-access' for '--permission-mode/)
  },
)

test(
  'the installed CLI accepts every sandbox profile this adapter emits',
  { skip: cliMissing },
  () => {
    for (const profile of ['off', 'workspace', 'read-only']) {
      const result = runCli(['--sandbox', profile, 'agent', '--no-leader', 'stdio'])
      assert.equal(result.status, 0, `${profile} must start the agent`)
      assert.doesNotMatch(result.stderr || '', /error:/, `${profile} must be accepted`)
    }
  },
)
