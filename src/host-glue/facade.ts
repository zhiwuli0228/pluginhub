/**
 * PluginHub Facade — unified entry point for host-glue and CLI consumers.
 *
 * Composes the DiscoveryEngine, Orchestrator, and (optionally) the
 * InvocationRouter behind a single imperative API. This module does **not**
 * import any `@deepseek-ai/*` packages; it is a pure core wrapper.
 *
 * @module
 */

import { DiscoveryEngine } from '../core/discovery/index.js';
import type { DiscoveredEntry } from '../core/discovery/types.js';
import { Orchestrator } from '../core/orchestrator/index.js';
import type { PluginInstance, PluginStartOptions } from '../core/orchestrator/index.js';
import type { CanonicalCapability } from '../core/capability/types.js';
import { ObserverBus } from '../core/observer/index.js';
import type { EventFilter, EventType, ObserverEvent } from '../core/observer/index.js';

// ---------------------------------------------------------------------------
// Optional router import
// ---------------------------------------------------------------------------

/**
 * The InvocationRouter class, loaded dynamically so the facade still works
 * before `router/index.ts` exports it. Typed loosely to avoid compile-time
 * dependency on a module that may not yet have a barrel export.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let InvocationRouterClass: (new (...args: any[]) => any) | null = null;

try {
  // Dynamic import so the facade still works before router/index.ts exists.
  const routerModule = await import('../core/router/index.js').catch(() => null);
  if (routerModule && typeof routerModule.InvocationRouter === 'function') {
    InvocationRouterClass = routerModule.InvocationRouter;
  }
} catch {
  // Router not available — facade operates without routing.
}

// ---------------------------------------------------------------------------
// Configuration & Status types
// ---------------------------------------------------------------------------

/**
 * Configuration accepted by {@link PluginHubFacade}.
 */
export interface PluginHubConfig {
  /** Directories to scan for local plugins during discovery. */
  localPluginPaths?: string[];

  /** Default maximum number of tools exposed to agents. */
  defaultMaxTools?: number;

  /** Graceful shutdown timeout for managed processes (ms). */
  gracefulShutdownMs?: number;
}

/**
 * Aggregate status snapshot returned by {@link PluginHubFacade.getStatus}.
 */
export interface PluginHubStatus {
  /** Number of discovered plugin entries. */
  discoveredPlugins: number;

  /** Number of currently running plugin processes. */
  activeProcesses: number;

  /** Total registered capabilities across all discovered plugins. */
  registeredCapabilities: number;

  /** Milliseconds since the facade was initialized. */
  uptime: number;
}

// ---------------------------------------------------------------------------
// PluginHubFacade
// ---------------------------------------------------------------------------

/**
 * Unified facade for PluginHub core functionality.
 *
 * This is the single entry point that host-glue and CLI both use. It owns
 * the lifecycle of the discovery engine, orchestrator, and invocation router.
 *
 * @example
 * ```ts
 * const hub = new PluginHubFacade({ localPluginPaths: ['./plugins'] });
 * await hub.initialize();
 * console.log(hub.getStatus());
 * await hub.shutdown();
 * ```
 */
export class PluginHubFacade {
  /** Discovery engine instance. */
  readonly discovery: DiscoveryEngine;

  /** Process orchestrator instance. */
  readonly orchestrator: Orchestrator;

  /** Observer bus for runtime event collection and streaming. */
  readonly observer: ObserverBus;

  /**
   * Invocation router instance (may be `null` if the router module is unavailable).
   * Typed as `unknown` until the router module exports a concrete class.
   */
  readonly router: unknown = null;

  /** Resolved configuration with defaults applied. */
  private readonly config: Required<PluginHubConfig>;

  /** Timestamp recorded at initialization for uptime calculation. */
  private startedAt: Date | null = null;

  /** Whether the facade has been shut down. */
  private disposed = false;

