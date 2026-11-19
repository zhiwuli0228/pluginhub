/**
 * dsh-pluginhub — Host plugin entry point
 *
 * This is the DSH Harness plugin entry. It registers the PluginHub
 * service with the host runtime when activated as a bundle.
 */

export function apply(ctx: any, config: Record<string, unknown>) {
  ctx.log?.info?.('PluginHub: host plugin activated')

  // TODO: Register discovery engine, activation engine, invocation router
  // TODO: Register observer bus and capability index

  return () => {
    ctx.log?.info?.('PluginHub: host plugin deactivated')
  }
}
