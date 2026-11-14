/**
 * Behavior evidence for the official MiMo Code (`mimo`) adaptation.
 *
 * The session tests drive the adapter's real launch vector against an executable ACP
 * fixture over a live stdio transport, and that fixture builds its model advertisement
 * from the launch configuration the adapter actually produced. Assertions therefore
 * cover wire method names, request order, advertised values, the child environment, and
 * the exact working directory — not the adapter's own constants.
 *
 * Every wait is condition-driven: a journal entry, an ACP notification, or a request
 * reply. No test sleeps for a fixed duration and then assumes an event happened.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpProcess } from '../../../src/execution/host/acp.ts'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import { resolveGitBashPath } from '../../../src/shell/host/git-bash.ts'
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
  buildMimoRouteConfig,
  MIMO_CODE_HARNESS,
  MIMO_GIT_BASH_VARIABLE,
  MIMO_OFM_MODEL,
  MIMO_OFM_PROVIDER,
  MIMO_ROUTE_PROVIDER_ID,
  MIMO_SHELL_FACTS,
  MIMO_SHELL_VARIABLE,
  mimoCodeAdapter,
  mimoCodeLaunch,
  mimoCodeModels,
  mimoModelValue,
  mimoShellEnvironment,
  mimoShellSelectionAccepts,
  withMimoAdapter,
} from '../../../src/execution/host/adapters/mimo/index.ts'

const exec = promisify(execFile)
const FIXTURE = resolve('tests/execution/ofm-mimo/mimo-acp-agent.mjs')
const MODEL_VALUE = mimoModelValue(MIMO_OFM_MODEL)
/** Never a real secret; the tests only prove where a credential can and cannot appear. */
const FAKE_KEY = 'opl-test-key-do-not-use'
const ROUTE: ExternalModelRoute = {
  baseURL: 'https://ofm.example.test/v1',
  model: MIMO_OFM_MODEL,
  apiKey: FAKE_KEY,
  protocol: 'chat',
}

const cleanups: (() => Promise<unknown>)[] = []
const removeTree = (path: string) =>
  rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function workspace(prefix: string, name = '中文 项目 dir'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opl-mimo-'))
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  cleanups.push(() => removeTree(root))
  return dir
}

/** Register a real source through the real registry, so revocation semantics are genuine. */
function sourcesWith(
  route: ExternalModelRoute = ROUTE,
  duringResolve?: (release: () => void) => void,
): { sources: ExternalModelSources; release: () => void } {
  const sources = new ExternalModelSources({} as never, () => {})
  let release = () => {}
  const source: ExternalModelSource = {
    provider: MIMO_OFM_PROVIDER,
    supports: () => true,
    resolve: async () => {
      duringResolve?.(() => release())
      return route
    },
  }
  // The fake owner's `effect` runs the callback synchronously and hands back the
  // disposer, exactly as an effect scope would.
  release = sources.register({ effect: (fn: () => unknown) => fn() } as never, source)
  return { sources, release }
}

function options(sources?: ExternalModelSources): AdapterOptions {
  return {
    home: 'C:/opl-mimo-home',
    command: process.execPath,
    ...(sources ? { modelSources: sources } : {}),
    grokCommand: 'grok',
    nativeBridgePath: 'bridge.js',
  }
}

function record(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 's1',
    combination: `${MIMO_CODE_HARNESS}/${MIMO_OFM_MODEL}`,
    harnessRef: MIMO_CODE_HARNESS,
    modelRef: mimoCodeModels()[0]!,
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
  /** Only present on the fixture's spawn record. */
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

const journalOf = async (dir: string): Promise<string> => join(dir, 'journal.jsonl')

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
  const journal = await journalOf(dir)
  const started = mimoCodeLaunch(process.execPath, dir, [FIXTURE])
  const updates: unknown[] = []
  const waiters: ((value: any) => void)[] = []
  const acp = new AcpProcess(
    started.command,
    started.args,
    dir,
    { ...process.env, PATH: process.env.PATH!, MIMO_JOURNAL: journal, ...env },
    (value) => {
      updates.push(value)
      for (const done of waiters.splice(0)) done(value)
    },
    (id, _value) => answerPermission?.(id, acp),
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
    agent: { agentInfo: { version: '9.9.9' } },
    session,
    configOptions: session.configOptions,
  }
}

