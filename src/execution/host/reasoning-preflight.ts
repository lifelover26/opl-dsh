/** Read external reasoning controls without creating a Harness task or sending a prompt. */
import { AcpProcess, object } from './acp.ts'
import { minimaxModelValue, minimaxReasoning } from './adapters/minimax.ts'
import type { AdapterLaunch, HarnessAdapter } from './adapters/types.ts'
import type { HarnessSession } from '../contracts/sessions.ts'
import type { HarnessReasoningPreflight } from '../../contracts/types.ts'

const OPTION_IDS = new Set([
  'thinking',
  'thinkingEffort',
  'thought_level',
  'thinking_effort',
  'reasoning',
  'reasoning_effort',
  'effort',
])

/** Extract only advertised option IDs; account data and arbitrary labels stay out of the response. */
export function readHarnessReasoning(
  record: HarnessSession,
  configOptions: unknown,
): HarnessReasoningPreflight['efforts'] | undefined {
  if (!Array.isArray(configOptions)) return undefined
  const option = configOptions.find((raw: unknown) => {
    const id = object(raw).id
    return typeof id === 'string' && OPTION_IDS.has(id)
  })
  if (option !== undefined) {
    if (!Array.isArray(object(option).options)) return undefined
    const efforts: HarnessReasoningPreflight['efforts'] = []
    for (const raw of object(option).options) {
      const id = object(raw).value
      if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/i.test(id)) return undefined
      if (!efforts.some((effort) => effort.id === id)) efforts.push({ id, name: id })
    }
    return efforts
  }
  const declared = minimaxReasoning(record.modelRef)
  if (record.harnessRef === 'minimax-code' && declared?.spec.control.kind === 'thinking') {
    const models = configOptions.find((raw: unknown) => object(raw).id === 'model')
    if (!Array.isArray(object(models).options)) return undefined
    const offered = object(models).options.map((raw: unknown) => object(raw).value)
    return declared.spec.control.options
      .filter((effort) => offered.includes(minimaxModelValue(declared.spec, effort.id)))
      .map((effort) => ({ id: effort.id, name: effort.id }))
  }
  return []
}

/** Initialize and configure an isolated CLI, read its options, then close it without a prompt. */
export async function probeHarnessReasoning(
  adapter: HarnessAdapter,
  record: HarnessSession,
  launch: AdapterLaunch,
): Promise<HarnessReasoningPreflight> {
  let options: unknown
  const acp = new AcpProcess(
    launch.command,
    launch.args,
    record.cwd,
    launch.env,
    (value) => {
      const envelope = object(value)
      if (envelope.sessionId !== record.acpSessionId) return
      const update = object(envelope.update)
      if (update.sessionUpdate === 'config_option_update') options = update.configOptions
    },
    (id) => acp.answer(id, undefined),
    () => {},
    launch.windowsVerbatimArguments,
    undefined,
    launch.clientRequests,
  )
  try {
    const agent = object(
      await acp.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'opl-dsh', version: '0.2.29' },
      }),
    )
    if (agent.protocolVersion !== 1) throw Error('Harness 未协商 ACP v1')
    await adapter.authenticate?.(acp, record, agent)
    const session = object(await acp.request('session/new', { cwd: record.cwd, mcpServers: [] }))
    if (typeof session.sessionId !== 'string' || !session.sessionId) throw Error('缺少 ACP 会话 ID')
    record.acpSessionId = session.sessionId
    options = session.configOptions
    const snapshot = { agent, session, configOptions: options }
    let model = object(session.models).currentModelId
    const configured = await adapter.configureSession?.(acp, record, snapshot)
    if (configured && 'configOptions' in configured) options = configured.configOptions
    if (configured?.modelId !== undefined) model = configured.modelId
    const expected =
      adapter.acpModelId?.(record.modelRef) ?? record.modelRef.model.split('::').at(-1)!
    if (model !== undefined && model !== expected) throw Error('Harness 配置后的模型回读不一致')
    adapter.verifySession?.(record, { ...snapshot, configOptions: options })
    const efforts = readHarnessReasoning(record, options)
    return efforts === undefined
      ? { status: 'unavailable', efforts: [] }
      : { status: 'known', efforts }
  } finally {
    await acp.dispose()
  }
}
