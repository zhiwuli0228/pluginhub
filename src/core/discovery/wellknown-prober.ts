/**
 * Well-known endpoint prober for AI capability discovery.
 *
 * Probes standard and extended well-known paths on a domain to discover
 * AI catalogs, MCP server cards, A2A agent cards, and MCP server/discover
 * endpoints. All probes run in parallel with independent timeouts and
 * never throw; failures are captured in {@link ProbeResult.error}.
 *
 * @module
 */

/** Result of probing a single well-known endpoint. */
export interface ProbeResult {
  /** The URL that was probed. */
  url: string
  /** Whether the probe succeeded (HTTP 2xx + valid JSON). */
  success: boolean
  /** Parsed response body (if successful). */
  data?: unknown
  /** Error message (if failed). */
  error?: string
  /** Response time in milliseconds. */
  latencyMs: number
  /** Content-Type header value (if present). */
  contentType?: string
}

/** A successfully discovered capability from a probe. */
export interface Discovery {
  /** The kind of capability discovered. */
  type: 'ai-catalog' | 'mcp-server-card' | 'a2a-agent-card' | 'mcp-server-discover'
  /** The parsed response payload. */
  data: unknown
  /** The URL where the capability was found. */
  url: string
}

/** Aggregated results from probing all known endpoints on a domain. */
export interface DomainProbeReport {
  /** The domain that was probed. */
  domain: string
  /** Timestamp when probing started. */
  probedAt: Date
  /** Individual probe results for each attempted URL. */
  results: ProbeResult[]
  /** Successfully discovered capabilities. */
  discoveries: Discovery[]
}

/** Configuration options for {@link WellKnownProber}. */
export interface WellKnownProberOptions {
  /** Per-probe request timeout in milliseconds. Default: 5000. */
  timeoutMs?: number
  /** Additional well-known paths to probe beyond the defaults. */
  additionalPaths?: string[]
  /** Whether to attempt the MCP server/discover POST probe. Default: false. */
  tryMcpDiscover?: boolean
}

/** Default well-known GET paths probed in order. */
const DEFAULT_PATHS: readonly string[] = [
  '/.well-known/ai-catalog.json',
  '/.well-known/mcp/server-card',
  '/.well-known/mcp.json',
  '/.well-known/agent-card.json',
  '/.well-known/agent.json',
] as const

/**
 * Determines whether a value is a plain object (non-null, non-array).
 *
 * @param value - The value to check.
 * @returns True if the value is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates an AI Catalog response body.
 * Must be an object with an `entries` array property.
 *
 * @param data - Parsed JSON body.
 * @returns True if the body satisfies the AI Catalog shape.
 */
function isValidAiCatalog(data: unknown): boolean {
  return isPlainObject(data) && Array.isArray(data['entries'])
}

/**
 * Validates an MCP server card response body.
 * Must be an object with a `name` string property.
 *
 * @param data - Parsed JSON body.
 * @returns True if the body satisfies the MCP server card shape.
 */
function isValidMcpServerCard(data: unknown): boolean {
  return isPlainObject(data) && typeof data['name'] === 'string'
}

/**
 * Validates an A2A agent card response body.
 * Must be an object with both `name` (string) and `supportedInterfaces` properties.
 *
 * @param data - Parsed JSON body.
 * @returns True if the body satisfies the A2A agent card shape.
 */
function isValidA2aAgentCard(data: unknown): boolean {
  return (
    isPlainObject(data) &&
    typeof data['name'] === 'string' &&
    'supportedInterfaces' in data
  )
}

/**
 * Maps a well-known path to its expected discovery type.
 * Returns undefined for unrecognized paths.
 *
 * @param path - The well-known path.
 * @returns The discovery type, or undefined.
 */
function getDiscoveryTypeForPath(
  path: string,
): Discovery['type'] | undefined {
  switch (path) {
    case '/.well-known/ai-catalog.json':
      return 'ai-catalog'
    case '/.well-known/mcp/server-card':
    case '/.well-known/mcp.json':
      return 'mcp-server-card'
    case '/.well-known/agent-card.json':
    case '/.well-known/agent.json':
      return 'a2a-agent-card'
    default:
      return undefined
  }
}

/**
 * Returns the validation function for a given discovery type.
 *
 * @param type - The discovery type.
 * @returns A predicate that validates the parsed response body.
 */
function getValidatorForType(
  type: Discovery['type'],
): ((data: unknown) => boolean) | undefined {
  switch (type) {
    case 'ai-catalog':
      return isValidAiCatalog
    case 'mcp-server-card':
      return isValidMcpServerCard
    case 'a2a-agent-card':
      return isValidA2aAgentCard
    case 'mcp-server-discover':
      // JSON-RPC responses have a result field
      return (data: unknown) =>
        isPlainObject(data) && 'result' in data
    default:
      return undefined
  }
}

/**
 * Normalizes a user-supplied domain into a base URL with scheme.
 * If no scheme is provided, https:// is assumed.
 * Trailing slashes are stripped.
 *
 * @param domain - Raw domain input (e.g. "example.com" or "https://example.com/").
 * @returns Normalized base URL without trailing slash.
 */
function normalizeBaseUrl(domain: string): string {
  let base = domain.trim()
  if (!/^https?:\/\//i.test(base)) {
    base = `https://${base}`
  }
  return base.replace(/\/+$/, '')
}

/**
 * Probes well-known AI capability endpoints on a domain.
 *
 * All probes execute in parallel via `Promise.allSettled`. Each probe has
 * its own {@link AbortController} timeout. Failures are recorded in
 * {@link ProbeResult.error} rather than thrown.
 *
 * @example
 * ```ts
 * const prober = new WellKnownProber({ timeoutMs: 3000 })
 * const report = await prober.probe('example.com')
 * console.log(report.discoveries)
 * ```
 */
