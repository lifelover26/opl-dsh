/**
 * Official StepCode (`step`) adapter for the OPL execution engine.
 *
 * StepCode has no ACP server, so this adapter contributes two things and nothing else:
 * a verified Git-for-Windows shell, a permission tier mapped onto the CLI's own
 * product presets, and a private bridge request that hands the bridge the exact model
 * identity it must pin. The ACP surface itself is produced by `./step-bridge.ts`, which
 * projects the official `step --mode rpc` protocol onto ACP without reimplementing the
 * official agent loop — prompting, tool execution, context and session persistence all
 * stay inside the `step` process.
 *
 * **What this adapter never does.** It does not guess an endpoint, does not silently
 * swap a model, does not widen a permission, and does not read a credential from a
 * global user profile. The model route is resolved through the registered model-source
 * owner (`options.modelSources.resolve`) and rejected if the owner's answer does not
 * name this lane's exact model and pinned protocol. The shell is verified by execution
 * and has no PowerShell/CMD/WSL fallback.
 *
 * **Scope of the credentials.** StepCode's official `models.json` schema resolves
 * `apiKey` through `$ENV_VAR` interpolation, so the resolved key is placed only in the
 * bridge's launch environment and referenced indirectly by a credential-blind config
 * file. It is never written to a file, an argument vector, or a log, and the real
 * `~/.stepcode` of the signed-in user is neither read nor modified: the agent
 * directory, the Step config root and the session directory all live under this
 * session's own suite-owned home.
 *
 * Integration for the packager is additive and consists of adding this adapter to the
 * adapter registry and to the harness list used for default-harness resolution, and of
 * letting the model source owner call `registerStepCodeSource`. No new settings page,
 * credential store, or navigation item is required: credentials belong to the model
 * source entry, the program to the execution-engine entry, and the binding to the
 * execution-combination entry.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { executablePath } from '../../harness-registry.ts'
import { acceptVisibleCliResult } from '../visible-result.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import type { ExternalModelSourceLease } from '../../model-sources.ts'
import { systemEnvironment } from '../environment.ts'
import { stepBashEnvironment } from './step-bash.ts'
import {
  stepApiForProtocol,
  stepLaneProtocol,
  stepLaneReasoning,
  stepThinkingValue,
  isStepCodeModel,
  stepLane,
  STEP_HARNESS,
  STEP_PROVIDER,
  STEP_MODEL_OPTION,
  STEP_THINKING_OPTION,
} from './step-models.ts'
import { stepPermissionPlan, STEP_PERMISSION_PRESET_ENV } from './step-permissions.ts'
import {
  STEP_AGENT_DIR_ENV,
  STEP_SESSION_DIR_ENV,
  STEP_STORAGE_ROOT_ENV,
  STEP_CREDENTIAL_ENV,
  stepStorage,
} from './step-config.ts'
import type { ModelRef } from '../../../contracts/catalog.ts'
import type { HarnessSession } from '../../../contracts/sessions.ts'
import type {
  AcpRequestSurface,
  AcpSessionConfigureResult,
  AcpSessionSnapshot,
  AdapterLaunch,
  AdapterOptions,
  HarnessAdapter,
} from '../types.ts'

/**
 * Resolve the exact model id and protocol this session must run, from the registered
 * source.
 *
 * The id is the lane's own id, and the resolved route must agree. Letting a source
 * redirect the id would move the session to a different model than the combination
 * names, which is precisely the silent substitution this adapter refuses — an unknown
 * source, a source that withdrew support while resolving, or a source that answers with
 * a different model or protocol all fail the launch.
 *
 * @throws HarnessConfigurationError when the reference, lane, or resolved route is not
 * this harness's.
 */
