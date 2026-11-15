import type { Context } from '@deepseek-ai/cordis'
import { mountRemotes } from '../shared/client/mount-remotes.ts'
import * as collaboration from '../collaboration/client/index.tsx'
export const inject = ['remote', 'slots', 'locale']
export async function apply(ctx: Context): Promise<void> {
  await mountRemotes(
    ctx,
    ['oplCoordination', 'oplRoleExecution', 'taskFeedback'],
    '@one-person-lab/dsh-collaboration',
  )
  ctx.plugin(collaboration)
}
