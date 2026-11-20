/**
 * MCP stdio transport client.
 *
 * Spawns an MCP server as a child process and communicates over stdin/stdout
 * using newline-delimited JSON-RPC 2.0 messages, as specified by the MCP
 * protocol version 2026-07-28.
 *
 * @module
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

import type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  McpTool,
  ServerCapabilities,
  InitializeResult,
} from './types.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration for spawning an MCP server via stdio. */
export interface McpStdioClientOptions {
  /** Executable path or command to start the MCP server. */
  command: string
  /** Arguments forwarded to the server process. */
  args?: string[]
  /** Working directory for the spawned process. */
  cwd?: string
  /** Additional environment variables merged with `process.env`. */
  env?: Record<string, string>
  /** Per-request timeout in milliseconds. Defaults to 30 000. */
  requestTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Default per-request timeout (ms). */
const DEFAULT_TIMEOUT_MS = 30_000

/** Grace period to wait after closing stdin before SIGKILL (ms). */
const CLOSE_KILL_GRACE_MS = 2_000

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Lightweight MCP client that communicates with a server over stdio.
 *
 * Usage:
 * ```ts
 * const client = new McpStdioClient({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] })
 * const info = await client.connect()
 * const tools = await client.listTools()
 * await client.close()
 * ```
 */
export class McpStdioClient extends EventEmitter {
  private readonly _options: Required<Pick<McpStdioClientOptions, 'command' | 'requestTimeoutMs'>> &
    McpStdioClientOptions

  private _process: ChildProcess | null = null
  private _connected = false
  private _nextId = 1
  private readonly _pending = new Map<number | string, PendingRequest>()

  /** Buffer for partial stdout lines. */
  private _stdoutBuffer = ''

  /** Collected stderr output (useful for debugging server logs). */
  private _stderrChunks: string[] = []

  constructor(options: McpStdioClientOptions) {
    super()
    this._options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Whether the client is currently connected to a running server. */
  get connected(): boolean {
    return this._connected
  }

  /**
   * Start the MCP server process and perform the `initialize` handshake.
   *
   * @returns The server's {@link InitializeResult}.
   */
  async connect(): Promise<InitializeResult> {
    if (this._connected) {
      throw new Error('McpStdioClient is already connected')
    }

    this._spawn()

    // Step 1 – send `initialize` request
    const initResult = (await this._send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pluginhub-mcp-client', version: '1.0.0' },
    })) as InitializeResult

    // Step 2 – send `notifications/initialized` notification (no response expected)
    this._notify('notifications/initialized')

    this._connected = true
    return initResult
  }

  /**
   * List all tools exposed by the connected MCP server.
   *
   * @returns An array of {@link McpTool} descriptors.
   */
  async listTools(): Promise<McpTool[]> {
    this._assertConnected()
    const result = (await this._send('tools/list')) as { tools: McpTool[] }
    return result.tools ?? []
  }

  /**
   * Invoke a tool by name.
   *
   * @param name - Tool name as returned by {@link listTools}.
   * @param args - Input parameters matching the tool's `inputSchema`.
   * @returns The tool's result payload.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this._assertConnected()
    return this._send('tools/call', { name, arguments: args })
  }

  /**
   * Send a `server/discover` request (MCP 2026-07-28 extension).
   *
   * @returns Protocol version and server capabilities.
   */
  async discover(): Promise<{ protocolVersion: string; capabilities: ServerCapabilities }> {
    this._assertConnected()
    return this._send('server/discover') as Promise<{
      protocolVersion: string
      capabilities: ServerCapabilities
    }>
  }

  /**
   * Gracefully shut down the connection and terminate the server process.
   *
   * Closes stdin first, waits up to 2 seconds for the process to exit on its
   * own, then sends SIGTERM followed by SIGKILL if necessary.
   */
  async close(): Promise<void> {
    if (!this._process) {
      return
    }

    // Reject any pending requests so callers don't hang.
    this._rejectAll(new Error('Client is closing'))

    // Close stdin to signal EOF.
    try {
      this._process.stdin?.end()
    } catch {
      // Already destroyed – ignore.
    }

    // Give the process time to exit gracefully.
    await this._waitForExit(CLOSE_KILL_GRACE_MS)

    // Force-kill if still alive.
    if (this._process && !this._process.killed) {
      try {
        this._process.kill('SIGTERM')
      } catch {
        // Ignore – may have exited between check and kill.
      }
      await this._waitForExit(1_000)

      if (this._process && !this._process.killed) {
        try {
          this._process.kill('SIGKILL')
        } catch {
          // Ignore.
        }
      }
    }

    this._cleanup()
  }

  // -------------------------------------------------------------------------
  // Spawning & I/O
  // -------------------------------------------------------------------------

