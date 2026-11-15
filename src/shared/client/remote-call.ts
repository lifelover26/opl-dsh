import type { RemoteResult, TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../generated/remote.mjs'
type Args<F> = F extends (...args: infer A) => unknown ? A : never
type Value<F> = F extends (...args: never[]) => Promise<RemoteResult<infer T>> ? T : never
export type RemoteCall<M> = <K extends keyof M>(
  method: K,
  ...args: Args<M[K]>
) => Promise<Value<M[K]>>
export type OptionalRequestRemoteCall<M> = <K extends keyof M>(
  method: K,
  ...args: M[K] extends (request: infer R) => unknown
    ? Record<string, never> extends R
      ? [request?: R]
      : Args<M[K]>
    : Args<M[K]>
) => Promise<Value<M[K]>>
export type RemoteCallInput<M> = RemoteCall<M> | OptionalRequestRemoteCall<M>
export type ExecutionCall = RemoteCall<TypertRemoteNamespace<'oplExecution'>>
export type GatewayCall = RemoteCall<TypertRemoteNamespace<'oplGatewayModels'>>
export type CoordinationCall = RemoteCall<TypertRemoteNamespace<'oplCoordination'>>
export type RoleExecutionCall = RemoteCall<TypertRemoteNamespace<'oplRoleExecution'>>
export type SetupCall = RemoteCall<TypertRemoteNamespace<'oplSetup'>>
/** Probe an optional namespace without requiring it for the feature lifecycle. */
export function optionalRemote<K extends keyof TypertRemoteNamespaceMap>(
  ctx: Context,
  name: K,
): TypertRemoteNamespaceMap[K] | undefined {
  return ctx.get(`remote.${name}`) as TypertRemoteNamespaceMap[K] | undefined
}
/** Keep generated method arguments and result inference through the component boundary. */
export function remoteCall<M>(namespace: M): RemoteCall<M> {
  return (async (method: keyof M, ...args: unknown[]) => {
    const invoke = namespace[method] as (
      this: M,
      ...args: unknown[]
    ) => Promise<RemoteResult<unknown>>
    const result = await invoke.apply(namespace, args)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }) as RemoteCall<M>
}
