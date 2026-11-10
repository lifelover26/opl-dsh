/**
 * Behavior evidence for the official OpenCode (`opencode`) adaptation.
 *
 * The session tests drive the adapter's real launch vector against an executable ACP
 * fixture over a live stdio transport, and that fixture builds its model advertisement
 * from the launch configuration the adapter actually produced (`OPENCODE_CONFIG_CONTENT`),
 * the same way the official CLI merges that variable. Assertions therefore cover wire
 * method names, request order, advertised values, the child environment, and the exact
 * working directory — not the adapter's own constants.
 *
 * Every wait is condition-driven: a journal entry, an ACP notification, or a request
 * reply. No test sleeps for a fixed duration and then assumes an event happened.
 */
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpProcess } from '../../../src/execution/host/acp.ts'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import { readHarnessReasoning } from '../../../src/execution/host/reasoning-preflight.ts'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
import type {
  OpenCodeShellBinding,
  OpenCodeShellOptions,
} from '../../../src/execution/host/adapters/opencode/opencode-shell.ts'
import type {
  ExternalModelRoute,
  ExternalModelSource,
} from '../../../src/execution/host/model-sources.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import type {
  AcpRequestSurface,
  AcpSessionSnapshot,
  AdapterOptions,
} from '../../../src/execution/host/adapters/types.ts'
import {
  buildOpenCodeRouteConfig,
  createOpenCodeSource,
  isExcludedOpenCodeModel,
  isOpenCodeModel,
  OPENCODE_EXCLUDED_MODELS,
  openCodeAdapter,
  openCodeLaunch,
  openCodeModels,
  openCodeModelValue,
  openCodeProfileRoots,
  openCodeShellBinding,
  openCodeShellSelectionAccepts,
  openCodeWireModel,
  OPENCODE_GIT_BASH_VARIABLE,
  OPENCODE_HARNESS,
  OPENCODE_OFM_MODELS,
  OPENCODE_OFM_PROVIDER,
  OPENCODE_ROUTE_PROVIDER_ID,
  OPENCODE_SHELL_CONFIG_KEY,
  OPENCODE_SHELL_FACTS,
  OPENCODE_SHELL_VARIABLE,
  verifyOpenCodeGitBash,
  withOpenCodeAdapter,
  withOpenCodeShell,
} from '../../../src/execution/host/adapters/opencode/index.ts'

/**
 * The adapter's Git Bash preflight is the single await the shared registry cannot cover: the
 * lease is checked immediately after it. On Windows it spawns a real process and is
 * therefore a real suspension point, but the POSIX binding resolves without suspending at
 * all, so nothing can interleave there. The tests below need that await to exist
 * deterministically on every host, so the shell module delegates to a test-supplied binding
 * while one is installed. Every other test keeps the real implementation.
 */
const shellBinding = vi.hoisted(() => ({
  current: null as null | ((env: NodeJS.ProcessEnv) => Promise<OpenCodeShellBinding>),
}))

vi.mock(
  '../../../src/execution/host/adapters/opencode/opencode-shell.ts',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../src/execution/host/adapters/opencode/opencode-shell.ts')
      >()
    return {
      ...actual,
      openCodeShellBinding: async (
        env: NodeJS.ProcessEnv,
        options?: OpenCodeShellOptions,
      ): Promise<OpenCodeShellBinding> => {
        const supplied = shellBinding.current
        return supplied ? supplied(env) : actual.openCodeShellBinding(env, options)
      },
    }
  },
)

/**
 * A shell binding the adapter can merge without a real Git Bash on this host. The path is
 * `/`-rooted, so it is absolute under both the posix and the win32 rules and this says
 * nothing about where the suite resolved a shell on any particular machine.
 */
const TEST_SHELL = '/opt/opl-test/Git/bin/bash.exe'

const testBinding = (env: NodeJS.ProcessEnv): OpenCodeShellBinding => ({
  config: { [OPENCODE_SHELL_CONFIG_KEY]: TEST_SHELL },
  env: {
    ...env,
    [OPENCODE_SHELL_VARIABLE]: TEST_SHELL,
    [OPENCODE_GIT_BASH_VARIABLE]: TEST_SHELL,
  },
  uname: 'MINGW64_NT-10.0',
})

/** Suspend preparation the way a spawned shell process would. */
const tick = () => new Promise<void>((done) => setImmediate(done))

