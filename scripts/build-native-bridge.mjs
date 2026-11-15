import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Build the regression-test bridge without rewriting platform-dependent RPC sources. */
export async function buildNativeBridge(root, output = join(root, 'dist')) {
  const result = await build({
    entryPoints: [join(root, 'src/execution/host/adapters/native-harness-bridge.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: join(output, 'package/lib/native-harness-bridge.mjs'),
    banner: {
      js: "import { createRequire as oplCreateRequire } from 'node:module'; const require = oplCreateRequire(import.meta.url);",
    },
    write: false,
  })
  for (const file of result.outputFiles ?? []) {
    await mkdir(dirname(file.path), { recursive: true })
    await writeFile(file.path, file.contents)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(import.meta.dirname, '..')
  await buildNativeBridge(repoRoot, join(repoRoot, 'dist/execution-package'))
}
