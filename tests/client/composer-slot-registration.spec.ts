/** Validate composer registrations against the official single/list slot semantics. */
import * as ts from 'typescript/unstable/ast'
import { expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { withTypeScriptSources } from '../../scripts/lib/typescript-source.mjs'

it('keeps model, editing and queue contributions registered together', () => {
  const path = new URL('../../src/execution/client/index.tsx', import.meta.url)
  withTypeScriptSources([path], (sourceFile) => {
    const source = sourceFile(path)
    const core = new SlotCore()
    core.register(
      {
        name: 'root',
        children: {
          'conversation.input.model': { kind: 'single', scope: 'session' },
          'conversation.input.activity': { kind: 'single', scope: 'session' },
          'conversation.input.right': { kind: 'list', scope: 'session' },
        },
      },
      () => null,
    )
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'register' &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const fields = node.arguments[0].properties
        const field = (name: string) =>
          fields.find(
            (item): item is ts.PropertyAssignment =>
              ts.isPropertyAssignment(item) && item.name.getText(source) === name,
          )?.initializer
        const name = field('name')
        if (name && ts.isStringLiteral(name) && core.spec(name.text)) {
          const priority = field('priority')
          const id = field('id')
          core.register(
            {
              name: name.text,
              ...(id && ts.isStringLiteral(id) ? { id: id.text } : {}),
              ...(priority ? { priority: Number(priority.getText(source)) } : {}),
            },
            () => null,
          )
        }
      }
      node.forEachChild(visit)
    }
    visit(source)
    expect(core.entries('conversation.input.model')).toHaveLength(1)
    expect(core.entries('conversation.input.activity')).toHaveLength(1)
    expect(core.entries('conversation.input.right')).toHaveLength(1)
  })
})
