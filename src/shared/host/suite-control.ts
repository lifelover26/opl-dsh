/** One general launch/update binding; collaboration contributes its optional operations. */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { oplProfilePath } from './profile-paths.ts'
import { setupStatus, finishSetup } from '../../setup/host/state.ts'
import { hostPeer, invokeHostRemote } from '../../compat/host/remote-invocation.ts'
import { startControlBridge } from './control-bridge.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oplExternalControl: Pick<TypertGateway, 'invoke' | 'stream'>
  }
}
export const inject = [
  'settings',
  'llm',
  'credentials',
  'agentDefaultModel',
  'typertGateway',
  'webServer',
  'connection',
]
export function apply(ctx: Context): void {
  const bridge: Pick<TypertGateway, 'invoke' | 'stream'> = {
    invoke: async (request) => {
      if (request.namespace === 'oplSuite' && request.method === 'setupUrl')
        return ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/#opl-setup`)
      if (request.namespace === 'oplSuite' && request.method === 'setupStatus')
        return setupStatus(ctx)
      if (request.namespace === 'oplSuite' && request.method === 'finishSetup') {
        const state = await setupStatus(ctx)
        const choice = state.choice === 'undecided' ? 'gateway' : state.choice
        await finishSetup(ctx, choice)
        return { completed: true, choice }
      }
      if (request.namespace === 'oplGatewayAccount') return invokeHostRemote(ctx, request)
      const port = ctx.get('oplExternalControl')
      if (!port) throw Error('OPL 跨引擎协作未启用')
      return port.invoke(request)
    },
    stream: (request) => {
      const port = ctx.get('oplExternalControl')
      if (!port) throw Error('OPL 跨引擎协作未启用')
      return port.stream(request)
    },
  }
  ctx.effect(() =>
    startControlBridge(bridge, hostPeer(ctx), oplProfilePath(undefined, 'control.json')),
  )
}