const configEnv = () => ({
  MIMOCODE_CONFIG_CONTENT: buildMimoRouteConfig(ROUTE, MIMO_OFM_MODEL).content,
})

describe('MiMo Code 声明面', () => {
  it('只声明官方来源的模型配对', () => {
    expect(mimoCodeModels()).toEqual([
      { provider: MIMO_OFM_PROVIDER, model: MIMO_OFM_MODEL },
      { provider: MIMO_OFM_PROVIDER, model: 'amd/MiMo-V2.6-Flash' },
    ])
    expect(mimoCodeAdapter.matches({ provider: MIMO_OFM_PROVIDER, model: MIMO_OFM_MODEL })).toBe(
      true,
    )
    // 不适配的模型必须明确拒绝，而不是被当成同一模型的别名。
    for (const ref of [
      { provider: MIMO_OFM_PROVIDER, model: 'gpt-oss-120b' },
      { provider: MIMO_OFM_PROVIDER, model: 'jev' },
      { provider: MIMO_OFM_PROVIDER, model: 'content-safety' },
      { provider: 'other-source', model: MIMO_OFM_MODEL },
    ])
      expect(mimoCodeAdapter.matches(ref)).toBe(false)
  })

  it('能力只声明官方真正提供的接口', () => {
    const c = mimoCodeAdapter.capabilities
    expect(c.transport).toBe('acp')
    expect(c.sessionLoad).toBe(true)
    expect(c.cancel).toBe(true)
    // 没有推理配置项、没有 Auto Review 接口、没有目录限制：如实声明，不做近似。
    expect(c.reasoning).toBe('none')
    expect(c.autoReview).toBe('unsupported')
    expect(c.permissions).toEqual(['full-access'])
    expect(c.protocols).toEqual(['chat'])
    expect(c.customEndpoint).toBe(true)
    // 官方 ACP 不广告 shell，也不广告 terminal：不得据此声称已验证绑定。
    expect(MIMO_SHELL_FACTS.advertisesShell).toBe(false)
    expect(MIMO_SHELL_FACTS.advertisesTerminal).toBe(false)
  })

  it('注册工厂按 id 幂等且不修改调用方数组', () => {
    const once = withMimoAdapter([])
    const twice = withMimoAdapter(once)
    expect(once).toHaveLength(1)
    expect(twice).toHaveLength(1)
    expect(twice[0]).toBe(mimoCodeAdapter)
  })
})

describe('MiMo Code 来源解析', () => {
  it('坏协议明确拒绝，不猜端点也不换 provider', async () => {
    for (const protocol of ['responses', 'messages'] as const) {
      const { sources } = sourcesWith({ ...ROUTE, protocol })
      await expect(
        mimoCodeAdapter.prepare!({} as never, record(), options(sources)),
      ).rejects.toThrow(/协议|执行参数/)
    }
    // 同一份路由直接序列化时也必须拒绝，形成第二道防线。
    expect(() => buildMimoRouteConfig({ ...ROUTE, protocol: 'responses' }, MIMO_OFM_MODEL)).toThrow(
      /协议/,
    )
  })

  it('来源返回另一个模型时拒绝启动，不静默替换', async () => {
    // 主审负例：来源 supports 返回 true 并不代表返回的模型就是所选组合。
    const { sources } = sourcesWith({ ...ROUTE, model: 'wrong-model' })
    await expect(mimoCodeAdapter.prepare!({} as never, record(), options(sources))).rejects.toThrow(
      /与所选组合（mimo-v2.6-flash-free）不一致/,
    )
  })

  it('来源在启动前校验期间被撤销时，不返回启动配置', async () => {
    // 主审负例：共享注册表只覆盖它自己的 resolve await；启动前的 shell 探测是适配器
    // 自己的 await 点，必须再校验一次来源身份。这里用来源自身的调用计数把撤销精确
    // 放在那次复核上，避免靠时间竞态。
    const sources = new ExternalModelSources({} as never, () => {})
    let release = () => {}
    let calls = 0
    const source: ExternalModelSource = {
      provider: MIMO_OFM_PROVIDER,
      supports: () => {
        // 注册表在 resolve 前后各校验一次；第三次即启动前的末次校验。
        // 在这一次上卸载自己并如实返回 false，等价于来源在该 await 期间消失。
        if (++calls === 3) {
          release()
          return false
        }
        return true
      },
      resolve: async () => ROUTE,
    }
    release = sources.register({ effect: (fn: () => unknown) => fn() } as never, source)
    await expect(mimoCodeAdapter.prepare!({} as never, record(), options(sources))).rejects.toThrow(
      /模型来源已变更/,
    )
  })

  it('来源在解析期间被撤销时拒绝启动', async () => {
    // 真实注册表在异步读取后重新核对来源身份，因此晚到的撤销必须让启动失败。
    const { sources } = sourcesWith(ROUTE, (release) => release())
    await expect(mimoCodeAdapter.prepare!({} as never, record(), options(sources))).rejects.toThrow(
      /模型来源已变更/,
    )
  })

  it('把来源解析结果原样写入官方配置，不改写端点或模型', async () => {
    const { sources } = sourcesWith()
    const launch = await mimoCodeAdapter.prepare!({} as never, record(), options(sources))
    const config = JSON.parse(launch.env.MIMOCODE_CONFIG_CONTENT!)
    const provider = config.provider[MIMO_ROUTE_PROVIDER_ID]
    expect(config.model).toBe(MODEL_VALUE)
    expect(provider.npm).toBe('@ai-sdk/openai-compatible')
    expect(provider.only_configured_models).toBe(true)
    expect(provider.options.baseURL).toBe(ROUTE.baseURL)
    expect(provider.options.apiKey).toBe(FAKE_KEY)
    expect(Object.keys(provider.models)).toEqual([ROUTE.model])
  })

  it('凭据与端点不出现在任何错误信息中', async () => {
    const { sources } = sourcesWith({ ...ROUTE, protocol: 'messages' })
    const error = await mimoCodeAdapter.prepare!({} as never, record(), options(sources)).catch(
      (cause: unknown) => cause as Error,
    )
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(FAKE_KEY)
    expect(String(error)).not.toContain(ROUTE.baseURL)
    // 序列化后的配置确实带有凭据，因此“不出现”来自错误信息本身，而不是配置为空。
    expect(buildMimoRouteConfig(ROUTE, MIMO_OFM_MODEL).content).toContain(FAKE_KEY)
  })
})

