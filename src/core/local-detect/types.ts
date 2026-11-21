/**
 * Local-only discovery and launch contracts.
 *
 * PluginHub manages plugins that live on this machine. A connector therefore
 * must never hard-code "where" a plugin listens — ports change whenever the
 * host restarts. Instead a connector declares:
 *
 * - {@link DiscoverSpec}: how to *recognise* the plugin (env hint, port hints,
 *   and a fingerprint probe whose response proves identity);
 * - {@link LaunchSpec}: how to *start* it if nothing is found.
 *
 * @module local-detect/types
 */

/** A request used to recognise a plugin on a candidate origin. */
export interface FingerprintSpec {
  /** Path to request, e.g. `/api/status`. */
  path: string
  /** HTTP method. Defaults to `GET`. */
  method?: string
  /** Extra request headers. */
  headers?: Record<string, string>
  /** Request body for POST probes. */
  body?: string
  /** Expected HTTP status. Defaults to 200. */
  expectStatus?: number
  /**
   * Path of a JSON property that must exist in the response body.
   * e.g. `hubRoot` proves this is a Memory Hub, `totals` proves token usage.
   */
  expectJsonKey?: string
  /** Substring the response body must contain. */
  expectBodyContains?: string
  /** Per-probe timeout in milliseconds. Defaults to 1500. */
  timeoutMs?: number
}

/** How to find an already-running instance. */
export interface DiscoverSpec {
  /** Environment variables that may hold the origin (tried first). */
  env?: string[]
  /** Port hints, tried before the machine-wide scan. */
  ports?: number[]
  /** Fingerprint that proves identity. */
  probe?: FingerprintSpec
  /** Hosts to try. Defaults to `['127.0.0.1']`. */
  hosts?: string[]
  /** Skip the machine-wide listening-port scan. */
  skipPortScan?: boolean
}

/** How to start a plugin whose web endpoint is not running. */
export interface LaunchSpec {
  /** Executable to run. */
  command: string
  /** Arguments. */
  args?: string[]
  /** Working directory. */
  cwd?: string
  /** Extra environment variables. */
  env?: Record<string, string>
  /**
   * Run through a shell. Required on Windows for `.cmd` shims such as `npx`
   * or a globally installed `dsh.ps1`.
   */
  shell?: boolean
  /** How long to wait for the fingerprint to succeed. Defaults to 30000. */
  readyTimeoutMs?: number
  /** Grace period before the child is considered abandoned (informational). */
  shutdownHint?: string
}

/** Where a resolved origin came from — surfaced in the UI for transparency. */
export type ResolutionSource = 'configured' | 'env' | 'port-hint' | 'port-scan' | 'launched'

/** Result of resolving one connector's origin. */
export interface Resolution {
  /** Origin such as `http://127.0.0.1:62724`, or null when not found. */
  origin: string | null
  /** How the origin was found. */
  source: ResolutionSource | null
  /** Human-readable failure detail when `origin` is null. */
  error?: string
  /** Ports that were actually tried. */
  tried?: number[]
}
