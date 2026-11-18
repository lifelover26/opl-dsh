import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { workspaceExpansionExpression } from '../scripts/qualification-client.mjs'
import {
  assertIsolatedRoot,
  verifyPayload,
  safeBinding,
  sha256,
  installationDiagnostics,
} from '../scripts/qualification-support.mjs'
import {
  TEAM_CHILD_PROMPT,
  TEAM_TASK_SUBJECT,
  officialCapabilityInventory,
  officialTeamProbeResponse,
  verifyOfficialCapabilities,
  verifyOfficialTeamChild,
} from '../scripts/qualification-official-capabilities.mjs'

test('qualification opens only its fixture workspace and preserves an expanded disclosure', () => {
  const dom = new JSDOM(
    '<div role="treeitem" aria-expanded="false"><span>other-project</span></div><div role="treeitem" aria-expanded="false"><span>test-project</span></div>',
    { runScripts: 'outside-only' },
  )
  try {
    const rows = [...dom.window.document.querySelectorAll('[role=treeitem]')]
    const clicked = []
    for (const row of rows) {
      row.getClientRects = () => [1]
      row.addEventListener('click', () => {
        clicked.push(row.textContent)
        row.setAttribute('aria-expanded', 'true')
      })
    }
    assert.equal(dom.window.eval(workspaceExpansionExpression('missing-project')), false)
    assert.equal(dom.window.eval(workspaceExpansionExpression('test-project')), false)
    assert.deepEqual(clicked, ['test-project'])
    assert.equal(dom.window.eval(workspaceExpansionExpression('test-project')), true)
    assert.deepEqual(clicked, ['test-project'])
    assert.equal(rows[0].getAttribute('aria-expanded'), 'false')
  } finally {
    dom.window.close()
  }
})

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

function promotedBundles() {
  const version = '0.2.2-rc.2'
  return [
    {
      name: '@deepseek-ai/dsh-base',
      official: false,
      optional: false,
      availability: 'installation',
      version,
      enabled: true,
      rows: ['agent-team', 'tool-agent-team'].map((name) => ({
        moduleName: '@deepseek-ai/dsh-' + name,
        entryId: name,
      })),
    },
    {
      name: '@deepseek-ai/dsh-web-app',
      official: false,
      optional: false,
      availability: 'installation',
      version,
      enabled: true,
      rows: [{ moduleName: '@deepseek-ai/dsh-client-ui-agent-team', entryId: 'ui-agent-team' }],
    },
    {
      name: '@deepseek-ai/dsh-experimental-auto-review',
      official: true,
      optional: true,
      availability: 'installation',
      version,
      enabled: true,
      rows: [{ entryId: 'auto-review' }],
    },
    ...['codex', 'claude-code'].map((name) => ({
      name: '@deepseek-ai/dsh-subagent-' + name,
      official: true,
      installed: false,
      installTarget: { version, spec: '@deepseek-ai/dsh-subagent-' + name + '@' + version },
    })),
  ]
}

test('promoted Team inventory requires the shipped base and Web rows without optional-bundle flags', () => {
  const bundles = promotedBundles()
  const inventory = officialCapabilityInventory(bundles, { presets: [] }, '0.2.2-rc.2')
  assert.deepEqual(inventory.agentTeams, {
    package: '@deepseek-ai/dsh-base',
    webPackage: '@deepseek-ai/dsh-web-app',
    composition: 'base',
    owner: 'official',
    modules: [
      '@deepseek-ai/dsh-agent-team',
      '@deepseek-ai/dsh-tool-agent-team',
      '@deepseek-ai/dsh-client-ui-agent-team',
    ],
  })
  for (const change of [
    (items) => {
      items[0].enabled = false
    },
    (items) => {
      items[0].availability = 'profile'
    },
    (items) => {
      items[0].version = '0.2.2-rc.1'
    },
    (items) => {
      delete items[0].rows[0].entryId
    },
    (items) => {
      items[0].rows.pop()
    },
    (items) => {
      items[1].rows = []
    },
    (items) => {
      items[1].version = '0.2.2-rc.1'
    },
    (items) => {
      items[2].enabled = false
    },
  ]) {
    const changed = structuredClone(bundles)
    change(changed)
    assert.throws(() => officialCapabilityInventory(changed, { presets: [] }, '0.2.2-rc.2'))
  }
})

function appendToolExchange(body, response, value, protocol) {
  const { name, id, input } = response.tool
  if (protocol === 'messages') {
    body.messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: [{ type: 'text', text: JSON.stringify(value) }],
          },
        ],
      },
    )
  } else {
    body.messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id, type: 'function', function: { name, arguments: JSON.stringify(input) } },
        ],
      },
      { role: 'tool', tool_call_id: id, content: JSON.stringify(value) },
    )
  }
}

