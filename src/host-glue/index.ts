/**
 * Host Glue — public API surface.
 *
 * Re-exports the {@link PluginHubFacade}, its configuration/status types,
 * and the DSH tool definition factory.
 *
 * @module
 */

// Facade
export { PluginHubFacade } from './facade.js';
export type { PluginHubConfig, PluginHubStatus } from './facade.js';

// DSH Tools
export { createDshTools } from './dsh-tools.js';
export type { DshToolDefinition } from './dsh-tools.js';
