import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertIsolatedRoot,
  verifyPayload,
  safeBinding,
  sha256,
  installationDiagnostics,
} from '../scripts/qualification-support.mjs'
import {
  officialCapabilityInventory,
  verifyOfficialTeamChild,
} from '../scripts/qualification-official-capabilities.mjs'

test('official Team child waits for its durable end through the parent-addressed events API', async () => {
  let calls = 0
  const assistant = {
    type: 'event',
    event: { type: 'message/assistant', data: { text: 'OPL_OFFICIAL_TEAM_CHILD_VERIFIED' } },
  }
  await verifyOfficialTeamChild({
    parentSessionId: 'lead-session',
    childSessionId: 'child-session',
    wire: async (method, args) => {
      assert.equal(method, 'session/events')
      assert.deepEqual(args.request.address, {
        kind: 'subagent',
        parentSessionId: 'lead-session',
        childSessionId: 'child-session',
        mode: 'continuable',
      })
      assert.equal(args.request.sessionId, undefined)
      calls++
      return {
        records:
          calls === 1
            ? [assistant]
            : [
                assistant,
                {
                  type: 'event',
                  event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
                },
              ],
      }
    },
  })
  assert.equal(calls, 2, 'Assistant output alone must not prove child completion')
})

test('official Team child rejects an aborted turn even when verified text already exists', async () => {
  await assert.rejects(
    verifyOfficialTeamChild({
      parentSessionId: 'lead-session',
      childSessionId: 'child-session',
      wire: async () => ({
        records: [
          {
            type: 'event',
            event: {
              type: 'message/assistant',
              data: { text: 'OPL_OFFICIAL_TEAM_CHILD_VERIFIED' },
            },
          },
          { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'aborted' } } } },
        ],
      }),
    }),
    /Official Team child did not complete/,
  )
})

test('official capability inventory requires live bundled owners and exact Host on-demand versions', () => {
  const officialVersion = '0.2.2-rc.1'
  const bundles = [
    {
      name: '@deepseek-ai/dsh-experimental-agent-team-profile',
      official: true,
      optional: true,
      availability: 'installation',
      version: officialVersion,
      enabled: true,
      rows: ['agent-team', 'tool-agent-team', 'client-ui-agent-team'].map((name) => ({
        moduleName: '@deepseek-ai/dsh-experimental-' + name,
        entryId: name,
      })),
    },
    {
      name: '@deepseek-ai/dsh-experimental-auto-review',
      official: true,
      optional: true,
      availability: 'installation',
      version: officialVersion,
      enabled: true,
      rows: [{ entryId: 'auto-review' }],
    },
    ...['codex', 'claude-code'].map((name) => ({
      name: '@deepseek-ai/dsh-subagent-' + name,
      official: true,
      installed: false,
      installTarget: {
        version: officialVersion,
        spec: '@deepseek-ai/dsh-subagent-' + name + '@' + officialVersion,
      },
    })),
  ]
  const result = officialCapabilityInventory(
    bundles,
    { presets: [{ id: 'default' }] },
    officialVersion,
  )
  assert.equal(result.agentTeams.owner, 'official')
  assert.equal(result.autoReview.mounted, true)
  assert.deepEqual(result.agentPresets.ids, ['default'])
  for (const change of [
    (items) => {
      items[0].enabled = false
    },
    (items) => {
      items[0].rows = []
    },
    (items) => {
      items[1].availability = 'profile'
    },
    (items) => {
      items[2].installTarget.version = '0.2.1-rc.5'
    },
    (items) => {
      items[3].error = { code: 'unsupported-platform' }
    },
  ]) {
    const changed = structuredClone(bundles)
    change(changed)
    assert.throws(() => officialCapabilityInventory(changed, { presets: [] }, officialVersion))
  }
})

