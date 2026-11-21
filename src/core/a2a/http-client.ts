/**
 * A2A 1.0.1 HTTP+JSON Client
 *
 * Minimal, zero-dependency client for the Agent-to-Agent protocol.
 * Uses Node.js 20+ built-in `fetch` and JSON-RPC 2.0 over HTTP POST.
 *
 * @module a2a/http-client
 */

import type {
  AgentCard,
  Message,
  Task,
  TaskV11,
  SendTaskOptions,
  SendTaskResult,
  A2ARequest,
  A2AResponse,
} from './types.js'

// ---------------------------------------------------------------------------
// Options & Errors
// ---------------------------------------------------------------------------

/** Configuration for {@link A2AHttpClient}. */
export interface A2AClientOptions {
  /** Base URL of the A2A agent endpoint (no trailing slash). */
  baseUrl: string
  /** Request timeout in milliseconds. Defaults to `30_000`. */
  timeoutMs?: number
  /** Additional headers sent with every request (e.g. `Authorization`). */
  headers?: Record<string, string>
}

/** Error thrown when the remote agent returns a JSON-RPC error object. */
export class A2ARpcError extends Error {
  /** JSON-RPC error code. */
  public readonly code: number
  /** Optional structured data attached to the error. */
  public readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(`A2A RPC error ${code}: ${message}`)
    this.name = 'A2ARpcError'
    this.code = code
    this.data = data
  }
}