describe('MiMo Code 启动前置条件', () => {
  it('受限权限拒绝启动，且不声称工作目录隔离', async () => {
    const { sources } = sourcesWith()
    for (const sandbox of ['read-only', 'workspace'] as const)
      await expect(
        mimoCodeAdapter.prepare!({} as never, record({ sandbox }), options(sources)),
      ).rejects.toThrow(/full-access/)
  })

  it('所选推理档位不被官方广告时明确拒绝，不静默忽略', async () => {
    const { sources } = sourcesWith()
    await expect(
      mimoCodeAdapter.prepare!({} as never, record({ reasoningEffort: 'max' }), options(sources)),
    ).rejects.toThrow(/未广告推理档位/)
  })

  it('缺少模型来源时明确拒绝', async () => {
    await expect(
      mimoCodeAdapter.prepare!({} as never, record(), options(undefined)),
    ).rejects.toThrow(/尚未适配此 Harness/)
  })
})

describe('MiMo Code Windows Shell', () => {
  it('错误的 shell 路径明确失败，不回退 PowerShell 或 CMD', async () => {
    for (const bad of [
      'C:/Windows/System32/cmd.exe',
      'C:/Program Files/PowerShell/7/pwsh.exe',
      'bash',
    ])
      await expect(
        mimoShellEnvironment({}, { platform: 'win32', resolve: () => bad }),
      ).rejects.toThrow(/Git Bash/)
  })

  it('无法执行的 shell 路径失败，且不注入任何变量', async () => {
    await expect(
      mimoShellEnvironment({}, { platform: 'win32', resolve: () => 'C:/missing/git/bin/bash.exe' }),
    ).rejects.toThrow(/Git Bash/)
  })

  it('SHELL 与官方 flag 变量只接受 MiMo 会直接采用的可执行路径', () => {
    // 官方 `select()` 只在 SHELL 非空且指向它会直接采用的 bash 时才跳过 PowerShell 回退。
    for (const candidate of ['bash', 'bash.exe', 'C:/Windows/System32/cmd.exe'])
      expect(mimoShellSelectionAccepts(candidate, 'win32')).toBe(false)
    // 同一个 `/` 根拼写在 posix 与 win32 规则下都是绝对路径，因此这里检验的是可执行文件名
    // 规则本身，而不是宿主对“绝对路径”的理解——`path.isAbsolute` 取自运行平台而非注入的
    // 那个平台，所以 `C:/…` 夹具在 Linux 上会因为一个无关的原因被拒。
    expect(mimoShellSelectionAccepts('/opt/opl-test/Git/bin/cmd.exe', 'win32')).toBe(false)
    expect(mimoShellSelectionAccepts('/opt/opl-test/Git/bin/bash.exe', 'win32')).toBe(true)
  })

  // 只有真正解析并执行一个 Git Bash 才回答得了的问题，限定在 Windows。
  it.skipIf(process.platform !== 'win32')(
    'SHELL 与官方 flag 变量指向同一个可执行的 Git Bash',
    async () => {
      const shell = resolveGitBashPath()
      const env = await mimoShellEnvironment(
        { PATH: process.env.PATH! },
        {
          platform: 'win32',
          resolve: () => shell,
        },
      )
      expect(env[MIMO_SHELL_VARIABLE]).toBe(shell)
      expect(env[MIMO_GIT_BASH_VARIABLE]).toBe(shell)
      expect(mimoShellSelectionAccepts(shell, 'win32')).toBe(true)
    },
  )

  it.skipIf(process.platform !== 'win32')('在中文加空格的目录里执行真实 git 外部命令', async () => {
    const dir = await workspace('opl-mimo-git-')
    await exec(resolveGitBashPath(), ['--noprofile', '--norc', '-c', 'git init -q'], { cwd: dir })
    const env = await mimoShellEnvironment({ PATH: process.env.PATH! }, { platform: 'win32' })
    const { stdout } = await exec(
      env[MIMO_SHELL_VARIABLE]!,
      [
        '--noprofile',
        '--norc',
        '-c',
        'git rev-parse --is-inside-work-tree && git status --porcelain',
      ],
      { cwd: dir, env: env as NodeJS.ProcessEnv },
    )
    expect(stdout).toContain('true')
  })
})

