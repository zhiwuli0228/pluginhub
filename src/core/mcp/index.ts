/**
 * MCP stdio client – public API surface.
 *
 * @module
 */

// Types
export type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcError,
  McpTool,
  ToolAnnotations,
  ServerCapabilities,
  InitializeResult,
} from './types.js'

// Client
export { McpStdioClient, McpRpcError } from './stdio-client.js'
export type { McpStdioClientOptions } from './stdio-client.js'
