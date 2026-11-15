/** Test-only plugin lifecycle checks through the official plugin manager. */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
export const inject = ['pluginManager', 'llm', 'credentials', 'subagents', 'sessionController']
export function apply(ctx, config) {
  let closed = false
  ctx.effect(() => {
    const timer = setTimeout(
      () =>
        void run().catch(async (error) => {
          await writeFile(
            config.output,
            JSON.stringify({ status: 'failed', phase: config.phase, failure: error.message }) +
              '\n',
            { mode: 0o600 },
          )
        }),
      1200,
    )
    return () => {
      closed = true
      clearTimeout(timer)
    }
  })
  async function waitFor(read, reason, timeout = 90000) {
    const until = Date.now() + timeout
    while (!closed && Date.now() < until) {
      const value = await read()
      if (value) return value
      await delay(200)
    }
    throw Error(reason)
  }
  async function enabled(name, value) {
    await ctx.pluginManager.setBundleEnabled('@one-person-lab/dsh-' + name, value)
  }
  async function run() {
    const state = JSON.parse(await readFile(config.state, 'utf8'))
    const parentResult = await ctx.sessionController.resolveAgent(state.parentId)
    if ('error' in parentResult) throw Error('官方协调会话无法加载')
    const parent = parentResult.agent
    const harness = await waitFor(() => ctx.get('oplHarness'), '执行插件未加载')
    if (config.phase === 'ui') {
      await waitFor(() => ctx.get('oplRoleExecution'), '角色绑定服务未加载')
      await writeFile(
        config.output,
        JSON.stringify({ status: 'passed', phase: config.phase, rolesAvailable: true }) + '\n',
        { mode: 0o600 },
      )
      return
    }
    if (config.phase === 'upgrade') {
      if (ctx.get('oplOfficialCollaboration') || ctx.get('oplRoleExecution'))
        throw Error('多包更新重新启用了已禁用的协作插件')
      await enabled('collaboration', true)
      const roles = await waitFor(() => ctx.get('oplRoleExecution'), '更新后协作插件无法恢复')
      const catalog = await roles.catalog()
      if (!catalog.bindings['opl-probe-codex']) throw Error('多包更新丢失了角色绑定')
      const record = (await harness.list()).sessions.find(
        (item) => item.id === state.harnessSessionId,
      )
      if (record?.acpSessionId !== state.externalId) throw Error('更新丢失了外部会话关联')
      await writeFile(
        config.output,
        JSON.stringify({
          status: 'passed',
          phase: config.phase,
          disabledChoicePreserved: true,
          roleBindingPreserved: true,
          externalIdentityPreserved: true,
        }) + '\n',
        { mode: 0o600 },
      )
      return
    }
    await parent.whenIdle()
    if (!ctx.get('oplRoleExecution')) await enabled('collaboration', true)
    const initialRoles = await waitFor(() => ctx.get('oplRoleExecution'), '协作插件未加载')
    const bindingBefore = (await initialRoles.catalog()).bindings
    await enabled('collaboration', false)
    await waitFor(
      () => !ctx.get('oplOfficialCollaboration') && !ctx.get('oplRoleExecution'),
      '协作插件没有卸载',
    )
    if (ctx.get('oplHarness') !== harness) throw Error('关闭协作插件重启了执行服务')
    const binding = JSON.parse(
      await readFile(join(dirname(config.state), 'profiles/desktop/control.json'), 'utf8'),
    )
    const control = await fetch(binding.endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'oplSuite', method: 'setupUrl', args: {} }),
    }).then((response) => response.json())
    if (!control.ok || typeof control.value !== 'string')
      throw Error('关闭协作插件影响了基础启动通道')
    await ctx.subagents.sendMessage(
      parent,
      state.childId,
      [
        {
          type: 'text',
          text: `单独执行能力验收：将 ${config.nonce}-independent 写入 independent-proof.txt，然后结束。不需要团队通信。`,
        },
      ],
      { signal: new AbortController().signal },
    )
    await waitFor(
      async () =>
        (
          await readFile(join(config.workspace, 'independent-proof.txt'), 'utf8').catch(() => '')
        ).trimEnd() ===
        config.nonce + '-independent',
      '停用协作插件后无法继续外部执行',
    )
    await waitFor(
      async () =>
        (await harness.list()).sessions.find(
          (item) => item.id === state.harnessSessionId && item.turns.at(-1)?.state === 'completed',
        ),
      '独立执行未结算',
    )
    await parent.whenIdle()
    await enabled('collaboration', true)
    const roles = await waitFor(() => ctx.get('oplRoleExecution'), '协作插件无法重新启用')
    if (JSON.stringify((await roles.catalog()).bindings) !== JSON.stringify(bindingBefore))
      throw Error('启停丢失了角色绑定')
    // This explicit test source models a third-party source using the public
    // registration seam. Its credentials remain in the official source owner.
    const ref = { provider: 'probe-independent', model: 'gpt-6-luna' }
    ctx.get('oplExternalModelSources').register(ctx, {
      provider: ref.provider,
      supports: (engine, model) => engine === 'codex' && model.model === ref.model,
      resolve: async () => {
        const key = await ctx.credentials.resolve('OPL_GATEWAY_CODEX_API_KEY')
        if (!key) throw Error('独立来源凭据未就绪')
        return {
          baseURL: 'https://gateway.medopl.com/v1',
          model: ref.model,
          apiKey: key.value,
          protocol: 'responses',
        }
      },
    })
    const catalog = await harness.executionCatalog()
    await harness.saveExecutionCatalog({
      ...catalog,
      combinations: [
        ...catalog.combinations.filter((item) => item.id !== 'probe-independent-codex'),
        {
          id: 'probe-independent-codex',
          name: '独立来源验证',
          harnessRef: 'codex',
          modelRef: ref,
          enabled: true,
          isDefault: false,
          permissionPolicy: 'workspace',
        },
      ],
    })
    await enabled('opl', false)
    await waitFor(
      () => !ctx.llm.listProviders().some((provider) => provider.id === 'opl-gateway'),
      '关闭基础增强后 Gateway 来源仍在加载',
    )
    if (ctx.get('oplHarness') !== harness) throw Error('基础增强控制了执行服务的生命周期')
    const independent = await harness.start({
      combination: 'probe-independent-codex',
      cwd: config.workspace,
      taskId: 'independent-source',
      origin: { kind: 'desktop', sessionId: 'probe' },
      sandbox: 'workspace',
    })
    await harness.prompt({
      sessionId: independent.id,
      operationId: 'independent-source-write',
      text: `将 ${config.nonce}-source 写入 independent-source-proof.txt，然后结束。`,
    })
    await waitFor(
      async () =>
        (
          await readFile(join(config.workspace, 'independent-source-proof.txt'), 'utf8').catch(
            () => '',
          )
        ).trimEnd() ===
        config.nonce + '-source',
      '基础增强关闭后其他模型来源不能执行',
    )
    await waitFor(
      async () => (await harness.snapshot({ sessionId: independent.id })).state === 'completed',
      '独立来源执行未结算',
    )
    await enabled('opl', true)
    await waitFor(
      () => ctx.llm.listProviders().some((provider) => provider.id === 'opl-gateway'),
      '基础增强无法恢复',
    )
    await enabled('execution', false)
    await waitFor(
      () => !ctx.get('oplHarness') && !ctx.get('oplOfficialCollaboration'),
      '执行停用后仍有执行或协作服务',
    )
    if (!ctx.llm.listProviders().some((provider) => provider.id === 'opl-gateway'))
      throw Error('停用执行插件影响了基础增强')
    await enabled('execution', true)
    const restored = await waitFor(() => ctx.get('oplHarness'), '执行插件无法恢复')
    await waitFor(() => ctx.get('oplOfficialCollaboration'), '执行恢复后依赖协作没有恢复')
    const record = (await restored.list()).sessions.find(
      (item) => item.id === state.harnessSessionId,
    )
    if (record?.acpSessionId !== state.externalId) throw Error('启停执行插件丢失了外部会话身份')
    await enabled('collaboration', false)
    await waitFor(() => !ctx.get('oplOfficialCollaboration'), '更新前协作停用未生效')
    await writeFile(
      config.output,
      JSON.stringify({
        status: 'passed',
        phase: config.phase,
        baseControlPreserved: true,
        collaborationDisabledExecutionVerified: true,
        baseDisabledOtherSourceVerified: true,
        executionDisabledBasePreserved: true,
        bindingsPreserved: true,
        updateChoice: 'collaboration-disabled',
      }) + '\n',
      { mode: 0o600 },
    )
  }
}
