/**
 * MCP Apps (SEP-1865) type definitions.
 *
 * Defines the manifest shape, JSON-RPC message format over postMessage,
 * sandbox configuration, and render results for secure iframe rendering.
 *
 * @module
 */

/** MCP App manifest from tool _meta.ui */
export interface McpAppManifest {
  /** Extension ID: io.modelcontextprotocol/ui */
  extension: string
  /** Resource URI: ui://<path> */
  resourceUri: string
  /** Fallback when UI can't render: 'text' | 'structuredContent' */
  fallback?: 'text' | 'structuredContent'
  /** Allowed connect domains for CSP */
  connectDomains?: string[]
  /** Allowed resource domains for CSP */
  resourceDomains?: string[]
  /** Allowed frame domains for nested iframes */
  frameDomains?: string[]
  /** Requested permissions */
  permissions?: McpAppPermission[]
}

/** A single permission request from an MCP App */
export interface McpAppPermission {
  type: 'camera' | 'microphone' | 'geolocation' | 'clipboard-read' | 'clipboard-write'
  reason?: string
}

/** JSON-RPC message over postMessage */
export interface McpAppRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

/** Sandbox configuration for rendering */
export interface McpAppSandboxConfig {
  /** CSP policy string */
  csp: string
  /** Sandbox attribute value */
  sandbox: string
  /** Allowed permissions */
  allow: string
}

/** Render result */
export interface McpAppRenderResult {
  /** HTML content to inject into iframe srcdoc */
  html: string
  /** Sandbox configuration */
  sandbox: McpAppSandboxConfig
  /** Warnings generated during template analysis */
  warnings: string[]
}
