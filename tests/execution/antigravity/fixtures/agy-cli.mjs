/** Owned ACP fixture; its fake model endpoint is supplied only by the bridge test. */
import { createInterface } from 'node:readline'
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const emit = (text) =>
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'owned-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    }) + '\n',
  )
const asks = new Map()
createInterface({ input: process.stdin }).on('line', (line) => {
  void (async () => {
    const m = JSON.parse(line)
    if (!m.method) {
      asks.get(m.id)?.(m.result)
      asks.delete(m.id)
      return
    }
    if (m.method === 'initialize') {
      reply(m.id, {
        protocolVersion: 1,
        agentInfo: {
          name: 'owned-fixture',
          version: '1',
          pid: process.pid,
          realRouteVisible: !!process.env.OPL_AGY_ROUTE,
          realKeyVisible: process.env.GEMINI_API_KEY === 'source-secret',
        },
      })
      return
    }
    if (m.method === 'session/new' || m.method === 'session/load') {
      emit('OLD_REPLAY_MUST_NOT_APPEAR')
      reply(m.id, { sessionId: 'owned-session', configOptions: [] })
      return
    }
    if (m.method !== 'session/prompt') {
      if (m.id !== undefined) reply(m.id, {})
      return
    }
    const text = m.params.prompt[0].text
    if (text === 'terminal-error') {
      emit('⚠ Agent execution ')
      emit('terminated due to error.')
      reply(m.id, { stopReason: 'end_turn' })
      return
    }
    if (text === 'ordinary-error-word') {
      emit('The test checks an error condition.')
      reply(m.id, { stopReason: 'end_turn' })
      return
    }
    if (text === 'permission') {
      const answer = new Promise((resolve) => asks.set('owned-permission', resolve))
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'owned-permission',
          method: 'session/request_permission',
          params: {
            sessionId: 'owned-session',
            toolCall: { title: 'owned request' },
            options: [{ optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
          },
        }) + '\n',
      )
      const result = await answer
      emit(result.outcome.optionId === 'deny' ? 'DENIED_BY_OPERATOR' : 'UNEXPECTED_ALLOW')
      reply(m.id, { stopReason: 'end_turn' })
      return
    }
    const post = (model) =>
      fetch(
        process.env.GOOGLE_GEMINI_BASE_URL +
          '/v1beta/models/' +
          model +
          ':streamGenerateContent?alt=sse',
        {
          method: 'POST',
          headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }] }),
        },
      )
    if (text === 'aux') await (await post('gemini-3.1-flash-lite-preview')).text()
    try {
      const response = await post('gemini-3.8-flash')
      await response.text()
      if (!response.ok) {
        for (let i = 0; i < 10; i++) await post('gemini-3.8-flash')
        return
      }
      emit('CURRENT_ANSWER')
      reply(m.id, {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 2695,
          outputTokens: 61,
          cachedReadTokens: 6290,
          cachedWriteTokens: 0,
          thoughtTokens: 53,
          totalTokens: 9046,
        },
      })
    } catch {
      emit('⚠ Agent execution terminated due to error.')
      reply(m.id, { stopReason: 'end_turn' })
    }
  })()
})
