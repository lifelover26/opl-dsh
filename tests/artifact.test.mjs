/** The release must carry only OPL code and explicit official runtime peers. */
import { test } from 'node:test'
import { parse } from 'yaml'
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
  assert.doesNotMatch(files, /(?:^|\/)\._/m, 'macOS metadata must not become plugin resources')
  assert.ok(!files.includes('package/lib/zcode-harness-bridge.mjs'))
  const executionArchive = manifest.plugins.find(
    (plugin) => plugin.package === '@one-person-lab/dsh-execution',
  )
  const executionFiles = execFileSync('tar', ['-tzf', executionArchive.name], {
    cwd: fileURLToPath(output),
    encoding: 'utf8',
  })
  for (const bridge of [
    'native-harness-bridge.mjs',
    'step-bridge.mjs',
    'pi-bridge.mjs',
    'zcode-ofm-bridge.mjs',
    'muse-bridge.mjs',
    'muse-bash-mcp.mjs',
    'muse-endpoint.mjs',
  ])
    assert.ok(executionFiles.includes(`package/lib/${bridge}`), `missing packaged bridge ${bridge}`)
  const overlay = parse(await readFile(new URL('package/cordis.patch.yml', output), 'utf8'))
  const web = overlay.find((entry) => entry.id === 'web')
  assert.equal(web?.config?.searchProvider, 'opl-gateway')
  assert.equal(web.config.fetchProvider, undefined)
  const pkg = JSON.parse(await readFile(new URL('package/package.json', output), 'utf8'))
  assert.equal(pkg.name, '@one-person-lab/dsh-opl')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm'], '*')
  const project = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dependencies.zod, project.devDependencies.zod)
  assert.equal(pkg.peerDependencies.zod, undefined)
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], pkg.icon)
  assert.ok(files.includes('package/' + pkg.icon.slice(2)))
  assert.deepEqual(
    await readFile(new URL('package/' + pkg.icon.slice(2), output)),
    await readFile(new URL('../' + project.icon.slice(2), import.meta.url)),
  )
  for (const language of ['zh', 'en']) {
    const resource = pkg.exports['./locale/*.json'].replace('*', language)
    const { meta } = JSON.parse(await readFile(new URL('package/' + resource.slice(2), output)))
    assert.equal(typeof meta.title, 'string')
    assert.notEqual(meta.title, pkg.name)
    assert.equal(typeof meta.description, 'string')
    assert.ok(files.includes('package/' + meta.detail))
    assert.ok(await readFile(new URL('package/' + meta.detail, output), 'utf8'))
  }
  assert.equal(manifest.version, manifest.officialVersion)
  assert.equal(manifest.updateProtocolVersion, 1)
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
  assert.equal(original.peerDependencies['@deepseek-ai/dsh-session'], '0.2.2-rc.3')
  assert.equal(original.dependencies['proper-lockfile'], '4.1.2')
  assert.equal(original.dependencies.zod, '4.6.7')
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

test('three real packages own distinct Host and Client lifecycles', async () => {
  const artifact = JSON.parse(await readFile(new URL('artifact.json', output), 'utf8'))
  assert.deepEqual(
    artifact.plugins.map((plugin) => plugin.package),
    ['@one-person-lab/dsh-execution', '@one-person-lab/dsh-collaboration'],
  )
  for (const plugin of artifact.plugins) {
    const id = plugin.package.split('dsh-')[1]
    const bytes = await readFile(new URL(plugin.name, output))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), plugin.sha256)
    assert.equal(artifact.payloadFiles[plugin.name], plugin.sha256)
    const pkg = JSON.parse(
      await readFile(new URL(`${id}-package/package/package.json`, output), 'utf8'),
    )
    assert.equal(pkg.name, plugin.package)
    if (id === 'collaboration') {
      assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-agent-preset-registry'], '*')
      assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-skill-filesystem'], '*')
      assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tool-skill'], '*')
    }
    const client = await readFile(new URL(`${id}-package/package/lib/client.js`, output), 'utf8')
    assert.ok(client.includes(`id:"${plugin.package}"`))
    const metadata = JSON.parse(
      await readFile(new URL(`${id}-package/package/locale/zh.json`, output), 'utf8'),
    )
    assert.match(metadata.meta.title, /^OPL /)
    assert.ok(
      await readFile(new URL(`${id}-package/package/${metadata.meta.detail}`, output), 'utf8'),
    )
  }
  const baseHost = await readFile(new URL('package/lib/index.js', output), 'utf8')
  const executionHost = await readFile(
    new URL('execution-package/package/lib/index.js', output),
    'utf8',
  )
  const collaborationHost = await readFile(
    new URL('collaboration-package/package/lib/index.js', output),
    'utf8',
  )
  assert.doesNotMatch(baseHost, /class HarnessService|OfficialCollaborationBridge/)
  assert.doesNotMatch(executionHost, /new OfficialCollaborationBridge/)
  assert.match(collaborationHost, /OfficialCollaborationBridge/)
  assert.match(collaborationHost, /DomainAgentPresetService/)
})
