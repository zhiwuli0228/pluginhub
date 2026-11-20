/**
 * MCP Protocol Core Types (P1 subset)
 *
 * Covers JSON-RPC 2.0 base types and the MCP-specific structures needed for
 * tool discovery, invocation, and the initialize handshake as defined in the
 * MCP specification version 2026-07-28.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

/** A JSON-RPC 2.0 request object. */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

/** A JSON-RPC 2.0 notification (no id). */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/** A JSON-RPC 2.0 response object. */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: JsonRpcError
}

/** A JSON-RPC 2.0 error object. */
export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------
// MCP – Tools
// ---------------------------------------------------------------------------

/** Annotations that describe behavioural hints about a tool. */
export interface ToolAnnotations {
  /** The tool does not modify external state. */
  readOnlyHint?: boolean
  /** The tool may perform destructive operations. */
  destructiveHint?: boolean
  /** Repeated calls with the same arguments produce the same effect. */
  idempotentHint?: boolean
  /** The tool interacts with entities outside the local environment. */
  openWorldHint?: boolean
}

/** Describes a single tool exposed by an MCP server. */
export interface McpTool {
  /** Unique tool name within the server. */
  name: string
  /** Human-friendly display title. */
  title?: string
  /** Description of what the tool does. */
  description?: string
  /** JSON Schema describing the expected input parameters. */
  inputSchema: Record<string, unknown>
  /** Optional JSON Schema describing the output structure. */
  outputSchema?: Record<string, unknown>
  /** Optional behavioural annotations. */
  annotations?: ToolAnnotations
}

// ---------------------------------------------------------------------------
// MCP – Capabilities & Initialization
// ---------------------------------------------------------------------------

/** Capabilities advertised by an MCP server during initialization. */
export interface ServerCapabilities {
  tools?: { listChanged?: boolean }
  resources?: { subscribe?: boolean; listChanged?: boolean }
  prompts?: { listChanged?: boolean }
}

/** The result payload returned by the `initialize` method. */
export interface InitializeResult {
  protocolVersion: string
  capabilities: ServerCapabilities
  serverInfo: { name: string; version: string }
}
