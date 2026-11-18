/** Read capability owners from the running official Host; exercise its real Team child. */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export const TEAM_CHILD_PROMPT = 'OPL_OFFICIAL_TEAM_CHILD_PROBE'
export const TEAM_TASK_SUBJECT = 'OPL_OFFICIAL_TEAM_TASK_PROBE'
const teamBundle = '@deepseek-ai/dsh-experimental-agent-team-profile'
const baseBundle = '@deepseek-ai/dsh-base'
const webBundle = '@deepseek-ai/dsh-web-app'
const autoReviewBundle = '@deepseek-ai/dsh-experimental-auto-review'
const oneShotProviders = [
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code',
]

export function officialCapabilityInventory(bundles, roster, officialVersion) {
  assert.match(officialVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  const selected = (name, optional = true) => {
    const bundle = bundles.find((item) => item.name === name)
    assert(bundle, 'Official bundle missing: ' + name)
    if (optional)
      assert(bundle.official && bundle.optional, 'Official optional bundle missing: ' + name)
    assert.equal(
      bundle.availability,
      'installation',
      'Bundle no longer comes from Desktop: ' + name,
    )
    assert.equal(bundle.version, officialVersion, 'Official bundle cohort changed: ' + name)
    assert.equal(bundle.enabled, true, 'Migrated official bundle is disabled: ' + name)
    assert.equal(bundle.error, undefined, 'Official bundle cannot load: ' + name)
    return bundle
  }
  const autoReview = selected(autoReviewBundle)
  assert(
    autoReview.rows.some((row) => row.entryId),
    'Official Auto Review row is not mounted',
  )
  const builtIn = bundles
    .find((bundle) => bundle.name === baseBundle)
    ?.rows.some((row) => row.moduleName === '@deepseek-ai/dsh-agent-team')
  const teamModules = builtIn
    ? [
        '@deepseek-ai/dsh-agent-team',
        '@deepseek-ai/dsh-tool-agent-team',
        '@deepseek-ai/dsh-client-ui-agent-team',
      ]
    : [
        '@deepseek-ai/dsh-experimental-agent-team',
        '@deepseek-ai/dsh-experimental-tool-agent-team',
        '@deepseek-ai/dsh-experimental-client-ui-agent-team',
      ]
  const team = selected(builtIn ? baseBundle : teamBundle, !builtIn)
  const web = builtIn ? selected(webBundle, false) : team
  for (const [index, name] of teamModules.entries()) {
    const owner = index === 2 ? web : team
    assert(
      owner.rows.some((row) => row.moduleName === name && row.entryId),
      'Team row not mounted: ' + name,
    )
  }
  const providers = oneShotProviders.map((name) => {
    const bundle = bundles.find((item) => item.name === name)
    assert.equal(bundle?.official, true, 'Official one-shot provider missing: ' + name)
    assert.equal(bundle.error, undefined, 'Official one-shot provider is unavailable: ' + name)
    assert.equal(
      bundle.installTarget?.version,
      officialVersion,
      'One-shot provider cohort changed: ' + name,
    )
    assert.equal(bundle.installTarget.spec, name + '@' + officialVersion)
    return {
      package: name,
      version: bundle.installTarget.version,
      owner: 'official',
      installed: bundle.installed,
    }
  })
  assert(Array.isArray(roster.presets), 'Official preset registry is unavailable')
  return {
    officialVersion,
    agentTeams: {
      package: team.name,
      ...(builtIn ? { webPackage: web.name } : {}),
      composition: builtIn ? 'base' : 'optional',
      owner: 'official',
      modules: teamModules,
    },
    autoReview: {
      package: autoReviewBundle,
      owner: 'official',
      mounted: autoReview.rows.some((row) => row.entryId),
    },
    oneShotProviders: providers,
    agentPresets: { owner: 'official', ids: roster.presets.map((preset) => preset.id) },
    // Daily qualifications retain newly offered official bundles for the same
    // source/payload. Replacement decisions remain with the capability owner.
    bundles: bundles
      .filter((bundle) => bundle.official)
      .map(({ name, version, enabled, availability, installTarget }) => ({
        name,
        version: version ?? installTarget?.version,
        enabled,
        availability,
      })),
  }
}

/** Script only advertised Team tools, using their actual results for task revisions. */
export function officialTeamProbeResponse(body) {
  const text = body.messages.some(
    (message) =>
      message.role === 'user' && JSON.stringify(message.content).includes(TEAM_CHILD_PROMPT),
  )
    ? 'OPL_OFFICIAL_TEAM_CHILD_VERIFIED'
    : 'OPL_OFFICIAL_TEAM_LEAD_VERIFIED'
  if (text === 'OPL_OFFICIAL_TEAM_CHILD_VERIFIED') return { text }
  const advertised = new Set(body.tools?.map((tool) => tool.name ?? tool.function?.name))
  const calls = []
  const results = new Map()
  for (const message of body.messages) {
    if (message.role === 'assistant') {
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (block.type === 'tool_use')
          calls.push({ id: block.id, name: block.name, input: block.input })
      for (const call of message.tool_calls ?? [])
        calls.push({
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments),
        })
    }
    if (message.role === 'tool') results.set(message.tool_call_id, message.content)
    for (const block of Array.isArray(message.content) ? message.content : [])
      if (block.type === 'tool_result') {
        assert(!block.is_error, 'Official Team fixture tool failed')
        results.set(block.tool_use_id, block.content)
      }
  }
  const call = (name, input, id) => {
    assert(advertised.has(name), 'Official Team fixture tool is not advertised: ' + name)
    return { text, tool: { name, input, id } }
  }
  const childInput = {
    name: 'qualification-worker',
    description: 'Verify the official Team child',
    prompt: TEAM_CHILD_PROMPT,
  }
  if (advertised.has('spawn_teammate'))
    return calls.some((item) => item.name === 'spawn_teammate')
      ? { text }
      : call('spawn_teammate', { ...childInput, context: 'fresh' }, 'team_child_fixture')

  const taskResult = (item) => {
    const content = results.get(item.id)
    assert(content !== undefined, 'Official Team fixture has no task result')
    const value = JSON.parse(
      typeof content === 'string'
        ? content
        : content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n'),
    )
    assert(
      typeof value.id === 'string' && Number.isSafeInteger(value.revision) && value.revision > 0,
      'Official Team fixture has an invalid task result',
    )
    return value
  }
  const created = calls.find((item) => item.name === 'team_task_create')
  if (!created)
    return call(
      'team_task_create',
      {
        subject: TEAM_TASK_SUBJECT,
        description: 'Verify durable official task ownership and completion.',
      },
      'team_create_fixture',
    )
  const claimed = calls.find(
    (item) => item.name === 'team_task_update' && item.input.action === 'claim',
  )
  if (!claimed) {
    const task = taskResult(created)
    return call(
      'team_task_update',
      { task_id: task.id, expected_revision: task.revision, action: 'claim' },
      'team_claim_fixture',
    )
  }
  const completed = calls.find(
    (item) => item.name === 'team_task_update' && item.input.action === 'complete',
  )
  if (!completed) {
    const task = taskResult(claimed)
    return call(
      'team_task_update',
      { task_id: task.id, expected_revision: task.revision, action: 'complete' },
      'team_complete_fixture',
    )
  }
  assert.equal(
    taskResult(completed).status,
    'completed',
    'Official Team fixture task did not complete',
  )
  return calls.some((item) => item.name === 'subagent')
    ? { text }
    : call('subagent', childInput, 'team_child_fixture')
}

