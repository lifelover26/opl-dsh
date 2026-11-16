import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWriteScope, writerConflicts } from '../../src/execution/host/write-scope.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-write-scope-'))
  roots.push(root)
  return root
}
describe('operation write ownership', () => {
  it('contends only when both operations declare overlapping scopes', async () => {
    const cwd = await fixture()
    const scope = (paths?: string[]) => resolveWriteScope(cwd, paths)
    const a = { cwd, writeScope: await scope(['src/client']) }
    expect(writerConflicts(a, { cwd, writeScope: await scope(['src/host/a.ts']) })).toBe(false)
    expect(writerConflicts(a, { cwd, writeScope: await scope(['src/client/a.ts']) })).toBe(true)
    expect(writerConflicts(a, { cwd, writeScope: await scope(['src/client-else/a.ts']) })).toBe(
      false,
    )
    expect(writerConflicts(a, { cwd })).toBe(false)
    expect(writerConflicts({ cwd }, { cwd, writeScope: await scope(['.']) })).toBe(false)
  })
  it('canonicalizes missing descendants through real symlink ancestors', async () => {
    const cwd = await fixture()
    await mkdir(join(cwd, 'real'))
    await symlink(
      join(cwd, 'real'),
      join(cwd, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const left = { cwd, writeScope: await resolveWriteScope(cwd, ['real/future/a.ts']) }
    const right = { cwd, writeScope: await resolveWriteScope(cwd, ['alias/future']) }
    expect(writerConflicts(left, right)).toBe(true)
    const duplicate = await resolveWriteScope(cwd, ['real/a.ts', 'alias/a.ts'])
    expect(duplicate).toHaveLength(1)
    if (process.platform === 'win32')
      expect(await resolveWriteScope(cwd, ['REAL/A.TS'])).toEqual(duplicate)
  })
  it('locks shared output across projects and rejects invalid declarations', async () => {
    const cwd = await fixture(),
      other = await fixture()
    const output = resolve(cwd, 'output')
    expect(
      writerConflicts(
        { cwd, writeScope: await resolveWriteScope(cwd, [output]) },
        { cwd: other, writeScope: await resolveWriteScope(other, [join(output, 'build.json')]) },
      ),
    ).toBe(true)
    for (const value of [null, [], [''], ['src/*'], ['file\0name'], [42], 'src/file'])
      await expect(resolveWriteScope(cwd, value)).rejects.toThrow('writeScope')
    expect(await resolveWriteScope(cwd, undefined)).toBeUndefined()
  })

  it('does not infer project ownership from an undeclared cwd or symlink alias', async () => {
    const root = await fixture()
    const cwd = join(root, 'project')
    const alias = join(root, 'alias')
    await mkdir(cwd)
    await symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const scoped = { cwd, writeScope: await resolveWriteScope(cwd, ['src/future.ts']) }
    expect(writerConflicts(scoped, { cwd: alias })).toBe(false)
    expect(writerConflicts({ cwd: alias }, scoped)).toBe(false)
    expect(writerConflicts({ cwd }, { cwd: alias })).toBe(false)
  })
})
