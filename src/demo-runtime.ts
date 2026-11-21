/**
 * Runtime module loaded by the PluginHub demo.
 *
 * The demo runs as plain Node, so instead of importing TypeScript sources
 * directly (or duplicating protocol code) it bundles this entry with esbuild at
 * startup and imports the result. That keeps the demo thin while the real logic
 * stays in the tested `src/core` modules.
 *
 * @module demo-runtime
 */

export { McpStdioClient, McpRpcError } from './core/mcp/index.js'
export type { McpTool, McpStdioClientOptions } from './core/mcp/index.js'

export {
  listListeningPorts,
  invalidatePortCache,
  resolveOrigin,
  probeFingerprint,
  normaliseOrigin,
  refreshAfterLaunch,
  launchAndWait,
} from './core/local-detect/index.js'
export type {
  DiscoverSpec,
  FingerprintSpec,
  LaunchSpec,
  LaunchResult,
  Resolution,
} from './core/local-detect/index.js'
