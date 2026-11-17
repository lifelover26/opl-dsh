import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
const state = vi.hoisted(() => ({ home: '' }))
vi.mock('@deepseek-ai/dsh-home-paths', () => ({ dshHomePath: () => state.home }))
import { coordinationAction } from '../../src/collaboration/host/settings.ts'
let base: string

afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true })
})
it('reads the Suite updater state from a legacy profile receipt, not a profile-local lookalike', async () => {
  base = await mkdtemp(join(tmpdir(), 'opl-coordination-paths-'))
  state.home = join(base, 'profile')
  const suiteRoot = join(base, 'suite'),
    skillDir = join(base, 'codex', 'skills', 'opl-dsh-official')
  for (const dir of [suiteRoot, skillDir, join(state.home, 'opl-dsh')])
    await mkdir(dir, { recursive: true })
  await writeFile(
    join(state.home, 'opl-dsh', 'installation.json'),
    JSON.stringify({
      home: state.home,
      release: join(suiteRoot, 'releases', 'old'),
      skillDir,
      officialVersion: '1.0.0',
    }),
  )
  await writeFile(
    join(skillDir, 'config.json'),
    JSON.stringify({ home: state.home, autoStart: false }),
  )
  await writeFile(
    join(suiteRoot, 'enhancement-update.json'),
    JSON.stringify({ state: 'updated', version: '0.3.0' }),
  )
  await writeFile(
    join(state.home, 'opl-dsh', 'enhancement-update.json'),
    JSON.stringify({ state: 'wrong-directory' }),
  )
  const ctx = { settings: { describe: () => [] } } as unknown as Context
  expect(await coordinationAction(ctx, 'coordination-status', undefined)).toMatchObject({
    installed: true,
    autoStart: false,
    update: { state: 'updated', version: '0.3.0', checkTrigger: 'maintenance-launcher' },
    superagentSupported: process.platform === 'darwin' || process.platform === 'linux',
    paths: { suiteRoot, profileHome: state.home, skillDir },
  })
})
