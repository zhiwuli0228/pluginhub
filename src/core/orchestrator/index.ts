/**
 * @module orchestrator
 * Public API surface for the PluginHub process orchestrator.
 */

// Core orchestrator
export { Orchestrator } from './orchestrator.js'
export type { PluginStartOptions, PluginInstance } from './orchestrator.js'

// Process manager
export { ProcessManager } from './process-manager.js'

// Port allocator
export { PortAllocator } from './port-allocator.js'
export type { PortAllocation } from './port-allocator.js'

// Health checker
export { HealthChecker } from './health-checker.js'
export type { HealthCheckConfig, HealthStatus, ProbeType, HealthCheckResult } from './health-checker.js'

// Log drain
export { LogDrain } from './log-drain.js'
export type { LogEntry, LogDrainOptions } from './log-drain.js'

// Shared types
export type {
  OrchestratorConfig,
  ProcessHandle,
  ProcessState,
  SpawnOptions,
} from './types.js'
