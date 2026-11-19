/**
 * @module types
 * Shared type definitions for the PluginHub process orchestrator.
 */

/**
 * Lifecycle states of a managed child process.
 *
 * State transitions:
 * ```
 * CREATED → STARTING → RUNNING → STOPPING → STOPPED
 *                                  ↓
 *                                FAILED
 * ```
 */
export type ProcessState =
  | 'created'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'

/**
 * Options for spawning a new child process.
 */
export interface SpawnOptions {
  /** Executable path or command name. */
  command: string

  /** Command-line arguments passed to the executable. */
  args?: string[]

  /** Working directory for the child process. Defaults to `process.cwd()`. */
  cwd?: string

  /** Additional environment variables merged with `process.env`. */
  env?: Record<string, string>

  /**
   * Standard I/O configuration.
   * - `'pipe'` – capture stdout/stderr as readable streams (default).
   * - `'inherit'` – share the parent's stdio handles.
   * - `'ignore'` – discard all stdio output.
   */
  stdio?: 'pipe' | 'inherit' | 'ignore'
}

/**
 * A handle to a spawned child process, exposing lifecycle control and I/O.
 */
export interface ProcessHandle {
  /** Operating-system process identifier. */
  readonly pid: number

  /** Current lifecycle state. */
  readonly state: ProcessState

  /** Readable stream of the child's stdout, or `null` when not piped. */
  readonly stdout: ReadableStream<Uint8Array> | null

  /** Readable stream of the child's stderr, or `null` when not piped. */
  readonly stderr: ReadableStream<Uint8Array> | null

  /** Resolves with the exit code once the process terminates, or `null` if killed by signal. */
  readonly exitCode: Promise<number | null>

  /**
   * Send a termination signal to the process (and its descendants, best-effort).
   *
   * On Unix this sends `signal` (default `SIGTERM`) then escalates to `SIGKILL`
   * after the configured grace period. On Windows it uses `CTRL_BREAK_EVENT`
   * followed by `taskkill /T /F` as a fallback.
   *
   * @param signal - Signal name (Unix only, ignored on Windows).
   */
  kill(signal?: string): Promise<void>

  /**
   * Wait for the process to exit.
   *
   * @param timeoutMs - Maximum time to wait in milliseconds. If the process has
   *   not exited within this window the promise resolves with `null`.
   * @returns The exit code, or `null` on timeout / signal termination.
   */
  waitForExit(timeoutMs?: number): Promise<number | null>
}

/**
 * Configuration for the {@link ProcessManager}.
 */
export interface OrchestratorConfig {
  /**
   * Milliseconds to wait after SIGTERM before escalating to SIGKILL.
   * @default 5000
   */
  gracefulShutdownMs?: number

  /**
   * Default working directory for spawned processes.
   * @default process.cwd()
   */
  defaultCwd?: string

  /**
   * Whether to automatically reap terminated child processes.
   * When `true`, the manager attaches exit listeners that clean up internal
   * bookkeeping as soon as a child exits.
   * @default true
   */
  autoReap?: boolean
}

/**
 * Internal record tracking a single managed process.
 * Not part of the public API.
 * @internal
 */
export interface ManagedProcessEntry {
  handle: ProcessHandle
  state: ProcessState
  abortController: AbortController
}
