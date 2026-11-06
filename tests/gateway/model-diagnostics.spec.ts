import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  diagnoseGatewayModelFailure,
  gatewayModelDiagnostic,
} from '../../src/gateway/host/model-diagnostics.ts'

describe('safe model-listing diagnostics', () => {
  it.each([
    [new LlmError('private key details', 'MISSING_CREDENTIAL'), 'missing_credentials'],
    [new LlmError('private key details', 'INVALID_CREDENTIAL'), 'invalid_credentials'],
    [new LlmError('private service details', 'NO_DISCOVERY'), 'service_unavailable'],
    [
      Object.assign(Error('private service details'), { code: 'SETTINGS_UNAVAILABLE' }),
      'service_unavailable',
    ],
    [new LlmError('private config details', 'DISCOVERY_UNSUPPORTED'), 'configuration'],
    [
      new LlmError('private URL', 'DISCOVERY_FAILED', { cause: new TypeError('fetch failed') }),
      'network',
    ],
    [
      new LlmError('private URL', 'DISCOVERY_FAILED', {
        cause: Object.assign(Error('private host'), { code: 'ETIMEDOUT' }),
      }),
      'timeout',
    ],
    [
      new LlmError('private URL', 'ABORTED', {
        cause: new DOMException('private URL', 'TimeoutError'),
      }),
      'timeout',
    ],
    [
      new LlmError('private body', 'DISCOVERY_FAILED', { cause: new SyntaxError('private JSON') }),
      'invalid_response',
    ],
    [new LlmError('private body', 'DISCOVERY_FAILED'), 'invalid_response'],
  ] as const)('classifies a failure without returning upstream detail: %s', (error, code) => {
    const result = diagnoseGatewayModelFailure(error)
    expect(result.code).toBe(code)
    expect(JSON.stringify(result)).not.toMatch(/private|fetch failed/)
    expect(result.message.length).toBeLessThan(180)
  })

  it.each([401, 403, 404, 429, 503])(
    'exposes only the HTTP %i status from the installed adapter error',
    (status) => {
      const result = diagnoseGatewayModelFailure(
        new LlmError(
          `https://account:password@host.invalid/path?token=private answered ${status}${status === 401 || status === 403 ? '; check the API key' : ''}`,
          'DISCOVERY_FAILED',
        ),
      )
      expect(result).toMatchObject({
        status,
        code: status === 401 || status === 403 ? 'authentication' : 'http',
      })
      expect(result.message).toContain(`HTTP ${status}`)
      expect(JSON.stringify(result)).not.toMatch(/account|password|host\.invalid|private/)
    },
  )

  it('uses the timeout signal and bounds cause traversal even for cyclic exceptions', () => {
    const controller = new AbortController()
    controller.abort(new DOMException('private', 'TimeoutError'))
    expect(diagnoseGatewayModelFailure(Error('private'), controller.signal).code).toBe('timeout')
    const cyclic = Error('private') as Error & { cause: unknown }
    cyclic.cause = cyclic
    expect(diagnoseGatewayModelFailure(cyclic)).toEqual(gatewayModelDiagnostic('discovery_failed'))
  })
})
