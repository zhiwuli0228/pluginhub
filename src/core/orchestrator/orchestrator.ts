/**
 * @module orchestrator
 * @description Unified orchestration layer for PluginHub.
 *
 * Assembles {@link ProcessManager}, {@link PortAllocator}, {@link HealthChecker},
 * and {@link LogDrain} into a single high-level API that manages the full
 * lifecycle of AI plugin processes: port allocation → spawn → log drain →
 * health checking → graceful shutdown.
 *
 * @remarks ESM-only, strict TypeScript, no DSH dependencies.
 */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { Readable as ReadableType } from 'node:stream'

import { HealthChecker } from './health-checker.js'
import type { HealthCheckConfig, HealthStatus } from './health-checker.js'
import { LogDrain } from './log-drain.js'
import { PortAllocator } from './port-allocator.js'
import { ProcessManager } from './process-manager.js'
import type { OrchestratorConfig, ProcessHandle, ProcessState } from './types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link Orchestrator.startPlugin}.
 */
export interface PluginStartOptions {
  /** Executable path or command name. */
  command: string

  /** Command-line arguments passed to the executable. */
  args?: string[]

  /** Working directory for the child process. */
  cwd?: string

  /** Additional environment variables merged with `process.env`. */
  env?: Record<string, string>

  /**
   * Health-check configuration. When provided the orchestrator starts a
   * {@link HealthChecker} after spawning the process. Omit to skip health
   * monitoring entirely.
   */
  healthCheck?: HealthCheckConfig

  /**
   * Whether to automatically allocate a port and inject it as `PORT` in the
   * child's environment. Defaults to `true`.
   */
  autoAllocatePort?: boolean
}

/**
 * Immutable snapshot of a managed plugin instance.
 */
export interface PluginInstance {
  /** Unique plugin identifier supplied at start time. */
  id: string

  /** Operating-system PID, or `null` if the process has not started / already exited. */
  pid: number | null

  /** Allocated port number, or `null` when port allocation was skipped. */
  port: number | null

  /** Current process lifecycle state. */
  processState: ProcessState

  /** Latest health status (`'unknown'` when no health check is configured). */
  healthStatus: HealthStatus

  /** Number of log entries collected so far. */
  logEntryCount: number

  /** Timestamp when the plugin was first started. */
  startedAt: Date
}

// ---------------------------------------------------------------------------
// Internal runtime record
// ---------------------------------------------------------------------------

/**
 * Internal bookkeeping for a single managed plugin.
 * @internal
 */
interface PluginRuntime {
  /** The original start options (kept for restarts). */
  options: PluginStartOptions

  /** Handle returned by {@link ProcessManager.spawn}. */
  handle: ProcessHandle | null

  /** Allocated port number, or `null`. */
  port: number | null

  /** Per-plugin log drain instance. */
  logDrain: LogDrain

  /** Per-plugin health checker instance, or `null` when unconfigured. */
  healthChecker: HealthChecker | null

  /** Unsubscribe function for health-check status changes. */
  healthUnsubscribe: (() => void) | null

  /** Timestamp when the plugin was started. */
  startedAt: Date

