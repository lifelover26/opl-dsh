import { describe, expect, it } from 'vitest'
import { HarnessConfigurationError } from '../../../src/execution/host/acp.ts'
import {
  kimiCodeAdapter,
  kimiConfigOption,
} from '../../../src/execution/host/adapters/kimi/kimi.ts'
import {
  KIMI_ENV_MODEL_ALIAS,
  KIMI_HARNESS,
  KIMI_PROVIDER,
  kimiProviderType,
} from '../../../src/execution/host/adapters/kimi/kimi-models.ts'
import type {
  AcpRequestSurface,
  AcpSessionSnapshot,
} from '../../../src/execution/host/adapters/types.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import { kimiRecord } from './fixtures/records.ts'

/**
 * A protocol double for the official ACP agent's config options, transcribed from the
 * 2.1.1 behaviour: the `model` select carries the environment alias when a route is
 * supplied, `thinking` is a boolean select, and `mode` carries the four official ids.
 */
class FakeAgent implements AcpRequestSurface {
  readonly writes: { configId: string; value: string }[] = []
  /** Make the agent report a different value than it stored. */
  drift: { configId: string; value: string } | undefined
  /** Values the agent is willing to offer for `model`. */
  readonly offered = [KIMI_ENV_MODEL_ALIAS]
  private current = { model: KIMI_ENV_MODEL_ALIAS, thinking: 'on', mode: 'default' }
  currentAdvertisement: Record<string, any>[] = []

  constructor(readonly sessionId = 'sess-1') {}

  private advertise(): unknown {
    return [
      {
        type: 'select',
        id: 'model',
        category: 'model',
        currentValue: this.current.model,
        options: this.offered.map((value) => ({ value, name: value })),
      },
      {
        type: 'select',
        id: 'thinking',
        category: 'thought_level',
        currentValue: this.current.thinking,
        options: ['off', 'on'].map((value) => ({ value, name: `Thinking ${value}` })),
      },
      {
        type: 'select',
        id: 'mode',
        category: 'mode',
        currentValue: this.current.mode,
        options: ['default', 'plan', 'auto', 'yolo'].map((value) => ({ value, name: value })),
      },
    ]
  }

  snapshot(overrides: Partial<AcpSessionSnapshot> = {}): AcpSessionSnapshot {
    return {
      agent: { agentInfo: { name: 'Kimi Code CLI', version: '2.1.1' } },
      session: { sessionId: this.sessionId },
      configOptions: this.advertise(),
      ...overrides,
    } as AcpSessionSnapshot
  }

  async request(method: string, params: object): Promise<unknown> {
    if (method !== 'session/set_config_option') throw new Error(`unexpected ${method}`)
    const { configId, value } = params as { configId: string; value: string }
    this.writes.push({ configId, value })
    const allowed: Record<string, readonly string[]> = {
      model: this.offered,
      thinking: ['off', 'on'],
      mode: ['default', 'plan', 'auto', 'yolo'],
    }
    if (!allowed[configId]?.includes(value))
      throw Object.assign(new Error('fake: rejected'), { code: -32602 })
    this.current[configId as 'model' | 'thinking' | 'mode'] = value
    const advertisement = this.advertise() as Record<string, any>[]
    this.currentAdvertisement = advertisement
    if (this.drift) {
      const target = advertisement.find((o) => o.id === this.drift!.configId)
      if (target) target.currentValue = this.drift.value
    }
    return { configOptions: advertisement }
  }
}

const record = (extra: Partial<HarnessSession> = {}): HarnessSession =>
  kimiRecord(
    { provider: KIMI_PROVIDER, model: 'moonshotai/kimi-k3' },
    { sandbox: 'read-only', ...extra },
  )