  /** Spawn the server child process and wire up stdio listeners. */
  private _spawn(): void {
    const { command, args, cwd, env } = this._options

    this._process = spawn(command, args ?? [], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // On Windows, hide the console window when possible.
      windowsHide: true,
    })

    this._process.stdout!.setEncoding('utf-8')
    this._process.stderr!.setEncoding('utf-8')

    this._process.stdout!.on('data', (chunk: string) => this._onStdout(chunk))
    this._process.stderr!.on('data', (chunk: string) => this._onStderr(chunk))
    this._process.on('error', (err: Error) => this._onProcessError(err))
    this._process.on('close', (code: number | null, signal: string | null) =>
      this._onProcessClose(code, signal),
    )
  }

  /** Handle incoming stdout data – parse complete newline-delimited JSON lines. */
  private _onStdout(chunk: string): void {
    this._stdoutBuffer += chunk

    let newlineIdx: number
    while ((newlineIdx = this._stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this._stdoutBuffer.slice(0, newlineIdx).trim()
      this._stdoutBuffer = this._stdoutBuffer.slice(newlineIdx + 1)

      if (line.length === 0) continue

      let message: JsonRpcResponse
      try {
        message = JSON.parse(line) as JsonRpcResponse
      } catch {
        // Malformed line – emit for diagnostics but don't crash.
        this.emit('parseError', line)
        continue
      }

      this._handleMessage(message)
    }
  }

  /** Collect stderr without blocking. */
  private _onStderr(chunk: string): void {
    this._stderrChunks.push(chunk)
    this.emit('stderr', chunk)
  }

  /** Dispatch a parsed JSON-RPC response to the matching pending request. */
  private _handleMessage(message: JsonRpcResponse): void {
    if (message.id == null) {
      // Server-initiated notification / request – not handled in P1.
      this.emit('notification', message)
      return
    }

    const pending = this._pending.get(message.id)
    if (!pending) {
      // Unknown id – possibly timed out already.
      return
    }

    this._pending.delete(message.id)
    clearTimeout(pending.timer)

    if (message.error) {
      pending.reject(
        new McpRpcError(message.error.code, message.error.message, message.error.data),
      )
    } else {
      pending.resolve(message.result)
    }
  }

  /** Handle child_process `error` event (e.g. executable not found). */
  private _onProcessError(err: Error): void {
    this._rejectAll(err)
    this._cleanup()
  }

  /** Handle child_process `close` event. */
  private _onProcessClose(code: number | null, signal: string | null): void {
    if (this._connected || this._pending.size > 0) {
      const reason =
        signal != null
          ? `Server process terminated by signal ${signal}`
          : `Server process exited with code ${code ?? 'unknown'}`
      this._rejectAll(new Error(reason))
    }
    this._cleanup()
  }

  // -------------------------------------------------------------------------
  // Request / Response plumbing
  // -------------------------------------------------------------------------

  /**
   * Send a JSON-RPC request and return a promise that resolves with the result.
   */
  private _send(method: string, params?: unknown): Promise<unknown> {
    const id = this._nextId++

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined && { params }),
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`MCP request '${method}' timed out after ${this._options.requestTimeoutMs}ms`))
      }, this._options.requestTimeoutMs)

      this._pending.set(id, { resolve, reject, timer })

      const payload = JSON.stringify(request) + '\n'
      this._process!.stdin!.write(payload, (err) => {
        if (err) {
          this._pending.delete(id)
          clearTimeout(timer)
          reject(err)
        }
      })
    })
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  private _notify(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined && { params }),
    }

    const payload = JSON.stringify(notification) + '\n'
    this._process!.stdin!.write(payload)
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /** Throw if the client is not connected. */
  private _assertConnected(): void {
    if (!this._connected || !this._process) {
      throw new Error('McpStdioClient is not connected – call connect() first')
    }
  }

  /** Reject every pending request with the given error. */
  private _rejectAll(error: Error): void {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this._pending.delete(id)
    }
  }

  /** Reset internal state after the process has ended. */
  private _cleanup(): void {
    this._connected = false
    this._process = null
    this._stdoutBuffer = ''
  }

  /** Wait up to `ms` milliseconds for the child process to exit. */
  private _waitForExit(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this._process || this._process.exitCode !== null || this._process.signalCode !== null) {
        resolve()
        return
      }

      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, ms)

      const onClose = () => {
        cleanup()
        resolve()
      }

      const cleanup = () => {
        clearTimeout(timer)
        this._process?.removeListener('close', onClose)
      }

      this._process.once('close', onClose)
    })
  }
}

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

/** Error thrown when the MCP server returns a JSON-RPC error response. */
export class McpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message)
    this.name = 'McpRpcError'
  }
}