  /** CrashLoopBackOff failure counter (persists across restarts). */
  restartFailureCount: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time (ms) to wait for the first successful health check during start. */
const FIRST_HEALTH_CHECK_TIMEOUT_MS = 30_000

/** Base delay for CrashLoopBackOff between stop and re-start (ms). */
const BACKOFF_BASE_MS = 1_000

/** Maximum CrashLoopBackOff cap (ms). */
const BACKOFF_MAX_MS = 60_000

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Unified plugin-process orchestrator.
 *
 * Combines port allocation, process management, log draining, and health
 * checking behind a simple start / stop / restart API.
 *
 * ### Events
 *
 * | Event             | Payload                                         | Description                              |
 * | ----------------- | ----------------------------------------------- | ---------------------------------------- |
 * | `pluginStarted`   | `{ id: string }`                                | A plugin process has been spawned.       |
 * | `pluginStopped`   | `{ id: string }`                                | A plugin process has been stopped.       |
 * | `pluginFailed`    | `{ id: string, error: Error }`                  | A plugin failed to start or crashed.     |
 * | `healthChanged`   | `{ id: string, status: HealthStatus }`          | Health status changed for a plugin.      |
 *
 * @example
 * ```ts
 * const orch = new Orchestrator()
 * const instance = await orch.startPlugin('my-plugin', {
 *   command: 'node',
 *   args: ['server.js'],
 *   healthCheck: { type: 'http', port: 0 }, // port overridden at runtime
 * })
 * console.log(instance.pid, instance.port)
 * await orch.stopPlugin('my-plugin')
 * await orch.dispose()
 * ```
 */
export class Orchestrator extends EventEmitter {
  /** Sub-module instances. */
  private readonly processManager: ProcessManager
  private readonly portAllocator: PortAllocator

  /** Resolved top-level configuration. */
  private readonly config: Required<OrchestratorConfig>

  /** Active plugin runtimes keyed by plugin id. */
  private readonly plugins = new Map<string, PluginRuntime>()

  /** Whether the orchestrator has been disposed. */
  private disposed = false