describe('Kimi Code route identity', () => {
  it('maps the pinned protocol to the official provider type', () => {
    expect(kimiProviderType('messages')).toBe('anthropic')
    expect(kimiProviderType('chat')).toBe('openai')
    // The official env overlay cannot express `responses`; refuse rather than pass it on.
    expect(kimiProviderType('responses')).toBeUndefined()
  })

  it('advertises the surfaces the real binary was measured to provide', () => {
    expect(kimiCodeAdapter.capabilities.authentication).toBe('api-source')
    expect(kimiCodeAdapter.capabilities.customEndpoint).toBe(true)
    expect(kimiCodeAdapter.capabilities.protocols).toEqual(['messages', 'chat'])
    expect(kimiCodeAdapter.capabilities.permissions).toEqual(['read-only', 'full-access'])
    expect(kimiCodeAdapter.capabilities.autoReview).toBe('unsupported')
  })

  it('serves exactly the pinned Kimi models and nothing else from that provider', () => {
    for (const model of ['moonshotai/kimi-k2.6', 'moonshotai/kimi-k3', 'moonshotai/kimi-k3.1-pro'])
      expect(kimiCodeAdapter.matches({ provider: KIMI_PROVIDER, model })).toBe(true)
    // Other models published by the same owner belong to other harnesses.
    for (const model of [
      'z-ai/glm-5.3',
      'openai/gpt-oss-120b',
      'kimi-for-coding',
      'moonshotai/kimi-k4',
      'anything',
    ])
      expect(kimiCodeAdapter.matches({ provider: KIMI_PROVIDER, model })).toBe(false)
    // And another owner never reaches this harness.
    expect(
      kimiCodeAdapter.matches({ provider: 'other-provider', model: 'moonshotai/kimi-k3' }),
    ).toBe(false)
  })
})

describe('Kimi Code session pinning', () => {
  it('pins the environment alias and the permission mode, then reads both back', async () => {
    const agent = new FakeAgent()
    const result = await kimiCodeAdapter.configureSession!(agent, record(), agent.snapshot())
    expect(agent.writes).toEqual([
      { configId: 'model', value: KIMI_ENV_MODEL_ALIAS },
      { configId: 'mode', value: 'plan' },
    ])
    expect(kimiConfigOption(result!.configOptions, 'model')?.currentValue).toBe(
      KIMI_ENV_MODEL_ALIAS,
    )
    expect(kimiConfigOption(result!.configOptions, 'mode')?.currentValue).toBe('plan')
  })

  it('writes no thinking value when the caller expressed no choice', async () => {
    const agent = new FakeAgent()
    await kimiCodeAdapter.configureSession!(agent, record(), agent.snapshot())
    expect(agent.writes.some((w) => w.configId === 'thinking')).toBe(false)
  })

  it('pins an advertised thinking value exactly', async () => {
    const agent = new FakeAgent()
    // The agent starts at 'on', so asking for 'off' is a real change that must be written.
    await kimiCodeAdapter.configureSession!(
      agent,
      record({ reasoningEffort: 'off' }),
      agent.snapshot(),
    )
    expect(agent.writes).toContainEqual({ configId: 'thinking', value: 'off' })
    expect(kimiConfigOption(agent.currentAdvertisement, 'thinking')?.currentValue).toBe('off')
  })

  it('does not rewrite a thinking value the agent already reports', async () => {
    const agent = new FakeAgent()
    await kimiCodeAdapter.configureSession!(
      agent,
      record({ reasoningEffort: 'on' }),
      agent.snapshot(),
    )
    expect(agent.writes.some((w) => w.configId === 'thinking')).toBe(false)
  })

  it('never ports a max tier onto a model that never advertised one', async () => {
    const agent = new FakeAgent()
    await expect(
      kimiCodeAdapter.configureSession!(
        agent,
        record({ reasoningEffort: 'max' }),
        agent.snapshot(),
      ),
    ).rejects.toThrow(/thinking 不含所需取值 max/)
  })

  it('refuses a model the running agent does not advertise', async () => {
    const agent = new FakeAgent()
    agent.offered.splice(0, 1, 'some-other-alias')
    await expect(
      kimiCodeAdapter.configureSession!(agent, record(), agent.snapshot()),
    ).rejects.toThrow(/不含所需取值/)
  })

  it('fails closed when the agent rejects the write, without echoing agent text', async () => {
    const agent = new FakeAgent()
    agent.request = async () => {
      throw new Error('transport error carrying <account-token>')
    }
    await expect(
      kimiCodeAdapter.configureSession!(agent, record(), agent.snapshot()),
    ).rejects.toThrow(/拒绝设置 model=/)
    await expect(
      kimiCodeAdapter.configureSession!(agent, record(), agent.snapshot()),
    ).rejects.not.toThrow(/account-token/)
  })

  it('refuses an agent older than the ACP surface it pins', async () => {
    const agent = new FakeAgent()
    await expect(
      kimiCodeAdapter.configureSession!(
        agent,
        record(),
        agent.snapshot({ agent: { agentInfo: { name: 'Kimi Code CLI', version: '1.42.0' } } }),
      ),
    ).rejects.toThrow(/低于本适配器所需的/)
  })

  it('refuses a session with no session id', async () => {
    const agent = new FakeAgent()
    await expect(
      kimiCodeAdapter.configureSession!(
        agent,
        record({ acpSessionId: '' }),
        agent.snapshot({ session: {} }),
      ),
    ).rejects.toThrow(/未返回会话 ID/)
  })
})