export async function resolveStepRoute(
  record: { modelRef: ModelRef },
  options: AdapterOptions,
  /**
   * Registration lease captured **before** any asynchronous preflight.
   *
   * `sources.resolve` re-checks registration only around its own read. A Bash probe that
   * runs afterwards gives a revoked or replaced source a window in which it could still
   * authorize a launch, so the lease is taken up front and asserted again once every
   * await has finished. The lease also invalidates on re-registration of the same
   * provider, which a plain "is it registered" check would miss.
   */
  lease?: ExternalModelSourceLease,
): Promise<{
  model: string
  provider: string
  protocol: string
  api: string
  baseURL: string
  apiKey: string
  contextWindow?: number
}> {
  const lane = stepLane(record.modelRef)
  if (!lane)
    throw new HarnessConfigurationError(
      '此模型不属于官方 StepCode 可固定的组合；已停止，未启动 CLI，不会改用其他模型。',
    )
  const protocol = stepLaneProtocol(record.modelRef)
  if (!protocol)
    throw new HarnessConfigurationError(
      `官方 StepCode 未为 ${lane.model} 固定执行协议；已停止，未启动 CLI，不会改用其他协议。`,
    )
  const sources = options.modelSources
  if (!sources)
    throw new HarnessConfigurationError(
      `模型来源 ${STEP_PROVIDER} 尚未注册到执行引擎，无法确认此组合的模型与渠道；已停止，未启动 CLI。`,
    )
  // Taken before the resolve await, so the whole preparation is covered.
  const captured = lease ?? sources.lease(STEP_HARNESS, record.modelRef)
  // Resolving also re-checks the registration after the await, so a source that was
  // replaced or unloaded during the read cannot authorize a launch.
  const route = await sources.resolve(STEP_HARNESS, record.modelRef, protocol)
  captured.assertCurrent()
  if (route.model !== lane.model)
    throw new HarnessConfigurationError(
      `模型来源解析出的模型（${route.model}）与所选组合（${lane.model}）不一致；已停止，未改用来源返回的模型。`,
    )
  return {
    model: lane.model,
    provider: lane.provider,
    protocol,
    api: stepApiForProtocol(protocol),
    baseURL: route.baseURL,
    apiKey: route.apiKey,
    ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
  }
}

/**
 * Read one `select` config option out of an advertised `configOptions` array.
 * A malformed or absent advertisement is treated as absent, so it fails the pinning
 * checks instead of passing them.
 */
export function stepConfigOption(
  configOptions: unknown,
  id: string,
): { currentValue: string; values: string[] } | undefined {
  if (!Array.isArray(configOptions)) return undefined
  for (const raw of configOptions) {
    const option = raw as Record<string, any> | null
    if (!option || typeof option !== 'object' || option.id !== id) continue
    const values = Array.isArray(option.options)
      ? option.options
          .map((entry: any) => (typeof entry?.value === 'string' ? entry.value : ''))
          .filter((value: string) => value.length > 0)
      : []
    return {
      currentValue: typeof option.currentValue === 'string' ? option.currentValue : '',
      values,
    }
  }
  return undefined
}

const failure = (message: string): HarnessConfigurationError =>
  new HarnessConfigurationError(`官方 StepCode：${message}已停止，未发送任务。`)

/**
 * Assert the advertisement offers the required model (and, when chosen, the tier).
 *
 * Checking before the write lets an unsupported request name the exact offered set
 * instead of failing as an opaque rejection.
 */
function assertAdvertised(configId: string, value: string, configOptions: unknown): void {
  const option = stepConfigOption(configOptions, configId)
  if (!option) throw failure(`未广告 ${configId} 配置项，无法确认所需取值 ${value}。`)
  if (!option.values.includes(value))
    throw failure(
      `广告的 ${configId} 不含所需取值 ${value}（实际：${option.values.join('、') || '无'}）。`,
    )
}

/**
 * Require the advertisement to report the pinned value for an option.
 *
 * A missing advertisement is a **failure**, never a pass. Before each turn the host
 * re-reads the live config options; if the agent stops sending them there is no evidence
 * that the session still runs the pinned model, and treating that as "nothing to check"
 * would silently downgrade a combination.
 *
 * @param expected - the required current value, or `undefined` when the combination did
 * not pin this option at all.
 */
function assertPinned(
  configId: string,
  expected: string | undefined,
  configOptions: unknown,
  required: boolean,
): void {
  const option = stepConfigOption(configOptions, configId)
  // Required when this value is the authoritative read-back, or when the combination
  // pinned it. Not required otherwise: a model that advertises no reasoning tiers still
  // has to be usable, and inventing a requirement for an absent option would refuse it.
  if (!option) {
    if (!required) return
    throw failure(`未广告 ${configId} 配置项，无法确认当前取值；已停止，未发送任务。`)
  }
  if (expected === undefined) return
  if (option.currentValue !== expected)
    throw failure(
      `会话 ${configId} 与要求的 ${expected} 不一致（实际 ${option.currentValue || '空'}），未发送任何任务。`,
    )
}

/**
 * Re-check every pinned value against one snapshot.
 *
 * Used both after each configuration write and before each turn. Checking each option
 * against a *different* snapshot is not enough: the final write can answer with a
 * different model than the one pinned earlier in the same call, and that is exactly the
 * drift this rejects.
 */
function assertAllPinned(
  pinned: { configId: string; value: string | undefined; required: boolean }[],
  configOptions: unknown,
): void {
  for (const { configId, value, required } of pinned)
    assertPinned(configId, value, configOptions, required)
}

/** The pinned values for a combination, with the model always required. */
const pinnedValues = (model: string, thinking: string | undefined) => [
  { configId: STEP_MODEL_OPTION, value: model, required: true },
  { configId: STEP_THINKING_OPTION, value: thinking, required: thinking !== undefined },
]

