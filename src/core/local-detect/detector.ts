/**
 * Resolve where a plugin actually listens, and launch it when it is down.
 *
 * @module local-detect/detector
 */

import { listListeningPorts, invalidatePortCache } from './ports.js'
import type { DiscoverSpec, FingerprintSpec, Resolution } from './types.js'

/**
 * Fetch a candidate origin and decide whether it is the plugin we are after.
 *
 * Returns `true` only when the fingerprint matches: status, optional JSON key,
 * and optional body substring all agree. A bare 200 is not enough — several
 * plugins share the host's HTTP server and would otherwise be confused.
 */
export async function probeFingerprint(origin: string, spec: FingerprintSpec): Promise<boolean> {
  const url = `${origin.replace(/\/$/, '')}${spec.path}`
  const init: RequestInit = {
    method: spec.method || 'GET',
    headers: { ...(spec.headers || {}) },
    signal: AbortSignal.timeout(spec.timeoutMs ?? 1500),
  }
  if (spec.body !== undefined) init.body = spec.body

  try {
    const res = await fetch(url, init)
    if (res.status !== (spec.expectStatus ?? 200)) return false

    if (spec.expectJsonKey || spec.expectBodyContains) {
      const text = await res.text()
      if (spec.expectBodyContains && !text.includes(spec.expectBodyContains)) return false
      if (spec.expectJsonKey) {
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          return false
        }
        if (!hasPath(json, spec.expectJsonKey)) return false
      }
    }
    return true
  } catch {
    return false
  }
}

/** Walk a dotted property path such as `totals.cost`. */
function hasPath(value: unknown, path: string): boolean {
  let cur: unknown = value
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return false
    if (!(key in (cur as Record<string, unknown>))) return false
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur !== undefined
}

/** Build `http://host:port` candidates from a port hint list. */
function candidatesFromPorts(hosts: string[], ports: number[]): string[] {
  const out: string[] = []
  for (const host of hosts) for (const port of ports) out.push(`http://${host}:${port}`)
  return out
}

/**
 * Resolve the origin a connector should be addressed at.
 *
 * Order:
 * 1. `discover.env` — an explicit environment hint wins (the host sets these).
 * 2. `discover.ports` — cheap, deterministic hints.
 * 3. Machine-wide listening-port scan — covers "user changed the port".
 *
 * When no `discover` spec is present the connector is treated as unreachable
 * unless an upstream was configured statically by the caller.
 */
export async function resolveOrigin(discover: DiscoverSpec | null | undefined): Promise<Resolution> {
  if (!discover) return { origin: null, source: null, error: 'no discover spec' }

  const hosts = discover.hosts && discover.hosts.length ? discover.hosts : ['127.0.0.1']
  const probe = discover.probe
  const tried: number[] = []

  // 1. Environment hints
  for (const name of discover.env || []) {
    const raw = process.env[name]
    if (!raw) continue
    const origin = normaliseOrigin(raw)
    if (!origin) continue
    if (!probe || (await probeFingerprint(origin, probe))) {
      return { origin, source: 'env', tried }
    }
  }

  // 2. Port hints
  if (discover.ports && discover.ports.length) {
    tried.push(...discover.ports)
    for (const origin of candidatesFromPorts(hosts, discover.ports)) {
      if (!probe || (await probeFingerprint(origin, probe))) {
        return { origin, source: 'port-hint', tried }
      }
    }
  }

  // 3. Machine-wide scan
  if (!discover.skipPortScan) {
    const listening = await listListeningPorts()
    const fresh = listening.filter((p) => !tried.includes(p))
    tried.push(...fresh)
    for (const origin of candidatesFromPorts(hosts, fresh)) {
      if (!probe || (await probeFingerprint(origin, probe))) {
        return { origin, source: 'port-scan', tried }
      }
    }
  }

  return {
    origin: null,
    source: null,
    tried,
    error: `未在本机找到该插件（尝试了 ${tried.length} 个端口）`,
  }
}

/** Accept `http://…`, `host:port`, or a bare port and return a clean origin. */
export function normaliseOrigin(raw: string): string | null {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    if (/^https?:\/\//i.test(text)) {
      const u = new URL(text)
      return `${u.protocol}//${u.host}`
    }
    if (/^\d+$/.test(text)) return `http://127.0.0.1:${text}`
    if (/^[\w.-]+:\d+$/.test(text)) return `http://${text}`
  } catch {
    return null
  }
  return null
}

/** Invalidate cached port data after a launch so the next scan sees it. */
export function refreshAfterLaunch(): void {
  invalidatePortCache()
}