for (const protocol of ['messages', 'completions'])
  test(`promoted Team model fixture uses actual task revisions and advertised subagent tools over ${protocol}`, () => {
    const body = {
      messages: [{ role: 'user', content: 'OPL_OFFICIAL_TEAM_LEAD_PROBE' }],
      tools: ['subagent', 'team_task_create', 'team_task_update'].map((name) =>
        protocol === 'messages' ? { name } : { function: { name } },
      ),
    }
    const create = officialTeamProbeResponse(body)
    assert.equal(create.tool.name, 'team_task_create')
    assert.equal(create.tool.input.subject, TEAM_TASK_SUBJECT)
    appendToolExchange(body, create, { id: 'task-41', revision: 7, status: 'pending' }, protocol)
    const claim = officialTeamProbeResponse(body)
    assert.equal(claim.tool.name, 'team_task_update')
    assert.deepEqual(claim.tool.input, {
      task_id: 'task-41',
      expected_revision: 7,
      action: 'claim',
    })
    appendToolExchange(body, claim, { id: 'task-41', revision: 8, status: 'in_progress' }, protocol)
    const complete = officialTeamProbeResponse(body)
    assert.deepEqual(complete.tool.input, {
      task_id: 'task-41',
      expected_revision: 8,
      action: 'complete',
    })
    appendToolExchange(
      body,
      complete,
      { id: 'task-41', revision: 9, status: 'completed' },
      protocol,
    )
    const delegate = officialTeamProbeResponse(body)
    assert.equal(delegate.tool.name, 'subagent')
    assert.deepEqual(delegate.tool.input, {
      name: 'qualification-worker',
      description: 'Verify the official Team child',
      prompt: TEAM_CHILD_PROMPT,
    })
    appendToolExchange(
      body,
      delegate,
      { kind: 'activation', name: 'qualification-worker' },
      protocol,
    )
    assert.deepEqual(officialTeamProbeResponse(body), { text: 'OPL_OFFICIAL_TEAM_LEAD_VERIFIED' })
    assert.deepEqual(
      officialTeamProbeResponse({
        messages: [{ role: 'user', content: TEAM_CHILD_PROMPT }],
        tools: [],
      }),
      { text: 'OPL_OFFICIAL_TEAM_CHILD_VERIFIED' },
    )
  })

test('legacy Team fixture retains spawn_teammate and does not invoke an unadvertised task tool', () => {
  const body = {
    messages: [{ role: 'user', content: 'OPL_OFFICIAL_TEAM_LEAD_PROBE' }],
    tools: [{ name: 'spawn_teammate' }],
  }
  const response = officialTeamProbeResponse(body)
  assert.equal(response.tool.name, 'spawn_teammate')
  assert.equal(response.tool.input.context, 'fresh')
  appendToolExchange(body, response, { id: 'child-session' }, 'messages')
  assert.deepEqual(officialTeamProbeResponse(body), { text: 'OPL_OFFICIAL_TEAM_LEAD_VERIFIED' })
  assert.throws(() => officialTeamProbeResponse({ ...body, tools: [] }), /not advertised/)
})

test('Team model fixture rejects failed or malformed task results', () => {
  for (const value of [{ error: 'permission denied' }, { id: 'task-1', revision: 0 }]) {
    const body = {
      messages: [],
      tools: [{ name: 'team_task_create' }, { name: 'team_task_update' }],
    }
    appendToolExchange(body, officialTeamProbeResponse(body), value, 'messages')
    assert.throws(() => officialTeamProbeResponse(body), /invalid task result/)
  }
  const body = { messages: [], tools: [{ name: 'team_task_create' }] }
  appendToolExchange(body, officialTeamProbeResponse(body), { error: 'refused' }, 'messages')
  body.messages.at(-1).content[0].is_error = true
  assert.throws(() => officialTeamProbeResponse(body), /tool failed/)
})