export async function verifyOfficialTeamChild({ wire, parentSessionId, childSessionId }) {
  const address = { kind: 'subagent', parentSessionId, childSessionId, mode: 'continuable' }
  const deadline = Date.now() + 30000
  let childEnd
  let childEvents
  // This bounded qualification read follows the native child's committed log.
  // It never addresses a subagent through ordinary Session wait/state methods.
  while (Date.now() < deadline) {
    childEvents = await wire('session/events', { request: { address, maxMessages: 100 } })
    childEnd = childEvents.records
      .map((record) => record.event)
      .findLast((event) => event.type === 'turn/end')
    if (childEnd) break
    await delay(100)
  }
  assert(childEnd, 'Official Team child has no durable turn/end event')
  assert.equal(childEnd.data.reason.kind, 'completed', 'Official Team child did not complete')
  assert.match(JSON.stringify(childEvents.records), /OPL_OFFICIAL_TEAM_CHILD_VERIFIED/)
}

export async function verifyOfficialCapabilities({
  wire,
  rpc,
  project,
  officialVersion,
  readTools,
}) {
  const initialBundles = await wire('pluginManager/listBundles')
  assert.equal(
    initialBundles.find((bundle) => bundle.name === autoReviewBundle)?.enabled,
    false,
    'Fresh official Auto Review must be disabled',
  )
  const autoReviewChange = await wire('pluginManager/setBundleEnabled', {
    name: autoReviewBundle,
    enabled: true,
  })
  assert.equal(autoReviewChange.application, 'applied', 'Official Auto Review was not enabled')
  const inventory = officialCapabilityInventory(
    await wire('pluginManager/listBundles'),
    await wire('agentPresets/list'),
    officialVersion,
  )
  const lead = await rpc('session', 'create', { request: { cwd: project } })
  await rpc('session', 'selectModel', {
    request: { sessionId: lead.sessionId, provider: 'opl-gateway', model: 'deepseek-flash' },
  })
  const builtIn = inventory.agentTeams.composition === 'base'
  if (builtIn) {
    const before = await wire('session/projections', { request: { sessionId: lead.sessionId } })
    assert.equal(
      before?.values.agentTeam?.enabled,
      false,
      'Fresh official Team mode must be disabled',
    )
    await wire('agentTeams/setEnabled', { agentId: lead.sessionId, enabled: true })
    const enabled = await wire('session/projections', { request: { sessionId: lead.sessionId } })
    assert.equal(enabled?.values.agentTeam?.enabled, true, 'Official Team mode was not saved')
    assert.equal(enabled.values.agentTeam.failure, undefined, 'Official Team projection failed')
  }
  const receipt = await rpc('session', 'prompt', {
    request: {
      sessionId: lead.sessionId,
      requestId: crypto.randomUUID(),
      mode: 'queue',
      content: [
        { type: 'text', text: 'OPL_OFFICIAL_TEAM_LEAD_PROBE: delegate one isolated fixture task.' },
      ],
    },
  })
  assert.equal(receipt.accepted, true)
  const done = await rpc('session', 'wait', { sessionId: lead.sessionId })
  assert.equal(done.outcome.kind, 'completed', 'Official Team Lead did not complete')
  const projection = await wire('session/projections', { request: { sessionId: lead.sessionId } })
  const teammate = builtIn
    ? projection.values.subagentCatalog?.find((member) => member.name === 'qualification-worker')
    : projection.values.agentTeam?.members.find((member) => member.name === 'qualification-worker')
  assert(
    teammate &&
      (builtIn
        ? teammate.mode === 'continuable'
        : teammate.role === 'teammate' && teammate.phase === 'active'),
    'Official Team child was not published',
  )
  if (builtIn) {
    const board = projection.values.agentTeam
    assert.equal(board?.enabled, true, 'Official Team mode changed during the probe')
    assert.equal(board.failure, undefined, 'Official Team projection failed')
    const task = board.tasks.find((item) => item.subject === TEAM_TASK_SUBJECT)
    assert(
      task && task.status === 'completed' && task.revision === 3 && task.ownerId === lead.sessionId,
      'Official Team task was not created, claimed and completed by its native owner',
    )
    inventory.agentTeams.taskBoard = true
    inventory.agentTeams.taskId = task.id
  }
  await verifyOfficialTeamChild({
    wire,
    parentSessionId: lead.sessionId,
    childSessionId: teammate.id,
  })
  const permissions = await wire('permissionPresets/catalog')
  assert(
    permissions.options.some((option) => option.value === 'auto'),
    'Official Auto Review preset is unavailable',
  )
  assert(
    !permissions.defaultOptions.some((option) => option.value === 'auto'),
    'Official Auto Review must remain a current-session choice',
  )
  inventory.autoReview = {
    ...inventory.autoReview,
    defaultEnabled: false,
    selectablePreset: 'auto',
    defaultSelectable: false,
  }
  const tools = new Set(readTools())
  for (const name of [
    builtIn ? 'subagent' : 'spawn_teammate',
    'send_message',
    'list_agents',
    'team_task_create',
    'team_task_update',
    ...(builtIn ? ['team_task_get', 'team_task_list'] : []),
  ])
    assert(tools.has(name), 'Official Team tool missing: ' + name)
  // Official Web presets may retain scoped continuable Subagent controls.
  // Their presence in a child's tool set does not change the Team bundle owner.
  inventory.agentTeams = {
    ...inventory.agentTeams,
    modelFacingTools: true,
    nativeChild: true,
    leadSessionId: lead.sessionId,
    childSessionId: teammate.id,
  }
  return inventory
}