const FIXTURE = resolve('tests/execution/ofm-opencode/fixtures/opencode-acp-agent.mjs')
/** The one model used for launch-level assertions; a slash-bearing id on purpose. */
const MODEL = 'inclusionai/ling-3.1-flash'
const MODEL_VALUE = openCodeModelValue(MODEL)
/** Never a real secret; the tests only prove where a credential can and cannot appear. */
const FAKE_KEY = 'opl-test-key-do-not-use'
const ROUTE: ExternalModelRoute = {
  baseURL: 'https://ofm.example.test/v1',
  model: MODEL,
  apiKey: FAKE_KEY,
  protocol: 'chat',
}

const cleanups: (() => Promise<unknown>)[] = []
const removeTree = (path: string) =>
  rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
afterEach(async () => {
  shellBinding.current = null
  while (cleanups.length) await cleanups.pop()!()
})

async function workspace(prefix: string, name = '中文 项目 dir'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  cleanups.push(() => removeTree(root))
  return dir
}

/** Register a real source through the real registry, so revocation semantics are genuine. */
function sourcesWith(route: ExternalModelRoute = ROUTE): {
  sources: ExternalModelSources
  release: () => void
  source: ExternalModelSource
  owner: { effect: (fn: () => unknown) => () => void }
} {
  const sources = new ExternalModelSources({} as never, () => {})
  let release = () => {}
  const source: ExternalModelSource = {
    provider: OPENCODE_OFM_PROVIDER,
    supports: () => true,
    resolve: async () => route,
  }
  // The fake owner's `effect` runs the callback synchronously and hands back the
  // disposer, exactly as an effect scope would.
  const owner = { effect: (fn: () => unknown) => fn() as () => void }
  release = sources.register(owner as never, source)
  return { sources, release, source, owner }
}

function options(sources?: ExternalModelSources): AdapterOptions {
  return {
    home: 'C:/opl-opencode-home',
    command: process.execPath,
    ...(sources ? { modelSources: sources } : {}),
    grokCommand: 'grok',
    nativeBridgePath: 'bridge.js',
  }
}

function record(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 's1',
    combination: `${OPENCODE_HARNESS}/${MODEL}`,
    harnessRef: OPENCODE_HARNESS,
    modelRef: { provider: OPENCODE_OFM_PROVIDER, model: MODEL },
    cwd: 'C:/work',
    acpSessionId: '',
    origin: { kind: 'harness', sessionId: 's1' },
    title: 't',
    sandbox: 'full-access',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    turns: [],
    ...overrides,
  }
}

interface Entry {
  method?: string
  event?: string
  params?: Record<string, any>
  argv?: string[]
}

/** Wait for a journal entry matching `match`, polling on a deadline rather than sleeping. */
async function until(journal: string, match: (entry: Entry) => boolean): Promise<Entry> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const text = await readFile(journal, 'utf8').catch(() => '')
    const entry = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry)
      .find(match)
    if (entry) return entry
    if (Date.now() > deadline) throw Error(`等待事件超时：${match.toString()}`)
    await new Promise((done) => setTimeout(done, 10))
  }
}

const journalOf = (dir: string) => join(dir, 'journal.jsonl')

/** Boot the fixture over a real stdio transport and return the live process. */
async function agent(
  dir: string,
  env: Record<string, string> = {},
  answerPermission?: (id: string | number, acp: AcpProcess) => void,
): Promise<{
  acp: AcpProcess
  journal: string
  updates: unknown[]
  waitUpdate: (match: (value: any) => boolean) => Promise<unknown>
}> {
  const journal = journalOf(dir)
  const started = openCodeLaunch(process.execPath, dir, [FIXTURE])
  const updates: unknown[] = []
  const waiters: ((value: any) => void)[] = []
  const acp = new AcpProcess(
    started.command,
    started.args,
    dir,
    { ...process.env, PATH: process.env.PATH!, OPENCODE_JOURNAL: journal, ...env },
    (value) => {
      updates.push(value)
      for (const done of waiters.splice(0)) done(value)
    },
    (id) => answerPermission?.(id, acp),
    () => {},
  )
  cleanups.push(() => acp.dispose())
  return {
    acp,
    journal,
    updates,
    waitUpdate: (match) =>
      new Promise((done) => {
        const existing = updates.find(match)
        if (existing) return done(existing)
        waiters.push((value) => {
          if (match(value)) done(value)
        })
      }),
  }
}

const initialize = async (acp: AcpProcess): Promise<AcpSessionSnapshot> => ({
  agent: (await acp.request('initialize', { protocolVersion: 1 })) as Record<string, any>,
  session: {},
  configOptions: undefined,
})

