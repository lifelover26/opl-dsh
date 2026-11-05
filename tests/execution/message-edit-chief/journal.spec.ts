import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { FileExternalEditJournal } from '../../../src/execution/host/message-edit-external-store.ts'
import type { ExternalEditIntent } from '../../../src/execution/host/message-edit-external.ts'

const intent: ExternalEditIntent = {
  version: 1,
  sessionId: 'dsh',
  recordId: 'record',
  requestId: 'edit',
  fingerprint: 'hash',
  previousSessionId: 'vendor',
  targetId: 'a',
  expected: { sessionId: 'vendor', token: 'before', boundaries: [{ id: 'a' }] },
  phase: 'invoking',
}
const stores: FileExternalEditJournal[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.drain()))
  await Promise.all(roots.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'opl-edit-journal-'))
  roots.push(home)
  const store = new FileExternalEditJournal(home)
  stores.push(store)
  return { home, store, directory: join(home, 'profiles/desktop/external-message-edit-intents') }
}
const filename = createHash('sha256').update('dsh').digest('hex') + '.json'

describe('external edit journal persistence', () => {
  it('keeps exact vendor image counts across restart and rejects damaged counts', async () => {
    const { home, store, directory } = await fixture()
    const withImages = {
      ...intent,
      expected: { ...intent.expected, boundaries: [{ id: 'a', imageCount: 2 }] },
    }
    await store.save(withImages)
    const restarted = new FileExternalEditJournal(home)
    await restarted.load()
    expect(restarted.get('dsh')).toEqual(withImages)
    await writeFile(
      join(directory, filename),
      JSON.stringify({
        ...withImages,
        expected: { ...withImages.expected, boundaries: [{ id: 'a', imageCount: -1 }] },
      }),
    )
    await expect(restarted.load()).rejects.toThrow('损坏')
    expect(restarted.get('dsh')?.expected.boundaries[0]?.imageCount).toBe(2)
  })
  it('retains the exact optional native target and rejects invalid sequence values', async () => {
    const { home, store, directory } = await fixture()
    await store.save({ ...intent, targetSeq: 17 })
    const restarted = new FileExternalEditJournal(home)
    await restarted.load()
    expect(restarted.get('dsh')?.targetSeq).toBe(17)
    await writeFile(join(directory, filename), JSON.stringify({ ...intent, targetSeq: -1 }))
    await expect(restarted.load()).rejects.toThrow('损坏')
  })
  it('restores an invoking intent after a new owner loads it', async () => {
    const { home, store } = await fixture()
    await store.save(intent)
    const restarted = new FileExternalEditJournal(home)
    await restarted.load()
    expect(restarted.get('dsh')).toEqual(intent)
    const copy = restarted.get('dsh')!
    copy.phase = 'settled'
    expect(restarted.get('dsh')?.phase).toBe('invoking')
  })
  it('refuses a durable intent whose filename belongs to another session', async () => {
    const { store, directory } = await fixture()
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, filename), JSON.stringify({ ...intent, sessionId: 'other' }))
    await expect(store.load()).rejects.toThrow('身份不符')
    expect(await readFile(join(directory, filename), 'utf8')).toContain('other')
  })
  it('refuses ready state without a confirmed vendor result', async () => {
    const { store, directory } = await fixture()
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, filename), JSON.stringify({ ...intent, phase: 'ready' }))
    await expect(store.load()).rejects.toThrow('历史身份不一致')
  })
  it('does not release guards after storage becomes unavailable', async () => {
    const { store, home } = await fixture()
    await writeFile(join(home, 'profiles'), 'blocked directory')
    await expect(store.save(intent)).rejects.toThrow()
    expect(() => store.get('dsh')).toThrow('未能保存')
    await expect(store.save({ ...intent, phase: 'uncertain' })).rejects.toThrow('未能保存')
  })
})
