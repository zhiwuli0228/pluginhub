/**
 * A2A (Agent-to-Agent) Protocol v1.0.1 — Public API
 *
 * @module a2a
 */

// Types
export type {
  AgentCard,
  SupportedInterface,
  AgentCapabilities,
  AgentSkill,
  TaskState,
  Task,
  TaskStatus,
  Message,
  Part,
  Artifact,
  A2ARequest,
  A2AResponse,
  // A2A 1.1 additions
  TaskGeneration,
  TaskV11,
  SendTaskOptions,
  SendTaskResult,
} from './types.js'

// Client
export { A2AHttpClient, A2ARpcError, A2AHttpError } from './http-client.js'
export type { A2AClientOptions } from './http-client.js'