const openSession = async (
  acp: AcpProcess,
  method: 'session/new' | 'session/load',
  cwd: string,
  sessionId?: string,
): Promise<AcpSessionSnapshot> => {
  const session = (await acp.request(method, {
    cwd,
    ...(sessionId ? { sessionId } : {}),
    mcpServers: [],
  })) as Record<string, any>
  return {
    agent: { agentInfo: { version: '1.19.0' } },
    session,
    configOptions: session.configOptions,
  }
}

/** The launch environment the adapter really produced, wired to the fixture. */
async function launchEnv(model = MODEL): Promise<Record<string, string>> {
  const { sources } = sourcesWith({ ...ROUTE, model })
  const launch = await openCodeAdapter.prepare!(
    {} as never,
    record({ modelRef: { provider: OPENCODE_OFM_PROVIDER, model } }),
    options(sources),
  )
  return launch.env as Record<string, string>
}

describe('OpenCode 声明面', () => {
  it('只声明本轮点名的 OFM 来源模型配对', () => {
    expect(openCodeModels().map((entry) => entry.model)).toEqual([...OPENCODE_OFM_MODELS])
    for (const entry of openCodeModels()) expect(openCodeAdapter.matches(entry)).toBe(true)
    // 每个来源渠道与 free 虚拟路由都按原样保留，不合并、不折叠。
    expect(new Set(OPENCODE_OFM_MODELS).size).toBe(OPENCODE_OFM_MODELS.length)
    expect(OPENCODE_OFM_MODELS).toContain('ling-3.1-flash-free')
    expect(OPENCODE_OFM_MODELS).toContain('inclusionai/ling-3.1-flash')
    expect(OPENCODE_OFM_MODELS).toContain('cat-jam-free')
    expect(OPENCODE_OFM_MODELS).toContain('nvidia/nemotron-3-ultra-550b-a55b:free')
    expect(OPENCODE_OFM_MODELS).not.toContain('nvidia/nemotron-3-super-120b-a12b:free')
    expect(OPENCODE_OFM_MODELS).toContain('nvidia/nemotron-3.5-super-vl:free')
    expect(OPENCODE_OFM_MODELS).not.toContain('nvidia/nemotron-3.5-ultra-550b-a55b:free')
    expect(OPENCODE_OFM_MODELS).not.toContain('nvidia/nemotron-3.5-super-120b-a12b:free')
    expect(OPENCODE_OFM_MODELS).toContain('openrouter/free')
    // The OpenCode free-directory lanes this round could pair, each as the exact bare id
    // the directory publishes. `nemotron-3.5-super-vl-free` stays distinct from the
    // provider-qualified `nvidia/nemotron-3.5-super-vl:free` twin asserted above.
    for (const model of [
      'beam-free',
      'nemotron-3.5-super-vl-free',
      'glm-5.3-flash-free',
      'longcat-2.5-free',
      'iceman-free',
      'inkling-2-small-free',
    ]) {
      expect(OPENCODE_OFM_MODELS).toContain(model)
      const ref = { provider: OPENCODE_OFM_PROVIDER, model }
      expect(isOpenCodeModel(ref)).toBe(true)
      expect(openCodeAdapter.matches(ref)).toBe(true)
      expect(openCodeWireModel(ref)).toBe(model)
    }
    // Big Pickle is now an exact OFM `our-free-model` lane and is served by the official
    // OpenCode directory; it keeps its real id and binds the OpenCode Harness.
    expect(OPENCODE_OFM_MODELS).toContain('big-pickle')
    expect(OPENCODE_OFM_MODELS).toContain('flint-40b-free')
    const flintRef = { provider: OPENCODE_OFM_PROVIDER, model: 'flint-40b-free' }
    expect(isOpenCodeModel(flintRef)).toBe(true)
    expect(openCodeAdapter.matches(flintRef)).toBe(true)
    expect(openCodeWireModel(flintRef)).toBe('flint-40b-free')
    const bigPickle = { provider: OPENCODE_OFM_PROVIDER, model: 'big-pickle' }
    expect(isOpenCodeModel(bigPickle)).toBe(true)
    expect(openCodeAdapter.matches(bigPickle)).toBe(true)
    expect(openCodeWireModel(bigPickle)).toBe('big-pickle')
    // Directory-only ids are not provider/model combinations: `exo-free` has no live free
    // lane and `ll-alpha-free` is refused upstream for every non-OpenCode client.
    for (const model of ['exo-free', 'll-alpha-free']) {
      expect(OPENCODE_OFM_MODELS).not.toContain(model)
      const ref = { provider: OPENCODE_OFM_PROVIDER, model }
      expect(isOpenCodeModel(ref)).toBe(false)
      expect(openCodeAdapter.matches(ref)).toBe(false)
      expect(openCodeWireModel(ref)).toBeUndefined()
    }
  })

  it('不适配的模型明确拒绝，而不是当成别名', () => {
    for (const model of OPENCODE_EXCLUDED_MODELS) {
      expect(isExcludedOpenCodeModel(model)).toBe(true)
      expect(openCodeAdapter.matches({ provider: OPENCODE_OFM_PROVIDER, model })).toBe(false)
    }
    expect(openCodeAdapter.matches({ provider: 'other-source', model: MODEL })).toBe(false)
    expect(
      openCodeAdapter.matches({ provider: OPENCODE_OFM_PROVIDER, model: 'unknown-model' }),
    ).toBe(false)
  })

  it('能力只声明官方真正提供的接口', () => {
    const c = openCodeAdapter.capabilities
    expect(c.transport).toBe('acp')
    expect(c.sessionLoad).toBe(true)
    // 实测：`session/cancel` 在 pin 版本返回 -32601 Method not found，不得广告。
    expect(c.cancel).toBe(false)
    // 官方 ACP 不广告 shell，也不广告 terminal：不得据此声称已验证绑定。
    expect(OPENCODE_SHELL_FACTS.advertisesShell).toBe(false)
    expect(OPENCODE_SHELL_FACTS.advertisesTerminal).toBe(false)
    // 实测：只有 model 与 mode，没有推理档位；没有 Auto Review；权限是转发不是沙箱。
    // `none` 还阻止把来源模型的 light/balanced/deep token budget 当成可选档位复制过来。
    expect(c.reasoning).toBe('none')
    expect(c.autoReview).toBe('unsupported')
    expect(c.permissions).toEqual(['full-access'])
    expect(c.protocols).toEqual(['chat'])
    expect(c.customEndpoint).toBe(true)
    expect(c.authentication).toBe('api-source')
  })

  it('注册工厂按 id 幂等且不修改调用方数组', () => {
    const once = withOpenCodeAdapter([])
    const twice = withOpenCodeAdapter(once)
    expect(once).toHaveLength(1)
    expect(twice).toHaveLength(1)
    expect(twice[0]).toBe(openCodeAdapter)
  })
})

