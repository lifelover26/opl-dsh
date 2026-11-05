import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  HARNESS_INPUT_MAX_LENGTH,
  currentHarnessInputText,
  requireHarnessInputText,
} from '../../src/execution/host/harness-input.ts'

describe('Harness input admission', () => {
  it('preserves accepted text and the existing length limit', () => {
    const text = ' \r\n' + '文'.repeat(HARNESS_INPUT_MAX_LENGTH - 4) + '\t'
    expect(text.length).toBe(HARNESS_INPUT_MAX_LENGTH)
    expect(requireHarnessInputText(text, 'request')).toBe(text)
    expect(() => requireHarnessInputText(text + 'x', 'request')).toThrow('reason=too-long')
  })

  it.each([undefined, null, 1, { secret: 'must-not-appear' }])(
    'refuses non-text input without coercion or object contents',
    (value) => {
      try {
        requireHarnessInputText(value, 'request')
        expect.fail('invalid input was accepted')
      } catch (error) {
        expect(error).toBeInstanceOf(LlmError)
        expect(error).toMatchObject({ code: 'HARNESS_INPUT' })
        expect((error as Error).message).toContain('stage=request; reason=type')
        expect((error as Error).message).not.toContain('must-not-appear')
      }
    },
  )

  it('measures combined current text separately and permits an image-only request', () => {
    expect(currentHarnessInputText([{ type: 'image' }], 'conversation-current')).toBe('')
    expect(() =>
      currentHarnessInputText([{ type: 'text', text: '\n\t ' }], 'conversation-current'),
    ).toThrow('reason=blank')
    expect(() =>
      currentHarnessInputText(
        [
          { type: 'text', text: 'a'.repeat(HARNESS_INPUT_MAX_LENGTH / 2) },
          { type: 'image' },
          { type: 'text', text: 'b'.repeat(HARNESS_INPUT_MAX_LENGTH / 2) },
        ],
        'conversation-current',
      ),
    ).toThrow(`currentTextLength=${HARNESS_INPUT_MAX_LENGTH + 1}`)
  })
})
