import { expect, it } from 'vitest'
import { restoreLaunchFailure } from '../../src/updates/host/runtime.ts'

const current = { suiteVersion: '0.2.55', officialVersion: '0.2.2-rc.1' }
const pending = { preparedAt: '2026-11-07T10:00:00Z' }
const failure = { state: 'deferred', checkedAt: '2026-11-07T10:01:00Z' }

it('restores a failed launch after the Host restarts, keeping the pending plan separate', () => {
  const stored = {
    installedVersion: current.suiteVersion,
    officialVersion: current.officialVersion,
    checkedAt: '2026-11-07T09:00:00Z',
  }
  expect(restoreLaunchFailure(stored, failure, pending, current)).toEqual({
    ...stored,
    error: 'prepare-failed',
  })
  expect(restoreLaunchFailure(null, failure, pending, current)).toEqual({
    installedVersion: current.suiteVersion,
    officialVersion: current.officialVersion,
    error: 'prepare-failed',
  })
})

it('does not revive a failure after cancellation, success, or a newly prepared update', () => {
  const stored = { error: null }
  expect(restoreLaunchFailure(stored, failure, null, current)).toBe(stored)
  expect(restoreLaunchFailure(stored, { ...failure, state: 'updated' }, pending, current)).toBe(
    stored,
  )
  expect(
    restoreLaunchFailure(stored, failure, { preparedAt: '2026-11-07T10:02:00Z' }, current),
  ).toBe(stored)
})

it('does not reuse an offer cached for a different installed runtime', () => {
  expect(
    restoreLaunchFailure(
      { installedVersion: '0.1.0', release: { version: '0.2.0' } },
      failure,
      pending,
      current,
    ),
  ).toEqual({
    installedVersion: current.suiteVersion,
    officialVersion: current.officialVersion,
    error: 'prepare-failed',
  })
  expect(
    restoreLaunchFailure(null, { state: 'deferred', checkedAt: 'invalid' }, pending, current),
  ).toBeNull()
})
