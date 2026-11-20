/**
 * A2A (Agent-to-Agent) Protocol v1.0.1 Type Definitions
 *
 * Defines the core types for cross-organization agent delegation,
 * including Agent Card discovery, Task lifecycle, and JSON-RPC messaging.
 *
 * @module a2a/types
 */

// ---------------------------------------------------------------------------
// Agent Card
// ---------------------------------------------------------------------------

/** A2A Agent Card (v1.0.1) — describes an agent's capabilities and endpoints. */
export interface AgentCard {
  /** Human-readable agent name. */
  name: string
  /** Short description of what this agent does. */
  description: string
  /** Semantic version of the agent card / agent implementation. */
  version: string
  /** Supported transport interfaces (JSON-RPC, gRPC, HTTP+JSON). */
  supportedInterfaces: SupportedInterface[]
  /** Optional capability flags. */
  capabilities?: AgentCapabilities
  /** MIME types the agent accepts as input by default. */
  defaultInputModes?: string[]
  /** MIME types the agent produces as output by default. */
  defaultOutputModes?: string[]
  /** Advertised skills. */
  skills?: AgentSkill[]
  /** Organization that operates this agent. */
  provider?: { organization: string; url?: string }
  /** URL to human-readable documentation. */
  documentationUrl?: string
  /** URL to an icon representing the agent. */
  iconUrl?: string
  /** OAuth2 / API-key security scheme definitions. */
  securitySchemes?: Record<string, unknown>
  /** Security requirements referencing `securitySchemes` keys. */
  securityRequirements?: Array<Record<string, string[]>>
  /** Cryptographic signatures over the agent card. */
  signatures?: unknown[]
}

/** A single transport binding advertised in the Agent Card. */
export interface SupportedInterface {
  /** Absolute or relative URL where this binding is reachable. */
  url: string
  /** Wire protocol used at this endpoint. */
  protocolBinding: 'JSONRPC' | 'GRPC' | 'HTTP+JSON'
  /** Protocol version string (e.g. "1.0.1"). */
  protocolVersion: string
}

/** Optional capability flags declared by the agent. */
export interface AgentCapabilities {
  /** Whether the agent supports SSE streaming responses. */
  streaming?: boolean
  /** Whether the agent can push notifications to the client. */
  pushNotifications?: boolean
  /** Whether an extended (authenticated) agent card is available. */
  extendedAgentCard?: boolean
  /** Vendor-specific extensions. */
  extensions?: unknown[]
}

/** A discrete skill advertised by the agent. */
export interface AgentSkill {
  /** Unique skill identifier within this agent. */
  id: string
  /** Human-readable skill name. */
  name: string
  /** What the skill does. */
  description: string
  /** Searchable tags. */
  tags?: string[]
  /** Example prompts that trigger this skill. */
  examples?: string[]
  /** MIME types accepted as input for this skill. */
  inputModes?: string[]
  /** MIME types produced as output for this skill. */
  outputModes?: string[]
}

// ---------------------------------------------------------------------------
// Task & Status
// ---------------------------------------------------------------------------

/**
 * Task states forming the 9-state machine defined by A2A 1.0.1.
 *
 * ```
 * SUBMITTED → WORKING → COMPLETED
 *                     → FAILED
 *                     → INPUT_REQUIRED → WORKING
 *                     → AUTH_REQUIRED  → WORKING
 *                     → CANCELED
 *                     → REJECTED
 * UNSPECIFIED (initial / error fallback)
 * ```
 */
export type TaskState =
  | 'SUBMITTED'
  | 'WORKING'
  | 'INPUT_REQUIRED'
  | 'AUTH_REQUIRED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELED'
  | 'REJECTED'
  | 'UNSPECIFIED'

/** A stateful work unit exchanged between agents. */
export interface Task {
  /** Unique task identifier. */
  id: string
  /** Correlation ID linking related tasks across agents. */
  contextId?: string
  /** Current status snapshot. */
  status: TaskStatus
  /** Conversation history (messages exchanged so far). */
  messages?: Message[]
  /** Artifacts delivered by the agent. */
  artifacts?: Artifact[]
  /** Arbitrary vendor metadata. */
  metadata?: Record<string, unknown>
}

/** Immutable status snapshot of a task. */
export interface TaskStatus {
  /** Current state in the 9-state machine. */
  state: TaskState
  /** Optional message accompanying the state transition (e.g. clarification request). */
  message?: Message
  /** ISO 8601 timestamp of the state transition. */
  timestamp?: string
}

// ---------------------------------------------------------------------------
// Message & Parts
// ---------------------------------------------------------------------------

/** One turn in the agent conversation. */
export interface Message {
  /** Sender role. */
  role: 'user' | 'agent'
  /** Ordered content parts. */
  parts: Part[]
  /** Arbitrary vendor metadata. */
  metadata?: Record<string, unknown>
}

/**
 * Discriminated union of content parts.
 *
 * - `text`   — plain text / markdown
 * - `data`   — structured JSON payload
 * - `file`   — binary file reference (inline base64 or URI)
 */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'data'; data: unknown; mimeType?: string }
  | { type: 'file'; file: { name?: string; mimeType: string; uri?: string; bytes?: string } }

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

/** A deliverable produced by the agent, independent of the message stream. */
export interface Artifact {
  /** Unique artifact identifier within the task. */
  artifactId: string
  /** Optional human-readable name. */
  name?: string
  /** Optional description of the artifact. */
  description?: string
  /** Content parts comprising the artifact. */
  parts: Part[]
  /** Arbitrary vendor metadata. */
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 Envelope
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 request envelope used by A2A methods. */
export interface A2ARequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

/** JSON-RPC 2.0 response envelope returned by A2A endpoints. */
export interface A2AResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}
