/**
 * Discovery Engine — collects, deduplicates, scores, and indexes plugin/agent
 * descriptions from multiple sources.
 *
 * Sources (in priority order):
 * 1. **local** — explicit local directories containing plugin manifests
 * 2. **well-known** — `/.well-known/` endpoints on publisher domains
 * 3. **registry** — external registries (MCP registry, Agntcy, AI Catalog)
 * 4. **scan** — heuristic filesystem scanning without a manifest
 *
 * Deduplication uses the entry `id`. When the same ID appears from multiple
 * sources the entry with the highest trust score wins; other locations are
 * recorded as mirrors.
 *
 * @module
 */

import { EventEmitter } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { PluginManifest } from '../manifest/types.js';
import type {
  DiscoveryConfig,
  DiscoveredEntry,
  DiscoveredProtocol,
  DiscoveryEvents,
  DiscoverySource,
  MirrorLocation,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default request timeout for network discovery (ms). */
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/** Default maximum concurrent network requests. */
const DEFAULT_MAX_CONCURRENCY = 10;

/** Manifest filenames recognised during local scanning. */
const MANIFEST_FILENAMES = ['plugin.yaml', 'plugin.yml', 'plugin.json'];

/** Skill descriptor filename. */
const SKILL_FILENAME = 'SKILL.md';

// ---------------------------------------------------------------------------
// Trust scoring helpers
// ---------------------------------------------------------------------------

/**
 * Compute a simplified trust score for a discovered entry.
 *
 * | Source       | Condition              | Score |
 * |-------------|------------------------|-------|
 * | local       | trusted publisher      | 90    |
 * | local       | self-asserted          | 70    |
 * | well-known  | HTTPS                  | 60    |
 * | registry    | —                      | 50    |
 * | scan        | no manifest            | 30    |
 *
 * @param source   - The discovery source.
 * @param hasTrustedPublisher - Whether the manifest declares a verified publisher.
 * @param isHttps  - Whether the location uses HTTPS.
 */
function computeTrustScore(
  source: DiscoverySource,
  hasTrustedPublisher: boolean,
  isHttps: boolean,
): number {
  switch (source) {
    case 'local':
      return hasTrustedPublisher ? 90 : 70;
    case 'well-known':
      return isHttps ? 60 : 40;
    case 'registry':
      return 50;
    case 'scan':
      return 30;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Protocol detection
// ---------------------------------------------------------------------------

/**
 * Infer the protocol from a raw manifest or descriptor object.
 *
 * @param raw - The parsed manifest / descriptor.
 */
function inferProtocol(raw: unknown): DiscoveredProtocol {
  if (raw == null || typeof raw !== 'object') return 'unknown';

  const obj = raw as Record<string, unknown>;

  // Plugin Manifest v1alpha1
  if (obj.apiVersion === 'plugin.agenthub.io/v1alpha1' && obj.kind === 'Plugin') {
    const manifest = raw as PluginManifest;
    if (manifest.components?.mcpServers?.length) return 'mcp';
    if (manifest.components?.agents?.length) return 'a2a';
    if (manifest.components?.skills?.length) return 'skills';
    if (manifest.components?.openapi?.length) return 'openapi';
    return 'agent-plugins';
  }

  // MCP server descriptor (mcp.json)
  if (typeof obj.mcpServers === 'object' || typeof obj.tools === 'object') return 'mcp';

  // A2A agent card
  if (obj.protocol === 'a2a' || typeof obj.agentCard === 'object') return 'a2a';

  // OpenAPI
  if (typeof obj.openapi === 'string' || typeof obj.swagger === 'string') return 'openapi';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Entry ID generation
// ---------------------------------------------------------------------------

/**
 * Build a stable entry ID from a manifest or fallback to protocol + location.
 *
 * @param manifest - Parsed manifest (may be undefined for scan results).
 * @param protocol - Detected protocol.
 * @param location - Source-specific location string.
 */
function buildEntryId(
  manifest: PluginManifest | undefined,
  protocol: DiscoveredProtocol,
  location: string,
): string {
  if (manifest?.metadata) {
    const domain = manifest.metadata.publisher?.domain ?? '_';
    return `${domain}/${manifest.metadata.id}`;
  }
  // Fallback: hash-free deterministic key from protocol + location
  return `${protocol}::${location}`;
}

// ---------------------------------------------------------------------------
// DiscoveryEngine
// ---------------------------------------------------------------------------

/**
 * Collects plugin/agent descriptions from multiple sources, deduplicates them,
 * assigns trust scores, and maintains a unified in-memory index.
 *
 * @example
 * ```ts
 * const engine = new DiscoveryEngine({ localPaths: ['./plugins'] });
 * const entries = await engine.discoverAll();
 * console.log(`Found ${entries.length} plugins`);
 * ```
 */
export class DiscoveryEngine extends EventEmitter {
  /** Internal entry store keyed by entry ID. */
  private readonly _entries: Map<string, DiscoveredEntry> = new Map();

  /** Engine configuration with defaults applied. */
  private readonly _config: Required<DiscoveryConfig>;

  constructor(config?: DiscoveryConfig) {
    super();
    this._config = {
      localPaths: config?.localPaths ?? [],
      requestTimeoutMs: config?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxConcurrency: config?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Discover from all configured sources in parallel.
   *
   * Runs local scanning and (when implemented) well-known / registry discovery
   * concurrently, then merges results into the index.
   *
   * @returns All known entries after discovery completes.
   */
  async discoverAll(): Promise<DiscoveredEntry[]> {
    const tasks: Array<Promise<DiscoveredEntry[]>> = [];

    // Local paths
    if (this._config.localPaths.length > 0) {
      tasks.push(this.scanLocal());
    }

    // Future: well-known and registry discovery will be added here.

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const entry of result.value) {
          this._mergeEntry(entry);
        }
      }
    }

    const allEntries = this.getEntries();
    this.emit('discoveryComplete', allEntries);
    return allEntries;
  }

  /**
   * Discover plugins from a specific domain via well-known endpoints.
   *
   * Currently returns an empty array — will integrate with WellKnownProber
   * once that module is implemented.
   *
   * @param _domain - The publisher domain to probe.
   * @returns Discovered entries from the domain.
   */
  async discoverDomain(_domain: string): Promise<DiscoveredEntry[]> {
    // TODO: Integrate with WellKnownProber when available.
    return [];
  }

  /**
   * Scan local directories for plugin manifests and skill descriptors.
   *
   * Walks each directory looking for `plugin.yaml`, `plugin.yml`,
   * `plugin.json`, or `SKILL.md`. Directories containing a manifest are
   * treated as plugin roots; bare `SKILL.md` files produce scan-level entries.
   *
   * @param paths - Override the configured local paths for this invocation.
   * @returns Newly discovered entries (already merged into the index).
   */
  async scanLocal(paths?: string[]): Promise<DiscoveredEntry[]> {
    const dirs = paths ?? this._config.localPaths;
    const entries: DiscoveredEntry[] = [];

    for (const dir of dirs) {
      const found = await this._scanDirectory(dir);
      for (const entry of found) {
        this._mergeEntry(entry);
        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * Get all currently indexed entries.
   *
   * @returns Snapshot array of all entries.
   */
  getEntries(): DiscoveredEntry[] {
    return [...this._entries.values()];
  }

  /**
   * Find entries whose `id` or `name` contain the query substring (case-insensitive).
   *
   * @param query - Search substring.
   * @returns Matching entries.
   */
  search(query: string): DiscoveredEntry[] {
    const lower = query.toLowerCase();
    const results: DiscoveredEntry[] = [];

    for (const entry of this._entries.values()) {
      if (
        entry.id.toLowerCase().includes(lower) ||
        entry.name.toLowerCase().includes(lower)
      ) {
        results.push(entry);
      }
    }

    return results;
  }

  /**
   * Manually add an entry to the index (e.g., from user configuration).
   *
   * If an entry with the same ID already exists, the higher-trust entry wins
   * and the other location is recorded as a mirror.
   *
   * @param entry - The entry to add.
   */
  addEntry(entry: DiscoveredEntry): void {
    this._mergeEntry(entry);
  }

  /**
   * Remove an entry by ID.
   *
   * @param id - Entry identifier.
   * @returns `true` if the entry existed and was removed.
   */
  removeEntry(id: string): boolean {
    const existing = this._entries.get(id);
    if (!existing) return false;

    this._entries.delete(id);
    this.emit('entryRemoved', existing);
    return true;
  }

  /**
   * Clear all entries from the index.
   */
  clear(): void {
    this._entries.clear();
  }

  // -------------------------------------------------------------------------
  // Typed event emitter overrides
  // -------------------------------------------------------------------------

  override emit<K extends keyof DiscoveryEvents>(
    event: K,
    ...args: [DiscoveryEvents[K]]
  ): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof DiscoveryEvents>(
    event: K,
    listener: (payload: DiscoveryEvents[K]) => void,
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override once<K extends keyof DiscoveryEvents>(
    event: K,
    listener: (payload: DiscoveryEvents[K]) => void,
  ): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Merge a discovered entry into the index, applying deduplication rules.
   *
   * - If no entry with this ID exists → insert and emit `entryAdded`.
   * - If an entry exists and the new one has a **higher** trust score → replace
   *   the old entry, demote its location to a mirror, emit `entryUpdated`.
   * - If an entry exists and the new one has an **equal or lower** trust score →
   *   add the new location as a mirror on the existing entry, emit `entryUpdated`.
   */
  private _mergeEntry(entry: DiscoveredEntry): void {
    const existing = this._entries.get(entry.id);

    if (!existing) {
      this._entries.set(entry.id, entry);
      this.emit('entryAdded', entry);
      return;
    }

    const mirror: MirrorLocation = {
      source: entry.source,
      location: entry.location,
    };

    if (entry.trustScore > existing.trustScore) {
      // New entry wins — demote old primary to mirror.
      const oldMirror: MirrorLocation = {
        source: existing.source,
        location: existing.location,
      };

      const updated: DiscoveredEntry = {
        ...entry,
        mirrors: [oldMirror, ...(entry.mirrors ?? []), ...(existing.mirrors ?? [])],
      };

      this._entries.set(entry.id, updated);
      this.emit('entryUpdated', updated);
    } else {
      // Existing entry keeps primary — append new location as mirror.
      const updatedMirrors = [...(existing.mirrors ?? []), mirror];
      const updated: DiscoveredEntry = { ...existing, mirrors: updatedMirrors };

      this._entries.set(entry.id, updated);
      this.emit('entryUpdated', updated);
    }
  }

  /**
   * Recursively scan a single directory for plugin manifests and skill files.
   *
   * @param dirPath - Absolute or relative directory path.
   * @returns Entries found in this directory tree.
   */
  private async _scanDirectory(dirPath: string): Promise<DiscoveredEntry[]> {
    const entries: DiscoveredEntry[] = [];

    let dirStat: import('node:fs').Stats;
    try {
      dirStat = await stat(dirPath);
    } catch {
      // Directory does not exist or is inaccessible — skip silently.
      return entries;
    }

    if (!dirStat.isDirectory()) return entries;

    // Check for manifest files in this directory.
    for (const filename of MANIFEST_FILENAMES) {
      const filePath = join(dirPath, filename);
      try {
        const content = await readFile(filePath, 'utf-8');
        const entry = this._parseManifestFile(content, filePath, extname(filePath));
        if (entry) {
          entries.push(entry);
        }
        // Found a manifest — stop checking other manifest filenames in this dir.
        break;
      } catch {
        // File doesn't exist or can't be read — try next filename.
      }
    }

    // Check for standalone SKILL.md (only if no manifest was found in this dir).
    if (entries.length === 0) {
      const skillPath = join(dirPath, SKILL_FILENAME);
      try {
        const content = await readFile(skillPath, 'utf-8');
        const entry = this._buildSkillEntry(content, skillPath);
        entries.push(entry);
      } catch {
        // No SKILL.md — continue.
      }
    }

    // Recurse into subdirectories (one level deep to avoid runaway scans).
    let children: import('node:fs').Dirent[];
    try {
      children = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return entries;
    }

    for (const child of children) {
      if (child.isDirectory() && !child.name.startsWith('.') && child.name !== 'node_modules') {
        const childEntries = await this._scanDirectory(join(dirPath, child.name));
        entries.push(...childEntries);
      }
    }

    return entries;
  }

  /**
   * Parse a manifest file (YAML or JSON) and build a {@link DiscoveredEntry}.
   *
   * @param content  - Raw file content.
   * @param filePath - Absolute path to the file.
   * @param ext      - File extension (`.yaml`, `.yml`, or `.json`).
   * @returns A discovered entry, or `null` if parsing fails.
   */
  private _parseManifestFile(
    content: string,
    filePath: string,
    ext: string,
  ): DiscoveredEntry | null {
    try {
      let raw: unknown;
      if (ext === '.json') {
        raw = JSON.parse(content);
      } else {
        raw = parseYaml(content);
      }

      const manifest = raw as PluginManifest | undefined;
      const protocol = inferProtocol(raw);
      const id = buildEntryId(manifest, protocol, filePath);
      const name =
        manifest?.metadata?.displayName != null
          ? typeof manifest.metadata.displayName === 'string'
            ? manifest.metadata.displayName
            : Object.values(manifest.metadata.displayName)[0] ?? manifest.metadata.name
          : manifest?.metadata?.name ?? basename(filePath);

      const hasTrustedPublisher = !!manifest?.metadata?.publisher?.domain;
      const trustScore = computeTrustScore('local', hasTrustedPublisher, false);

      return {
        id,
        name,
        source: 'local',
        location: filePath,
        raw,
        protocol,
        trustScore,
        discoveredAt: new Date(),
      };
    } catch {
      // Malformed file — skip.
      return null;
    }
  }

  /**
   * Build a scan-level entry from a standalone SKILL.md file.
   *
   * @param content  - Raw SKILL.md content.
   * @param filePath - Absolute path to the file.
   * @returns A discovered entry with protocol `skills` and scan-level trust.
   */
  private _buildSkillEntry(content: string, filePath: string): DiscoveredEntry {
    // Extract title from first markdown heading, if present.
    const headingMatch = content.match(/^#\s+(.+)$/m);
    const name = headingMatch ? headingMatch[1].trim() : basename(filePath, '.md');

    const trustScore = computeTrustScore('scan', false, false);

    return {
      id: `skills::${filePath}`,
      name,
      source: 'scan',
      location: filePath,
      raw: content,
      protocol: 'skills',
      trustScore,
      discoveredAt: new Date(),
    };
  }
}
