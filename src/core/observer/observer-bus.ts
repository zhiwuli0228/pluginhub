/**
 * Observer Bus – unified runtime event collector.
 *
 * Collects structured events into a fixed-size ring buffer, supports filtered
 * queries, typed subscriptions, and Server-Sent Events (SSE) streaming with
 * heartbeat keep-alive and history replay for new connections.
 *
 * @module observer/observer-bus
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  EventType,
  ObserverEvent,
  EventFilter,
  ObserverConfig,
} from './types.js'

/** Default maximum number of events kept in the ring buffer. */
const DEFAULT_MAX_BUFFER_SIZE = 10_000

/** Default SSE heartbeat interval in milliseconds. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

/** Number of recent events replayed to a new SSE connection. */
const SSE_REPLAY_COUNT = 50

/**
 * Trace context passed alongside an event emission.
 */
export interface TraceContext {
  traceId?: string
  spanId?: string
  parentSpanId?: string
}

/**
 * ObserverBus collects structured runtime events into an in-memory ring buffer
 * and exposes query, subscription and SSE streaming APIs.
 *
 * @example
 * ```ts
 * const bus = new ObserverBus({ maxBufferSize: 5000 })
 * bus.emitEvent('process.started', { pid: 1234 })
 * const events = bus.query({ types: ['process.started'] })
 * ```
 */
export class ObserverBus extends EventEmitter {
  /** Ring buffer storage. */
  private readonly _buffer: (ObserverEvent | undefined)[]
  /** Write head index into the ring buffer. */
  private _head = 0
  /** Total number of events ever emitted (monotonically increasing). */
  private _totalEvents = 0
  /** Per-type event counters. */
  private readonly _counts: Map<string, number> = new Map()
  /** Resolved configuration. */
  private readonly _config: Required<ObserverConfig>
  /** Active SSE abort controllers for cleanup on shutdown. */
  private readonly _sseControllers: Set<AbortController> = new Set()
  /** Whether the bus has been shut down. */
  private _shutdown = false

  constructor(config?: ObserverConfig) {
    super()
    this._config = {
      maxBufferSize: config?.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE,
      persistEnabled: config?.persistEnabled ?? false,
      heartbeatIntervalMs: config?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    }
    this._buffer = new Array<ObserverEvent | undefined>(this._config.maxBufferSize).fill(undefined)
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Emit a structured event into the bus.
   *
   * Generates a UUID and ISO timestamp, stores the event in the ring buffer,
   * updates per-type counters, and emits the event on the underlying
   * EventEmitter so that subscribers are notified.
   *
   * @param type - The event type tag.
   * @param payload - Type-specific event data.
   * @param traceContext - Optional distributed-tracing correlation fields.
   * @returns The fully-formed {@link ObserverEvent}.
   */
  emitEvent(
    type: EventType,
    payload: Record<string, unknown>,
    traceContext?: TraceContext,
  ): ObserverEvent {
    if (this._shutdown) {
      throw new Error('ObserverBus has been shut down')
    }

    const event: ObserverEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      payload,
      ...(traceContext?.traceId !== undefined && { traceId: traceContext.traceId }),
      ...(traceContext?.spanId !== undefined && { spanId: traceContext.spanId }),
      ...(traceContext?.parentSpanId !== undefined && { parentSpanId: traceContext.parentSpanId }),
    }

    // Write into ring buffer at current head, then advance.
    this._buffer[this._head] = event
    this._head = (this._head + 1) % this._config.maxBufferSize
    this._totalEvents++

    // Update per-type counter.
    this._counts.set(type, (this._counts.get(type) ?? 0) + 1)

    // Notify EventEmitter listeners registered via subscribe / on.
    this.emit(type, event)
    this.emit('*', event)

    return event
  }

  /**
   * Query buffered events with an optional filter.
   *
   * Events are returned in insertion order (oldest first). When a `limit` is
   * specified the most recent matching events up to that limit are returned.
   *
   * @param filter - Optional filter criteria.
   * @returns Matching events sorted oldest-first.
   */
  query(filter?: EventFilter): ObserverEvent[] {
    const events = this._snapshotOrdered()

    let result = events

    if (filter) {
      if (filter.types && filter.types.length > 0) {
        const typeSet = new Set<EventType>(filter.types)
        result = result.filter((e) => typeSet.has(e.type))
      }

      if (filter.traceId !== undefined) {
        result = result.filter((e) => e.traceId === filter.traceId)
      }

      if (filter.since !== undefined) {
        const sinceMs = filter.since.getTime()
        result = result.filter((e) => new Date(e.timestamp).getTime() >= sinceMs)
      }

      if (filter.until !== undefined) {
        const untilMs = filter.until.getTime()
        result = result.filter((e) => new Date(e.timestamp).getTime() <= untilMs)
      }

      if (filter.limit !== undefined && filter.limit > 0 && result.length > filter.limit) {
        // Return the most recent N matches.
        result = result.slice(result.length - filter.limit)
      }
    }

    return result
  }

