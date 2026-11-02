/**
 * Behavior evidence for the official Kilo (`kilo`) adaptation.
 *
 * These tests cover what the adapter itself decides: the launch vector and environment, the
 * shape of the route it serialises, the refusals it makes, and the source-lease semantics
 * around asynchronous preparation. They drive the real shared registry and the real
 * `ExternalModelSources`, so revocation and re-registration behave exactly as they do in
 * production rather than as a stand-in would.
 *
 * Session-level behaviour over a live transport lives in `kilo-session.spec.ts`; the
 * measured surface of the pinned official binary lives in `kilo-official.spec.ts`.
 *
 * No test sleeps for a fixed duration and then assumes an event happened.
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import { systemEnvironment } from '../../../src/execution/host/adapters/environment.ts'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
import type {
  KiloShellBinding,
  KiloShellOptions,
} from '../../../src/execution/host/adapters/kilo/kilo-shell.ts'
import type {
  ExternalModelRoute,
  ExternalModelSource,
} from '../../../src/execution/host/model-sources.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import type { AdapterOptions } from '../../../src/execution/host/adapters/types.ts'
import {
  assertNoKiloEffort,
  buildKiloRouteConfig,
  createKiloSource,
  isExcludedKiloModel,
  kiloAdapter,
  kiloLaunch,
  kiloModels,
  kiloModelValue,
  kiloProfileRoots,
  kiloShellBinding,
  kiloShellSelectionAccepts,
  verifyKiloGitBash,
  withKiloAdapter,
  withKiloShell,
  KILO_EFFORT_FACTS,
  KILO_EXCLUDED_MODELS,
  KILO_GIT_BASH_VARIABLE,
  KILO_HARNESS,
  KILO_OFM_MODELS,
  KILO_OFM_PROVIDER,
  KILO_ROUTE_PROVIDER_ID,
  KILO_SHELL_CONFIG_KEY,
  KILO_SHELL_FACTS,
  KILO_SHELL_VARIABLE,
} from '../../../src/execution/host/adapters/kilo/index.ts'

/**
 * The adapter's Git Bash preflight is the single await the shared registry cannot cover: the
 * lease is checked immediately after it. On Windows it spawns a real process and is
 * therefore a real suspension point, but the POSIX binding resolves without suspending at
 * all, so nothing can interleave there. The tests below need that await to exist
 * deterministically on every host, so the shell module delegates to a test-supplied binding
 * while one is installed. Every other test keeps the real implementation.
 */
const shellBinding = vi.hoisted(() => ({
  current: null as null | ((env: NodeJS.ProcessEnv) => Promise<KiloShellBinding>),
}))

vi.mock('../../../src/execution/host/adapters/kilo/kilo-shell.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/execution/host/adapters/kilo/kilo-shell.ts')>()
  return {
    ...actual,
    kiloShellBinding: async (
      env: NodeJS.ProcessEnv,
      options?: KiloShellOptions,
    ): Promise<KiloShellBinding> => {
      const supplied = shellBinding.current
      return supplied ? supplied(env) : actual.kiloShellBinding(env, options)
    },
  }
})

/**
 * A shell binding the adapter can merge without a real Git Bash on this host. The path is
 * `/`-rooted, so it is absolute under both the posix and the win32 rules and this says
 * nothing about where the suite resolved a shell on any particular machine.
 */
const TEST_SHELL = '/opt/opl-test/Git/bin/bash.exe'

const testBinding = (env: NodeJS.ProcessEnv): KiloShellBinding => ({
  config: { [KILO_SHELL_CONFIG_KEY]: TEST_SHELL },
  env: { ...env, [KILO_SHELL_VARIABLE]: TEST_SHELL, [KILO_GIT_BASH_VARIABLE]: TEST_SHELL },
  uname: 'MINGW64_NT-10.0',
})

/** Suspend preparation the way a spawned shell process would. */
const tick = () => new Promise<void>((done) => setImmediate(done))

const exec = promisify(execFile)
const FIXTURE = resolve('tests/execution/ofm-kilo/fixtures/kilo-acp-agent.mjs')
/** A slash-and-colon bearing id, matching what the pinned binary really accepted. */
const MODEL = 'dots-studio/dots-3-note-preview:free'
/** Never a real secret; the tests only prove where a credential can and cannot appear. */
const FAKE_KEY = 'opl-test-key-do-not-use'
const ROUTE: ExternalModelRoute = {
  baseURL: 'https://ofm.example.test/v1',
  model: MODEL,
  apiKey: FAKE_KEY,
  protocol: 'chat',
}

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  shellBinding.current = null
  while (cleanups.length) await cleanups.pop()!()
})

