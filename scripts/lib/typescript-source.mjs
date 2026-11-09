import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API } from 'typescript/unstable/sync'

/**
 * Traverse real source files while the TypeScript 7 API snapshot is alive.
 * The callback should return inspection results, not snapshot-owned nodes.
 *
 * @template T
 * @param {Array<string | URL>} paths
 * @param {(sourceFile: (path: string | URL) => import('typescript/unstable/ast').SourceFile) => T} inspect
 * @returns {T}
 */
export function withTypeScriptSources(paths, inspect) {
  const fileName = (path) => (path instanceof URL ? fileURLToPath(path) : resolve(path))
  const files = paths.map(fileName)
  const api = new API({ cwd: process.cwd() })
  try {
    const snapshot = api.updateSnapshot({ openFiles: files })
    try {
      return inspect((path) => {
        const name = fileName(path)
        const project = snapshot.getDefaultProjectForFile(name)
        const source = project?.program.getSourceFile(name)
        if (!source) throw new Error(`TypeScript could not load source file ${name}`)
        return source
      })
    } finally {
      snapshot.dispose()
    }
  } finally {
    api.close()
  }
}