  constructor(config?: PluginHubConfig) {
    this.config = {
      localPluginPaths: config?.localPluginPaths ?? [],
      defaultMaxTools: config?.defaultMaxTools ?? 40,
      gracefulShutdownMs: config?.gracefulShutdownMs ?? 5_000,
    };

    this.discovery = new DiscoveryEngine({
      localPaths: this.config.localPluginPaths,
    });

    this.orchestrator = new Orchestrator({
      gracefulShutdownMs: this.config.gracefulShutdownMs,
    });

    this.observer = new ObserverBus();

    // Instantiate the router if available.
    if (InvocationRouterClass !== null) {
      try {
        this.router = new InvocationRouterClass();
      } catch {
        // Router construction failed — operate without it.
        this.router = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the facade: run discovery, prepare the orchestrator.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async initialize(): Promise<void> {
    if (this.startedAt !== null) {
      return; // Already initialized.
    }

    this.startedAt = new Date();

    // Run initial discovery sweep.
    await this.discovery.discoverAll();
  }

  /**
   * Shutdown: stop all managed processes, release resources.
   *
   * After shutdown the facade cannot be reused; create a new instance instead.
   */
  async shutdown(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Stop all managed plugin processes.
    await this.orchestrator.dispose();

    // Shutdown the observer bus (closes SSE streams, removes listeners).
    await this.observer.shutdown();

    // Clear discovery index.
    this.discovery.clear();

    this.startedAt = null;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Get an aggregate status snapshot.
   */
  getStatus(): PluginHubStatus {
    const entries = this.discovery.getEntries();
    const instances = this.orchestrator.listPlugins();

    return {
      discoveredPlugins: entries.length,
      activeProcesses: instances.filter((i) => i.processState === 'running').length,
      registeredCapabilities: 0, // TODO: wire up capability index when available
      uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
    };
  }

  /**
   * List all discovered plugin entries.
   */
  listDiscoveredPlugins(): DiscoveredEntry[] {
    return this.discovery.getEntries();
  }

  /**
   * Search discovered plugins by query string.
   *
   * @param query - Case-insensitive substring to match against id and name.
   */
  searchPlugins(query: string): DiscoveredEntry[] {
    return this.discovery.search(query);
  }

  // -------------------------------------------------------------------------
  // Process management
  // -------------------------------------------------------------------------

  /**
   * Start a plugin process via the orchestrator.
   *
   * @param id - Unique identifier for the plugin instance.
   * @param options - Spawn and health-check options.
   * @returns Snapshot of the running plugin instance.
   */
  async startPlugin(id: string, options: PluginStartOptions): Promise<PluginInstance> {
    this.ensureNotDisposed();
    return this.orchestrator.startPlugin(id, options);
  }

  /**
   * Stop a running plugin process.
   *
   * @param id - Plugin identifier previously passed to {@link startPlugin}.
   */
  async stopPlugin(id: string): Promise<void> {
    this.ensureNotDisposed();
    return this.orchestrator.stopPlugin(id);
  }

  /**
   * Get the current status of a specific plugin instance.
   *
   * @param id - Plugin identifier.
   * @returns Instance snapshot, or `null` if not tracked.
   */
  getPluginStatus(id: string): PluginInstance | null {
    return this.orchestrator.getPluginStatus(id);
  }

  /**
   * List all currently managed plugin instances.
   */
  listActivePlugins(): PluginInstance[] {
    return this.orchestrator.listPlugins();
  }

  // -------------------------------------------------------------------------
  // Capability queries (placeholder until capability index is wired)
  // -------------------------------------------------------------------------

  /**
   * Search capabilities by query.
   *
   * Currently returns an empty array — will integrate with the capability
   * index once it is implemented.
   *
   * @param _query - Natural-language search query.
   */
  async searchCapabilities(_query: string): Promise<CanonicalCapability[]> {
    // TODO: Wire up capability index search.
    return [];
  }

  /**
   * Get the full schema for a specific capability by ID.
   *
   * Currently returns `null` — will integrate with the capability index
   * once it is implemented.
   *
   * @param _capabilityId - Fully qualified capability ID.
   */
  async getCapabilitySchema(_capabilityId: string): Promise<CanonicalCapability | null> {
    // TODO: Wire up capability index lookup.
    return null;
  }

  /**
   * Invoke a capability by its fully qualified ID.
   *
   * Currently throws — will integrate with the invocation router once it
   * is implemented.
   *
   * @param _capabilityId - Fully qualified capability ID.
   * @param _args - Input arguments for the capability.
   */
  async invokeCapability(
    _capabilityId: string,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    // TODO: Wire up invocation router.
    throw new Error('Capability invocation is not yet implemented.');
  }

  // -------------------------------------------------------------------------
  // Observer proxies
  // -------------------------------------------------------------------------

  /**
   * Query buffered runtime events with an optional filter.
   *
   * Proxies to {@link ObserverBus.query}.
   *
   * @param filter - Optional filter criteria (types, since, limit, etc.).
   * @returns Matching events sorted oldest-first.
   */
  getEvents(filter?: EventFilter): ObserverEvent[] {
    return this.observer.query(filter);
  }

  /**
   * Emit a structured runtime event into the observer bus.
   *
   * Proxies to {@link ObserverBus.emitEvent}.
   *
   * @param type - The event type tag.
   * @param payload - Type-specific event data.
   * @returns The fully-formed observer event.
   */
  emitEvent(type: EventType, payload: Record<string, unknown>): ObserverEvent {
    return this.observer.emitEvent(type, payload);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Guard against use-after-shutdown.
   */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('PluginHubFacade has been shut down.');
    }
  }
}