describe('MiMo Code 会话与模型固定', () => {
  it('在中文加空格的工作目录启动，且目录原样送达官方 CLI', async () => {
    const dir = await workspace('opl-mimo-cwd-')
    const { acp, journal } = await agent(dir, configEnv())
    await acp.request('initialize', { protocolVersion: 1 })
    const spawn = await until(journal, (entry) => entry.event === 'spawn')
    // 官方命令是 `mimo acp --cwd <目录>`；目录必须逐字送达，不能被截断或改写。
    expect(spawn.argv).toEqual(['acp', '--cwd', dir])
    await openSession(acp, 'session/new', dir)
    const created = await until(journal, (entry) => entry.method === 'session/new')
    expect(created.params!.cwd).toBe(dir)
  })

  it('新建会话后固定来源解析出的确切模型，并回读确认', async () => {
    const dir = await workspace('opl-mimo-pin-')
    const { acp, journal } = await agent(dir, { ...configEnv(), MIMO_FAKE_VERSION: '2.4.1' })
    const agentInfo = await initialize(acp)
    const snapshot = await openSession(acp, 'session/new', dir)
    const result = await mimoCodeAdapter.configureSession!(
      acp as unknown as AcpRequestSurface,
      record(),
      { agent: agentInfo.agent, session: snapshot.session, configOptions: snapshot.configOptions },
    )
    // 官方回读的广告里，model 取值必须等于来源解析出的那个值。
    const modelOption = (result!.configOptions as any[]).find((option) => option.id === 'model')
    expect(modelOption.currentValue).toBe(MODEL_VALUE)
    expect(modelOption.options.map((option: any) => option.value)).toEqual([MODEL_VALUE])
    const written = await until(journal, (entry) => entry.method === 'session/set_config_option')
    expect(written.params).toEqual({
      sessionId: snapshot.session.sessionId,
      configId: 'model',
      value: MODEL_VALUE,
    })
    // 版本号进入失败信息，便于用户定位。
    expect(() =>
      mimoCodeAdapter.verifySession!(record(), {
        agent: agentInfo.agent,
        session: snapshot.session,
        configOptions: [
          { id: 'model', currentValue: 'other/model', options: [{ value: 'other/model' }] },
        ],
      }),
    ).toThrow(/mimo 2\.4\.1/)
  })

  it('会话漂移到其他模型时失败，不沿用旧值继续执行', async () => {
    const dir = await workspace('opl-mimo-drift-')
    // 官方接受写入却报告另一个模型：回读必须发现，不能默认成功。
    const { acp } = await agent(dir, { ...configEnv(), MIMO_DRIFT_AFTER_SET: '1' })
    const agentInfo = await initialize(acp)
    const snapshot = await openSession(acp, 'session/new', dir)
    await expect(
      mimoCodeAdapter.configureSession!(acp as unknown as AcpRequestSurface, record(), {
        agent: agentInfo.agent,
        session: snapshot.session,
        configOptions: snapshot.configOptions,
      }),
    ).rejects.toThrow(/不一致/)
  })

  it('官方未广告本套件模型时拒绝，不挑选任何其他模型', async () => {
    const dir = await workspace('opl-mimo-absent-')
    const { acp } = await agent(dir, configEnv())
    const agentInfo = await initialize(acp)
    const snapshot = await openSession(acp, 'session/new', dir)
    const foreign = [
      { id: 'model', currentValue: 'someone/else', options: [{ value: 'someone/else' }] },
    ]
    await expect(
      mimoCodeAdapter.configureSession!(acp as unknown as AcpRequestSurface, record(), {
        agent: agentInfo.agent,
        session: snapshot.session,
        configOptions: foreign,
      }),
    ).rejects.toThrow(/未广告要求的模型/)
  })

  it('官方拒绝配置写入时失败，且不回显官方错误文本', async () => {
    const dir = await workspace('opl-mimo-reject-')
    const { acp } = await agent(dir, { ...configEnv(), MIMO_REJECT_SET: '1' })
    const agentInfo = await initialize(acp)
    const snapshot = await openSession(acp, 'session/new', dir)
    await expect(
      mimoCodeAdapter.configureSession!(acp as unknown as AcpRequestSurface, record(), {
        agent: agentInfo.agent,
        session: snapshot.session,
        configOptions: snapshot.configOptions,
      }),
    ).rejects.toThrow(/官方 CLI 未接受该配置/)
  })

  it('恢复会话保留会话身份，并在恢复后重新固定模型', async () => {
    const dir = await workspace('opl-mimo-load-')
    const { acp, journal } = await agent(dir, configEnv())
    const agentInfo = await initialize(acp)
    const created = await openSession(acp, 'session/new', dir)
    const loaded = await openSession(acp, 'session/load', dir, created.session.sessionId)
    const request = await until(journal, (entry) => entry.method === 'session/load')
    expect(request.params!.sessionId).toBe(created.session.sessionId)
    expect(loaded.session.sessionId).not.toBe(created.session.sessionId)
    await mimoCodeAdapter.configureSession!(
      acp as unknown as AcpRequestSurface,
      record({ acpSessionId: created.session.sessionId }),
      { agent: agentInfo.agent, session: loaded.session, configOptions: loaded.configOptions },
    )
    const writes = (await readFile(journal, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry)
      .filter((entry) => entry.method === 'session/set_config_option')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.params!.sessionId).toBe(loaded.session.sessionId)
  })

  it('每轮发送前按 record 的精确模型复核，额外广告不影响目标', async () => {
    const dir = await workspace('opl-mimo-verify-')
    const { acp } = await agent(dir, configEnv())
    const agentInfo = await initialize(acp)
    const snapshot = await openSession(acp, 'session/new', dir)
    const base = { agent: agentInfo.agent, session: snapshot.session }
    mimoCodeAdapter.verifySession!(record(), { ...base, configOptions: snapshot.configOptions })
    // 广告里多出别的取值时，目标仍由 record 决定，不因“唯一”而改变。
    expect(() =>
      mimoCodeAdapter.verifySession!(record(), {
        ...base,
        configOptions: [
          {
            id: 'model',
            currentValue: MODEL_VALUE,
            options: [{ value: MODEL_VALUE }, { value: `${MIMO_ROUTE_PROVIDER_ID}/other` }],
          },
        ],
      }),
    ).not.toThrow()
  })

  it('只广告唯一但错误的模型时，写入前即拒绝且不发生任何写入', async () => {
    // 主审负例：广告唯一不等于正确。目标必须来自 record，而不是来自广告。
    let writes = 0
    const wrong = [
      {
        id: 'model',
        currentValue: 'oplmimo/wrong-model',
        options: [{ value: 'oplmimo/wrong-model' }],
      },
    ]
    await expect(
      mimoCodeAdapter.configureSession!(
        {
          request: async () => {
            writes++
            return { configOptions: wrong }
          },
        },
        record(),
        {
          agent: { agentInfo: { version: '1.0.0' } },
          session: { sessionId: 'chief-session' },
          configOptions: wrong,
        },
      ),
    ).rejects.toThrow(/未广告要求的模型/)
    expect(writes).toBe(0)
  })

  it('发送前复核对一致但错误的模型同样拒绝', () => {
    const wrong = [
      {
        id: 'model',
        currentValue: 'oplmimo/wrong-model',
        options: [{ value: 'oplmimo/wrong-model' }],
      },
    ]
    expect(() =>
      mimoCodeAdapter.verifySession!(record(), {
        agent: { agentInfo: { version: '1.0.0' } },
        session: { sessionId: 'chief-session' },
        configOptions: wrong,
      }),
    ).toThrow(/未广告要求的模型/)
  })

  it('非本适配声明的模型一律拒绝', async () => {
    const snapshot: AcpSessionSnapshot = {
      agent: { agentInfo: { version: '1.0.0' } },
      session: { sessionId: 'x' },
      configOptions: snapshotOptions(MODEL_VALUE),
    }
    const foreign = record({ modelRef: { provider: MIMO_OFM_PROVIDER, model: 'jev' } })
    await expect(
      mimoCodeAdapter.configureSession!({ request: async () => ({}) }, foreign, snapshot),
    ).rejects.toThrow(/不属于本适配声明/)
    expect(() => mimoCodeAdapter.verifySession!(foreign, snapshot)).toThrow(/不属于本适配声明/)
  })
})

