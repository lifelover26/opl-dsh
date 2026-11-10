/** Read capability owners from the running official Host; exercise its real Team child. */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export const TEAM_CHILD_PROMPT = 'OPL_OFFICIAL_TEAM_CHILD_PROBE'
const teamBundle = '@deepseek-ai/dsh-experimental-agent-team-profile'
const autoReviewBundle = '@deepseek-ai/dsh-experimental-auto-review'
const oneShotProviders = [
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code',
]

export function officialCapabilityInventory(bundles, roster, officialVersion) {
  assert.match(officialVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  const selected = (name) => {
    const bundle = bundles.find((item) => item.name === name)
    assert(bundle?.official && bundle.optional, 'Official optional bundle missing: ' + name)
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
  const team = selected(teamBundle)
  const autoReview = selected(autoReviewBundle)
  assert(
    autoReview.rows.some((row) => row.entryId),
    'Official Auto Review row is not mounted',
  )
  const teamModules = [
    '@deepseek-ai/dsh-experimental-agent-team',
    '@deepseek-ai/dsh-experimental-tool-agent-team',
    '@deepseek-ai/dsh-experimental-client-ui-agent-team',
  ]
  for (const name of teamModules)
    assert(
      team.rows.some((row) => row.moduleName === name && row.entryId),
      'Team row not mounted: ' + name,
    )
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
    agentTeams: { package: teamBundle, owner: 'official', modules: teamModules },
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
  const inventory = officialCapabilityInventory(
    await wire('pluginManager/listBundles'),
    await wire('agentPresets/list'),
    officialVersion,
  )
  const lead = await rpc('session', 'create', { request: { cwd: project } })
  await rpc('session', 'selectModel', {
    request: { sessionId: lead.sessionId, provider: 'opl-gateway', model: 'deepseek-flash' },
  })
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
  const teammate = projection.values.agentTeam?.members.find(
    (member) => member.name === 'qualification-worker',
  )
  assert(
    teammate && teammate.role === 'teammate' && teammate.phase === 'active',
    'Official Team child was not published',
  )
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
    selectablePreset: 'auto',
    defaultSelectable: false,
  }
  const tools = new Set(readTools())
  for (const name of [
    'spawn_teammate',
    'send_message',
    'list_agents',
    'team_task_create',
    'team_task_update',
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
