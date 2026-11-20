/**
 * Discovery Engine — public API surface.
 *
 * Re-exports the discovery types and the {@link DiscoveryEngine} class.
 *
 * @module
 */

// Types
export type {
  DiscoverySource,
  DiscoveredProtocol,
  MirrorLocation,
  DiscoveredEntry,
  DiscoveryConfig,
  DiscoveryEvents,
} from './types.js';

// Engine
export { DiscoveryEngine } from './discovery-engine.js';