  /**
   * Get event counts grouped by event type.
   *
   * @returns A plain object mapping each observed event type to its count.
   */
  getCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [type, count] of this._counts) {
      out[type] = count
    }
    return out
  }

  /**
   * Subscribe to one or more event types.
   *
   * @param types - Event types to listen for.
   * @param callback - Invoked with each matching event.
   * @returns An unsubscribe function that removes the listener.
   */
  subscribe(types: EventType[], callback: (event: ObserverEvent) => void): () => void {
    for (const type of types) {
      this.on(type, callback)
    }

    return () => {
      for (const type of types) {
        this.off(type, callback)
      }
    }
  }

  /**
   * Create an SSE stream handler.
   *
   * Returns an async function that accepts a `WritableStream`. When invoked it:
   * 1. Replays the most recent matching historical events.
   * 2. Streams new matching events as they arrive.
   * 3. Sends periodic heartbeat comments to keep the connection alive.
   * 4. Cleans up on client disconnect or bus shutdown.
   *
   * @param filter - Optional filter applied to both replay and live events.
   * @returns An async function accepting a writable stream.
   */
  createSSEHandler(filter?: EventFilter): (stream: NodeJS.WritableStream) => Promise<void> {
    return async (stream: NodeJS.WritableStream): Promise<void> => {
      if (this._shutdown) {
        return
      }

      const ac = new AbortController()
      this._sseControllers.add(ac)

      // --- Replay recent history -----------------------------------------------
      const history = this.query({ ...filter, limit: SSE_REPLAY_COUNT })
      for (const event of history) {
        writeSSE(stream, event)
      }

      // --- Live subscription ---------------------------------------------------
      const onEvent = (event: ObserverEvent) => {
        if (ac.signal.aborted) return
        if (!matchesFilter(event, filter)) return
        writeSSE(stream, event)
      }

      // Listen on wildcard so we can apply filter ourselves.
      this.on('*', onEvent)

      // --- Heartbeat timer -----------------------------------------------------
      const heartbeatTimer = setInterval(() => {
        if (ac.signal.aborted) return
        try {
          stream.write(': heartbeat\n\n')
        } catch {
          cleanup()
        }
      }, this._config.heartbeatIntervalMs)

      // --- Cleanup helper ------------------------------------------------------
      const cleanup = () => {
        if (ac.signal.aborted) return
        ac.abort()
        clearInterval(heartbeatTimer)
        this.off('*', onEvent)
        this._sseControllers.delete(ac)
      }

      // Detect client disconnect.
      stream.on('close', cleanup)
      stream.on('error', cleanup)
      ac.signal.addEventListener('abort', cleanup, { once: true })

      // Keep the promise pending until the stream ends.
      await new Promise<void>((resolve) => {
        stream.on('close', resolve)
        stream.on('error', resolve)
        ac.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  }

  /**
   * Clear all buffered events and reset counters.
   */
  clear(): void {
    this._buffer.fill(undefined)
    this._head = 0
    this._totalEvents = 0
    this._counts.clear()
  }

  /**
   * Total number of events emitted since construction (including evicted ones).
   */
  get totalEvents(): number {
    return this._totalEvents
  }

  /**
   * Shut down the bus: close all active SSE connections and release resources.
   */
  async shutdown(): Promise<void> {
    if (this._shutdown) return
    this._shutdown = true

    // Abort every active SSE stream.
    for (const ac of this._sseControllers) {
      ac.abort()
    }
    this._sseControllers.clear()

    // Remove all EventEmitter listeners.
    this.removeAllListeners()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Return all non-empty buffer slots in insertion order (oldest → newest).
   */
  private _snapshotOrdered(): ObserverEvent[] {
    const size = this._config.maxBufferSize
    const result: ObserverEvent[] = []

    if (this._totalEvents < size) {
      // Buffer hasn't wrapped yet – read from 0..head-1.
      for (let i = 0; i < this._head; i++) {
        const ev = this._buffer[i]
        if (ev !== undefined) result.push(ev)
      }
    } else {
      // Buffer has wrapped – read from head..end then 0..head-1.
      for (let i = this._head; i < size; i++) {
        const ev = this._buffer[i]
        if (ev !== undefined) result.push(ev)
      }
      for (let i = 0; i < this._head; i++) {
        const ev = this._buffer[i]
        if (ev !== undefined) result.push(ev)
      }
    }

    return result
  }
}

// =============================================================================
// Module-private helpers
// =============================================================================

/**
 * Write a single SSE `data:` frame to the stream.
 */
function writeSSE(stream: NodeJS.WritableStream, event: ObserverEvent): void {
  try {
    stream.write(`data: ${JSON.stringify(event)}\n\n`)
  } catch {
    // Stream already closed – caller handles cleanup.
  }
}

/**
 * Check whether an event matches an optional filter.
 * Used by the SSE live-subscription path where we listen on `*` and filter
 * manually so that a single listener covers all types.
 */
function matchesFilter(event: ObserverEvent, filter?: EventFilter): boolean {
  if (!filter) return true

  if (filter.types && filter.types.length > 0) {
    if (!filter.types.includes(event.type)) return false
  }

  if (filter.traceId !== undefined && event.traceId !== filter.traceId) {
    return false
  }

  if (filter.since !== undefined) {
    if (new Date(event.timestamp).getTime() < filter.since.getTime()) return false
  }

  if (filter.until !== undefined) {
    if (new Date(event.timestamp).getTime() > filter.until.getTime()) return false
  }

  return true
}