  constructor(config?: OrchestratorConfig) {
    super()

    this.config = {
      gracefulShutdownMs: config?.gracefulShutdownMs ?? 5_000,
      defaultCwd: config?.defaultCwd ?? process.cwd(),
      autoReap: config?.autoReap ?? true,
    }

    this.processManager = new ProcessManager(this.config)
    this.portAllocator = new PortAllocator()
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start a plugin: allocate port → spawn → attach logs → start health check.
   *
   * @param id - Unique identifier for this plugin instance.
   * @param options - Spawn and health-check options.
   * @returns A snapshot of the running plugin instance.
   * @throws If the orchestrator is disposed, the id is already active, or
   *   spawning fails.
   */
  async startPlugin(id: string, options: PluginStartOptions): Promise<PluginInstance> {
    this.ensureNotDisposed()

    if (this.plugins.has(id)) {
      throw new Error(`Plugin "${id}" is already running. Stop it before restarting.`)
    }

    const autoPort = options.autoAllocatePort !== false
    let port: number | null = null

    // 1. Allocate port -------------------------------------------------------
    if (autoPort) {
      port = await this.portAllocator.allocateWithRetry(5)
    }

    // 2. Build environment (inject PORT) -------------------------------------
    const mergedEnv: Record<string, string> = { ...options.env }
    if (port !== null) {
      mergedEnv['PORT'] = String(port)
    }

    // 3. Spawn process -------------------------------------------------------
    let handle: ProcessHandle
    try {
      handle = this.processManager.spawn({
        command: options.command,
        args: options.args,
        cwd: options.cwd ?? this.config.defaultCwd,
        env: mergedEnv,
        stdio: 'pipe',
      })
    } catch (err) {
      // Roll back port allocation on spawn failure.
      if (port !== null) {
        this.portAllocator.release(port)
      }
      const error = err instanceof Error ? err : new Error(String(err))
      this.emit('pluginFailed', { id, error })
      throw error
    }

    // 4. Attach log drain ----------------------------------------------------
    const logDrain = new LogDrain({ runId: id, pid: handle.pid })

    // Convert Web ReadableStream → Node Readable for LogDrain.attach().
    const stdoutNode = webToNodeReadable(handle.stdout)
    const stderrNode = webToNodeReadable(handle.stderr)
    logDrain.attach(stdoutNode, stderrNode)

    // 5. Start health checker (optional) -------------------------------------
    let healthChecker: HealthChecker | null = null
    let healthUnsubscribe: (() => void) | null = null

    if (options.healthCheck && port !== null) {
      // Override the port in the health-check config with the allocated one.
      const hcConfig: HealthCheckConfig = {
        ...options.healthCheck,
        port: options.healthCheck.port || port,
      }
      healthChecker = new HealthChecker(hcConfig)

      healthUnsubscribe = healthChecker.onStatusChange((result) => {
        this.emit('healthChanged', { id, status: result.status })
      })

      healthChecker.start()
    }

    // 6. Persist runtime record ----------------------------------------------
    const runtime: PluginRuntime = {
      options,
      handle,
      port,
      logDrain,
      healthChecker,
      healthUnsubscribe,
      startedAt: new Date(),
      restartFailureCount: 0,
    }
    this.plugins.set(id, runtime)

    this.emit('pluginStarted', { id })

    // 7. Wait for first healthy signal (best-effort, non-blocking timeout) ---
    if (healthChecker) {
      await this.waitForFirstHealthy(healthChecker, FIRST_HEALTH_CHECK_TIMEOUT_MS)
    }

    return this.buildSnapshot(id, runtime)
  }

  /**
   * Stop a plugin: stop health check → detach logs → kill process → release port.
   *
   * @param id - Plugin identifier previously passed to {@link startPlugin}.
   * @throws If the plugin is not currently tracked.
   */
  async stopPlugin(id: string): Promise<void> {
    const runtime = this.plugins.get(id)
    if (!runtime) {
      throw new Error(`Plugin "${id}" is not running.`)
    }

    await this.teardownRuntime(id, runtime)
  }

  /**
   * Restart a plugin with CrashLoopBackOff semantics.
   *
   * Performs stop → backoff delay → start. The backoff counter persists
   * across consecutive failures and resets on a successful start.
   *
   * @param id - Plugin identifier.
   * @returns Snapshot of the restarted plugin instance.
   */
  async restartPlugin(id: string): Promise<PluginInstance> {
    const runtime = this.plugins.get(id)
    if (!runtime) {
      throw new Error(`Plugin "${id}" is not running; cannot restart.`)
    }

    // Capture options and backoff counter before teardown.
    const previousOptions = runtime.options
    const failureCount = runtime.restartFailureCount

    // Tear down current runtime but keep the map entry removed.
    await this.teardownRuntime(id, runtime)

    // Compute CrashLoopBackOff delay.
    const delay = computeBackoff(failureCount)
    await sleep(delay)

    // Re-start with the same options. On success the backoff resets;
    // on failure the caller can inspect the thrown error.
    try {
      const instance = await this.startPlugin(id, previousOptions)

      // Reset backoff on successful start.
      const newRuntime = this.plugins.get(id)
      if (newRuntime) {
        newRuntime.restartFailureCount = 0
        newRuntime.healthChecker?.resetRestartBackoff()
      }

      return instance
    } catch (err) {
      // Increment backoff counter for next attempt.
      // The plugin entry was cleaned up by startPlugin's failure path,
      // so we store the incremented count on the error for the caller.
      const error = err instanceof Error ? err : new Error(String(err))
      ;(error as Error & { restartFailureCount?: number }).restartFailureCount = failureCount + 1
      throw error
    }
  }

  /**
   * Return the current status snapshot for a plugin, or `null` if not tracked.
   *
   * @param id - Plugin identifier.
   */
  getPluginStatus(id: string): PluginInstance | null {
    const runtime = this.plugins.get(id)
    if (!runtime) {
      return null
    }
    return this.buildSnapshot(id, runtime)
  }

  /**
   * List all currently registered plugin instances.
   */
  listPlugins(): PluginInstance[] {
    const results: PluginInstance[] = []
    for (const [id, runtime] of this.plugins) {
      results.push(this.buildSnapshot(id, runtime))
    }
    return results
  }

  /**
   * Dispose the orchestrator: stop every plugin and release all resources.
   *
   * After disposal, further calls to {@link startPlugin} will throw.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true

    // Stop all plugins concurrently.
    const stops: Promise<void>[] = []
    for (const [id, runtime] of this.plugins) {
      stops.push(this.teardownRuntime(id, runtime).catch(() => { /* best-effort */ }))
    }
    await Promise.allSettled(stops)
    this.plugins.clear()

    // Dispose sub-modules.
    await this.processManager.dispose()
    this.portAllocator.destroy()
    this.removeAllListeners()
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Full teardown sequence for a single plugin runtime.
   * Removes the entry from the internal map once complete.
   */
  private async teardownRuntime(id: string, runtime: PluginRuntime): Promise<void> {
    // 1. Stop health checker.
    if (runtime.healthChecker) {
      runtime.healthChecker.stop()
    }
    if (runtime.healthUnsubscribe) {
      runtime.healthUnsubscribe()
      runtime.healthUnsubscribe = null
    }

    // 2. Detach log drain (flushes remaining buffers).
    await runtime.logDrain.detach()

    // 3. Kill process.
    if (runtime.handle) {
      try {
        await runtime.handle.kill()
      } catch {
        // Best-effort – process may have already exited.
      }
    }

    // 4. Release port.
    if (runtime.port !== null) {
      this.portAllocator.release(runtime.port)
    }

    // 5. Remove from map.
    this.plugins.delete(id)

    this.emit('pluginStopped', { id })
  }

  /**
   * Build an immutable {@link PluginInstance} snapshot from internal state.
   */
  private buildSnapshot(id: string, runtime: PluginRuntime): PluginInstance {
    return {
      id,
      pid: runtime.handle?.pid ?? null,
      port: runtime.port,
      processState: runtime.handle?.state ?? 'stopped',
      healthStatus: runtime.healthChecker?.getStatus().status ?? 'unknown',
      logEntryCount: runtime.logDrain.getEntries().length,
      startedAt: runtime.startedAt,
    }
  }

  /**
   * Wait until the health checker reports `'healthy'` or the timeout expires.
   * Resolves regardless of outcome — callers treat this as best-effort.
   */
  private waitForFirstHealthy(checker: HealthChecker, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      // Already healthy?
      if (checker.getStatus().status === 'healthy') {
        resolve()
        return
      }

      let settled = false
      const done = (): void => {
        if (!settled) {
          settled = true
          unsub()
          clearTimeout(timer)
          resolve()
        }
      }

      const unsub = checker.onStatusChange((result) => {
        if (result.status === 'healthy') {
          done()
        }
      })

      const timer = setTimeout(done, timeoutMs)
    })
  }

  /**
   * Guard against use-after-dispose.
   */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Orchestrator has been disposed.')
    }
  }
}

// ---------------------------------------------------------------------------
// Module-private utilities
// ---------------------------------------------------------------------------

/**
 * Compute a CrashLoopBackOff delay with full jitter.
 *
 * @param failureCount - Number of consecutive restart failures.
 * @returns Delay in milliseconds.
 */
function computeBackoff(failureCount: number): number {
  const exponential = BACKOFF_BASE_MS * Math.pow(2, failureCount)
  const capped = Math.min(exponential, BACKOFF_MAX_MS)
  return Math.round(Math.random() * capped)
}

/**
 * Promisified sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Convert a Web `ReadableStream<Uint8Array>` to a Node.js `Readable`.
 *
 * Returns `null` when the input is `null`, allowing direct pass-through to
 * {@link LogDrain.attach}.
 */
function webToNodeReadable(webStream: ReadableStream<Uint8Array> | null): ReadableType | null {
  if (webStream === null) {
    return null
  }

  const reader = webStream.getReader()

  const nodeStream = new Readable({
    read() {
      reader
        .read()
        .then(({ value, done }) => {
          if (done) {
            this.push(null)
          } else {
            this.push(Buffer.from(value))
          }
        })
        .catch((err: Error) => {
          this.destroy(err)
        })
    },
  })

  return nodeStream
}
