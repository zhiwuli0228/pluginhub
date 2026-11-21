/**
 * MCP Apps (SEP-1865) public API.
 *
 * Re-exports all types and the sandbox renderer for external consumption.
 *
 * @module
 */

export type {
  McpAppManifest,
  McpAppPermission,
  McpAppRpcMessage,
  McpAppRenderResult,
  McpAppSandboxConfig,
} from './types.js'

export { McpAppSandbox } from './sandbox.js'
