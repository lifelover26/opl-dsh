/** The release must carry only OPL code and explicit official runtime peers. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const output = new URL('../dist/', import.meta.url)
test('tarball checksum and contents bind the installer to an external plugin', async () => {
  const manifest = JSON.parse(await readFile(new URL('artifact.json', output), 'utf8'))
  const bytes = await readFile(new URL(manifest.name, output))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256)
  // A Windows drive path is read by tar as a remote `host:path`, so list the bare asset name
  // from the dist directory instead of handing over an absolute path.
  const files = execFileSync('tar', ['-tzf', manifest.name], {
    cwd: fileURLToPath(output),
    encoding: 'utf8',
  })
  assert.doesNotMatch(files, /node_modules|app\.asar|credentials|\/\.env/)
  assert.ok(!files.includes('package/lib/zcode-harness-bridge.mjs'))
  for (const bridge of [
    'native-harness-bridge.mjs',
    'step-bridge.mjs',
    'pi-bridge.mjs',
    'zcode-ofm-bridge.mjs',
    'muse-bridge.mjs',
    'muse-bash-mcp.mjs',
    'muse-endpoint.mjs',
  ])
    assert.ok(files.includes(`package/lib/${bridge}`), `missing packaged bridge ${bridge}`)
  const pkg = JSON.parse(await readFile(new URL('package/package.json', output), 'utf8'))
  assert.equal(pkg.name, '@one-person-lab/dsh-opl')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm'], '*')
  assert.equal(manifest.version, manifest.officialVersion)
  assert.equal(manifest.enhancementVersion, pkg.version)
  const companion = manifest.superagent
  assert.equal(companion.upstreamCommit, '6337fc823ce20251c8de8085948165c81aaa701e')
  assert.equal(
    createHash('sha256')
      .update(await readFile(new URL(companion.name, output)))
      .digest('hex'),
    companion.sha256,
  )
  const original = JSON.parse(
    await readFile(new URL('superagent-package/package/package.json', output), 'utf8'),
  )
  assert.equal(original.name, 'dsh-superagent')
  assert.equal(original.peerDependencies['@deepseek-ai/dsh-session'], '0.2.1-rc.5')
  assert.equal(original.dependencies['proper-lockfile'], '4.1.2')
  const originalClient = await readFile(
    new URL('superagent-package/package/lib/client.js', output),
    'utf8',
  )
  assert.match(originalClient, /__ModuleLoader__/)
  const code = await readFile(new URL('package/lib/index.js', output), 'utf8')
  assert.doesNotMatch(code, /api\.modelarts-maas\.com|HUAWEI_MAAS_API_KEY|oplContextBudget/)
  assert.match(code, /from "@deepseek-ai\/dsh-llm-deepseek"/)
  assert.doesNotMatch(
    code,
    /class LlmRuntime|class AgentLoop|resolveProfiles|credentialStoreFrom|authContextFrom/,
  )
  const client = await readFile(new URL('package/lib/client.js', output), 'utf8')
  assert.doesNotMatch(
    client,
    /require\("@deepseek-ai\/dsh-typert-protocol\/remote-info"\)/,
    'the official Client loader does not materialize the protocol remote-info leaf',
  )
})