describe('OpenCode 启动参数与环境', () => {
  it('以 acp 子命令和真实 cwd 启动，中文加空格目录逐字保留', async () => {
    const dir = await workspace('opl-opencode-launch-')
    const started = openCodeLaunch(process.execPath, dir)
    expect(started.args.slice(-4)).toEqual(['acp', '--print-logs', '--cwd', dir])
    expect(started.args).toContain(dir)
    // 目录确实存在且名字没有被改写。
    await expect(access(dir)).resolves.toBeUndefined()
  })

  it('profile 走官方专用入口，不设置也不重定向 HOME/CODEX_HOME', async () => {
    const SUITE_HOME = 'C:/opl-opencode-home'
    const roots = openCodeProfileRoots(SUITE_HOME)
    expect(roots.XDG_DATA_HOME).toBe(join(SUITE_HOME, 'opencode/data'))
    expect(roots.XDG_CONFIG_HOME).toBe(join(SUITE_HOME, 'opencode/config'))
    expect(roots.XDG_CACHE_HOME).toBe(join(SUITE_HOME, 'opencode/cache'))
    expect(roots.XDG_STATE_HOME).toBe(join(SUITE_HOME, 'opencode/state'))
    const env = await launchEnv()
    const profileValues = Object.values(roots)

    // CODEX_HOME 未被接管：生产的 systemEnvironment() 使用固定 allowlist，不复制
    // CODEX_HOME，本适配器也不设置它。无论外层环境是否带 CODEX_HOME，子进程都拿不到它，
    // 因此这条断言不依赖运行环境。
    expect(env.CODEX_HOME).toBeUndefined()
    // 即便将来被写入，也绝不能指向本套件的隔离 profile。
    if (env.CODEX_HOME !== undefined) expect(profileValues).not.toContain(env.CODEX_HOME)

    // HOME 只是原样继承（allowlist 允许透传），没有被重定向到隔离 profile。
    if (env.HOME !== undefined) {
      expect(env.HOME).toBe(process.env.HOME)
      expect(profileValues).not.toContain(env.HOME)
      expect(env.HOME).not.toBe(SUITE_HOME)
    }

    // 隔离只来自官方文档化的 XDG 入口，全部位于套件自有 home 之下。
    expect(env.XDG_DATA_HOME).toBe(roots.XDG_DATA_HOME)
    expect(env.XDG_CONFIG_HOME).toBe(roots.XDG_CONFIG_HOME)
    expect(env.XDG_CACHE_HOME).toBe(roots.XDG_CACHE_HOME)
    expect(env.XDG_STATE_HOME).toBe(roots.XDG_STATE_HOME)
  })

  it('配置经官方环境变量传入，根级 shell 与 provider 都在同一份文档里', async () => {
    // The shell fragment is supplied explicitly so this proves how the adapter merges one
    // document on every host. On POSIX the real binding injects nothing at all, which
    // `POSIX 主机不注入任何 shell 覆盖` asserts separately.
    shellBinding.current = async (env) => testBinding(env)
    const env = await launchEnv()
    const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    expect(content.$schema).toBe('https://opencode.ai/config.json')
    // The root `shell` the selector reads and the inherited `SHELL` are one value, so the
    // legacy variable can never point the selector at a different interpreter.
    expect(content[OPENCODE_SHELL_CONFIG_KEY]).toEqual(env[OPENCODE_SHELL_VARIABLE])
    expect(content[OPENCODE_SHELL_CONFIG_KEY]).toBe(TEST_SHELL)
    const provider = content.provider[OPENCODE_ROUTE_PROVIDER_ID]
    expect(provider.npm).toBe('@ai-sdk/openai-compatible')
    expect(provider.options).toEqual({ baseURL: ROUTE.baseURL, apiKey: FAKE_KEY })
    // 模型 id 原样进入 provider 命名空间，斜杠不被拆开。
    expect(Object.keys(provider.models)).toEqual([MODEL])
  })

  it('没有已注册来源时明确拒绝启动', async () => {
    await expect(openCodeAdapter.prepare!({} as never, record(), options())).rejects.toThrow(
      /尚未适配此 Harness/,
    )
  })

  it.each(['opencode/glm-5.3-flash-free', 'opencode/deepseek-v4.1-flash-free'])(
    'EAC %s uses the owner endpoint and retains its qualified model id',
    async (model) => {
      const { sources } = sourcesWith({ ...ROUTE, model })
      const launch = await openCodeAdapter.prepare!(
        {} as never,
        record({ modelRef: { provider: OPENCODE_OFM_PROVIDER, model } }),
        options(sources),
      )
      const config = JSON.parse(launch.env!.OPENCODE_CONFIG_CONTENT!)
      expect(config.permission).toBe('allow')
      const provider = config.provider[OPENCODE_ROUTE_PROVIDER_ID]
      expect(provider.options).toEqual({ baseURL: ROUTE.baseURL, apiKey: FAKE_KEY })
      expect(Object.keys(provider.models)).toEqual([model])
      expect(openCodeWireModel({ provider: OPENCODE_OFM_PROVIDER, model })).toBe(model)
    },
  )

  it('受限权限与未知推理档位明确拒绝，不静默降级', async () => {
    const { sources } = sourcesWith()
    for (const sandbox of ['read-only', 'workspace'] as const) {
      await expect(
        openCodeAdapter.prepare!({} as never, record({ sandbox }), options(sources)),
      ).rejects.toThrow(/只支持显式授权的 full-access/)
    }
    await expect(
      openCodeAdapter.prepare!({} as never, record({ reasoningEffort: 'max' }), options(sources)),
    ).rejects.toThrow(/未广告推理档位配置项/)
  })

  it('Big Pickle 不显示也不虚构推理档位：high/max/balanced 都拒绝', async () => {
    // The owning OFM catalog publishes light/balanced/deep token budgets, but the official
    // OpenCode CLI advertises no effort option. Those budgets must not become selectable
    // `high`/`max` tiers on this combination.
    expect(openCodeAdapter.capabilities.reasoning).toBe('none')
    expect(
      readHarnessReasoning(
        record({ modelRef: { provider: OPENCODE_OFM_PROVIDER, model: 'big-pickle' } }),
        [
          {
            id: 'model',
            currentValue: 'opencode/big-pickle',
            options: [{ value: 'opencode/big-pickle' }],
          },
          { id: 'mode', currentValue: 'build', options: [{ value: 'build' }, { value: 'plan' }] },
        ],
      ),
    ).toEqual([])
    const { sources } = sourcesWith()
    for (const reasoningEffort of ['high', 'max', 'balanced', 'light', 'deep']) {
      await expect(
        openCodeAdapter.prepare!(
          {} as never,
          record({
            modelRef: { provider: OPENCODE_OFM_PROVIDER, model: 'big-pickle' },
            reasoningEffort,
          }),
          options(sources),
        ),
      ).rejects.toThrow(/未广告推理档位配置项/)
    }
  })
})

