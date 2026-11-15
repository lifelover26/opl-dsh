/** Test-only driver: all member identity, messaging and task operations use the official Host. */
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
export const inject = [
  'sessionController',
  'subagents',
  'agentPresets',
  'oplHarness',
  'oplRoleExecution',
  'oplOfficialCollaboration',
  'agentTeams',
  'workspaceRegistry',
  'permissionPresets',
  'agents',
]
export function apply(ctx, config) {
  let closed = false
  ctx.on('agent/request', async (payload, next) => {
    const result = await next()
    if (payload.agent.session.header.origin === 'subagent') {
      const admitted = await payload.agent.ctx.tools.resolve({
        agent: payload.agent,
        modelSelection: payload.agent.model.current(),
        signal: payload.signal,
      })
      try {
        await writeFile(
          config.output + '.tools',
          JSON.stringify({
            names: [...admitted.view(payload.agent).keys()],
            official: (
              await ctx.oplOfficialCollaboration.tools(payload.agent.id, payload.signal)
            ).map((t) => t.name),
          }),
        )
      } finally {
        admitted.dispose()
      }
    }
    return result
  })
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void run().catch(async (error) => {
        await writeFile(
          config.output,
          JSON.stringify({
            status: 'failed',
            failure: String(error.message).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]'),
          }) + '\n',
          { mode: 0o600 },
        )
      })
    }, 1200)
    return () => {
      closed = true
      clearTimeout(timer)
    }
  })
  async function waitFor(read, reason, timeout = 180000) {
    const until = Date.now() + timeout
    while (!closed && Date.now() < until) {
      const result = await read()
      if (result) return result
      await delay(150)
    }
    throw Error(reason)
  }
  async function run() {
    const signal = new AbortController().signal
    const path = join(config.workspace, 'member-proof.txt')
    const prior =
      config.phase !== 'first' ? JSON.parse(await readFile(config.state, 'utf8')) : undefined
    const catalog = await ctx.oplHarness.executionCatalog()
    const combination = catalog.combinations.find(
      (item) =>
        item.enabled && item.harnessRef === 'codex' && item.modelRef.model.endsWith('gpt-6-luna'),
    )
    if (!combination) throw Error('真实 Codex 组合未就绪')
    const claudeCombination = catalog.combinations.find(
      (item) =>
        item.enabled && item.harnessRef === 'claude' && item.modelRef.model.startsWith('aws::'),
    )
    await ctx.oplRoleExecution.save({
      bindings: {
        'opl-probe-codex': combination.id,
        ...(claudeCombination ? { 'opl-probe-claude': claudeCombination.id } : {}),
      },
    })
    let parent
    if (prior) {
      const resolved = await ctx.sessionController.resolveAgent(prior.parentId)
      if ('error' in resolved) throw Error('无法恢复官方父会话')
      parent = resolved.agent
    } else {
      const workspace = await ctx.workspaceRegistry.create(config.workspace)
      const created = await ctx.sessionController.create({
        sessionId: config.parentId,
        workspaceId: workspace.id,
        agentPreset: 'standard',
      })
      const resolved = await ctx.sessionController.resolveAgent(
        created.sessionId ?? config.parentId,
      )
      if ('error' in resolved) throw Error('无法创建官方父会话')
      parent = resolved.agent
      ctx.permissionPresets.set(parent.session, 'workspace-write')
      await ctx.agentTeams.setEnabled(parent, true)
    }
    if (config.phase === 'mixed') {
      if (!claudeCombination) throw Error('真实 Claude 组合未就绪')
      const activation = await ctx.subagents.startActivation({
        parent,
        provider: 'spawn',
        name: 'reviewer',
        agentPreset: 'opl-probe-claude',
        label: '真实 Claude 混合团队验证',
        delivery: 'caller',
        signal,
        prompt: [
          {
            type: 'text',
            text: `本机受控验收：读取 member-proof.txt，写入 claude-proof.txt，内容为 ${config.nonce}-claude。通过 opl-harness MCP 的 dsh_team_task_create 创建一项主题为 ${config.nonce} 的官方任务，按工具返回的 revision 领取并完成该任务。然后用 dsh_send_message 向 developer 发送以下指令：“读取 claude-proof.txt，创建 codex-peer.txt，内容为 ${config.nonce}-peer；再用 dsh_send_message 向 lead 发送 ${config.nonce}-peer，最后结束。” 不要创建子成员。`,
          },
        ],
      })
      const result = await activation.result
      if (result.stopReason !== 'completed') throw Error('真实 Claude 未完成：' + result.stopReason)
      await waitFor(
        async () =>
          (
            await readFile(join(config.workspace, 'codex-peer.txt'), 'utf8').catch(() => '')
          ).trimEnd() ===
          config.nonce + '-peer',
        'Codex 没有响应 Claude 的官方成员消息',
      )
      const records = (await ctx.oplHarness.list()).sessions
      const claude = records.find((item) => item.nativeSessionId === activation.childId)
      const codex = await waitFor(
        async () =>
          (await ctx.oplHarness.list()).sessions.find(
            (item) =>
              item.nativeSessionId === prior.childId &&
              item.turns.at(-1)?.state === 'completed' &&
              item.turns.length >= 3,
          ),
        'Codex 成员续作未完成',
      )
      if (!claude || claude.harnessRef !== 'claude' || codex.acpSessionId !== prior.externalId)
        throw Error('混合团队执行关联错误')
      const completedTask = parent.session
        .snapshotEvents()
        .find(
          (event) =>
            event.type === 'team/task' &&
            event.data.task?.status === 'completed' &&
            event.data.task.ownerId === activation.childId &&
            event.data.task.subject === config.nonce,
        )
      if (!completedTask) throw Error('官方任务板缺少 Claude 身份的完成记录')
      await waitFor(
        () =>
          parent.session
            .snapshotEvents()
            .some(
              (event) =>
                event.type === 'user/message' &&
                event.data.source?.kind === 'agent-message' &&
                event.data.source.senderSessionId === prior.childId &&
                JSON.stringify(event.data).includes(config.nonce + '-peer'),
            ),
        '官方协调者未收到跨引擎回执',
      )
      await writeFile(
        config.output,
        JSON.stringify({
          status: 'passed',
          phase: config.phase,
          parentId: parent.id,
          codexId: prior.childId,
          claudeId: activation.childId,
          codexExternalId: codex.acpSessionId,
          claudeExternalId: claude.acpSessionId,
          taskId: completedTask.data.task.id,
          taskRevision: completedTask.data.task.revision,
          peerMessageVerified: true,
          artifactsVerified: true,
        }) + '\n',
        { mode: 0o600 },
      )
      return
    }
    if (config.phase === 'cancel') {
      const cancelPath = join(config.workspace, 'must-not-exist-after-cancel.txt')
      await ctx.subagents.sendMessage(
        parent,
        prior.childId,
        [
          {
            type: 'text',
            text: '受控取消验收：先用 shell 执行 sleep 45，等待结束后才创建 must-not-exist-after-cancel.txt。先不要回复或发送团队消息。',
          },
        ],
        { signal },
      )
      await waitFor(
        async () =>
          (await ctx.oplHarness.list()).sessions.find(
            (item) =>
              item.id === prior.harnessSessionId &&
              item.turns.at(-1)?.state === 'running' &&
              item.turns.at(-1).tools.some((tool) => tool.title?.includes('sleep')),
          ),
        '没有观察到可取消的真实 Codex 执行',
      )
      ctx.subagents.interrupt(prior.childId, { kind: 'ancestor', agent: parent })
      const cancelled = await waitFor(
        async () =>
          (await ctx.oplHarness.list()).sessions.find(
            (item) =>
              item.id === prior.harnessSessionId &&
              ['cancelled', 'interrupted'].includes(item.turns.at(-1)?.state),
          ),
        '官方取消没有终止外部执行',
      )
      if (
        await access(cancelPath).then(
          () => true,
          () => false,
        )
      )
        throw Error('取消后的写入仍发生了')
      await ctx.subagents.sendMessage(
        parent,
        prior.childId,
        [
          {
            type: 'text',
            text: `取消已经完成。请继续同一会话，将 ${config.nonce}-after-cancel 写入 after-cancel.txt，然后结束。`,
          },
        ],
        { signal },
      )
      await waitFor(
        async () =>
          (
            await readFile(join(config.workspace, 'after-cancel.txt'), 'utf8').catch(() => '')
          ).trimEnd() ===
          config.nonce + '-after-cancel',
        '取消后不能继续同一成员',
      )
      const resumed = await waitFor(
        async () =>
          (await ctx.oplHarness.list()).sessions.find(
            (item) =>
              item.id === prior.harnessSessionId && item.turns.at(-1)?.state === 'completed',
          ),
        '取消后的新轮次未完成',
      )
      if (resumed.acpSessionId !== prior.externalId) throw Error('取消后替换了外部会话')
      await writeFile(
        config.output,
        JSON.stringify({
          status: 'passed',
          phase: config.phase,
          childId: prior.childId,
          externalId: resumed.acpSessionId,
          cancelledTurns: cancelled.turns.filter((turn) =>
            ['cancelled', 'interrupted'].includes(turn.state),
          ).length,
          artifactSuppressed: true,
          continuationVerified: true,
        }) + '\n',
        { mode: 0o600 },
      )
      return
    }
    let childId
    if (!prior) {
      const activation = await ctx.subagents.startActivation({
        parent,
        provider: 'spawn',
        name: 'developer',
        label: '真实 Codex 团队验证',
        agentPreset: 'opl-probe-codex',
        delivery: 'caller',
        signal,
        prompt: [
          {
            type: 'text',
            text: `这是受控的本机能力验收。请用你的文件工具将精确文本 ${config.nonce} 写入工作目录中的 member-proof.txt，然后使用 opl-harness MCP 的 dsh_send_message 向 lead 发送 ${config.nonce}，先用 dsh_list_agents 查看地址。最终回答包含这段文本。不要另行创建子任务。`,
          },
        ],
      })
      childId = activation.childId
      const result = await activation.result
      if (result.stopReason !== 'completed') {
        const child = ctx.agents.get(childId)
        const failures = child?.session
          .snapshotEvents()
          .filter((event) => /error|turn\/end/.test(event.type))
          .map((event) => event.data)
        throw Error('真实 Codex 首轮未完成：' + JSON.stringify({ result, failures }))
      }
    } else {
      childId = prior.childId
      await ctx.subagents.sendMessage(
        parent,
        childId,
        [
          {
            type: 'text',
            text: `继续原任务：读取 member-proof.txt，再把精确文本 ${config.nonce}-resumed 写入同一文件，调用 opl-harness MCP 的 dsh_send_message 向 lead 发送相同文本，然后结束。`,
          },
        ],
        { signal },
      )
      await waitFor(
        async () =>
          (await readFile(path, 'utf8').catch(() => '')).trimEnd() === config.nonce + '-resumed',
        '冷恢复没有更新实际产物',
      )
    }
    const expected = prior ? config.nonce + '-resumed' : config.nonce
    await waitFor(
      async () => (await readFile(path, 'utf8').catch(() => '')).trimEnd() === expected,
      'Codex 未写入精确产物',
    )
    const record = await waitFor(async () => {
      const item = (await ctx.oplHarness.list()).sessions.find(
        (item) => item.nativeSessionId === childId,
      )
      return item && item.turns.at(-1)?.state === 'completed' ? item : undefined
    }, '外部执行未结算')
    if (prior && record.acpSessionId !== prior.externalId) throw Error('冷恢复替换了外部会话身份')
    const message = await waitFor(
      () =>
        parent.session
          .snapshotEvents()
          .find(
            (event) =>
              event.type === 'user/message' &&
              event.data.source?.kind === 'agent-message' &&
              event.data.source.senderSessionId === childId &&
              JSON.stringify(event.data).includes(expected),
          ),
      '官方未记录真实成员的消息',
    )
    const members = await ctx.subagents.listDescendants(parent.id)
    if (!members.some((member) => member.id === childId))
      throw Error('官方成员目录缺少外部执行成员')
    const state = {
      parentId: parent.id,
      childId,
      externalId: record.acpSessionId,
      harnessSessionId: record.id,
    }
    await writeFile(config.state, JSON.stringify(state) + '\n', { mode: 0o600 })
    await writeFile(
      config.output,
      JSON.stringify({
        status: 'passed',
        phase: config.phase,
        ...state,
        modelRef: record.modelRef,
        turns: record.turns.length,
        toolEvents: record.turns.reduce((n, turn) => n + turn.tools.length, 0),
        memberName: members.find((member) => member.id === childId)?.name,
        messageSeq: message.seq,
        artifactVerified: true,
      }) + '\n',
      { mode: 0o600 },
    )
  }
}
