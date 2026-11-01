/** Package the pinned upstream bundle without embedding DSH runtime services. */
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export async function buildSuperagent(root, output, tar) {
  const source = join(root, 'vendor/dsh-superagent')
  execFileSync(process.execPath, [join(root, 'node_modules/tsdown/dist/run.mjs')], {
    cwd: source,
    stdio: 'inherit',
  })
  const stage = join(output, 'superagent-package')
  await rm(stage, { recursive: true, force: true })
  await mkdir(join(stage, 'package'), { recursive: true })
  for (const name of [
    'lib',
    'cordis.patch.yml',
    'locale',
    'README.md',
    'prompts',
    'skills',
    'LICENSE',
    'package.json',
    'UPSTREAM.md',
  ])
    await cp(join(source, name), join(stage, 'package', name), { recursive: true })
  const temporary = join(output, 'dsh-superagent.tgz')
  execFileSync(tar, ['-czf', temporary, '-C', stage, 'package'])
  const sha256 = createHash('sha256')
    .update(await readFile(temporary))
    .digest('hex')
  const name = `dsh-superagent-${sha256.slice(0, 12)}.tgz`
  await cp(temporary, join(output, name))
  return {
    name,
    sha256,
    version: '0.1.0',
    upstream: 'https://github.com/deepseek-ai/dsh-superagent-prototype',
    upstreamCommit: '6337fc823ce20251c8de8085948165c81aaa701e',
  }
}
