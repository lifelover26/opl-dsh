import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { coordinationAction } from './settings.ts'
import type { CoordinationStatus, WakeSettings } from '../../contracts/types.ts'
declare module '@deepseek-ai/cordis' {
  interface Context {
    oplCoordination: CoordinationService
  }
}
/** Installation and external Skill management have no Gateway dependency. */
export class CoordinationService extends TypertRemoteService {
  static inject = ['settings']
  constructor(ctx: Context) {
    super(ctx, 'oplCoordination')
  }
  @Remote('coordination-status')
  async status(): Promise<CoordinationStatus> {
    return (await coordinationAction(
      this.ctx,
      'coordination-status',
      undefined,
    )) as CoordinationStatus
  }
  @Remote('skill-install')
  async installSkill(): Promise<null> {
    await coordinationAction(this.ctx, 'skill-install', undefined)
    return null
  }
  @Remote('superagent-open')
  async openSuperagent(): Promise<{ state: string }> {
    return (await coordinationAction(this.ctx, 'superagent-open', undefined)) as { state: string }
  }
  @Remote('auto-start')
  async autoStart(enabled: boolean): Promise<null> {
    await coordinationAction(this.ctx, 'auto-start', enabled)
    return null
  }
  @Remote('wake-settings')
  async wakeSettings(settings: WakeSettings): Promise<null> {
    await coordinationAction(this.ctx, 'wake-settings', settings)
    return null
  }
}
