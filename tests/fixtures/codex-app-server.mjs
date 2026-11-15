#!/usr/bin/env node
import { createInterface } from 'node:readline'
const send = (x) => process.stdout.write(JSON.stringify(x) + '\n')
let threadId = 'native-test',
  turn = 'turn-1',
  receivedSandbox = null,
  probePending = false
// `FIXTURE_EXPECT_SANDBOX` and `FIXTURE_REPORT` let a test drive the fixture into reporting the
// configuration it actually received, without changing the default behaviour other tests rely on.
// `FIXTURE_SHELL_PROBE` selects what the fake shell actually reports, so the bridge's real-shell
// verification can be exercised in both directions.
const expectedSandbox = process.env.FIXTURE_EXPECT_SANDBOX
const report = process.env.FIXTURE_REPORT === '1'
const shellProbe = process.env.FIXTURE_SHELL_PROBE ?? 'bash'
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fixture' } })
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (
      m.params.modelProvider !== 'opl-gateway' ||
      m.params.config.model_providers['opl-gateway'].env_key !== 'OPL_NATIVE_API_KEY'
    )
      throw Error('invalid native configuration')
    if (expectedSandbox && m.params.sandbox !== expectedSandbox)
      throw Error(`expected sandbox ${expectedSandbox} but the bridge sent ${m.params.sandbox}`)
    if (
      process.env.OPL_FIXTURE_INSTRUCTIONS &&
      m.params.developerInstructions !== process.env.OPL_FIXTURE_INSTRUCTIONS
    )
      throw Error('official role instructions were not forwarded')
    threadId = m.params.threadId ?? threadId
    receivedSandbox = m.params.sandbox
    send({ id: m.id, result: { thread: { id: threadId }, model: m.params.model } })
  }
  // Model-free shell probe: the official entry point a client uses to learn which shell the
  // process really executes commands with. The fixture answers as bash or as PowerShell.
  if (m.method === 'thread/shellCommand') {
    probePending = true
    send({ id: m.id, result: {} })
    const bash = shellProbe === 'bash'
    send({
      method: 'item/started',
      params: {
        threadId,
        item: {
          id: 'probe',
          type: 'commandExecution',
          command: m.params.command,
          status: 'inProgress',
        },
      },
    })
    send({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId,
        itemId: 'probe',
        delta: bash
          ? 'OPL_SHELL_NAME=/usr/bin/bash\nOPL_SHELL_BASH_VERSION=5.3.15(1)-release\n'
          : 'OPL_SHELL_NAME=pwsh\nOPL_SHELL_BASH_VERSION=none\n',
      },
    })
    send({
      method: 'item/completed',
      params: {
        threadId,
        item: { id: 'probe', type: 'commandExecution', status: 'completed', exitCode: 0 },
      },
    })
    setTimeout(() => {
      probePending = false
      send({
        method: 'turn/completed',
        params: { threadId, turn: { id: 'probe-turn', status: 'completed', items: [] } },
      })
    }, 100)
    return
  }
  if (m.method === 'turn/start') {
    if (probePending) throw Error('user turn started before shell probe completed')
    if (m.params.effort !== (process.env.OPL_FIXTURE_EFFORT ?? 'high'))
      throw Error('reasoning effort was not forwarded')
    send({ id: m.id, result: { turn: { id: turn } } })
    send({
      id: 100,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId,
        turnId: turn,
        itemId: 'tool',
        command: 'outside project',
        reason: 'sandbox escalation',
      },
    })
  }
  if (m.id === 100 && m.result) {
    if (m.result.decision !== 'decline') throw Error('sandbox escalation allowed')
    send({
      method: 'item/agentMessage/delta',
      params: {
        threadId,
        turnId: turn,
        itemId: 'message',
        // Report what this process actually observed so the test asserts on real values.
        delta: report
          ? JSON.stringify({
              sandbox: receivedSandbox,
              gitBash: process.env.CODEX_NATIVE_GIT_BASH_PATH ?? null,
            })
          : 'boundary preserved',
      },
    })
    send({
      method: 'turn/completed',
      params: { threadId, turn: { id: turn, status: 'completed' } },
    })
  }
})
