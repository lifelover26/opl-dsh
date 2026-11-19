/** Immutable, pinned Codex Git Bash packages. Validation never executes package code. */
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import plan from './candidate.json' with { type: 'json' }

import previousPlan from './candidate-0.160.1.json' with { type: 'json' }

function planFor(version) {
  if (version === plan.id) return plan
  if (version === previousPlan.id) return previousPlan
  throw Error('此 Codex 候选版本尚未验收')
}

export const codexCandidatePlan = plan
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Reject directory links before reading or writing a package, including parent junctions. */
export function plainPath(path) {
  if (!isAbsolute(path)) throw Error('候选目录必须是绝对路径')
  let current = resolve(path)
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw Error('候选路径不能包含符号链接或 junction')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(path)
}

/** Verify the reviewed build identity and every file; a self-declared hash is insufficient. */
export function verifyCodexCandidate(directory, version = plan.id) {
  const root = plainPath(directory)
  const selected = planFor(version)
  const manifestPath = join(root, 'manifest.json')
  const expectedFiles = Object.keys(selected.files).sort()
  const actualFiles = []
  function walk(base, prefix = '') {
    for (const name of readdirSync(base)) {
      const path = join(base, name),
        info = lstatSync(path)
      if (info.isSymbolicLink()) throw Error('候选包不能包含链接')
      if (info.isDirectory()) walk(path, prefix + name + '/')
      else if (info.isFile()) actualFiles.push(prefix + name)
      else throw Error('候选包包含非普通文件')
    }
  }
  walk(root)
  if (
    JSON.stringify(actualFiles.sort()) !==
    JSON.stringify([...expectedFiles, 'manifest.json'].sort())
  )
    throw Error('候选文件集合与已验收清单不一致')
  const bytes = readFileSync(manifestPath)
  const manifest = JSON.parse(bytes)
  if (JSON.stringify(manifest) !== JSON.stringify(selected))
    throw Error('候选清单与已验收构建不一致')
  for (const file of expectedFiles)
    if (digest(readFileSync(join(root, file))) !== selected.files[file])
      throw Error('候选文件摘要不一致：' + file)
  return {
    version: selected.id,
    command: join(root, 'bin/codex.exe'),
    manifestSha256: digest(bytes),
    executableSha256: selected.files['bin/codex.exe'],
    validation: 'static',
  }
}

/** Copy a verified package into an immutable version directory, preserving earlier builds. */
export function importCodexCandidate(source, store, version = plan.id) {
  const selected = planFor(version)
  const root = plainPath(store),
    destination = join(root, version)
  verifyCodexCandidate(source, version)
  if (existsSync(destination)) return verifyCodexCandidate(destination, version)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  plainPath(root)
  const stage = join(root, '.import-' + randomUUID())
  mkdirSync(stage, { mode: 0o700 })
  try {
    for (const file of [...Object.keys(selected.files), 'manifest.json']) {
      const target = join(stage, file)
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      copyFileSync(join(source, file), target)
    }
    verifyCodexCandidate(stage, version)
    plainPath(root)
    if (existsSync(destination)) throw Error('候选版本已存在，未覆盖')
    renameSync(stage, destination)
  } finally {
    // This random staging directory was created by this call, never a user-selected target.
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
  }
  return verifyCodexCandidate(destination, version)
}

/** Package the exact previously accepted executable with pinned patches and upstream notices. */
export function packageCodexCandidate(binary, output, assets = import.meta.dirname) {
  const target = plainPath(output)
  if (existsSync(target)) throw Error('交付目录已存在，未覆盖')
  if (digest(readFileSync(binary)) !== plan.files['bin/codex.exe'])
    throw Error('二进制与已验收构建不一致')
  mkdirSync(target, { recursive: true, mode: 0o700 })
  for (const file of Object.keys(plan.files)) {
    const source = file.startsWith('patches/')
      ? join(assets, file)
      : file === 'LICENSE' || file === 'NOTICE'
        ? join(assets, 'licenses', file)
        : join(dirname(dirname(binary)), file)
    const bytes =
      file === 'LICENSE' || file === 'NOTICE'
        ? Buffer.from(readFileSync(source, 'utf8').replaceAll('\r\n', '\n'))
        : readFileSync(source)
    if (digest(bytes) !== plan.files[file]) throw Error('交付输入摘要不一致：' + file)
    mkdirSync(dirname(join(target, file)), { recursive: true, mode: 0o700 })
    writeFileSync(join(target, file), bytes, { flag: 'wx' })
  }
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' })
  return verifyCodexCandidate(target)
}
