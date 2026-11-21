/**
 * Observer Bus – public API barrel export.
 *
 * @module observer
 */

export type {
  EventType,
  ObserverEvent,
  EventFilter,
  ObserverConfig,
} from './types.js'

export { ObserverBus } from './observer-bus.js'
export type { TraceContext } from './observer-bus.js'
