/** Manage the installed collaboration Skill without changing the desktop profile. */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { installationPaths } from '../../../installer/installation-paths.mjs'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const receiptPath = () => join(dshHomePath(), 'opl-dsh', 'installation.json')
async function installation() {
  return installationPaths(JSON.parse(await readFile(receiptPath(), 'utf8')), {
    profileHome: dshHomePath(),
  })
}
export async function coordinationAction(
  ctx: Context,
  action: string,
  payload: unknown,
): Promise<unknown> {
  const installed = await installation()
  if (action === 'coordination-status') {
    const config = JSON.parse(
      await readFile(join(installed.skillDir, 'config.json'), 'utf8').catch(() => '{}'),
    ) as { autoStart?: boolean; home?: string }
    const state = await readFile(
      join(installed.suiteRoot, 'enhancement-update.json'),
      'utf8',
    ).catch(() => '{}')
    const settings = ctx.settings.describe().find((item) => item.ns === 'opl-suite')?.value as {
      wakeTransport?: string
      wakeExecutable?: string
      wakeExecution?: string
      wakeDistro?: string
    }
    return {
      installed: config.home === installed.home,
      autoStart: config.autoStart !== false,
      version: process.env.OPL_OFFICIAL_VERSION ?? installed.officialVersion ?? 'unknown',
      enhancementVersion: installed.suiteVersion ?? 'unknown',
      superagentSupported: process.platform === 'darwin',
      update: { ...JSON.parse(state), checkTrigger: 'maintenance-launcher' },
      paths: {
        suiteRoot: installed.suiteRoot,
        profileHome: installed.profileHome,
        skillDir: installed.skillDir,
      },
      wakeTransport: settings?.wakeTransport ?? 'unconnected',
      wakeExecution: settings?.wakeExecution ?? 'native',
      wakeExecutable: settings?.wakeExecutable ?? '',
      wakeDistro: settings?.wakeDistro ?? '',
    }
  }
  if (action === 'superagent-open') {
    const module = (await import(
      pathToFileURL(join(installed.release, 'superagent.mjs')).href
    )) as { openSuperagent: (installation: object) => Promise<{ state: string }> }
    return module.openSuperagent(installed)
  }
  if (action === 'skill-install') {
    const module = (await import(
      pathToFileURL(join(installed.release, 'skill-install.mjs')).href
    )) as { installSkill: (options: object) => string }
    const executable =
      process.platform === 'win32'
        ? join(installed.app, 'DeepSeek Harness.exe')
        : join(installed.app, 'Contents/MacOS/DeepSeek Harness')
    module.installSkill({
      executable,
      ...installed,
      root: installed.suiteRoot,
      codexHome: dirname(dirname(installed.skillDir)),
    })
    return null
  }
  if (action === 'auto-start' && typeof payload === 'boolean') {
    const file = join(installed.skillDir, 'config.json'),
      marker = join(installed.skillDir, '.opl-install.json')
    const original = await readFile(file, 'utf8'),
      manifest = JSON.parse(await readFile(marker, 'utf8'))
    if (manifest.owner !== 'opl-dsh-suite' || manifest.files['config.json'] !== digest(original))
      throw new Error('Skill 已被手动修改，已保留')
    const next = JSON.stringify({ ...JSON.parse(original), autoStart: payload }, null, 2) + '\n'
    await writeFile(file + '.tmp', next, { mode: 0o600 })
    await rename(file + '.tmp', file)
    manifest.files['config.json'] = digest(next)
    await writeFile(marker, JSON.stringify(manifest) + '\n', { mode: 0o600 })
    return null
  }
  if (action === 'wake-settings' && payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>
    if (
      !['unconnected', 'codex-queue'].includes(String(p.wakeTransport)) ||
      !['native', 'wsl'].includes(String(p.wakeExecution)) ||
      typeof p.wakeExecutable !== 'string' ||
      typeof p.wakeDistro !== 'string'
    )
      throw new Error('无效的回调配置')
    await ctx.settings.update('opl-suite', {
      wakeTransport: p.wakeTransport,
      wakeExecution: p.wakeExecution,
      wakeExecutable: p.wakeExecutable,
      wakeDistro: p.wakeDistro,
    })
    return null
  }
  throw new Error('未知协作设置操作')
}
