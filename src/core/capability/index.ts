/**
 * Canonical Capability module — public API surface.
 *
 * Re-exports the unified capability types, the adapter contract, and all
 * built-in protocol adapters.
 *
 * @module
 */

// Types & adapter contract
export type {
  AdapterContext,
  CanonicalCapability,
  CapabilityAdapter,
  CapabilityKind,
  ExecutionMode,
  LatencyHint,
  ProtocolId,
  TrustLevel,
} from './types.js';

// Built-in adapters
export { A2AAdapter } from './a2a-adapter.js';
export { McpToolAdapter } from './mcp-adapter.js';
export { SkillsAdapter } from './skills-adapter.js';