describe('OpenCode 来源解析', () => {
  it('坏协议明确拒绝，不猜端点也不换 provider', async () => {
    // Layer 1: the shared registry refuses a route whose protocol is not the one the
    // adapter asked for, before anything is written or launched.
    for (const protocol of ['responses', 'messages'] as const) {
      const { sources } = sourcesWith({ ...ROUTE, protocol })
      await expect(
        openCodeAdapter.prepare!({} as never, record(), options(sources)),
      ).rejects.toThrow(/模型来源未提供兼容的执行参数/)
    }
    // Layer 2: even if such a route reached the adapter, it refuses to express it.
    for (const protocol of ['responses', 'messages'] as const) {
      expect(() => buildOpenCodeRouteConfig({ ...ROUTE, protocol }, MODEL)).toThrow(
        /未被官方 OpenCode 适配验证/,
      )
    }
  })

  it('来源返回的模型与所选组合不一致时拒绝，不静默换模型', async () => {
    const { sources } = sourcesWith({ ...ROUTE, model: 'space-bunny-free' })
    await expect(openCodeAdapter.prepare!({} as never, record(), options(sources))).rejects.toThrow(
      /不会静默改用其他模型/,
    )
  })

  it('凭据不出现在任何错误文本里', async () => {
    const { sources } = sourcesWith({ ...ROUTE, apiKey: FAKE_KEY, protocol: 'responses' })
    const error = await openCodeAdapter.prepare!({} as never, record(), options(sources))
      .then(() => undefined)
      .catch((cause: Error) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).not.toContain(FAKE_KEY)
  })

  it('来源在启动准备期间撤销，晚到的 launch 被拒绝', async () => {
    // The shared registry re-checks around its own `resolve`; this revocation lands
    // strictly after it, while the adapter is still awaiting its shell preflight. That
    // preflight is the adapter's only await past the registry's re-check, and on POSIX the
    // real binding resolves without suspending — so the supplied binding revokes first and
    // then yields a macrotask, reproducing the window deterministically on every host
    // instead of depending on a Windows process spawn.
    const { sources, release } = sourcesWith(ROUTE)
    shellBinding.current = async () => {
      release()
      await tick()
      return testBinding({})
    }
    await expect(openCodeAdapter.prepare!({} as never, record(), options(sources))).rejects.toThrow(
      /模型来源已变更，请重新选择/,
    )
    // The disposer really ran; nothing else released it.
    expect(sources.supports(OPENCODE_HARNESS, record().modelRef)).toBe(false)
    expect(release).toBeTypeOf('function')
  })

  it('同一 source 对象注销再注册，旧 launch 仍然被拒绝', async () => {
    const { sources, release, source, owner } = sourcesWith(ROUTE)
    shellBinding.current = async () => {
      // Unregister and re-register the *same object* while preparation is in flight.
      release()
      sources.register(owner as never, source)
      await tick()
      return testBinding({})
    }
    await expect(openCodeAdapter.prepare!({} as never, record(), options(sources))).rejects.toThrow(
      /模型来源已变更，请重新选择/,
    )
    // The replacement really is registered, so the refusal came from comparing registration
    // identity rather than from the source having been dropped.
    expect(sources.supports(OPENCODE_HARNESS, record().modelRef)).toBe(true)
  })

  it('官方免费通道的新车道同样受来源代次约束：撤销后晚到的 launch 被拒绝', async () => {
    // This lane never reaches `resolve` — the CLI's own free provider carries the wire
    // value — so the captured lease is the only gate left. It must still fail after the
    // owning source is unloaded: a model id appearing in the official directory never
    // substitutes for the plugin that owns its discovery.
    const { sources, release } = sourcesWith()
    shellBinding.current = async () => {
      release()
      await tick()
      return testBinding({})
    }
    const session = record({ modelRef: { provider: OPENCODE_OFM_PROVIDER, model: 'beam-free' } })
    await expect(openCodeAdapter.prepare!({} as never, session, options(sources))).rejects.toThrow(
      /模型来源已变更，请重新选择/,
    )
  })

  it('官方免费通道的新车道在同一 source 对象注销再注册后仍拒绝旧 launch', async () => {
    const { sources, release, source, owner } = sourcesWith()
    shellBinding.current = async () => {
      release()
      sources.register(owner as never, source)
      await tick()
      return testBinding({})
    }
    const session = record({
      modelRef: { provider: OPENCODE_OFM_PROVIDER, model: 'nemotron-3.5-super-vl-free' },
    })
    await expect(openCodeAdapter.prepare!({} as never, session, options(sources))).rejects.toThrow(
      /模型来源已变更，请重新选择/,
    )
    expect(sources.supports(OPENCODE_HARNESS, session.modelRef)).toBe(true)
  })
})

