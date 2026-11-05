import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { AgentModel, agentEvents, assembleContextFor, modelSelectionProjectionDefinition, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const projection = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = ctx.sessions.create(SessionId('role-model'))
  const options: Agent['options'] = { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }
  const model: Agent['model'] = new AgentModel(projection.readerFor(session), session, options)
  const agent = { ctx, session, model, options } as Agent
  ctx.systemPrompt.variable('provider', context => context.modelSelection?.provider)
  ctx.systemPrompt.variable('model', context => context.modelSelection?.model)
  // The driver captures current() before assembly and retains that selection across retries.
  const prepare = () => {
    const selection = Object.freeze({ ...model.current()! })
    const signal = new AbortController().signal
    return {
      assemble: () => ctx.systemPrompt.assemble({ ...assembleContextFor(agent, signal), modelSelection: selection }),
      request: () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal }, async () => selection),
    }
  }
  const record = (selection: ModelSelection) => session.append('request/header', { header: { config: selection }, reason: 'initial' })
  return { ctx, agent, options, projection, resolve, flush, prepare, record }
}
it('keeps prompt variables and initial routing on the role model without saving the host default', async () => {
  const { ctx, agent, options, projection, prepare, record, flush } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  const step = prepare()
  expect((await step.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  const selected = await step.request()
  expect(selected).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(projection.stateOf(agent.session).pending).toEqual(selected)
  expect(options).toEqual({ provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') })
  expect(flush).toHaveBeenCalledOnce()
  record(selected)
  expect(projection.stateOf(agent.session)).toEqual({ pending: null, lastUsed: selected })
  expect(await step.request()).toEqual(selected)
  const next = prepare()
  await next.assemble()
  expect(await next.request()).toEqual(selected)
})
it('lets a later explicit selection win without changing the in-flight assembled step', async () => {
  const { ctx, agent, projection, prepare, record } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  const step = prepare()
  await step.assemble()
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  agent.model.select(manual)
  const selected = await step.request()
  expect(selected).toEqual({ provider: 'worker', model: 'one' })
  record(selected)
  expect(projection.stateOf(agent.session).pending).toEqual(manual)
  const next = prepare()
  expect((await next.assemble()).variables).toMatchObject({ provider: manual.provider, model: manual.model })
  expect(await next.request()).toEqual(manual)
})
it('retains the prepared selection when a manual choice arrives before assembly', async () => {
  const { ctx, agent, prepare } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  const step = prepare()
  agent.model.select({ provider: 'manual', model: 'two' })
  expect((await step.assemble()).variables).toMatchObject({ provider: 'worker', model: 'one' })
  expect(await step.request()).toEqual({ provider: 'worker', model: 'one' })
  const next = prepare()
  expect((await next.assemble()).variables).toMatchObject({ provider: 'manual', model: 'two' })
  expect(await next.request()).toEqual({ provider: 'manual', model: 'two' })
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve, prepare } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.model.select(existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
  const step = prepare()
  expect((await step.assemble()).variables).toMatchObject(existing)
  expect(await step.request()).toEqual(existing)
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, prepare } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  const step = prepare()
  await step.assemble()
  expect(await step.request()).toEqual({ provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})