describe('MiMo Code 轮次、取消与审批', () => {
  it('取消回执由原 prompt 确认，不靠等待超时判定', async () => {
    const dir = await workspace('opl-mimo-cancel-')
    const { acp, journal, waitUpdate } = await agent(dir, { ...configEnv(), MIMO_HOLD: '1' })
    const agentInfo = await initialize(acp)
    const snapshot = await openSession(acp, 'session/new', dir)
    await mimoCodeAdapter.configureSession!(acp as unknown as AcpRequestSurface, record(), {
      agent: agentInfo.agent,
      session: snapshot.session,
      configOptions: snapshot.configOptions,
    })
    const sessionId = snapshot.session.sessionId as string
    const pending = acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })
    // 事件驱动：等到真实分块到达后才发出取消。
    await waitUpdate((value: any) => value?.update?.sessionUpdate === 'agent_message_chunk')
    acp.cancel(sessionId)
    const result = (await pending) as Record<string, any>
    expect(result.stopReason).toBe('cancelled')
    const cancel = await until(journal, (entry) => entry.method === 'session/cancel')
    expect(cancel.params!.sessionId).toBe(sessionId)
    // 进程可重复清理，且不会留下未决请求。
    await acp.dispose()
    await acp.dispose()
  })

  it('人工审批拒绝后不重试也不回退', async () => {
    const dir = await workspace('opl-mimo-approve-')
    const asked: unknown[] = []
    const { acp, journal } = await agent(
      dir,
      { ...configEnv(), MIMO_ASK_PERMISSION: '1' },
      (id, process) => {
        // 真实的人工拒绝决定，不是测试替身直接跳过审批。
        asked.push(id)
        process.answer(id, 'reject')
      },
    )
    await initialize(acp)
    const snapshot = await openSession(acp, 'session/new', dir)
    const sessionId = snapshot.session.sessionId as string
    const pending = acp.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    })
    const result = (await pending) as Record<string, any>
    expect(result.stopReason).toBe('refusal')
    expect(asked).toHaveLength(1)
    await until(journal, (entry) => entry.event === 'permission.settled')
    // 只发生一次审批、一次提示：拒绝后没有任何重试或替代路径。
    const text = await readFile(journal, 'utf8')
    expect(text.match(/permission\.requested/g)).toHaveLength(1)
    expect(text.match(/session\/prompt/g)).toHaveLength(1)
  })

  it('中文加空格目录下的真实文件读写往返', async () => {
    const dir = await workspace('opl-mimo-file-')
    const file = join(dir, '说明 文件.txt')
    await writeFile(file, '你好，MiMo\n', 'utf8')
    const content = await readFile(file, 'utf8')
    expect(content).toBe('你好，MiMo\n')
  })
})

const snapshotOptions = (value: string) => [
  { id: 'model', currentValue: value, options: [{ value }] },
]
