import { expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import type { ExternalEditHistory } from '../../../src/execution/host/message-edit-driver.ts'
import type { ExternalEditIntent } from '../../../src/execution/host/message-edit-external.ts'
import {
  externalEditRecovery,
  externalPreparedChoice,
  externalTerminalFailureChoice,
  externalUnsentEmptyChoice,
} from '../../../src/execution/host/message-edit-mapping.ts'

function fixture() {
  const record = {
    id: 'record',
    nativeSessionId: 'dsh',
    acpSessionId: 'vendor',
    turns: [
      { operationId: 'first', state: 'completed', native: { officialSeq: 1, userMessageId: 'a' } },
      {
        operationId: 'message-edit:edit',
        state: 'failed',
        native: { officialSeq: 2, userMessageId: 'b' },
      },
    ],
  } as HarnessSession
  const history: ExternalEditHistory = {
    sessionId: 'vendor',
    token: 'live',
    boundaries: [{ id: 'a' }, { id: 'b' }],
    settledInputId: 'b',
  }
  const intent: ExternalEditIntent = {
    version: 1,
    sessionId: 'dsh',
    recordId: 'record',
    requestId: 'edit',
    fingerprint: 'original',
    previousSessionId: 'parent',
    targetId: 'old-b',
    phase: 'prompting',
    expected: { sessionId: 'parent', token: 'old', boundaries: [{ id: 'old-a' }, { id: 'old-b' }] },
    result: { sessionId: 'vendor', retained: [{ previousId: 'old-a', nextId: 'a' }] },
  }
  const events = [1, 2].map((seq) => ({
    type: 'user/message',
    seq,
    data: {
      source: { kind: 'user', rpcId: seq === 2 ? 'edit' : 'first' },
      content: [{ type: 'text', text: 'same' }],
    },
  })) as unknown as SessionEvent[]
  const active = new Set([1, 2])
  return {
    record,
    history,
    intent,
    events,
    active,
    recover: () => externalEditRecovery(record, history, intent, events, active),
  }
}

it('resumes an allocated prefix only at its persisted official edit target', () => {
  const f = fixture()
  f.intent.phase = 'ready'
  f.intent.targetSeq = 2
  f.record.turns.pop()
  const second = f.events[1]!
  if (second.type !== 'user/message') throw Error('fixture user required')
  second.data.source = { kind: 'user', rpcId: 'original-second' } as never
  const choice = () => externalPreparedChoice(f.record, f.intent, f.events, f.active)
  expect(choice()).toEqual({ seq: 2, text: 'same' })
  f.intent.targetSeq = 99
  expect(choice()).toBeUndefined()
  f.intent.targetSeq = 2
  f.active.delete(2)
  expect(choice()).toBeUndefined()
  f.active.add(2)
  f.record.turns[0]!.native!.userMessageId = 'different-prefix'
  expect(choice()).toBeUndefined()
})

it('recovers a legacy known-empty allocation without guessing between multiple user inputs', () => {
  const f = fixture()
  f.intent.phase = 'ready'
  f.intent.expected.boundaries = [{ id: 'old-b' }]
  f.intent.result!.retained = []
  f.record.turns = []
  f.events.pop()
  const choice = () => externalPreparedChoice(f.record, f.intent, f.events, f.active)
  expect(choice()).toEqual({ seq: 1, text: 'same' })
  f.events.push(structuredClone(f.events[0]!))
  expect(choice()).toBeUndefined()
})

it.each(['invoking', 'admitting', 'prompting', 'uncertain', 'settled'] as const)(
  'does not treat %s as a confirmed prepared allocation',
  (phase) => {
    const f = fixture()
    f.intent.phase = phase
    f.intent.targetSeq = 2
    f.record.turns.pop()
    expect(externalPreparedChoice(f.record, f.intent, f.events, f.active)).toBeUndefined()
  },
)

it('does not resume a prepared allocation if its replacement already appears in the log', () => {
  const f = fixture()
  f.intent.phase = 'ready'
  f.intent.targetSeq = 2
  f.record.turns.pop()
  expect(externalPreparedChoice(f.record, f.intent, f.events, f.active)).toBeUndefined()
})

it('recovers a settled failed input by its exact vendor and official request identities', () => {
  expect(fixture().recover()).toEqual({ kind: 'settled' })
})
it('offers a second retry directly from a persisted terminal vendor identity', () => {
  const f = fixture()
  f.intent.phase = 'settled'
  f.record.turns[1]!.native!.userMessageId = 'b'
  f.record.turns[1]!.stopReason = 'error_response'
  expect(externalTerminalFailureChoice(f.record, f.intent, f.events, f.active)).toEqual({
    seq: 2,
    text: 'same',
  })
})
it('recovers a second failed edit when the vendor retained its new input identity', () => {
  const f = fixture()
  f.intent.phase = 'settled'
  f.history.settledInputId = 'b'
  expect(f.recover()).toEqual({ kind: 'settled' })
})
it('recovers a durable terminal error response after restart without sending a prompt', () => {
  const f = fixture()
  delete f.history.settledInputId
  f.record.turns[1]!.stopReason = 'error_response'
  expect(f.recover()).toEqual({ kind: 'settled' })
})
it('offers a verified unsent replacement while retaining the prepared vendor prefix', () => {
  const f = fixture()
  f.intent.phase = 'admitting'
  delete f.record.turns[1]!.native!.userMessageId
  f.history.boundaries.pop()
  delete f.history.settledInputId
  expect(f.recover()).toEqual({ kind: 'unsent', choice: { seq: 2, text: 'same' } })
})
it('locates an unsent empty fork from the durable admission without inventing a vendor message', () => {
  const f = fixture()
  f.intent.phase = 'admitting'
  f.intent.result = { sessionId: 'vendor', retained: [], ephemeral: true }
  f.record.turns.shift()
  delete f.record.turns[0]!.native!.userMessageId
  const choice = () => externalUnsentEmptyChoice(f.record, f.intent, f.events, f.active)
  expect(choice()).toEqual({ seq: 2, text: 'same' })
  f.intent.phase = 'prompting'
  expect(choice()).toBeUndefined()
  f.intent.phase = 'admitting'
  f.record.turns[0]!.native!.userMessageId = 'already-sent'
  expect(choice()).toBeUndefined()
})
it.each([
  'unknown',
  'wrong-session',
  'wrong-request',
  'wrong-record',
  'missing-input',
  'extra-input',
  'wrong-prefix',
  'superseded',
  'running',
  'uncertain',
  'invoking',
  'duplicate',
  'unsent-already-written',
])('retains the guard for %s', (reason) => {
  const f = fixture()
  switch (reason) {
    case 'unknown':
      delete f.history.settledInputId
      break
    case 'wrong-session':
      f.history.sessionId = 'other'
      break
    case 'wrong-request':
      f.record.turns[1]!.operationId = 'other'
      break
    case 'wrong-record':
      f.intent.recordId = 'other'
      break
    case 'missing-input':
      delete f.record.turns[1]!.native!.userMessageId
      break
    case 'extra-input':
      f.history.boundaries.push({ id: 'extra' })
      break
    case 'wrong-prefix':
      f.history.boundaries[0]!.id = 'other'
      break
    case 'superseded':
      f.active.delete(2)
      break
    case 'running':
      f.record.turns[1]!.state = 'running'
      break
    case 'uncertain':
      f.intent.phase = 'uncertain'
      break
    case 'invoking':
      f.intent.phase = 'invoking'
      break
    case 'duplicate':
      f.history.boundaries[0]!.id = 'b'
      break
    case 'unsent-already-written':
      f.intent.phase = 'admitting'
      break
  }
  expect(f.recover()).toBeUndefined()
})
