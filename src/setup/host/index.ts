import { invokeHostRemote } from '../../compat/host/remote-invocation.ts'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { setupStatus, finishSetup } from './state.ts'
import type { SetupStatus, LoginChoice } from '../contracts.ts'
import { nativeShellStatus, selectNativeShell } from '../../shell/host/selection.ts'
import type { NativeShellStatus } from '../../shell/contracts/selection.ts'
declare module '@deepseek-ai/cordis' {
  interface Context {
    oplSetup: SetupService
  }
}
/** First-run owns account choice only; other features mount independently. */
export class SetupService extends TypertRemoteService {
  static inject = [
    'settings',
    'llm',
    'credentials',
    'agentDefaultModel',
    'typertGateway',
    'webServer',
  ]
  constructor(ctx: Context) {
    super(ctx, 'oplSetup')
  }
  @Remote('native-shell')
  nativeShell(): NativeShellStatus {
    return nativeShellStatus(this.ctx)
  }
  @Remote('select-native-shell')
  selectNativeShell(enabled: boolean): Promise<NativeShellStatus> {
    return selectNativeShell(this.ctx, enabled)
  }
  @Remote('status')
  status(): Promise<SetupStatus> {
    return setupStatus(this.ctx)
  }
  @Remote('finish')
  async finish(choice: Exclude<LoginChoice, 'undecided'>): Promise<null> {
    await finishSetup(this.ctx, choice)
    return null
  }
  @Remote('official-start')
  async startOfficial(): Promise<null> {
    await invokeHostRemote(this.ctx, {
      namespace: 'account',
      method: 'startSignIn',
      args: {
        client: {
          version: process.env.OPL_OFFICIAL_VERSION ?? '0.0.0',
          locale: 'zh',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        },
        callbackOrigin: `http://127.0.0.1:${this.ctx.webServer.port}`,
        loginSource: 'desktop',
      },
    })
    return null
  }
  @Remote('official-cancel')
  async cancelOfficial(): Promise<null> {
    const state = (await invokeHostRemote(this.ctx, {
      namespace: 'account',
      method: 'getState',
      args: {},
    })) as { attempt?: { id?: string } }
    if (state.attempt?.id)
      await invokeHostRemote(this.ctx, {
        namespace: 'account',
        method: 'cancelSignIn',
        args: { attemptId: state.attempt.id },
      })
    return null
  }
  @Remote('official-key')
  async saveOfficialKey(key: string): Promise<null> {
    if (!key.trim() || key.length > 4096) throw Error('密钥无效')
    const config = this.ctx.settings.describe().find((item) => item.ns === 'llm-deepseek')
      ?.value as { apiKeyEnv?: string } | undefined
    if (!config?.apiKeyEnv) throw Error('官方模型配置暂不可用')
    await this.ctx.credentials.set(credentialRef(config.apiKeyEnv), key.trim())
    await finishSetup(this.ctx, 'official')
    return null
  }
}