describe('OpenCode 来源配对', () => {
  it('只为 OpenCode 和本轮声明的模型服务', async () => {
    const owner = () => ({ baseURL: ROUTE.baseURL, apiKey: FAKE_KEY, model: MODEL })
    const source = createOpenCodeSource(owner)
    expect(source.provider).toBe(OPENCODE_OFM_PROVIDER)
    expect(
      source.supports(OPENCODE_HARNESS, { provider: OPENCODE_OFM_PROVIDER, model: MODEL }),
    ).toBe(true)
    expect(source.supports('codex', { provider: OPENCODE_OFM_PROVIDER, model: MODEL })).toBe(false)
    for (const model of OPENCODE_EXCLUDED_MODELS)
      expect(source.supports(OPENCODE_HARNESS, { provider: OPENCODE_OFM_PROVIDER, model })).toBe(
        false,
      )
    await expect(
      source.resolve(OPENCODE_HARNESS, {
        provider: OPENCODE_OFM_PROVIDER,
        model: 'unlisted-model',
      }),
    ).rejects.toThrow(/未分配给 OpenCode Harness/)
  })

  it('不自行注册：同一个 provider 只能有一个 owner', () => {
    // The helper returns a source; registering is the owner's single responsibility.
    // Registering twice must be refused by the shared registry, proving no second owner
    // can be created for one provider id.
    const { sources } = sourcesWith()
    const owner = { effect: (fn: () => unknown) => fn() } as never
    const second = createOpenCodeSource(() => ({
      baseURL: ROUTE.baseURL,
      apiKey: FAKE_KEY,
      model: MODEL,
    }))
    expect(() => sources.register(owner, second)).toThrow(/外部模型来源已注册或身份无效/)
  })

  it('来源返回的凭据只进入解析结果，不进入日志或错误', async () => {
    const owner = () => ({ baseURL: ROUTE.baseURL, apiKey: FAKE_KEY, model: MODEL })
    const route = await createOpenCodeSource(owner).resolve(OPENCODE_HARNESS, {
      provider: OPENCODE_OFM_PROVIDER,
      model: MODEL,
    })
    expect(route).toEqual({
      baseURL: ROUTE.baseURL,
      apiKey: FAKE_KEY,
      model: MODEL,
      protocol: 'chat',
    })
  })
})

