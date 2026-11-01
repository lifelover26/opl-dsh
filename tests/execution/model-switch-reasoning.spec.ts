import { harnessAdapters } from '../../src/execution/host/adapters/index.ts'
import * as harnessRegistry from '../../src/execution/host/harness-registry.ts'
import { beforeEach } from 'vitest'
/** Exercise the model picker through its Host entry point and the official Session selection log. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { HarnessService } from '../../src/execution/host/harness.ts'
import { adapterFor } from '../../src/execution/host/adapters/index.ts'
import { testPeerConnection } from '../test-peer.ts'

const provider = 'minimax-official'
const flash = 'MiniMax-M3.1-Flash'
const m3 = 'MiniMax-M3'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.restoreAllMocks()
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'opl-model-switch-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const session = Session.create(SessionId('session-model-switch'), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('session-model-switch'),
    createdAt: Date.now(),
    isSeeded: false,
    cwd: root,
  })
  const models = [
    {
      id: flash,
      name: flash,
      reasoning: {
        defaultEffort: 'max',
        efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({
          id,
          name: id,
        })),
      },
    },
    {
      id: m3,
      name: m3,
      reasoning: { defaultEffort: 'on', efforts: ['on', 'off'].map((id) => ({ id, name: id })) },
    },
    { id: 'plain', name: 'No reasoning' },
    {
      id: 'optional',
      name: 'Provider default',
      reasoning: { efforts: [{ id: 'high', name: 'High' }] },
    },
  ]
  const groups: ModelCatalog['groups'] = [
    { id: provider, name: 'MiniMax', models: models.slice(0, 2) },
    { id: 'other-channel', name: 'Other channel', models: [models[0]!, ...models.slice(2)] },
  ]
  const defaultSelection = { provider, model: flash, reasoningEffort: 'max' }
  const current = () =>
    session.snapshotEvents().findLast((event) => event.type === 'model/selection')
  // The official controller validates and normalizes the model-specific catalogue
  // before logging a selection. This fixture models that wire boundary only;
  // the Host picker, exact-model lookup and Session log are real.
  const select = vi.fn(async (request: ModelSelection) => {
    const info = groups
      .find((group) => group.id === request.provider)
      ?.models.find((model) => model.id === request.model)
    if (!info) throw Error('Unknown model')
    if (
      request.reasoningEffort !== undefined &&
      !info.reasoning?.efforts.some((e) => e.id === request.reasoningEffort)
    )
      throw Error('Unsupported reasoning effort')
    const effort = request.reasoningEffort ?? info.reasoning?.defaultEffort
    const selected = {
      provider: request.provider,
      model: request.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
    session.append('model/selection', selected)
    return { selected }
  })
  const ctx = {
    connection: testPeerConnection,
    get: () => undefined,
    agents: { get: () => undefined },
    sessions: { get: () => session },
    llm: {
      listProviders: () => groups.map((g) => ({ id: g.id, name: g.name })),
      listConfigurableProviders: () => [],
      listModels: async (id: string) => groups.find((g) => g.id === id)!.models,
    },
    sessionProjections: {
      snapshot: () => {
        const event = current()
        return {
          values: {
            modelSelection: {
              next: event?.type === 'model/selection' ? event.data : null,
              lastUsed: null,
            },
          },
        }
      },
    },
    typertGateway: {
      invoke: async ({ method, args }: { method: string; args?: { request: ModelSelection } }) => {
        if (method === 'modelCatalog') return { default: defaultSelection, groups }
        if (method === 'selectModel') return select(args!.request)
        throw Error('Unexpected method: ' + method)
      },
    },
  } as unknown as Context
  vi.spyOn(adapterFor('minimax-code', { provider, model: flash })!, 'available').mockResolvedValue({
    available: true,
  })
  const create = async () => {
    const service = new HarnessService(ctx, { home: root })
    cleanups.push(() => service.dispose())
    // No model request or CLI is started by a picker test.
    vi.spyOn(service, 'start').mockResolvedValue({ id: 'external-child' } as never)
    return service
  }
  const service = await create()
  const catalog = await service.executionCatalog()
  for (const g of groups)
    for (const model of g.models)
      if (!catalog.combinations.some((c) => c.id === g.id + '/' + model.id))
        catalog.combinations.push({
          id: g.id + '/' + model.id,
          name: model.name,
          modelRef: { provider: g.id, model: model.id },
          harnessRef: 'dsh',
          permissionPolicy: 'workspace',
          enabled: true,
          isDefault: false,
        })
  await service.saveExecutionCatalog(catalog)
  const choose = (model: string, svc = service, channel = provider, external = true) =>
    svc.selectCombination({
      sessionId: session.id,
      combination: external ? 'minimax-code/' + model : channel + '/' + model,
    })
  return { service, session, select, choose, create, groups, ctx, root }
}

describe('per-model reasoning in the conversation picker', () => {
  it('uses the Session log before the deployment default while its projection is cold', async () => {
    const { service, session, choose, ctx } = await setup()
    await choose(flash)
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: flash,
      reasoningEffort: 'high',
    })
    await choose(m3)
    vi.spyOn(ctx.sessionProjections, 'snapshot').mockReturnValue({
      values: { modelSelection: { next: null, lastUsed: null } },
    } as never)
    await choose(flash)
    expect(
      session.snapshotEvents().findLast((e) => e.type === 'model/selection')?.data,
    ).toMatchObject({ model: flash, reasoningEffort: 'high' })
  })
  it('switches max to thinking-on and remembers each model independently', async () => {
    const { service, session, choose } = await setup()
    await choose(flash)
    await choose(m3)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      model: m3,
      reasoningEffort: 'on',
    })
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: m3,
      reasoningEffort: 'off',
    })
    await choose(flash)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      model: flash,
      reasoningEffort: 'max',
    })
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: flash,
      reasoningEffort: 'high',
    })
    await choose(m3)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      model: m3,
      reasoningEffort: 'off',
    })
    await choose(flash)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      model: flash,
      reasoningEffort: 'high',
    })
  })

  it('retains explicit default across switches and a Host service restart', async () => {
    const { service, session, choose, create } = await setup()
    await choose(flash)
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: flash,
      reasoningEffort: 'default',
    })
    await choose(m3)
    await service.dispose()
    const restored = await create()
    await choose(flash, restored)
    expect((await restored.modelSelection(session.id)).current).toMatchObject({
      model: flash,
      reasoningEffort: 'default',
    })
  })

  it('drops all reasoning on a model that has no reasoning control', async () => {
    const { service, session, select, choose } = await setup()
    await choose(m3)
    await choose('plain', service, 'other-channel', false)
    expect(select.mock.calls.at(-1)?.[0]).not.toHaveProperty('reasoningEffort')
    expect((await service.modelSelection(session.id)).current).toEqual({
      provider: 'other-channel',
      model: 'plain',
    })
    await choose(m3)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      reasoningEffort: 'on',
    })
  })

  it('keeps identical model names in different channels independent', async () => {
    const { service, session, choose } = await setup()
    await choose(flash)
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: flash,
      reasoningEffort: 'low',
    })
    await choose(flash, service, 'other-channel', false)
    expect((await service.modelSelection(session.id)).current).toEqual({
      provider: 'other-channel',
      model: flash,
      reasoningEffort: 'max',
    })
    await choose(flash)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      provider,
      reasoningEffort: 'low',
    })
  })

  it('uses the live model default when its remembered effort was retired', async () => {
    const { service, session, choose, groups } = await setup()
    await choose(flash)
    await service.invoke('select-effort', {
      sessionId: session.id,
      provider,
      model: flash,
      reasoningEffort: 'high',
    })
    await choose(m3)
    const info = groups[0]!.models[0]!.reasoning!
    const remaining = info.efforts.filter((e) => e.id !== 'high')
    ;(info as { efforts: typeof remaining }).efforts = remaining
    await choose(flash)
    expect((await service.modelSelection(session.id)).current).toMatchObject({
      reasoningEffort: 'max',
    })
  })

  it('preserves the provider-default option when no default effort is declared', async () => {
    const { service, session, select, choose } = await setup()
    await choose('optional', service, 'other-channel', false)
    expect(select.mock.calls.at(-1)?.[0]).not.toHaveProperty('reasoningEffort')
    await choose(m3)
    await choose('optional', service, 'other-channel', false)
    expect((await service.modelSelection(session.id)).current).toEqual({
      provider: 'other-channel',
      model: 'optional',
    })
  })

  it('waits for a pending model switch before admitting the next prompt', async () => {
    const { service, session, select, choose } = await setup()
    let release!: () => void
    let applied = false
    let nextCalled = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    select.mockImplementationOnce(async (request: ModelSelection) => {
      await gate
      applied = true
      session.append('model/selection', request)
      return { selected: request }
    })

    const switching = choose('plain', service, 'other-channel', false)
    await Promise.resolve()
    const prompt = Array.fromAsync(
      service.conversationStream(
        {
          sessionId: session.id,
          provider: 'other-channel',
          model: 'plain',
          messages: [
            createUserMessage({
              source: { kind: 'user' },
              content: [{ type: 'text', text: 'after-switch' }],
            }),
          ],
        } as GenerateOptions,
        async function* () {
          nextCalled = true
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      ),
    )

    await Promise.resolve()
    expect(applied).toBe(false)
    expect(nextCalled).toBe(false)
    release()
    await Promise.all([switching, prompt])
    expect(applied).toBe(true)
    expect(nextCalled).toBe(true)
  })

  it('keeps a rejected picker write blocking later sends until an explicit selection succeeds', async () => {
    const { service, session, select, choose } = await setup()
    await choose('optional', service, 'other-channel', false)
    select.mockRejectedValueOnce(Error('selection write failed'))
    await expect(choose('plain', service, 'other-channel', false)).rejects.toThrow(
      'selection write failed',
    )

    await expect(service.assertConversationEditable(session.id)).rejects.toThrow('模型切换尚未完成')
    await choose('plain', service, 'other-channel', false)
    await expect(service.assertConversationEditable(session.id)).resolves.toBeUndefined()
  })

  it('refuses options frozen for the old model while a picker write was pending', async () => {
    const { service, session, select, choose } = await setup()
    await choose('optional', service, 'other-channel', false)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    select.mockImplementationOnce(async (request: ModelSelection) => {
      await gate
      session.append('model/selection', request)
      return { selected: request }
    })
    const switching = choose('plain', service, 'other-channel', false)
    const next = vi.fn(async function* () {
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    })
    const prompt = Array.fromAsync(
      service.conversationStream(
        {
          sessionId: session.id,
          provider: 'other-channel',
          model: 'optional',
          messages: [
            createUserMessage({
              source: { kind: 'user' },
              content: [{ type: 'text', text: 'must not use old model' }],
            }),
          ],
        } as GenerateOptions,
        next,
      ),
    )
    const refused = expect(prompt).rejects.toThrow('模型选择已改变')
    await Promise.resolve()
    release()
    await Promise.all([switching, refused])
    expect(next).not.toHaveBeenCalled()
    expect(service.start).not.toHaveBeenCalled()
  })

  it('waits for a newer picker write queued while the first write is completing', async () => {
    const { service, session, select, choose } = await setup()
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    select.mockImplementationOnce(async (request: ModelSelection) => {
      await firstGate
      session.append('model/selection', request)
      return { selected: request }
    })
    select.mockImplementationOnce(async (request: ModelSelection) => {
      await secondGate
      session.append('model/selection', request)
      return { selected: request }
    })
    const first = choose('plain', service, 'other-channel', false)
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1))
    let admitted = false
    const admission = service.assertConversationEditable(session.id).then(() => {
      admitted = true
    })
    await Promise.resolve()
    const second = choose('optional', service, 'other-channel', false)
    releaseFirst()
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2))
    expect(admitted).toBe(false)
    releaseSecond()
    await Promise.all([first, second, admission])
    expect(admitted).toBe(true)
    expect((await service.modelSelection(session.id)).current.model).toBe('optional')
  })
})

describe('CLI effort selection independent of source provider', () => {
  async function fixture() {
    const f = await setup()
    const adapter = adapterFor('minimax-code', { provider, model: flash })!
    vi.spyOn(f.service as any, 'cliOwnsEffort').mockImplementation(
      (d: any) => d.harnessRef === 'minimax-code',
    )
    // The same path serves OFM Step/Pi/Pool/Kimi; source metadata deliberately lacks balanced.
    vi.spyOn(f.service, 'reasoningPreflight').mockResolvedValue({
      status: 'known',
      efforts: [{ id: 'balanced', name: 'Balanced' }],
    })
    await f.choose(flash)
    return f
  }
  it('uses the newly chosen Harness when normalizing same-model effort', async () => {
    const f = await fixture()
    await f.choose(flash, f.service, provider, false)
    await f.service.invoke('select-effort', {
      sessionId: f.session.id,
      provider,
      model: flash,
      reasoningEffort: 'high',
    })
    f.select.mockClear()
    await f.choose(flash)
    expect(f.select.mock.calls.at(-1)?.[0]).not.toHaveProperty('reasoningEffort')
    expect(await f.service.modelSelection(f.session.id)).toMatchObject({
      combination: 'minimax-code/' + flash,
      effortSource: 'harness',
    })
    expect((await f.service.modelSelection(f.session.id)).current.reasoningEffort).toBeUndefined()
  })

  it('stores advertised balanced without submitting it to the provider controller', async () => {
    const f = await fixture()
    await f.service.invoke('select-effort', {
      sessionId: f.session.id,
      provider,
      model: flash,
      reasoningEffort: 'balanced',
    })
    expect(f.select.mock.calls.at(-1)?.[0]).not.toHaveProperty('reasoningEffort')
    expect((await f.service.modelSelection(f.session.id)).current.reasoningEffort).toBe('balanced')
    expect(f.service.start).not.toHaveBeenCalled()
    await f.service.dispose()
    const restored = await f.create()
    vi.spyOn(restored as any, 'cliOwnsEffort').mockReturnValue(true)
    expect((await restored.modelSelection(f.session.id)).current.reasoningEffort).toBe('balanced')
    await restored.invoke('select-effort', { sessionId: f.session.id, provider, model: flash })
    expect((await restored.modelSelection(f.session.id)).current.reasoningEffort).toBeUndefined()
  })
  it('rejects an unadvertised choice before changing provider selection', async () => {
    const f = await fixture()
    f.select.mockClear()
    await expect(
      f.service.invoke('select-effort', {
        sessionId: f.session.id,
        provider,
        model: flash,
        reasoningEffort: 'max',
      }),
    ).rejects.toThrow('未提供')
    expect(f.select).not.toHaveBeenCalled()
  })
  it('rejects a preflight result after another combination was selected', async () => {
    const f = await fixture()
    let release!: (value: any) => void
    vi.mocked(f.service.reasoningPreflight).mockImplementation(
      () =>
        new Promise((r) => {
          release = r
        }),
    )
    const pending = f.service.invoke('select-effort', {
      sessionId: f.session.id,
      provider,
      model: flash,
      reasoningEffort: 'balanced',
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await f.choose(m3)
    release({ status: 'known', efforts: [{ id: 'balanced', name: 'Balanced' }] })
    await expect(pending).rejects.toThrow('状态已改变')
    expect((await f.service.modelSelection(f.session.id)).current.model).toBe(m3)
  })
})

// These suites exercise other harnesses; their catalog must not probe a personal ZCode install.
beforeEach(() => {
  vi.spyOn(harnessRegistry, 'inspectHarness').mockImplementation(async (definition) => ({
    id: definition.id,
    name: definition.name,
    installed: true,
    runnable: true,
    path: definition.command ?? process.execPath,
    instructions: 'fixture',
    website: 'https://example.test',
  }))
  vi.spyOn(
    harnessAdapters.find((adapter) => adapter.id === 'zcode')!,
    'available',
  ).mockResolvedValue({ available: false, reason: 'ZCode outside this fixture' })
})