describe('Kimi Code drift failures', () => {
  it('rejects model drift reported in the final mode response', async () => {
    // The model write succeeds; the mode write then reports a different model. Re-checking
    // only the last-written option would let the drifted model through.
    const agent = new FakeAgent()
    let calls = 0
    const base = agent.snapshot().configOptions as Record<string, any>[]
    const drifted = base.map((option) =>
      option.id === 'model' ? { ...option, currentValue: 'other-model' } : option,
    )
    const real = agent.request.bind(agent)
    agent.request = async (method, params) => {
      const result = (await real(method, params)) as { configOptions: Record<string, any>[] }
      if (++calls === 2) return { configOptions: drifted }
      return result
    }
    await expect(
      kimiCodeAdapter.configureSession!(agent, record(), agent.snapshot()),
    ).rejects.toThrow(/model 与要求的 __kimi_env_model__ 不一致/)
  })

  it('rejects mode drift reported by the final response', async () => {
    const agent = new FakeAgent()
    agent.drift = { configId: 'mode', value: 'yolo' }
    await expect(
      kimiCodeAdapter.configureSession!(agent, record(), agent.snapshot()),
    ).rejects.toThrow(/mode 与要求的 plan 不一致/)
  })

  it('rejects a missing advertisement instead of trusting an empty snapshot', () => {
    expect(() =>
      kimiCodeAdapter.verifySession!(record(), {
        agent: { agentInfo: { name: 'Kimi Code CLI', version: '2.1.1' } },
        session: { sessionId: 's' },
        // Deliberately without `configOptions`: the snapshot type requires it, so this
        // stands for a snapshot that never carried one.
      } as unknown as AcpSessionSnapshot),
    ).toThrow(/缺少 configOptions 广告/)
  })

  it('rejects a snapshot whose advertisement carries no pinned option at all', () => {
    expect(() =>
      kimiCodeAdapter.verifySession!(record(), {
        agent: { agentInfo: { name: 'Kimi Code CLI', version: '2.1.1' } },
        session: { sessionId: 's' },
        configOptions: [],
      } as AcpSessionSnapshot),
    ).toThrow(/未广告 model/)
  })

  it('accepts a session that still reports every pinned value', () => {
    const agent = new FakeAgent()
    agent.request = async () => {
      throw new Error('unused')
    }
    const pinned = agent.snapshot()
    const config = (pinned.configOptions as Record<string, any>[]).map((option) =>
      option.id === 'mode' ? { ...option, currentValue: 'plan' } : option,
    )
    expect(() =>
      kimiCodeAdapter.verifySession!(record(), {
        ...pinned,
        configOptions: config,
      } as AcpSessionSnapshot),
    ).not.toThrow()
  })

  it('rejects thinking drift before a prompt is sent', () => {
    const agent = new FakeAgent()
    // Mode and model already agree; only thinking differs.
    const base = agent.snapshot()
    const config = (base.configOptions as Record<string, any>[]).map((option) => {
      if (option.id === 'mode') return { ...option, currentValue: 'plan' }
      if (option.id === 'thinking') return { ...option, currentValue: 'on' }
      return option
    })
    expect(() =>
      kimiCodeAdapter.verifySession!(record({ reasoningEffort: 'off' }), {
        ...base,
        configOptions: config,
      } as AcpSessionSnapshot),
    ).toThrow(/thinking 与要求的 off 不一致/)
  })
})

describe('Kimi Code failure types', () => {
  it('raises the harness configuration error the host turns into a refusal', async () => {
    const agent = new FakeAgent()
    const error = await kimiCodeAdapter.configureSession!(
      agent,
      record({ sandbox: 'workspace' }),
      agent.snapshot(),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(HarnessConfigurationError)
    expect(error.message).toContain('未提供可验证的工作区写入隔离')
  })

  it('keeps the harness id stable for registry wiring', () => {
    expect(kimiCodeAdapter.id).toBe(KIMI_HARNESS)
    expect(kimiCodeAdapter.transport).toBe('acp')
  })
})
