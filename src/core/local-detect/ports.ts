/**
 * Enumerate TCP ports that are currently listening on the loopback interface.
 *
 * Node has no API for this, so each platform uses its native source. Every
 * parser is exported separately so it can be unit-tested without the OS.
 *
 * @module local-detect/ports
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Cache so repeated dashboard polls do not shell out every time. */
let cachedPorts: { at: number; ports: number[] } | null = null
const PORT_CACHE_MS = 8000

/**
 * Parse `netstat -ano` output (Windows) and return loopback listening ports.
 *
 * Accepts lines such as:
 * `  TCP    127.0.0.1:62724        0.0.0.0:0              LISTENING       80808`
 */
export function parseWindowsNetstat(output: string): number[] {
  const ports = new Set<number>()
  for (const line of output.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const m = /(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]):(\d+)\s/i.exec(line)
    if (!m) continue
    const port = Number(m[1])
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN` output (macOS / fallback).
 *
 * Accepts lines such as:
 * `node      1234 user   23u  IPv4 0x1  0t0  TCP 127.0.0.1:7777 (LISTEN)`
 */
export function parseLsof(output: string): number[] {
  const ports = new Set<number>()
  for (const line of output.split(/\r?\n/)) {
    if (!/LISTEN/.test(line)) continue
    const matches = line.match(/(?:127\.0\.0\.1|\[::1\]|\*|[0-9.]+):(\d+)/g)
    if (!matches) continue
    for (const raw of matches) {
      const port = Number(raw.slice(raw.lastIndexOf(':') + 1))
      if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b)
}

/**
 * Parse `/proc/net/tcp` or `/proc/net/tcp6` (Linux).
 *
 * Each data row is `sl local_address rem_address st ...` where local_address is
 * `HEXIP:HEXPORT` and `st` is `0A` for LISTEN.
 */
export function parseProcNetTcp(content: string): number[] {
  const ports = new Set<number>()
  for (const line of content.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    if (cols[3] !== '0A') continue
    const local = cols[1]
    if (!local) continue
    const idx = local.lastIndexOf(':')
    if (idx < 0) continue
    const port = parseInt(local.slice(idx + 1), 16)
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

/**
 * List TCP ports listening on loopback, best effort and never throwing.
 *
 * @param force Bypass the cache.
 */
export async function listListeningPorts(force = false): Promise<number[]> {
  const now = Date.now()
  if (!force && cachedPorts && now - cachedPorts.at < PORT_CACHE_MS) return cachedPorts.ports

  let ports: number[] = []
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], {
        windowsHide: true,
        timeout: 6000,
        maxBuffer: 8 * 1024 * 1024,
      })
      ports = parseWindowsNetstat(stdout)
    } else if (process.platform === 'linux') {
      const merged = new Set<number>()
      for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        try {
          for (const p of parseProcNetTcp(readFileSync(file, 'utf-8'))) merged.add(p)
        } catch {
          /* file may not exist */
        }
      }
      ports = [...merged].sort((a, b) => a - b)
    } else {
      const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
        timeout: 6000,
        maxBuffer: 8 * 1024 * 1024,
      })
      ports = parseLsof(stdout)
    }
  } catch {
    ports = []
  }

  cachedPorts = { at: now, ports }
  return ports
}

/** Drop the cached port list (call after launching a process). */
export function invalidatePortCache(): void {
  cachedPorts = null
}
