/**
 * @module process-manager
 * Process abstraction layer for managing AI plugin child-process lifecycles.
 *
 * Responsibilities:
 * - Spawn child processes with platform-appropriate isolation (detached / CREATE_NEW_PROCESS_GROUP).
 * - Graceful shutdown: SIGTERM → grace period → SIGKILL (Unix); CTRL_BREAK_EVENT → taskkill /T /F (Windows).
 * - Best-effort process-tree killing via execa's `killDescendants`.
 * - Zombie reaping through exit-listener bookkeeping.
 * - Deterministic state machine: CREATED → STARTING → RUNNING → STOPPING → STOPPED | FAILED.
 */

import { execa, type ResultPromise } from 'execa'
import { execSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type {
  OrchestratorConfig,
  ProcessHandle,
  ProcessState,
  SpawnOptions,
} from './types.js'

const IS_WINDOWS = process.platform === 'win32'

/** Default grace period before escalating to a force-kill (ms). */
const DEFAULT_GRACEFUL_SHUTDOWN_MS = 5_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Transition guard – throws when the current state does not allow the target.
 */
function assertTransition(from: ProcessState, to: ProcessState): void {
  const allowed: Record<ProcessState, ProcessState[]> = {
    created: ['starting', 'failed'],
    starting: ['running', 'failed'],
    running: ['stopping', 'stopped', 'failed'],
    stopping: ['stopped', 'failed'],
    stopped: [],
    failed: [],
  }

  if (!allowed[from].includes(to)) {
    throw new Error(
      `Invalid process state transition: ${from} → ${to}`,
    )
  }
}

/**
 * On Windows, send CTRL_BREAK_EVENT to a process tree via `taskkill`.
 * This is more reliable than SIGTERM which Node on Windows does not truly support.
 */
function windowsTaskKill(pid: number): void {
  try {
    // /T = kill child processes, /F = force, /PID = target pid
    execSync(`taskkill /T /F /PID ${pid}`, { timeout: 5_000, stdio: 'ignore' })
  } catch {
    // Best-effort – the process may have already exited.
  }
}

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of AI plugin child processes.
 *
 * @example
 * ```ts
 * const pm = new ProcessManager({ gracefulShutdownMs: 3000 })
 * const handle = pm.spawn({ command: 'node', args: ['server.js'] })
 * // … later …
 * await handle.kill()
 * pm.dispose()
 * ```
 */
export class ProcessManager extends EventEmitter {
  /** Active managed processes keyed by PID. */
  private readonly processes = new Map<number, {
    handle: ProcessHandle
    state: ProcessState
    subprocess: ResultPromise
    abortController: AbortController
  }>()

  /** Resolved configuration with defaults applied. */
  private readonly config: Required<OrchestratorConfig>

  /** Whether the manager has been disposed. */
  private disposed = false

  constructor(config: OrchestratorConfig = {}) {
    super()
    this.config = {
      gracefulShutdownMs: config.gracefulShutdownMs ?? DEFAULT_GRACEFUL_SHUTDOWN_MS,
      defaultCwd: config.defaultCwd ?? process.cwd(),
      autoReap: config.autoReap ?? true,
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Spawn a new child process and return a {@link ProcessHandle}.
   *
   * The process starts in its own process group so that signals can be
   * delivered to the entire tree. On Unix this uses `detached: true`;
   * on Windows execa sets `CREATE_NEW_PROCESS_GROUP` automatically when
   * `killDescendants` is enabled.
   *
   * @param options - Spawn configuration.
   * @returns A handle exposing streams, state, and lifecycle control.
   * @throws If the manager has been disposed or the spawn fails synchronously.
   */
  spawn(options: SpawnOptions): ProcessHandle {
    if (this.disposed) {
      throw new Error('ProcessManager has been disposed; cannot spawn new processes.')
    }

    const { command, args = [], cwd, env, stdio = 'pipe' } = options

    // Build execa options ---------------------------------------------------
    const abortController = new AbortController()

    const subprocess = execa(command, args, {
      cwd: cwd ?? this.config.defaultCwd,
      env: env ? { ...process.env, ...env } : undefined,
      stdin: stdio === 'pipe' ? 'pipe' : stdio,
      stdout: stdio === 'pipe' ? 'pipe' : stdio,
      stderr: stdio === 'pipe' ? 'pipe' : stdio,
      // Process-group isolation for tree-wide signal delivery.
      detached: !IS_WINDOWS,
      killDescendants: true,
      forceKillAfterDelay: this.config.gracefulShutdownMs,
      cancelSignal: abortController.signal,
      // Do NOT reject on non-zero exit – we handle exit codes ourselves.
      reject: false,
      // Prevent inheriting parent IPC which could leak file descriptors.
      ipc: undefined,
      // Hide console window on Windows.
      windowsHide: true,
    })

    const pid = subprocess.pid
    if (pid === undefined) {
      throw new Error(`Failed to spawn process: ${command} ${args.join(' ')}`)
    }

    // State tracking --------------------------------------------------------
    let state: ProcessState = 'created'

    const setState = (next: ProcessState): void => {
      const prev = state
      assertTransition(prev, next)
      state = next
      this.emit('stateChange', { pid, from: prev, to: next })
    }

    // Transition to STARTING immediately; RUNNING once the OS confirms spawn.
    setState('starting')

    // execa resolves/rejects when the process exits. We use the promise form
    // to capture the exit code without throwing.
    const exitCodePromise: Promise<number | null> = subprocess.then(
      (result) => {
        // Reap on natural exit.
        if (this.config.autoReap) {
          this.reap(pid)
        }
        // Determine final state.
        if (state === 'stopping') {
          setState('stopped')
        } else if (result.exitCode === 0 || result.exitCode === null) {
          // Could be a clean exit while still marked running (no explicit stop).
          if (state === 'running') {
            setState('stopped')
          }
        } else {
          if (state !== 'stopped' && state !== 'failed') {
            setState('failed')
          }
        }
        return result.exitCode ?? null
      },
      (_error) => {
        if (this.config.autoReap) {
          this.reap(pid)
        }
        if (state !== 'stopped' && state !== 'failed') {
          setState('failed')
        }
        return null
      },
    )

    // Once the underlying Node ChildProcess emits 'spawn', move to RUNNING.
    subprocess.nodeChildProcess.once('spawn', () => {
      if (state === 'starting') {
        setState('running')
      }
    })

    // Web ReadableStreams for stdout / stderr --------------------------------
    const stdoutStream = subprocess.stdout
      ? subprocess.readableStream()
      : null
    const stderrStream = subprocess.stderr
      ? subprocess.readableStream()
      : null

    // Build the public handle ------------------------------------------------
    const self = this

    const handle: ProcessHandle = {
      get pid() {
        return pid
      },
      get state() {
        return state
      },
      get stdout() {
        return stdoutStream
      },
      get stderr() {
        return stderrStream
      },
      get exitCode() {
        return exitCodePromise
      },

      async kill(signal?: string): Promise<void> {
        if (state === 'stopped' || state === 'failed') {
          return
        }

        setState('stopping')

        if (IS_WINDOWS) {
          // Windows: taskkill /T /F is the reliable way to terminate a tree.
          windowsTaskKill(pid)
        } else {
          // Unix: send the requested signal (default SIGTERM). execa's
          // forceKillAfterDelay will escalate to SIGKILL automatically.
          const sig = (signal ?? 'SIGTERM') as NodeJS.Signals
          subprocess.kill(sig)
        }

        // Wait for the process to actually exit (bounded).
        await handle.waitForExit(self.config.gracefulShutdownMs + 1_000)

        // Ensure terminal state.
        if (state === 'stopping') {
          setState('stopped')
        }
      },

      async waitForExit(timeoutMs?: number): Promise<number | null> {
        if (timeoutMs === undefined) {
          return exitCodePromise
        }

        const timeout = new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), timeoutMs)
        })

        return Promise.race([exitCodePromise, timeout])
      },
    }

    // Register in internal map.
    this.processes.set(pid, { handle, state, subprocess, abortController })

    // Keep the map's state field in sync via the event emitter.
    this.on('stateChange', (evt: { pid: number; to: ProcessState }) => {
      if (evt.pid === pid) {
        const entry = this.processes.get(pid)
        if (entry) {
          entry.state = evt.to
        }
      }
    })

    return handle
  }

  /**
   * Return the current set of active (non-terminal) process PIDs.
   */
  getActivePids(): number[] {
    const pids: number[] = []
    for (const [pid, entry] of this.processes) {
      if (entry.state !== 'stopped' && entry.state !== 'failed') {
        pids.push(pid)
      }
    }
    return pids
  }

  /**
   * Retrieve the handle for a given PID, if still tracked.
   */
  getHandle(pid: number): ProcessHandle | undefined {
    return this.processes.get(pid)?.handle
  }

  /**
   * Kill all active managed processes gracefully.
   *
   * @param timeoutMs - Per-process kill timeout. Defaults to the configured
   *   graceful shutdown period plus a 1-second buffer.
   */
  async killAll(timeoutMs?: number): Promise<void> {
    const effectiveTimeout = timeoutMs ?? this.config.gracefulShutdownMs + 1_000
    const kills: Promise<void>[] = []

    for (const [, entry] of this.processes) {
      if (entry.state !== 'stopped' && entry.state !== 'failed') {
        kills.push(entry.handle.kill())
      }
    }

    await Promise.allSettled(kills)

    // Final sweep: force-kill anything still alive after the timeout.
    for (const [pid, entry] of this.processes) {
      if (entry.state !== 'stopped' && entry.state !== 'failed') {
        if (IS_WINDOWS) {
          windowsTaskKill(pid)
        } else {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }
    }
  }

  /**
   * Dispose the manager: kill all children and release resources.
   * After disposal, {@link spawn} will throw.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true

    await this.killAll()
    this.processes.clear()
    this.removeAllListeners()
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Remove a terminated process from the internal tracking map.
   * Called automatically when `autoReap` is enabled.
   */
  private reap(pid: number): void {
    this.processes.delete(pid)
    this.emit('reaped', { pid })
  }
}