async function prepareStepLaunch(
  _ctx: Context,
  record: HarnessSession,
  options: AdapterOptions,
  bridgePath: string,
): Promise<AdapterLaunch> {
  // Permission first: an unsupported tier must leave no state behind and must not touch
  // the credential path at all.
  const permissions = stepPermissionPlan(record.sandbox)
  if (!isStepCodeModel(record.modelRef))
    throw new HarnessConfigurationError(
      '此模型不属于官方 StepCode 可固定的组合；已停止，未启动 CLI，不会改用其他模型。',
    )
  // Captured before any await below; the launch is refused unless it is still current.
  const lease = options.modelSources?.lease(STEP_HARNESS, record.modelRef)
  const route = await resolveStepRoute(record, options, lease)
  const path = await executablePath(options.command || 'step', STEP_HARNESS)
  if (!path) throw Error('未找到官方 StepCode CLI（step），无法启动此组合')
  const shell = await stepBashEnvironment(systemEnvironment())

  const home = join(options.home, 'harnesses', record.harnessRef, record.id)
  await mkdir(home, { recursive: true })
  const storage = stepStorage(home)
  await mkdir(storage.agentDir, { recursive: true })
  await mkdir(storage.configRoot, { recursive: true })
  await mkdir(storage.sessionDir, { recursive: true })
  const scratch = join(home, 'tmp')
  await mkdir(scratch, { recursive: true })
  await mkdir(storage.storageRoot, { recursive: true })
  // No `HOME` override. The official CLI resolves each path it owns through a dedicated
  // variable — the agent directory (whose parent is the config root holding
  // `config.toml`/`auth.json`/`models.json`), the session directory, and the product
  // storage root (`device-id`, telemetry) — so redirecting those three isolates this
  // session without claiming the signed-in user's home directory or their `AppData`.
  const thinking = stepThinkingValue(record.reasoningEffort) ?? ''
  // The last thing before returning: every await above has completed, so a source revoked
  // or replaced anywhere in preparation — including while the Bash probe was running —
  // fails the launch instead of producing one.
  lease?.assertCurrent()
  return {
    home,
    command: process.execPath,
    args: [bridgePath],
    env: {
      ...shell.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPL_STEP_COMMAND: path,
      OPL_STEP_PREFIX: JSON.stringify(options.prefix ?? []),
      OPL_STEP_AGENT_DIR: storage.agentDir,
      OPL_STEP_CONFIG_ROOT: storage.configRoot,
      OPL_STEP_SESSION_DIR: storage.sessionDir,
      OPL_STEP_SESSION_INDEX_DIR: storage.sessionIndexDir,
      OPL_STEP_PROVIDER: route.provider,
      OPL_STEP_MODEL: route.model,
      OPL_STEP_BASE_URL: route.baseURL,
      OPL_STEP_API: route.api,
      OPL_STEP_REASONING: stepLaneReasoning(record.modelRef) ? '1' : '0',
      ...(route.contextWindow === undefined
        ? {}
        : { OPL_STEP_CONTEXT_WINDOW: String(route.contextWindow) }),
      OPL_STEP_PROTOCOL: route.protocol,
      OPL_STEP_THINKING: thinking,
      OPL_STEP_PRESET: permissions.preset,
      OPL_STEP_ACKNOWLEDGE_FULL_ACCESS: permissions.acknowledgeFullAccessRisk ? '1' : '0',
      OPL_STEP_SHELL_PATH: shell.shell ?? '',
      // The credential reaches the CLI only through its own environment, referenced by
      // the official `$ENV_VAR` interpolation in a credential-blind `models.json`.
      [STEP_CREDENTIAL_ENV]: route.apiKey,
      [STEP_PERMISSION_PRESET_ENV]: permissions.preset,
      [STEP_AGENT_DIR_ENV]: storage.agentDir,
      [STEP_SESSION_DIR_ENV]: storage.sessionDir,
      [STEP_STORAGE_ROOT_ENV]: storage.storageRoot,
      // Scratch only. The official CLI reads neither, so this cannot redirect any
      // product state.
      TEMP: scratch,
      TMP: scratch,
    },
  }
}

/**
 * Build the official StepCode adapter.
 *
 * @param bridgePath - absolute path to the compiled RPC→ACP bridge. The packager supplies
 * this the same way it supplies the ZCode bridge, because `AdapterOptions` is a shared
 * contract this adapter must not modify.
 * @returns the adapter for the registry.
 */