/** Error thrown when the HTTP layer fails (non-2xx, network, timeout). */
export class A2AHttpError extends Error {
  /** HTTP status code (0 when the request never completed). */
  public readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(`A2A HTTP error ${statusCode}: ${message}`)
    this.name = 'A2AHttpError'
    this.statusCode = statusCode
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Default well-known path for the Agent Card. */
const DEFAULT_AGENT_CARD_PATH = '/.well-known/agent-card.json'

/** Auto-incrementing JSON-RPC request id. */
let nextRpcId = 1

/** Build a JSON-RPC 2.0 request envelope. */
function buildRequest(method: string, params?: unknown): A2ARequest {
  return {
    jsonrpc: '2.0',
    id: nextRpcId++,
    method,
    params,
  }
}

/** Strip a single trailing slash from a base URL. */
function normalizeBase(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Minimal HTTP+JSON client for the A2A 1.0.1 protocol.
 *
 * ```ts
 * const client = new A2AHttpClient({ baseUrl: 'https://agent.example.com' })
 * const card = await client.getAgentCard()
 * const task = await client.sendTask({
 *   message: { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
 * })
 * ```
 */
export class A2AHttpClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly headers: Record<string, string>

  constructor(options: A2AClientOptions) {
    this.baseUrl = normalizeBase(options.baseUrl)
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.headers = { ...options.headers }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Fetch the Agent Card.
   *
   * @param path - Custom path. Defaults to `/.well-known/agent-card.json`.
   * @returns Parsed {@link AgentCard}.
   */
  async getAgentCard(path?: string): Promise<AgentCard> {
    const url = `${this.baseUrl}${path ?? DEFAULT_AGENT_CARD_PATH}`
    const response = await this.fetchWithTimeout(url, { method: 'GET' })

    if (!response.ok) {
      throw new A2AHttpError(response.status, `Failed to fetch Agent Card from ${url}`)
    }

    return (await response.json()) as AgentCard
  }

  /**
   * Submit a new task by sending an initial message.
   *
   * Corresponds to the `tasks/send` JSON-RPC method.
   *
   * @param params - Task submission parameters.
   * @returns The created or updated {@link Task}.
   */
  async sendTask(params: {
    id?: string
    message: Message
    acceptedOutputModes?: string[]
  }): Promise<Task> {
    const rpcParams: Record<string, unknown> = {
      message: params.message,
    }
    if (params.id !== undefined) {
      rpcParams.id = params.id
    }
    if (params.acceptedOutputModes !== undefined) {
      rpcParams.acceptedOutputModes = params.acceptedOutputModes
    }

    return this.rpcCall<Task>('tasks/send', rpcParams)
  }

  /**
   * Retrieve the current state of an existing task.
   *
   * Corresponds to the `tasks/get` JSON-RPC method.
   *
   * @param taskId - The task identifier.
   * @returns Current {@link Task} snapshot.
   */
  async getTask(taskId: string): Promise<Task> {
    return this.rpcCall<Task>('tasks/get', { id: taskId })
  }

  /**
   * Cancel a running task.
   *
   * Corresponds to the `tasks/cancel` JSON-RPC method.
   *
   * @param taskId - The task identifier to cancel.
   * @returns Updated {@link Task} with cancellation status.
   */
  async cancelTask(taskId: string): Promise<Task> {
    return this.rpcCall<Task>('tasks/cancel', { id: taskId })
  }

  /**
   * Send a follow-up message to an existing task.
   *
   * Reuses the `tasks/send` JSON-RPC method with the task's ID so the
   * remote agent appends the message to the ongoing conversation.
   *
   * @param params - Follow-up parameters including the target task ID.
   * @returns Updated {@link Task}.
   */
  async sendMessage(params: {
    taskId: string
    message: Message
  }): Promise<Task> {
    return this.rpcCall<Task>('tasks/send', {
      id: params.taskId,
      message: params.message,
    })
  }

  // -------------------------------------------------------------------------
  // A2A 1.1 Methods
  // -------------------------------------------------------------------------

  /**
   * Send a task with 1.1 generation-based concurrency control.
   *
   * If `options.expectedGeneration` is provided, an `if_generation_match`
   * field is included in the JSON-RPC params so the server can enforce
   * optimistic concurrency. The response is parsed for a `generation` field
   * when the server supports A2A 1.1.
   *
   * @param params  - Standard send-task parameters.
   * @param options - Optional 1.1 concurrency / live flags.
   * @returns The task and optional new generation.
   */
  async sendTaskV11(
    params: {
      id?: string
      message: Message
      acceptedOutputModes?: string[]
    },
    options?: SendTaskOptions,
  ): Promise<SendTaskResult> {
    const rpcParams: Record<string, unknown> = {
      message: params.message,
    }
    if (params.id !== undefined) {
      rpcParams.id = params.id
    }
    if (params.acceptedOutputModes !== undefined) {
      rpcParams.acceptedOutputModes = params.acceptedOutputModes
    }
    if (options?.expectedGeneration !== undefined) {
      rpcParams.if_generation_match = options.expectedGeneration
    }

    const result = await this.rpcCall<Record<string, unknown>>('tasks/send', rpcParams)

    return this.extractSendTaskResult(result)
  }

  /**
   * Send a live (streaming) message to an existing task (1.1 SendLiveMessage).
   *
   * Uses the `tasks/sendSubscribe` JSON-RPC method introduced in A2A 1.1.
   * If the server does not recognise the method (method-not-found error),
   * the call gracefully falls back to the regular {@link sendMessage} path.
   *
   * @param params - Target task ID and message payload.
   * @returns The task and optional new generation.
   */
  async sendLiveMessage(params: {
    taskId: string
    message: Message
  }): Promise<SendTaskResult> {
    try {
      const result = await this.rpcCall<Record<string, unknown>>(
        'tasks/sendSubscribe',
        {
          id: params.taskId,
          message: params.message,
        },
      )
      return this.extractSendTaskResult(result)
    } catch (err) {
      // Fall back when the server does not support the 1.1 live method.
      // JSON-RPC -32601 = Method not found; HTTP 404/405 also qualify.
      const isMethodNotFound =
        err instanceof A2ARpcError && err.code === -32601
      const isHttpNotFound =
        err instanceof A2AHttpError &&
        (err.statusCode === 404 || err.statusCode === 405)

      if (isMethodNotFound || isHttpNotFound) {
        const task = await this.sendMessage(params)
        return { task }
      }
      throw err
    }
  }

  /**
   * Get task with generation info (1.1).
   *
   * Identical to {@link getTask} but returns the extended {@link TaskV11}
   * type that includes the optional `generation` field.
   *
   * @param taskId - The task identifier.
   * @returns Current {@link TaskV11} snapshot including generation if available.
   */
  async getTaskV11(taskId: string): Promise<TaskV11> {
    return this.rpcCall<TaskV11>('tasks/get', { id: taskId })
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Normalise a raw RPC result into a {@link SendTaskResult}.
   *
   * Handles both the case where the server wraps the task in an object with
   * a top-level `generation`, and the case where it returns a plain Task.
   */
  private extractSendTaskResult(raw: Record<string, unknown>): SendTaskResult {
    // If the result has a nested `task` key, unwrap it.
    if (raw && typeof raw === 'object' && 'task' in raw) {
      return {
        task: raw.task as Task,
        generation:
          typeof raw.generation === 'number' ? raw.generation : undefined,
      }
    }

    // Otherwise treat the whole result as a Task (possibly with generation).
    const task = raw as unknown as Task
    const generation =
      typeof (raw as Record<string, unknown>).generation === 'number'
        ? ((raw as Record<string, unknown>).generation as number)
        : undefined

    return { task, generation }
  }

  /**
   * Execute a JSON-RPC call against the agent endpoint.
   *
   * Handles both HTTP-level and RPC-level errors.
   */
  private async rpcCall<T>(method: string, params: unknown): Promise<T> {
    const body = buildRequest(method, params)
    const response = await this.fetchWithTimeout(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      let detail = ''
      try {
        detail = await response.text()
      } catch {
        // ignore read failure — we already have the status
      }
      throw new A2AHttpError(response.status, detail || response.statusText)
    }

    const envelope = (await response.json()) as A2AResponse

    if (envelope.error) {
      throw new A2ARpcError(
        envelope.error.code,
        envelope.error.message,
        envelope.error.data,
      )
    }

    return envelope.result as T
  }

  /**
   * Wrapper around global `fetch` that enforces a timeout via AbortController.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const mergedHeaders: Record<string, string> = {
        ...this.headers,
        ...(init.headers as Record<string, string> | undefined),
      }

      return await fetch(url, {
        ...init,
        headers: mergedHeaders,
        signal: controller.signal,
      })
    } catch (err) {
      // Distinguish abort (timeout) from other network errors
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new A2AHttpError(0, `Request timed out after ${this.timeoutMs}ms`)
      }
      // Node.js AbortError may not be a DOMException
      if (err instanceof Error && err.name === 'AbortError') {
        throw new A2AHttpError(0, `Request timed out after ${this.timeoutMs}ms`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}