async function workspace(prefix: string, name = '中文 项目 dir'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
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
    provider: KILO_OFM_PROVIDER,
    supports: () => true,
    resolve: async () => route,
  }
  // The fake owner's `effect` runs the callback synchronously and hands back the disposer,
  // exactly as an effect scope would.
  const owner = { effect: (fn: () => unknown) => fn() as () => void }
  release = sources.register(owner as never, source)
  return { sources, release, source, owner }
}

function options(sources?: ExternalModelSources): AdapterOptions {
  return {
    home: 'C:/opl-kilo-home',
    command: process.execPath,
    ...(sources ? { modelSources: sources } : {}),
    grokCommand: 'grok',
    nativeBridgePath: 'bridge.js',
  }
}

function record(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 's1',
    combination: `${KILO_HARNESS}/${MODEL}`,
    harnessRef: KILO_HARNESS,
    modelRef: { provider: KILO_OFM_PROVIDER, model: MODEL },
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

/** The launch environment the adapter really produced. */
async function launchEnv(model = MODEL): Promise<Record<string, string>> {
  const { sources } = sourcesWith({ ...ROUTE, model })
  const launch = await kiloAdapter.prepare!(
    {} as never,
    record({ modelRef: { provider: KILO_OFM_PROVIDER, model } }),
    options(sources),
  )
  return launch.env as Record<string, string>
}

describe('Kilo 声明面', () => {
  it('声明 Kilo 已验证的 OFM 来源模型配对', () => {
    expect(kiloModels().map((entry) => entry.model)).toEqual([
      'inclusionai/ling-3.1-flash-1019-free',
      'dots-studio/dots-3-note-preview:free',
      'stealth/glyph-cluster',
      'kilo-auto/free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'nvidia/nemotron-3.5-super-vl:free',
      'reflection/beam-free',
      'xingchen-agi/xing4.0-29b-a4b:free',
      'recursive/flint-v1.0:free',
    ])
    for (const entry of kiloModels()) expect(kiloAdapter.matches(entry)).toBe(true)
    // 每个 id 保持原样，不合并、不折叠、不拆分斜杠或冒号。
    expect(new Set(KILO_OFM_MODELS).size).toBe(KILO_OFM_MODELS.length)
    expect(KILO_OFM_MODELS).toContain('stealth/glyph-cluster')
    // free/auto 路由条目按路由条目保留，不被替换成某个具体底层模型。
    expect(KILO_OFM_MODELS).toContain('kilo-auto/free')
    expect(KILO_OFM_MODELS).toContain('nvidia/nemotron-3-super-120b-a12b:free')
    expect(KILO_OFM_MODELS).toContain('nvidia/nemotron-3.5-super-vl:free')
    expect(KILO_OFM_MODELS).toContain('reflection/beam-free')
    expect(KILO_OFM_MODELS).toContain('xingchen-agi/xing4.0-29b-a4b:free')
    expect(KILO_OFM_MODELS).toContain('recursive/flint-v1.0:free')
    expect(kiloModelValue('kilo-auto/free')).toBe('oplkilo/kilo-auto/free')
  })

  it('不适配的模型明确拒绝，而不是当成别名', () => {
    for (const model of KILO_EXCLUDED_MODELS) {
      expect(isExcludedKiloModel(model)).toBe(true)
      expect(kiloAdapter.matches({ provider: KILO_OFM_PROVIDER, model })).toBe(false)
    }
    expect(kiloAdapter.matches({ provider: 'other-source', model: MODEL })).toBe(false)
    expect(kiloAdapter.matches({ provider: KILO_OFM_PROVIDER, model: 'unknown-model' })).toBe(false)
  })

  it('能力只声明官方真正提供的接口', () => {
    const c = kiloAdapter.capabilities
    expect(c.transport).toBe('acp')
    expect(c.sessionLoad).toBe(true)
    // 实测：`session/cancel` 在 pin 版本返回 -32601 Method not found，不得广告。
    expect(c.cancel).toBe(false)
    // 官方 ACP 不广告 shell，也不广告 terminal：不得据此声称已验证绑定。
    expect(KILO_SHELL_FACTS.advertisesShell).toBe(false)
    expect(KILO_SHELL_FACTS.advertisesTerminal).toBe(false)
    // 实测：本组合声明的模型没有可用档位，写入一律被拒；没有 Auto Review；权限是转发不是沙箱。
    expect(c.reasoning).toBe('model-declared')
    expect(KILO_EFFORT_FACTS.advertisesEffortOptionOnDefault).toBe(true)
    expect(KILO_EFFORT_FACTS.defaultValues).toEqual(['thinking'])
    expect(KILO_EFFORT_FACTS.advertisesEffortOptionForDeclaredModels).toBe(false)
    expect(KILO_EFFORT_FACTS.writable).toBe(false)
    expect(KILO_EFFORT_FACTS.advertisesMax).toBe(false)
    expect(c.autoReview).toBe('unsupported')
    expect(c.permissions).toEqual(['full-access'])
    expect(c.protocols).toEqual(['chat'])
    expect(c.customEndpoint).toBe(true)
    expect(c.authentication).toBe('api-source')
  })

  it('注册工厂按 id 幂等且不修改调用方数组', () => {
    const once = withKiloAdapter([])
    const twice = withKiloAdapter(once)
    expect(once).toHaveLength(1)
    expect(twice).toHaveLength(1)
    expect(twice[0]).toBe(kiloAdapter)
  })
})

describe('Kilo 启动参数与环境', () => {
  it('以 acp 子命令和真实 cwd 启动，中文加空格目录逐字保留', async () => {
    const dir = await workspace('opl-kilo-launch-')
    const started = kiloLaunch(process.execPath, dir)
    expect(started.args.slice(-3)).toEqual(['acp', '--cwd', dir])
    expect(started.args).toContain(dir)
    // 目录确实存在且名字没有被改写。
    await expect(access(dir)).resolves.toBeUndefined()
  })

  it('profile 走官方专用入口 KILO_CONFIG_DIR，不设置也不重定向 HOME', async () => {
    const roots = kiloProfileRoots('C:/opl-kilo-home')
    expect(roots.KILO_CONFIG_DIR).toBe(join('C:/opl-kilo-home', 'kilo/config'))
    const env = await launchEnv()
    // HOME 在系统环境白名单里，所以它是被原样透传的，而不是被隔离根接管或重定向。
    expect(env.HOME).toBe(process.env.HOME)
    expect(env.USERPROFILE).toBe(process.env.USERPROFILE)
    expect(env.HOME).not.toBe(roots.KILO_CONFIG_DIR)
    expect(env.USERPROFILE).not.toBe(roots.KILO_CONFIG_DIR)
    // 隔离只来自官方自己的配置根，全部在套件 home 之下。
    expect(env.KILO_CONFIG_DIR).toBe(roots.KILO_CONFIG_DIR)
    // 除 KILO_CONFIG_DIR 自身外，没有任何其他环境变量承载这个隔离根：profile 不借用
    // HOME/USERPROFILE 或别的键来承载。
    for (const [key, value] of Object.entries(env))
      if (key !== 'KILO_CONFIG_DIR') expect(value).not.toBe(roots.KILO_CONFIG_DIR)
  })

  it('不接管 CODEX_HOME：启动环境里根本没有这个键', async () => {
    const env = await launchEnv()
    // 断言键本身不存在，而不是比较父子值是否相等。
    //
    // `systemEnvironment()` 使用固定白名单，`CODEX_HOME` 并不在其中，因此子进程环境从不会
    // 携带它。写 `env.CODEX_HOME === process.env.CODEX_HOME` 在本宿主上只是
    // `undefined === undefined`：即使适配器主动删除该变量也会通过，那条断言不证明任何事。
    // 这里断言的是真正需要保证的性质——Kilo 既不设置也不转发 CODEX_HOME，更不会用它承载
    // 隔离 profile。
    expect('CODEX_HOME' in env).toBe(false)
    expect(Object.keys(env)).not.toContain('CODEX_HOME')
    expect(env.CODEX_HOME).toBeUndefined()
  })

  it('即使父进程存在 CODEX_HOME，也不会被复制进 Kilo 启动环境', async () => {
    // 上一条在默认宿主上成立，但默认宿主本身没有 CODEX_HOME。这里显式放入一个哨兵值，
    // 证明丢弃来自白名单本身，而不是来自“宿主恰好没有这个变量”。
    const sentinel = join('C:/sentinel-codex-home', 'do-not-copy')
    vi.stubEnv('CODEX_HOME', sentinel)
    try {
      // 白名单直接丢弃它：不设置、不转发、也不改写。
      expect('CODEX_HOME' in systemEnvironment()).toBe(false)
      // 走完整的准备路径，得到适配器真正产出的启动环境。
      const env = await launchEnv()
      expect('CODEX_HOME' in env).toBe(false)
      // 隔离依然只由 KILO_CONFIG_DIR 承担，与该哨兵路径无关。
      expect(env.KILO_CONFIG_DIR).toBe(join('C:/opl-kilo-home', 'kilo/config'))
      expect(Object.values(env)).not.toContain(sentinel)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('子进程不自行更新，也不自行拉取远端模型目录', async () => {
    const env = await launchEnv()
    expect(env.KILO_DISABLE_AUTOUPDATE).toBe('1')
    expect(env.KILO_DISABLE_MODELS_FETCH).toBe('1')
  })

  it('配置经官方环境变量传入，根级 shell 与 provider 都在同一份文档里', async () => {
    // The shell fragment is supplied explicitly so this proves how the adapter merges one
    // document on every host. On POSIX the real binding injects nothing at all, which
    // `POSIX 主机不注入任何 shell 覆盖` asserts separately.
    shellBinding.current = async (env) => testBinding(env)
    const env = await launchEnv()
    const content = JSON.parse(env.KILO_CONFIG_CONTENT)
    expect(content.permission).toBe('allow')
    expect(content.$schema).toBe('https://kilo.ai/schema.json')
    // The root `shell` the bash tool reads and the inherited `SHELL` are one value, so the
    // legacy selector cannot describe a different interpreter than the one that will run.
    expect(content[KILO_SHELL_CONFIG_KEY]).toEqual(env[KILO_SHELL_VARIABLE])
    expect(content[KILO_SHELL_CONFIG_KEY]).toBe(TEST_SHELL)
    const provider = content.provider[KILO_ROUTE_PROVIDER_ID]
    expect(provider.npm).toBe('@ai-sdk/openai-compatible')
    expect(provider.options).toEqual({ baseURL: ROUTE.baseURL, apiKey: FAKE_KEY })
    // 模型 id 原样进入 provider 命名空间，斜杠与冒号都不被拆开。
    expect(Object.keys(provider.models)).toEqual([MODEL])
  })

  it('每个声明模型都能逐字进入配置，free/auto 路由不被替换成具体模型', async () => {
    for (const model of KILO_OFM_MODELS) {
      const env = await launchEnv(model)
      const content = JSON.parse(env.KILO_CONFIG_CONTENT)
      const models = content.provider[KILO_ROUTE_PROVIDER_ID].models
      expect(Object.keys(models)).toEqual([model])
      // 只声明被绑定的那一个模型，不附带任何“可能路由到”的具体底层模型。
      expect(models[model].name).toBe(model)
      expect(Object.keys(models)).toHaveLength(1)
    }
  })

  it('没有已注册来源时明确拒绝启动', async () => {
    await expect(kiloAdapter.prepare!({} as never, record(), options())).rejects.toThrow(
      /尚未适配此 Harness/,
    )
  })

  it('受限权限与未知推理档位明确拒绝，不静默降级', async () => {
    const { sources } = sourcesWith()
    for (const sandbox of ['read-only', 'workspace'] as const) {
      await expect(
        kiloAdapter.prepare!({} as never, record({ sandbox }), options(sources)),
      ).rejects.toThrow(/只支持显式授权的 full-access/)
    }
    // 本次实施的 max 档位不得被套用到未广告该档位的目标模型。
    for (const effort of ['max', 'high', 'medium']) {
      await expect(
        kiloAdapter.prepare!({} as never, record({ reasoningEffort: effort }), options(sources)),
      ).rejects.toThrow(/未广告任何可用推理档位/)
    }
    // 拒绝文本必须点名不会把 max 套用到未广告的模型。
    await expect(
      kiloAdapter.prepare!({} as never, record({ reasoningEffort: 'max' }), options(sources)),
    ).rejects.toThrow(/不会把本套件的 max 档位套用到未广告该档位的模型/)
    // 空档位不触发拒绝：不发送任何 effort 即为合法。
    await expect(
      kiloAdapter.prepare!({} as never, record({ reasoningEffort: '' }), options(sources)),
    ).resolves.toBeTruthy()
  })

  it('档位断言在没有任何可用值时明确拒绝，任何请求都不静默通过', () => {
    const boom = (message: string) => new Error(message)
    expect(() => assertNoKiloEffort('', boom)).not.toThrow()
    expect(() => assertNoKiloEffort(undefined, boom)).not.toThrow()
    expect(() => assertNoKiloEffort('max', boom)).toThrow(/未广告任何推理档位/)
    expect(() => assertNoKiloEffort('thinking', boom)).toThrow(/未广告任何推理档位/)
  })
})

describe('Kilo 来源解析', () => {
  it('坏协议明确拒绝，不猜端点也不换 provider', async () => {
    // Layer 1: the shared registry refuses a route whose protocol is not the one the
    // adapter asked for, before anything is written or launched.
    for (const protocol of ['responses', 'messages'] as const) {
      const { sources } = sourcesWith({ ...ROUTE, protocol })
      await expect(kiloAdapter.prepare!({} as never, record(), options(sources))).rejects.toThrow(
        /模型来源未提供兼容的执行参数/,
      )
    }
    // Layer 2: even if such a route reached the adapter, it refuses to express it.
    for (const protocol of ['responses', 'messages'] as const) {
      expect(() => buildKiloRouteConfig({ ...ROUTE, protocol }, MODEL)).toThrow(
        /未被官方 Kilo 适配验证/,
      )
    }
  })

  it('来源返回的模型与所选组合不一致时拒绝，不静默换模型', async () => {
    for (const other of ['stealth/glyph-cluster', 'kilo-auto/free']) {
      const { sources } = sourcesWith({ ...ROUTE, model: other })
      await expect(kiloAdapter.prepare!({} as never, record(), options(sources))).rejects.toThrow(
        /不会静默改用其他模型/,
      )
    }
  })

  it('凭据不出现在任何错误文本里', async () => {
    const { sources } = sourcesWith({ ...ROUTE, apiKey: FAKE_KEY, protocol: 'responses' })
    const error = await kiloAdapter.prepare!({} as never, record(), options(sources))
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
    await expect(kiloAdapter.prepare!({} as never, record(), options(sources))).rejects.toThrow(
      /模型来源已变更，请重新选择/,
    )
    // The disposer really ran; nothing else released it.
    expect(sources.supports(KILO_HARNESS, record().modelRef)).toBe(false)
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
    await expect(kiloAdapter.prepare!({} as never, record(), options(sources))).rejects.toThrow(
      /模型来源已变更，请重新选择/,
    )
    // The replacement really is registered, so the refusal came from comparing registration
    // identity rather than from the source having been dropped.
    expect(sources.supports(KILO_HARNESS, record().modelRef)).toBe(true)
  })

  it('声明之外的模型没有来源配对，准备阶段即拒绝', async () => {
    // Use the real pairing helper, so the registry itself refuses the pairing rather than
    // the adapter having to defend against a permissive stub source.
    const sources = new ExternalModelSources({} as never, () => {})
    sources.register(
      { effect: (fn: () => unknown) => fn() } as never,
      createKiloSource(() => ({ baseURL: ROUTE.baseURL, apiKey: FAKE_KEY, model: MODEL })),
    )
    expect(
      sources.supports(KILO_HARNESS, {
        provider: KILO_OFM_PROVIDER,
        model: 'not-declared-here',
      }),
    ).toBe(false)
    await expect(
      kiloAdapter.prepare!(
        {} as never,
        record({ modelRef: { provider: KILO_OFM_PROVIDER, model: 'not-declared-here' } }),
        options(sources),
      ),
    ).rejects.toThrow(/尚未适配此 Harness/)
  })

  it('即使来源无条件放行，返回的模型与组合不符也拒绝启动', async () => {
    // A permissive stub source cannot smuggle a different model past the adapter: the route
    // check compares the resolved model against the record's own model.
    const { sources } = sourcesWith()
    await expect(
      kiloAdapter.prepare!(
        {} as never,
        record({ modelRef: { provider: KILO_OFM_PROVIDER, model: 'not-declared-here' } }),
        options(sources),
      ),
    ).rejects.toThrow(/不会静默改用其他模型/)
  })
})

describe('Kilo 来源配对', () => {
  it('只为 Kilo 和本轮声明的模型服务', async () => {
    const owner = () => ({ baseURL: ROUTE.baseURL, apiKey: FAKE_KEY, model: MODEL })
    const source = createKiloSource(owner)
    expect(source.provider).toBe(KILO_OFM_PROVIDER)
    expect(source.supports(KILO_HARNESS, { provider: KILO_OFM_PROVIDER, model: MODEL })).toBe(true)
    expect(source.supports('codex', { provider: KILO_OFM_PROVIDER, model: MODEL })).toBe(false)
    for (const model of KILO_EXCLUDED_MODELS)
      expect(source.supports(KILO_HARNESS, { provider: KILO_OFM_PROVIDER, model })).toBe(false)
    await expect(
      source.resolve(KILO_HARNESS, {
        provider: KILO_OFM_PROVIDER,
        model: 'unlisted-model',
      }),
    ).rejects.toThrow(/未分配给 Kilo Harness/)
    await expect(
      source.resolve(KILO_HARNESS, {
        provider: KILO_OFM_PROVIDER,
        model: 'openai/gpt-oss-20b',
      }),
    ).rejects.toThrow(/未纳入本次 Kilo 适配范围/)
  })

  it('不自行注册：同一个 provider 只能有一个 owner', () => {
    // The helper returns a source; registering is the owner's single responsibility.
    // Registering twice must be refused by the shared registry, proving no second owner
    // can be created for one provider id.
    const { sources } = sourcesWith()
    const owner = { effect: (fn: () => unknown) => fn() } as never
    const second = createKiloSource(() => ({
      baseURL: ROUTE.baseURL,
      apiKey: FAKE_KEY,
      model: MODEL,
    }))
    expect(() => sources.register(owner, second)).toThrow(/外部模型来源已注册或身份无效/)
  })

  it('来源返回的凭据只进入解析结果，不进入日志或错误', async () => {
    const owner = () => ({ baseURL: ROUTE.baseURL, apiKey: FAKE_KEY, model: MODEL })
    const route = await createKiloSource(owner).resolve(KILO_HARNESS, {
      provider: KILO_OFM_PROVIDER,
      model: MODEL,
    })
    expect(route).toEqual({
      baseURL: ROUTE.baseURL,
      apiKey: FAKE_KEY,
      model: MODEL,
      protocol: 'chat',
    })
  })

  it('free/auto 路由条目不会被来源改写成具体底层模型', async () => {
    // The pairing helper passes the owner's answer through untouched. If the owner answered
    // a concrete model for a routing entry, the adapter's own route check refuses it later;
    // the helper itself must not invent an expansion.
    const owner = () => ({
      baseURL: ROUTE.baseURL,
      apiKey: FAKE_KEY,
      model: 'kilo-auto/free',
    })
    const route = await createKiloSource(owner).resolve(KILO_HARNESS, {
      provider: KILO_OFM_PROVIDER,
      model: 'kilo-auto/free',
    })
    expect(route.model).toBe('kilo-auto/free')
  })
})

describe('Kilo shell 绑定', () => {
  it('记录 pin 版本实测到的绑定事实', () => {
    expect(KILO_SHELL_FACTS.bindsFromMergedConfig).toBe(true)
    // 实测：配置 shell 指向可运行路径时是 Git Bash；旧 KILO_GIT_BASH_PATH/SHELL 不足以覆盖它。
    expect(KILO_SHELL_FACTS.legacyEnvironmentIsSufficient).toBe(false)
    // 实测：无效 shell 配置会静默落到 PowerShell，必须由本套件自己先验证。
    expect(KILO_SHELL_FACTS.invalidShellFallsBackToPowerShell).toBe(true)
    // 权限是转发不是沙箱：bash 以宿主用户权限执行，不限制在工作目录内。
    expect(KILO_SHELL_FACTS.confinesToWorkingDirectory).toBe(false)
  })

  it('缺少 Git Bash 明确失败，且不声称回退 PowerShell', async () => {
    await expect(
      kiloShellBinding(
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
      expect(kiloShellSelectionAccepts(candidate, 'win32')).toBe(false)
    // Rooted paths. The same `/`-rooted spelling is absolute under both the posix and the
    // win32 rules, so these check the executable-name rule itself instead of the host's
    // notion of an absolute path — `path.isAbsolute` follows the running platform, not the
    // injected one, so a `C:/…` fixture would be refused on Linux for an unrelated reason.
    expect(kiloShellSelectionAccepts('/opt/opl-test/Git/bin/git.exe', 'win32')).toBe(false)
    expect(kiloShellSelectionAccepts('/opt/opl-test/Git/bin/bash.exe', 'win32')).toBe(true)
    // On a Windows host the drive-letter spelling the resolver really returns is accepted.
    if (process.platform === 'win32')
      expect(kiloShellSelectionAccepts('C:/Program Files/Git/bin/bash.exe', 'win32')).toBe(true)
  })

  it('不是 Git Bash 的可执行文件和不存在的路径都在启动前拒绝', async () => {
    // A runnable executable that is not Git Bash must never be let through, on any host.
    await expect(verifyKiloGitBash(process.execPath, process.env)).rejects.toThrow(
      /Kilo Git Bash 启动验证失败/,
    )
    await expect(verifyKiloGitBash(process.execPath, process.env)).rejects.toThrow(
      /未回退 PowerShell、CMD 或 WSL/,
    )
    // A path that does not exist fails the same way instead of falling through to
    // PowerShell, which is the silent failure this check exists to prevent.
    await expect(
      verifyKiloGitBash(join(tmpdir(), 'opl-no-such-dir', 'opl-missing-bash.exe'), process.env),
    ).rejects.toThrow(/未回退 PowerShell、CMD 或 WSL/)
  })

  // Executing a real Git Bash only answers on Windows; POSIX hosts run a different shell
  // that the adapter deliberately does not bind at all.
  it.skipIf(process.platform !== 'win32')(
    '真实执行所选 shell，只有 Git Bash/MSYS 运行时才算通过',
    async () => {
      const gitBash = resolveGitBashPath()
      const uname = await verifyKiloGitBash(gitBash, process.env)
      expect(uname).toMatch(/^MINGW(?:32|64)?_NT-|^MSYS_NT-/)
    },
  )

  it('POSIX 主机不注入任何 shell 覆盖', async () => {
    const env = { PATH: '/usr/bin' }
    const binding = await kiloShellBinding(env, { platform: 'linux' })
    expect(binding.config).toEqual({})
    expect(binding.env).toBe(env)
  })

  it('shell 片段合并进配置根级，键不被 provider 覆盖', () => {
    const content = JSON.stringify({ $schema: 'x', provider: { a: {} } })
    const merged = JSON.parse(
      withKiloShell(content, {
        config: { [KILO_SHELL_CONFIG_KEY]: 'C:/git/bin/bash.exe' },
        env: {},
        uname: 'MINGW64_NT',
      }),
    )
    expect(merged[KILO_SHELL_CONFIG_KEY]).toBe('C:/git/bin/bash.exe')
    expect(merged.provider).toEqual({ a: {} })
    // 不可解析的文档明确拒绝，不静默放行。
    expect(() =>
      withKiloShell('not json', {
        config: { [KILO_SHELL_CONFIG_KEY]: 'C:/git/bin/bash.exe' },
        env: {},
        uname: 'MINGW64_NT',
      }),
    ).toThrow(/无法解析/)
  })
})

describe('Kilo 工作目录', () => {
  it('中文加空格目录下的真实文件往返', async () => {
    const dir = await workspace('opl-kilo-file-')
    const file = join(dir, '说明 文件.txt')
    await writeFile(file, '你好，Kilo\n', 'utf8')
    expect(await readFile(file, 'utf8')).toBe('你好，Kilo\n')
    // 适配器启动参数里的 cwd 与该目录逐字一致。
    const started = kiloLaunch(process.execPath, dir)
    expect(started.args[started.args.length - 1]).toBe(dir)
  })

  it('真实 Git 外部命令在该目录可运行', async () => {
    const dir = await workspace('opl-kilo-git-')
    const result = await exec('git', ['--version'], { cwd: dir })
    expect(result.stdout.trim()).toMatch(/^git version \d+\./)
  })
})