test('qualification retains bounded package failures before scratch cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-dsh-accept-log-'))
  try {
    assert.deepEqual(await installationDiagnostics(root), [])
    const logs = join(root, 'profiles/desktop/.plugin-manager/logs/operation-test')
    await mkdir(logs, { recursive: true })
    await writeFile(
      join(logs, 'pnpm.log'),
      'x'.repeat(10000) + '\nERR_PNPM_FETCH_403 Bearer fixture-secret\n',
    )
    const [result] = await installationDiagnostics(root)
    assert.ok(result.length <= 8192)
    assert.match(result, /ERR_PNPM_FETCH_403/)
    assert.doesNotMatch(result, /fixture-secret/)
  } finally {
    await rm(root, { recursive: true })
  }
})

test('qualification accepts only a real temporary acceptance tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-dsh-accept-test-'))
  const other = await mkdtemp(join(tmpdir(), 'opl-other-'))
  try {
    assert.equal(
      await assertIsolatedRoot(root),
      await import('node:fs/promises').then((fs) => fs.realpath(root)),
    )
    await assert.rejects(assertIsolatedRoot(other), /隔离目录/)
    const nested = join(other, 'opl-dsh-accept-not-a-root')
    await mkdir(nested)
    await assert.rejects(assertIsolatedRoot(nested), /隔离目录/)
    if (process.platform !== 'win32') {
      await symlink(other, join(root, 'escape'))
      await assert.rejects(assertIsolatedRoot(join(root, 'escape')), /隔离目录/)
    }
  } finally {
    await rm(root, { recursive: true })
    await rm(other, { recursive: true })
  }
})

test('qualification refuses remote control endpoint or missing process owner', () => {
  const binding = { endpoint: 'http://127.0.0.1:2345/control', token: 'fixture', pid: 123 }
  assert.deepEqual(safeBinding(binding), binding)
  assert.throws(() => safeBinding({ ...binding, endpoint: 'http://example.com/control' }), /无效/)
  assert.throws(() => safeBinding({ ...binding, pid: 0 }), /无效/)
})

test('qualification binds evidence to every shipped byte and rejects traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-qualification-payload-'))
  try {
    const name = 'opl-dsh-enhancements-1.0.0.tgz'
    const bytes = Buffer.from('fixture')
    await writeFile(join(root, name), bytes)
    const payloadFiles = { [name]: sha256(bytes) }
    const manifest = {
      name,
      sha256: sha256(bytes),
      payloadFiles,
      suiteSha256: sha256(JSON.stringify(payloadFiles)),
    }
    await writeFile(join(root, 'artifact.json'), JSON.stringify(manifest))
    assert.equal((await verifyPayload(root)).sha256, sha256(bytes))
    await writeFile(join(root, name), 'tampered')
    await assert.rejects(verifyPayload(root), /摘要不匹配/)
    const badFiles = { '../outside': sha256(bytes) }
    await writeFile(
      join(root, 'artifact.json'),
      JSON.stringify({
        ...manifest,
        payloadFiles: badFiles,
        suiteSha256: sha256(JSON.stringify(badFiles)),
      }),
    )
    await assert.rejects(verifyPayload(root), /路径无效/)
  } finally {
    await rm(root, { recursive: true })
  }
})

test('desktop CDP uses only its child pipe and matches fragmented responses', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const { DesktopPipe } = await import('../scripts/qualification-client.mjs')
  const child = new EventEmitter()
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()]
  const pipe = new DesktopPipe(child)
  child.stdio[3].once('data', (bytes) => {
    const request = JSON.parse(bytes.toString().replace(/\0$/, ''))
    assert.equal(request.sessionId, 'isolated-session')
    const response = JSON.stringify({ id: request.id, result: { result: { value: true } } }) + '\0'
    child.stdio[4].write(response.slice(0, 7))
    child.stdio[4].write(response.slice(7))
  })
  assert.equal(await pipe.evaluate('isolated-session', 'true'), true)
  const pending = pipe.command('Page.enable')
  child.emit('exit', 0)
  await assert.rejects(pending, /CDP 已关闭/)
})