describe('OpenCode shell 绑定', () => {
  it('记录 pin 版本实测到的 V1/V2 差异', () => {
    expect(OPENCODE_SHELL_FACTS.bindsFromRootConfig).toBe(true)
    // V1 的 OPENCODE_GIT_BASH_PATH 在 V2 不足以决定 shell：实测会落到 PowerShell。
    expect(OPENCODE_SHELL_FACTS.gitBashVariableIsSufficient).toBe(false)
    // 无效 shell 配置会静默回退，必须由本套件自己先验证。
    expect(OPENCODE_SHELL_FACTS.invalidShellFallsBackToPowerShell).toBe(true)
  })

  it('缺少 Git Bash 明确失败，且不声称回退 PowerShell', async () => {
    await expect(
      openCodeShellBinding(
        {},
        {
          platform: 'win32',
          resolve: () => {
            throw Error('未找到')
          },
        },
      ),
    ).rejects.toThrow(/未回退 PowerShell、CMD 或 WSL/)
  })

  it('无法被直接采用的路径在启动前就拒绝', () => {
    // A bare name resolves only through PATH, so it can become some other interpreter by
    // the time the tool runs; it is refused rather than handed over to be reinterpreted.
    for (const candidate of ['bash', 'bash.exe', 'Git/bin/bash.exe'])
      expect(openCodeShellSelectionAccepts(candidate, 'win32')).toBe(false)
    // Rooted paths. The same `/`-rooted spelling is absolute under both the posix and the
    // win32 rules, so these check the executable-name rule itself instead of the host's
    // notion of an absolute path — `path.isAbsolute` follows the running platform, not the
    // injected one, so a `C:/…` fixture would be refused on Linux for an unrelated reason.
    expect(openCodeShellSelectionAccepts('/opt/opl-test/Git/bin/git.exe', 'win32')).toBe(false)
    expect(openCodeShellSelectionAccepts('/opt/opl-test/Git/bin/bash.exe', 'win32')).toBe(true)
    // On a Windows host the drive-letter spelling the resolver really returns is accepted.
    if (process.platform === 'win32')
      expect(openCodeShellSelectionAccepts('C:/Program Files/Git/bin/bash.exe', 'win32')).toBe(true)
  })

  it('不是 Git Bash 的可执行文件和不存在的路径都在启动前拒绝', async () => {
    // A runnable executable that is not Git Bash must never be let through, on any host.
    await expect(verifyOpenCodeGitBash(process.execPath, process.env)).rejects.toThrow(
      /OpenCode Git Bash 启动验证失败/,
    )
    await expect(verifyOpenCodeGitBash(process.execPath, process.env)).rejects.toThrow(
      /未回退 PowerShell、CMD 或 WSL/,
    )
    // A path that does not exist fails the same way instead of falling through to
    // PowerShell, which is the silent failure this check exists to prevent.
    await expect(
      verifyOpenCodeGitBash(join(tmpdir(), 'opl-no-such-dir', 'opl-missing-bash.exe'), process.env),
    ).rejects.toThrow(/未回退 PowerShell、CMD 或 WSL/)
  })

  // Executing a real Git Bash only answers on Windows; POSIX hosts run a different shell
  // that the adapter deliberately does not bind at all.
  it.skipIf(process.platform !== 'win32')(
    '真实执行所选 shell，只有 Git Bash/MSYS 运行时才算通过',
    async () => {
      const gitBash = resolveGitBashPath()
      const uname = await verifyOpenCodeGitBash(gitBash, process.env)
      expect(uname).toMatch(/^MINGW(?:32|64)?_NT-|^MSYS_NT-/)
    },
  )

  it('POSIX 主机不注入任何 shell 覆盖', async () => {
    const env = { PATH: '/usr/bin' }
    const binding = await openCodeShellBinding(env, { platform: 'linux' })
    expect(binding.config).toEqual({})
    expect(binding.env).toBe(env)
  })

  it('shell 片段合并进配置根级，键不被 provider 覆盖', () => {
    const content = JSON.stringify({ $schema: 'x', provider: { a: {} } })
    const merged = JSON.parse(
      withOpenCodeShell(content, {
        config: { [OPENCODE_SHELL_CONFIG_KEY]: 'C:/git/bin/bash.exe' },
        env: {},
        uname: 'MINGW64_NT',
      }),
    )
    expect(merged[OPENCODE_SHELL_CONFIG_KEY]).toBe('C:/git/bin/bash.exe')
    expect(merged.provider).toEqual({ a: {} })
    // 不可解析的文档明确拒绝，不静默放行。
    expect(() =>
      withOpenCodeShell('not json', {
        config: { [OPENCODE_SHELL_CONFIG_KEY]: 'C:/git/bin/bash.exe' },
        env: {},
        uname: 'MINGW64_NT',
      }),
    ).toThrow(/无法解析/)
  })
})

