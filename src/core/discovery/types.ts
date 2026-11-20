/**
 * Discovery Engine type definitions.
 *
 * Defines the data shapes for discovered plugin/agent entries, discovery
 * sources, and engine configuration.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Discovery Source
// ---------------------------------------------------------------------------

/** Source priority for discovery. */
export type DiscoverySource = 'local' | 'well-known' | 'registry' | 'scan';

// ---------------------------------------------------------------------------
// Discovered Entry
// ---------------------------------------------------------------------------

/** Supported protocol identifiers for discovered entries. */
export type DiscoveredProtocol =
  | 'mcp'
  | 'a2a'
  | 'skills'
  | 'agent-plugins'
  | 'openapi'
  | 'unknown';

/** A mirror location for a discovered entry. */
export interface MirrorLocation {
  /** Where this mirror was found. */
  source: DiscoverySource;
  /** Source-specific location (file path, URL, registry name). */
  location: string;
}

/**
 * A discovered plugin/agent entry before activation.
 *
 * Represents a single discoverable unit from any source. Entries are deduplicated
 * by their `id` — when the same plugin is found at multiple locations, the entry
 * with the highest trust score wins and alternative locations are recorded as mirrors.
 */
export interface DiscoveredEntry {
  /** Unique key: `(publisher.domain, metadata.id)` or generated. */
  id: string;

  /** Display name. */
  name: string;

  /** Where this entry was originally found. */
  source: DiscoverySource;

  /** Source-specific location (file path, URL, registry name). */
  location: string;

  /** Raw manifest or descriptor object. */
  raw: unknown;

  /** Protocol that describes this entry. */
  protocol: DiscoveredProtocol;

  /** Trust score: 0 (untrusted) to 100 (fully trusted). */
  trustScore: number;

  /** When this entry was discovered. */
  discoveredAt: Date;

  /** Alternative locations for the same plugin (mirrors). */
  mirrors?: MirrorLocation[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the discovery engine.
 *
 * All fields are optional — sensible defaults are applied when omitted.
 */
export interface DiscoveryConfig {
  /** Directories to scan for local plugins. */
  localPaths?: string[];

  /** Request timeout for network discovery in milliseconds. Default: 5000. */
  requestTimeoutMs?: number;

  /** Maximum concurrent network requests. Default: 10. */
  maxConcurrency?: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Map of event names emitted by {@link DiscoveryEngine} to their payload types. */
export interface DiscoveryEvents {
  /** Emitted when a new entry is added to the index. */
  entryAdded: DiscoveredEntry;

  /** Emitted when an entry is removed from the index. */
  entryRemoved: DiscoveredEntry;

  /** Emitted when an existing entry is updated (e.g., higher trust score). */
  entryUpdated: DiscoveredEntry;

  /** Emitted after a full discovery cycle completes. */
  discoveryComplete: DiscoveredEntry[];
}
