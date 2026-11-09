/** Enforce runtime ownership, rather than freezing source text or file sizes. */
import { readdir } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { withTypeScriptSources } from './lib/typescript-source.mjs'
const root = resolve(import.meta.dirname, '../src')
async function files(directory) {
  const found = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === 'generated') continue
    const path = resolve(directory, item.name)
    if (item.isDirectory()) found.push(...(await files(path)))
    else if (['.ts', '.tsx'].includes(extname(path))) found.push(path)
  }
  return found
}
const errors = []
const sourcePaths = await files(root)
withTypeScriptSources(sourcePaths, (sourceFile) => {
  for (const path of sourcePaths) {
    const name = relative(root, path).replaceAll('\\', '/')
    const source = sourceFile(path)
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const specifier = statement.moduleSpecifier.text
      if (!specifier.startsWith('.')) continue
      const target = relative(root, resolve(dirname(path), specifier)).replaceAll('\\', '/')
      const typeOnly = ts.isImportDeclaration(statement)
        ? statement.importClause?.isTypeOnly === true
        : statement.isTypeOnly === true
      if (name.includes('/client/') && target.includes('/host/') && !typeOnly)
        errors.push(`${name}: browser runtime imports Host implementation ${target}`)
      if (name.startsWith('gateway/') && /^(execution|collaboration)\//.test(target))
        errors.push(`${name}: Gateway depends on execution/collaboration ${target}`)
      if (name.startsWith('setup/') && /^(execution|collaboration)\//.test(target))
        errors.push(`${name}: onboarding owns another capability ${target}`)
      if (!name.startsWith('suite/') && target.startsWith('suite/') && !typeOnly)
        errors.push(`${name}: feature depends on its assembly ${target}`)
    }
  }
})
if (errors.length) throw Error(errors.join('\n'))
console.log('Module ownership boundaries verified')
