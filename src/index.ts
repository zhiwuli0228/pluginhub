/**
 * dsh-pluginhub — Host plugin entry point
 *
 * This is the DSH Harness plugin entry. It registers the PluginHub
 * service with the host runtime when activated as a bundle.
 *
 * Only this file (and future DSH-specific adapters) may import from
 * `@deepseek-ai/*`. The host-glue layer itself remains framework-agnostic.
 */

import { PluginHubFacade, type PluginHubConfig } from './host-glue/index.js';

let facade: PluginHubFacade | null = null;

/**
 * DSH host plugin activation hook.
 *
 * Creates and initializes the {@link PluginHubFacade}, then returns a
 * teardown function that the host calls on deactivation.
 *
 * @param ctx - DSH host context (provides logging, tool registration, etc.).
 * @param config - Plugin configuration forwarded to the facade.
 * @returns Async teardown function.
 */
export function apply(ctx: any, config: Record<string, unknown>) {
  facade = new PluginHubFacade(config as PluginHubConfig | undefined);
  facade.initialize().catch((err: unknown) => {
    ctx.log?.error?.('PluginHub init failed', err);
  });

  // TODO: Register tools via ctx when DSH tool registration API is available.
  // Example (future):
  //   const tools = createDshTools(facade);
  //   for (const tool of tools) { ctx.registerTool(tool); }

  ctx.log?.info?.('PluginHub: host plugin activated');

  return async () => {
    await facade?.shutdown();
    facade = null;
    ctx.log?.info?.('PluginHub: host plugin deactivated');
  };
}