it.each([
  'nemotron-3.5-lightning-free',
  'longcat-2.5-preview-free',
  'longcat-2.5-free',
  'iceman-free',
  'inkling-2-small-free',
  'beam-free',
  'nemotron-3.5-super-vl-free',
  'glm-5.3-flash-free',
])('pins %s to the official free provider without resolving OFM credentials', async (model) => {
  const { sources, source } = sourcesWith()
  source.resolve = async () => {
    throw Error('must not request OFM credentials')
  }
  shellBinding.current = async (env) => testBinding(env)
  const session = record({ modelRef: { provider: OPENCODE_OFM_PROVIDER, model } })
  const launch = await openCodeAdapter.prepare!({} as never, session, options(sources))
  const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!)
  expect(config.provider).toBeUndefined()
  expect(config.shell).toBe(TEST_SHELL)
  const target = 'opencode/' + model
  const configOptions = [
    {
      id: 'model',
      type: 'select',
      currentValue: target,
      options: [{ value: target, name: model }],
    },
  ]
  const calls: unknown[] = []
  const acp = {
    request: async (_method: string, args: unknown) => {
      calls.push(args)
      return { configOptions }
    },
  }
  const snapshot = { session: { sessionId: 'owned' }, configOptions }
  await openCodeAdapter.configureSession!(acp as never, session, snapshot as never)
  expect(calls).toEqual([{ sessionId: 'owned', configId: 'model', value: target }])
  expect(() =>
    openCodeAdapter.verifySession!(session, { ...snapshot, configOptions: [] } as never),
  ).toThrow()
})
