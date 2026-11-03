import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  MODEL_PLUGIN_FIXTURE,
  startModelPluginFixture,
} from '../scripts/qualification-model-plugins.mjs'

test('the OFM qualification fixture serves the current inference model listing', async () => {
  const fixture = await startModelPluginFixture()
  try {
    const base = fixture.environment.OUR_FREE_MODEL_BASE
    for (const path of ['/inference/v1/models', '/zen/v1/models']) {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(10_000) })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { data: [{ id: MODEL_PLUGIN_FIXTURE }] })
    }
    const kilo = await fetch(base + '/kilo/models', { signal: AbortSignal.timeout(10_000) })
    assert.deepEqual(await kilo.json(), { data: [] })
  } finally {
    await fixture.close()
  }
})

for (const renamed of [false, true])
  test(`the OFM qualification fixture returns the caller's ${renamed ? 'renamed' : 'original'} tool and finishes after its result`, async () => {
    const fixture = await startModelPluginFixture()
    try {
      const name = renamed
        ? 'clint_' +
          createHash('sha256').update('list_harness_combinations').digest('hex').slice(0, 12)
        : 'list_harness_combinations'
      const url = fixture.environment.OUR_FREE_MODEL_BASE + '/inference/openai/v1/chat/completions'
      const body = {
        model: MODEL_PLUGIN_FIXTURE,
        tools: [
          { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } },
        ],
        messages: [{ role: 'user', content: 'Use the advertised tool.' }],
      }
      const send = async (value) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
          signal: AbortSignal.timeout(10_000),
        })
        assert.equal(response.status, 200)
        return response.text()
      }
      const call = await send(body)
      assert.match(call, /"finish_reason":"tool_calls"/)
      assert(call.includes(`"name":"${name}"`))
      assert(!call.includes('MODEL_PLUGIN_VERIFIED'))
      body.messages.push({ role: 'tool', tool_call_id: 'ofm-fixture-call', content: '[]' })
      const result = await send(body)
      assert.match(result, /MODEL_PLUGIN_VERIFIED/)
      assert.match(result, /"finish_reason":"stop"/)
      assert.match(result, /"prompt_tokens":8/)
      assert.deepEqual(
        fixture.requests.map((request) => request.usedTool),
        [false, true],
      )
    } finally {
      await fixture.close()
    }
  })