export function createStepCodeAdapter(bridgePath: string): HarnessAdapter {
  return {
    id: STEP_HARNESS,
    transport: 'acp',
    capabilities: {
      transport: 'official-sdk',
      authentication: 'api-source',
      protocols: ['chat', 'responses', 'messages'],
      customEndpoint: true,
      // `read-only` and `workspace` are absent on purpose: the official preset taxonomy
      // has no verifiable filesystem boundary (see ./step-permissions.ts), so those
      // tiers are refused at launch rather than advertised and mapped.
      permissions: ['full-access'],
      sessionLoad: true,
      cancel: true,
      reasoning: 'cli-advertised',
      autoReview: 'unsupported',
    },
    matches: isStepCodeModel,
    acceptResult: acceptVisibleCliResult,
    async available(_ctx, options) {
      const path = await executablePath(options.command || 'step', STEP_HARNESS)
      if (!path)
        return {
          available: false,
          reason:
            '未找到官方 StepCode CLI（step）。请使用阶跃官方安装方式安装，安装后重新检测；此组合不依赖 OPL Gateway 的凭据。',
        }
      // The Windows shell is a launch precondition, so report it here rather than
      // letting the first real task fail. This probes the suite's own provider and never
      // touches an account.
      try {
        await stepBashEnvironment(systemEnvironment())
      } catch (error) {
        return { available: false, reason: (error as Error).message }
      }
      return { available: true }
    },
    prepare: (ctx, record, options) => prepareStepLaunch(ctx, record, options, bridgePath),
    async configureSession(
      acp: AcpRequestSurface,
      record: HarnessSession,
      snapshot: AcpSessionSnapshot,
    ): Promise<AcpSessionConfigureResult> {
      const lane = stepLane(record.modelRef)
      if (!lane) throw failure('此模型不属于官方 StepCode 可固定的组合，未启动 CLI。')
      const sessionId =
        (typeof snapshot.session?.sessionId === 'string' ? snapshot.session.sessionId : '') ||
        record.acpSessionId
      if (!sessionId) throw failure('未返回会话 ID，无法固定模型与思考档位。')
      const model = lane.model
      const thinking = stepThinkingValue(record.reasoningEffort)
      // Everything this session pins, re-checked together against one snapshot.
      const pinned = pinnedValues(model, thinking)

      // Model first and always: it is the authoritative read-back, and a tier only
      // becomes meaningful once the model that owns it is selected.
      assertAdvertised(STEP_MODEL_OPTION, model, snapshot.configOptions)
      assertAllPinned(pinned, snapshot.configOptions)
      let configOptions = await applyConfigOption(acp, sessionId, STEP_MODEL_OPTION, model)
      assertAllPinned(pinned, configOptions)
      if (thinking !== undefined) {
        const option = stepConfigOption(configOptions, STEP_THINKING_OPTION)
        if (!option)
          throw failure(
            `已选择 ${model}，但未广告 ${STEP_THINKING_OPTION} 配置项，无法设置 ${thinking} 思考档位。`,
          )
        if (!option.values.includes(thinking))
          throw failure(
            `广告的 ${STEP_THINKING_OPTION} 不含所选取值 ${thinking}（实际：${option.values.join('、') || '无'}）。`,
          )
        if (option.currentValue !== thinking)
          configOptions = await applyConfigOption(acp, sessionId, STEP_THINKING_OPTION, thinking)
      }
      // Final read-back of both values from the last response, so a final answer carrying
      // another model cannot slip through behind a correct thinking value.
      assertAllPinned(pinned, configOptions)
      return { configOptions }
    },
    verifySession(record, snapshot) {
      const lane = stepLane(record.modelRef)
      if (!lane) throw failure('此模型不属于官方 StepCode 可固定的组合，未发送任务。')
      assertAllPinned(
        pinnedValues(lane.model, stepThinkingValue(record.reasoningEffort)),
        snapshot.configOptions,
      )
    },
  }
}

/**
 * Write one pinned config option over ACP and return the fresh advertisement.
 *
 * The bridge rejects a value that is not this combination's, so a silent downgrade is
 * impossible; the agent's own rejection text is not echoed because it is
 * provider-controlled.
 */
async function applyConfigOption(
  acp: AcpRequestSurface,
  sessionId: string,
  configId: string,
  value: string,
): Promise<unknown> {
  let result: Record<string, any>
  try {
    result = (await acp.request('session/set_config_option', {
      sessionId,
      configId,
      value,
    })) as Record<string, any>
  } catch {
    throw failure(`拒绝设置 ${configId}=${value}（官方 StepCode 未接受该配置）。`)
  }
  return result?.configOptions
}

/**
 * Adapter used when the packager supplies the bridge path at module scope.
 *
 * `fileURLToPath` rather than `URL.pathname`: the latter yields `/C:/…` on Windows,
 * which is not a path the spawn can resolve.
 */
export const stepCodeAdapter: HarnessAdapter = createStepCodeAdapter(
  fileURLToPath(new URL('./step-bridge.mjs', import.meta.url)),
)
