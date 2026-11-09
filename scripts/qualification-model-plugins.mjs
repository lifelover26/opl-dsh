/** Original model plugin, isolated upstream fixtures, and the real OPL/DSH callers. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const MODEL_PLUGIN_FIXTURE = 'opl-qualification-free'
const fixtureTool = 'list_harness_combinations'
const diagnosticTool = 'inspect_mcp_app_host'
const renamedDiagnosticTool =
  'clint_' + createHash('sha256').update(diagnosticTool).digest('hex').slice(0, 12)
const renamedFixtureTool =
  'clint_' + createHash('sha256').update(fixtureTool).digest('hex').slice(0, 12)

export async function startModelPluginFixture() {
  const requests = []
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data:
            req.url === '/inference/v1/models' || req.url === '/zen/v1/models'
              ? [{ id: MODEL_PLUGIN_FIXTURE }]
              : [],
        }),
      )
      return
    }
    try {
      let bytes = ''
      for await (const part of req) bytes += part
      const body = JSON.parse(bytes)
      const usedTool = body.messages?.some((message) => message.role === 'tool')
      const diagnosticName = body.tools
        ?.map((tool) => tool.function?.name)
        .find((name) => name === diagnosticTool || name === renamedDiagnosticTool)
      let hostDiagnostic
      for (const message of body.messages ?? []) {
        if (message.role !== 'tool' || typeof message.content !== 'string') continue
        try {
          const value = JSON.parse(message.content)
          if (value.oplPresentation === 'tools-only')
            hostDiagnostic = {
              oplPresentation: value.oplPresentation,
              officialBridge: value.officialBridge,
              nextAction: value.nextAction,
            }
        } catch {
          /* Another tool result is not this diagnostic. */
        }
      }
      const diagnosticRequested = body.messages?.some(
        (message) =>
          message.role === 'assistant' &&
          message.tool_calls?.some((call) => call.function?.name === diagnosticName),
      )
      const ownerToolName = body.tools
        ?.map((tool) => tool.function?.name)
        .find((name) => name === fixtureTool || name === renamedFixtureTool)
      const toolName =
        usedTool && diagnosticName && !diagnosticRequested ? diagnosticName : ownerToolName
      const hasTool = toolName !== undefined
      requests.push({
        model: body.model,
        usedTool: !!usedTool,
        hasTool,
        toolName,
        path: req.url,
        ...(hostDiagnostic ? { hostDiagnostic } : {}),
      })
      const tool = hasTool && (!usedTool || (diagnosticName && !diagnosticRequested))
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: toolName === diagnosticName ? 'ofm-diagnostic-call' : 'ofm-fixture-call',
                type: 'function',
                function: { name: toolName, arguments: '{}' },
              },
            ],
          }
        : { content: 'MODEL_PLUGIN_VERIFIED' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        'data: ' +
          JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) +
          '\n\n' +
          'data: ' +
          JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
          }) +
          '\n\ndata: [DONE]\n\n',
      )
    } catch {
      res.writeHead(400)
      res.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  // The channel pack's own gateway needs a separate port from a user's live DSH.
  const reservation = createServer()
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const gatewayPort = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  return {
    environment: {
      OUR_FREE_MODEL_BASE: base,
      OUR_FREE_MODEL_KILO_BASE: base + '/kilo',
      DSH_OPENAI_GATEWAY_PORT: String(gatewayPort),
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
    requests,
  }
}

export async function verifyModelPlugins({ root, origin, cookie, wire, harness }) {
  const profile = JSON.parse(await readFile(join(root, 'profiles/desktop/package.json'), 'utf8'))
  const pkg = JSON.parse(
    await readFile(
      join(root, 'profiles/desktop/node_modules/dsh-our-free-model/package.json'),
      'utf8',
    ),
  )
  assert.equal(pkg.name, 'dsh-our-free-model')
  assert(
    profile.dsh.profile.bundles.includes(pkg.name),
    'Original model plugin bundle is not enabled',
  )
  const api = async (path, body) => {
    const response = await fetch(origin + '/api/our-free-model' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    }).catch((error) => {
      throw new Error('隔离模型插件请求未完成：' + path, { cause: error })
    })
    assert.equal(response.status, 200, 'Original model plugin API failed: ' + path)
    return response.json()
  }
  let summary
  for (let attempt = 0; attempt < 90; attempt++) {
    summary = await api('/summary')
    if (
      summary.catalog.some((model) => model.id === MODEL_PLUGIN_FIXTURE) &&
      summary.channels?.state === 'ready'
    )
      break
    await delay(500)
  }
  assert(summary.catalog.some((model) => model.id === MODEL_PLUGIN_FIXTURE))
  assert.equal(summary.channels?.state, 'ready', 'Original account channel pack did not mount')
  // The route is created via the original plugin API, never in an OPL routing table.
  const combo = 'combo:qualification-route'
  await api('/combos', {
    combos: [
      {
        id: combo,
        name: 'Qualification route',
        models: [MODEL_PLUGIN_FIXTURE],
        strategy: 'fallback',
        enabled: true,
      },
    ],
  })
  const catalog = await harness('catalog')
  assert(
    !catalog.models.some((model) => model.ref.provider === 'huawei-maas'),
    'Deleted native Huawei provider returned in the execution catalog',
  )
  for (const model of [MODEL_PLUGIN_FIXTURE, combo])
    assert(
      !catalog.combinations.some(
        (item) => item.modelRef.provider === 'our-free-model' && item.modelRef.model === model,
      ),
      'A generic model was presented as an automatic official pairing: ' + model,
    )
  const manual = structuredClone(catalog)
  for (const model of [MODEL_PLUGIN_FIXTURE, combo])
    manual.combinations.push({
      id: 'qualification-manual-' + model.replaceAll(/[^a-z0-9]+/gi, '-'),
      name: 'Qualification manual · ' + model,
      modelRef: { provider: 'our-free-model', model },
      harnessRef: 'dsh',
      permissionPolicy: 'workspace',
      isDefault: true,
      enabled: true,
      autoEnabled: false,
      autoEnabledDisabled: true,
    })
  await harness('save-catalog', { catalog: manual })
  const reloaded = await harness('catalog')
  for (const model of [MODEL_PLUGIN_FIXTURE, combo]) {
    const combination = reloaded.combinations.find(
      (item) => item.modelRef.provider === 'our-free-model' && item.modelRef.model === model,
    )
    assert(combination, 'Manually created plugin combination missing: ' + model)
    assert.equal(combination.generated, undefined, 'Manual combination kept generated identity')
    assert.equal(combination.harnessRef, 'dsh')
    const run = await harness('start', {
      combination: combination.id,
      cwd: join(root, 'test-project'),
      origin: { kind: 'desktop', sessionId: 'isolated-model-plugin' },
    })
    await harness('prompt', {
      sessionId: run.id,
      operationId: 'model-plugin-' + model,
      text: 'List the available combinations once, then reply MODEL_PLUGIN_VERIFIED.',
    })
    const done = await harness('wait', { sessionId: run.id }).catch(async (error) => {
      const snapshot = await harness('snapshot', { sessionId: run.id }).catch(() => null)
      const diagnostic = snapshot && {
        state: snapshot.state,
        turns: snapshot.turns.map((turn) => ({
          state: turn.state,
          error: turn.error,
          tools: turn.tools.map(({ title, status }) => ({ title, status })),
        })),
      }
      throw new Error('OFM 任务等待失败：' + JSON.stringify(diagnostic), { cause: error })
    })
    assert.equal(done.state, 'completed', JSON.stringify(done.turns.map((turn) => turn.error)))
    assert.match(done.turns.at(-1).text, /MODEL_PLUGIN_VERIFIED/)
  }
  const providers = await wire('llm/listProviders')
  const channelProviders = [
    'lobsterai',
    'qoder',
    'qodercn',
    'trae',
    'cline',
    'loomy',
    'raccoon',
    'minimax',
    'zcode',
    'gemini',
  ]
  for (const provider of channelProviders)
    assert(
      providers.some((item) => item.id === provider),
      'Original channel provider missing: ' + provider,
    )
  const removedChannelProviders = ['codearts', 'buddy', 'workbuddy']
  for (const provider of removedChannelProviders)
    assert(
      !providers.some((item) => item.id === provider),
      'Removed OFM channel provider returned: ' + provider,
    )
  return {
    package: pkg.name,
    version: pkg.version,
    originalBundle: true,
    accountChannelProviders: channelProviders,
    removedAccountChannelProviders: removedChannelProviders,
    nativeModel: true,
    virtualModel: true,
    manualPairings: true,
    officialToolFlow: true,
  }
}
