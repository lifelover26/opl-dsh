import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPostExitUpdate } from '../installer/post-exit-update.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hostPid = 71001
const desktopPid = 71002

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opl-post-exit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pending = Buffer.from(
    JSON.stringify({ version: '0.2.67', preparedAt: '2026-11-16T00:00:00.000Z' }),
  )
  const path = join(root, 'enhancement-pending.json')
  await writeFile(path, pending)
  return { root, path, expected: digest(pending) }
}

test('reserves the profile lock before waiting and updates once after every process exits', async (t) => {
  const value = await fixture(t)
  const steps = []
  let hostAlive = true
  let desktopAlive = true
  let officialAlive = true
  let released = false
  const result = await runPostExitUpdate(
    {
      root: value.root,
      application: '/tmp/DeepSeek Harness.app',
      profileHome: '/tmp/profile',
      expected: value.expected,
      hostPid,
      desktopPid,
    },
    {
      alive: (pid) => {
        assert.equal(released, false)
        return pid === hostPid ? hostAlive : desktopAlive
      },
      lock: async () => {
        steps.push('lock')
        return async () => {
          released = true
          steps.push('unlock')
        }
      },
      processes: async () => (officialAlive ? [72001] : []),
      wait: async () => {
        steps.push('wait')
        hostAlive = false
        desktopAlive = false
        officialAlive = false
      },
      apply: async (root, application, options) => {
        assert.equal(released, false)
        assert.equal(root, value.root)
        assert.equal(application, '/tmp/DeepSeek Harness.app')
        assert.deepEqual(options, {
          expectedPendingSha256: value.expected,
          trigger: 'post-exit',
        })
        steps.push('apply')
        await rm(value.path)
      },
    },
  )
  assert.equal(result, 'updated')
  assert.deepEqual(steps, ['lock', 'wait', 'apply', 'unlock'])
})

test('releases a deferred lock without applying a replaced pending plan', async (t) => {
  const value = await fixture(t)
  let expected = value.expected
  let releaseCount = 0
  const result = await runPostExitUpdate(
    {
      root: value.root,
      application: '/tmp/DeepSeek Harness.app',
      profileHome: '/tmp/profile',
      expected,
      hostPid,
      desktopPid,
    },
    {
      alive: () => false,
      lock: async () => async () => {
        releaseCount++
      },
      processes: async () => [],
      wait: async () => {},
      apply: async () => {
        await writeFile(value.path, '{"version":"0.2.68"}')
        expected = digest(await readFile(value.path))
      },
    },
  )
  assert.equal(result, 'deferred')
  assert.equal(releaseCount, 1)
})

test('waits while the profile lock is owned instead of stealing it', async (t) => {
  const value = await fixture(t)
  let attempts = 0
  const result = await runPostExitUpdate(
    {
      root: value.root,
      application: '/tmp/DeepSeek Harness.app',
      profileHome: '/tmp/profile',
      expected: value.expected,
      hostPid,
      desktopPid,
    },
    {
      alive: () => false,
      lock: async () => (++attempts === 1 ? null : async () => {}),
      processes: async () => [],
      wait: async () => {},
      apply: async () => {
        await rm(value.path)
      },
    },
  )
  assert.equal(result, 'updated')
  assert.equal(attempts, 2)
})

test('stops waiting for a profile lock when the prepared plan is cancelled', async (t) => {
  const value = await fixture(t)
  let attempts = 0
  const result = await runPostExitUpdate(
    {
      root: value.root,
      application: '/tmp/DeepSeek Harness.app',
      profileHome: '/tmp/profile',
      expected: value.expected,
      hostPid,
      desktopPid,
    },
    {
      lock: async () => {
        attempts++
        return null
      },
      wait: async () => rm(value.path),
      apply: () => assert.fail('a cancelled plan cannot install'),
    },
  )
  assert.equal(result, 'changed')
  assert.equal(attempts, 1)
})