function capabilityProbe({
  changeProjection = () => {},
  ignoreEnable = false,
  autoReviewEnabled = false,
  autoReviewApplication = 'applied',
  tools,
} = {}) {
  let enabled = false
  let prompted = false
  const calls = []
  return {
    calls,
    async run() {
      return verifyOfficialCapabilities({
        project: '/isolated/fixture-project',
        officialVersion: '0.2.2-rc.2',
        readTools: () =>
          tools ?? [
            'subagent',
            'send_message',
            'list_agents',
            'team_task_create',
            'team_task_update',
            'team_task_get',
            'team_task_list',
          ],
        rpc: async (namespace, method, args) => {
          assert.equal(namespace, 'session')
          calls.push({ method, args })
          if (method === 'create') return { sessionId: 'lead-session' }
          if (method === 'selectModel') return {}
          if (method === 'prompt') {
            assert.equal(enabled, true, 'Probe prompted before official Team mode was saved')
            prompted = true
            return { accepted: true }
          }
          if (method === 'wait') return { outcome: { kind: 'completed' } }
          assert.fail('Unexpected control call: ' + method)
        },
        wire: async (method, args) => {
          calls.push({ method, args })
          if (method === 'pluginManager/listBundles')
            return promotedBundles().map((bundle) =>
              bundle.name === '@deepseek-ai/dsh-experimental-auto-review' && !autoReviewEnabled
                ? { ...bundle, enabled: false, rows: [] }
                : bundle,
            )
          if (method === 'pluginManager/setBundleEnabled') {
            assert.deepEqual(args, {
              name: '@deepseek-ai/dsh-experimental-auto-review',
              enabled: true,
            })
            autoReviewEnabled = autoReviewApplication === 'applied'
            return { application: autoReviewApplication }
          }
          if (method === 'agentPresets/list') return { presets: [] }
          if (method === 'agentTeams/setEnabled') {
            assert.equal(args.agentId, 'lead-session')
            if (!ignoreEnable) enabled = args.enabled
            return
          }
          if (method === 'session/projections') {
            assert.deepEqual(args, { request: { sessionId: 'lead-session' } })
            const projection = {
              values: {
                agentTeam: {
                  enabled,
                  tasks: prompted
                    ? [
                        {
                          id: 'task-1',
                          subject: TEAM_TASK_SUBJECT,
                          status: 'completed',
                          revision: 3,
                          ownerId: 'lead-session',
                        },
                      ]
                    : [],
                },
                subagentCatalog: prompted
                  ? [{ name: 'qualification-worker', id: 'child-session', mode: 'continuable' }]
                  : [],
              },
            }
            if (prompted) changeProjection(projection)
            return projection
          }
          if (method === 'session/events') {
            assert.deepEqual(args.request.address, {
              kind: 'subagent',
              parentSessionId: 'lead-session',
              childSessionId: 'child-session',
              mode: 'continuable',
            })
            return {
              records: [
                {
                  event: {
                    type: 'assistant/message',
                    data: { text: 'OPL_OFFICIAL_TEAM_CHILD_VERIFIED' },
                  },
                },
                { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
              ],
            }
          }
          if (method === 'permissionPresets/catalog')
            return { options: [{ value: 'auto' }], defaultOptions: [] }
          assert.fail('Unexpected wire call: ' + method)
        },
      })
    },
  }
}

test('promoted Team qualification saves mode before prompting and verifies durable task ownership and child completion', async () => {
  const probe = capabilityProbe()
  const result = await probe.run()
  assert.equal(result.agentTeams.nativeChild, true)
  assert.equal(result.agentTeams.taskBoard, true)
  assert.equal(result.agentTeams.taskId, 'task-1')
  assert.equal(result.agentTeams.childSessionId, 'child-session')
  assert.equal(result.autoReview.defaultEnabled, false)
  assert.equal(result.autoReview.mounted, true)
  assert.deepEqual(probe.calls.find((item) => item.method === 'agentTeams/setEnabled').args, {
    agentId: 'lead-session',
    enabled: true,
  })
})

test('official qualification rejects Auto Review enabled at startup or an unapplied activation', async () => {
  await assert.rejects(capabilityProbe({ autoReviewEnabled: true }).run(), /must be disabled/)
  await assert.rejects(
    capabilityProbe({ autoReviewApplication: 'restart-required' }).run(),
    /was not enabled/,
  )
})

test('promoted Team qualification rejects unsaved mode, missing children and incomplete or misowned boards', async () => {
  await assert.rejects(capabilityProbe({ ignoreEnable: true }).run(), /mode was not saved/)
  for (const changeProjection of [
    (view) => {
      view.values.subagentCatalog = []
    },
    (view) => {
      view.values.subagentCatalog[0].mode = 'one-shot'
    },
    (view) => {
      view.values.agentTeam.enabled = false
    },
    (view) => {
      view.values.agentTeam.failure = 'corrupt board'
    },
    (view) => {
      view.values.agentTeam.tasks = []
    },
    (view) => {
      view.values.agentTeam.tasks[0].status = 'in_progress'
    },
    (view) => {
      view.values.agentTeam.tasks[0].revision = 2
    },
    (view) => {
      view.values.agentTeam.tasks[0].ownerId = 'another-session'
    },
  ])
    await assert.rejects(capabilityProbe({ changeProjection }).run(), /Official Team/)
  await assert.rejects(capabilityProbe({ tools: ['subagent'] }).run(), /Official Team tool missing/)
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
