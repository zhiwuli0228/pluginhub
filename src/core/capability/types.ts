/**
 * Canonical Capability — unified capability model for PluginHub.
 *
 * All protocol-specific capability descriptions (MCP tools, Agent Skills,
 * A2A agents, OpenAPI operations, etc.) are normalized to this single
 * interface so that downstream consumers (routing, security evaluation,
 * UI rendering) can operate on a consistent shape.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Canonical Capability
// ---------------------------------------------------------------------------

/** Supported capability kinds across all protocols. */
export type CapabilityKind =
  | 'tool'
  | 'skill'
  | 'agent'
  | 'workflow'
  | 'resource'
  | 'app';

/** Supported source protocols. */
export type ProtocolId =
  | 'mcp'
  | 'skills'
  | 'a2a'
  | 'openapi'
  | 'arazzo'
  | 'oasf';

/** Execution mode of a capability. */
export type ExecutionMode = 'sync' | 'stream' | 'task';

/** Latency hint bucket for routing decisions. */
export type LatencyHint = 'instant' | 'seconds' | 'minutes' | 'hours';

/** Trust classification carried from the security layer. */
export type TrustLevel = 'self-asserted' | 'verified-untrusted' | 'trusted';

/** Unified capability model — all protocols normalize to this. */
export interface CanonicalCapability {
  /** Globally unique stable ID: `<pluginId>/<componentId>/<member>` */
  id: string;

  /** Capability kind. */
  kind: CapabilityKind;

  /** Display information for UI and search. */
  display: {
    /** Human-readable name. */
    name: string;
    /** Short description / summary. */
    summary: string;
    /** Optional usage examples. */
    examples?: string[];
  };

  /** Input/output schemas (`null` for capabilities without parameter contracts). */
  io: {
    /** JSON Schema for input parameters, or `null`. */
    inputSchema: Record<string, unknown> | null;
    /** JSON Schema for output structure, or `null`. */
    outputSchema: Record<string, unknown> | null;
    /** Accepted input MIME types / modes. */
    inputModes?: string[];
    /** Produced output MIME types / modes. */
    outputModes?: string[];
  };

  /** Side-effect semantics (from MCP annotations or inferred). */
  semantics: {
    /** The capability does not modify external state. */
    readOnly: boolean;
    /** The capability may perform destructive operations. */
    destructive: boolean;
    /** Repeated invocations with the same arguments produce the same effect. */
    idempotent: boolean;
    /** The capability interacts with entities outside the local environment. */
    openWorld: boolean;
    /** The capability requires explicit user approval before execution. */
    requiresApproval: boolean;
  };

  /** Execution characteristics. */
  execution: {
    /** How the capability is invoked. */
    mode: ExecutionMode;
    /** Suggested timeout in seconds. */
    timeoutSeconds?: number;
    /** Whether concurrent invocations are safe. */
    concurrencySafe: boolean;
  };

  /** Cost hints for routing decisions. */
  cost?: {
    /** Estimated token consumption per invocation. */
    tokensHint?: number;
    /** Expected latency bucket. */
    latencyHint?: LatencyHint;
  };

  /** Provenance — MUST preserve original object untouched. */
  provenance: {
    /** Source protocol identifier. */
    protocol: ProtocolId;
    /** Original description object, preserved as-is. */
    native: unknown;
    /** Semantic version of the adapter that produced this record. */
    adapterVersion: string;
  };

  /** Trust status from security evaluation. */
  trust: {
    /** Resolved trust level. */
    status: TrustLevel;
    /** Publisher domain or identity, when available. */
    publisher?: string;
  };
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

/** Context passed to adapters during conversion. */
export interface AdapterContext {
  /** Owning plugin identifier. */
  pluginId: string;
  /** Component identifier within the plugin. */
  componentId: string;
  /** Pre-evaluated trust status. */
  trustStatus: TrustLevel;
  /** Optional publisher domain for provenance. */
  publisherDomain?: string;
}

/**
 * Adapter interface — each protocol implements this to convert its native
 * capability description into the canonical form.
 *
 * @typeParam TNative - The protocol-specific capability description type.
 */
export interface CapabilityAdapter<TNative> {
  /** Protocol identifier this adapter handles. */
  readonly protocol: ProtocolId;
  /** Semantic version of this adapter implementation. */
  readonly adapterVersion: string;

  /** Convert a native capability description to canonical form. */
  adapt(native: TNative, context: AdapterContext): CanonicalCapability;
}
