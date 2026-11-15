import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import remote from '../../generated/remote.mjs'

/** Each independently unloaded Client owns only its own Remote namespaces. */
export async function mountRemotes(
  ctx: Context,
  namespaces: string[],
  packageName = remote.package,
): Promise<void> {
  const dispose = await ctx.remote.$mount({
    package: packageName,
    descriptors: remote.descriptors
      .filter((descriptor) => namespaces.includes(descriptor.namespace))
      .map((descriptor) => ({
        ...descriptor,
        id: `${packageName}#${descriptor.namespace}/${descriptor.method}`,
      })),
  })
  ctx.effect(() => dispose)
}
