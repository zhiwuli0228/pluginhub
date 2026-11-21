/**
 * Observer Bus type definitions.
 *
 * Defines the event taxonomy, event shape, query filters and bus configuration
 * used by the Observer Bus to collect and correlate runtime events across
 * agents and protocols.
 *
 * @module observer/types
 */

/** Event types emitted by the observer bus */
export type EventType =
  | 'capability.invoked'
  | 'capability.completed'
  | 'capability.failed'
  | 'process.state_changed'
  | 'process.started'
  | 'process.stopped'
  | 'health.probe_result'
  | 'health.status_changed'
  | 'permission.requested'
  | 'permission.granted'
  | 'permission.denied'
  | 'discovery.entry_added'
  | 'discovery.entry_removed'
  | 'routing.matched'
  | 'routing.approval_required'
  | 'error.unified'

/** A single observer event */
export interface ObserverEvent {
  /** Unique event ID (UUID) */
  id: string
  /** Event timestamp (ISO 8601) */
  timestamp: string
  /** Event type */
  type: EventType
  /** Event payload (type-specific) */
  payload: Record<string, unknown>
  /** Trace correlation ID (for cross-component tracing) */
  traceId?: string
  /** Span ID within the trace */
  spanId?: string
  /** Parent span ID */
  parentSpanId?: string
}

/** Filter for querying events */
export interface EventFilter {
  /** Match only these event types */
  types?: EventType[]
  /** Match only events with this trace ID */
  traceId?: string
  /** Match only events at or after this time */
  since?: Date
  /** Match only events at or before this time */
  until?: Date
  /** Maximum number of events to return */
  limit?: number
}

/** Observer configuration */
export interface ObserverConfig {
  /** Maximum events to keep in memory ring buffer (default 10000) */
  maxBufferSize?: number
  /** Whether to persist events to SQLite (default false; P4 uses in-memory only) */
  persistEnabled?: boolean
  /** SSE heartbeat interval in milliseconds (default 30000) */
  heartbeatIntervalMs?: number
}