export class WellKnownProber {
  private readonly timeoutMs: number
  private readonly additionalPaths: string[]
  private readonly tryMcpDiscover: boolean

  constructor(options?: WellKnownProberOptions) {
    this.timeoutMs = options?.timeoutMs ?? 5000
    this.additionalPaths = options?.additionalPaths ?? []
    this.tryMcpDiscover = options?.tryMcpDiscover ?? false
  }

  /**
   * Returns the default list of well-known GET paths.
   *
   * @returns An array of well-known path strings.
   */
  static getDefaultPaths(): string[] {
    return [...DEFAULT_PATHS]
  }

  /**
   * Probes a domain for all known AI capability endpoints.
   *
   * Probes run in parallel with individual timeouts. The returned report
   * contains every probe result and any validated discoveries.
   *
   * Default probe list:
   * 1. `/.well-known/ai-catalog.json`
   * 2. `/.well-known/mcp/server-card`
   * 3. `/.well-known/mcp.json`
   * 4. `/.well-known/agent-card.json`
   * 5. `/.well-known/agent.json` (legacy A2A path)
   * 6. `POST /mcp` with `server/discover` (if enabled)
   *
   * @param domain - The domain to probe (with or without scheme).
   * @returns Aggregated probe report with discoveries.
   */
  async probe(domain: string): Promise<DomainProbeReport> {
    const baseUrl = normalizeBaseUrl(domain)
    const probedAt = new Date()

    // Build the full list of GET URLs to probe
    const allPaths = [...DEFAULT_PATHS, ...this.additionalPaths]
    const getUrls = allPaths.map((path) => `${baseUrl}${path}`)

    // Launch all GET probes in parallel
    const getPromises = getUrls.map((url) => this.probeUrl(url))

    // Optionally launch the MCP server/discover POST probe
    const postPromise = this.tryMcpDiscover
      ? this.probeMcpDiscover(baseUrl)
      : null

    // Await all probes
    const getResults = await Promise.all(getPromises)
    const postResult = postPromise ? await postPromise : null

    const results: ProbeResult[] = [...getResults]
    if (postResult) {
      results.push(postResult)
    }

    // Extract validated discoveries
    const discoveries: Discovery[] = []

    for (let i = 0; i < getResults.length; i++) {
      const result = getResults[i]!
      if (!result.success || result.data === undefined) continue

      const path = allPaths[i]!
      const type = getDiscoveryTypeForPath(path)
      if (!type) continue

      const validator = getValidatorForType(type)
      if (validator && validator(result.data)) {
        discoveries.push({ type, data: result.data, url: result.url })
      }
    }

    // Check MCP server/discover result
    if (postResult?.success && postResult.data !== undefined) {
      const validator = getValidatorForType('mcp-server-discover')
      if (validator && validator(postResult.data)) {
        discoveries.push({
          type: 'mcp-server-discover',
          data: postResult.data,
          url: postResult.url,
        })
      }
    }

    return {
      domain,
      probedAt,
      results,
      discoveries,
    }
  }

  /**
   * Probes a single URL with an independent timeout.
   *
   * Performs a GET request, parses the response as JSON, and captures
   * timing and content-type metadata. Never throws; errors are captured
   * in the returned {@link ProbeResult}.
   *
   * @param url - The fully-qualified URL to probe.
   * @returns The probe result for this URL.
   */
  async probeUrl(url: string): Promise<ProbeResult> {
    const start = performance.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(url, { signal: controller.signal })
      const latencyMs = Math.round(performance.now() - start)
      const contentType = response.headers.get('content-type') ?? undefined

      if (!response.ok) {
        return {
          url,
          success: false,
          error: `HTTP ${response.status} ${response.statusText}`,
          latencyMs,
          contentType,
        }
      }

      let data: unknown
      try {
        data = await response.json()
      } catch (parseError) {
        return {
          url,
          success: false,
          error: `JSON parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          latencyMs,
          contentType,
        }
      }

      return {
        url,
        success: true,
        data,
        latencyMs,
        contentType,
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start)

      if (err instanceof DOMException && err.name === 'AbortError') {
        return {
          url,
          success: false,
          error: `Timeout after ${this.timeoutMs}ms`,
          latencyMs,
        }
      }

      return {
        url,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Sends a JSON-RPC `server/discover` POST to the `/mcp` endpoint.
   *
   * This is used to discover MCP servers that expose their capabilities
   * via the MCP server/discover protocol rather than a static well-known file.
   *
   * @param baseUrl - The normalized base URL of the target.
   * @returns The probe result for the POST request.
   */
  private async probeMcpDiscover(baseUrl: string): Promise<ProbeResult> {
    const url = `${baseUrl}/mcp`
    const start = performance.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
    })

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      })

      const latencyMs = Math.round(performance.now() - start)
      const contentType = response.headers.get('content-type') ?? undefined

      if (!response.ok) {
        return {
          url,
          success: false,
          error: `HTTP ${response.status} ${response.statusText}`,
          latencyMs,
          contentType,
        }
      }

      let data: unknown
      try {
        data = await response.json()
      } catch (parseError) {
        return {
          url,
          success: false,
          error: `JSON parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          latencyMs,
          contentType,
        }
      }

      return {
        url,
        success: true,
        data,
        latencyMs,
        contentType,
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start)

      if (err instanceof DOMException && err.name === 'AbortError') {
        return {
          url,
          success: false,
          error: `Timeout after ${this.timeoutMs}ms`,
          latencyMs,
        }
      }

      return {
        url,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
