#!/usr/bin/env node

/**
 * PluginHub — connector-driven plugin dashboard.
 *
 * Model
 * -----
 * A connector (connectors/*.yaml) declares, for one third-party or in-house
 * plugin:
 *   - upstream    : origin that owns the plugin's HTTP routes
 *   - panelPath   : a self-contained HTML page the plugin serves itself (Tier 0)
 *   - pathPrefixes: absolute paths the panel calls, rewritten through the proxy
 *   - health      : liveness probe
 *
 * PluginHub then only does three things per plugin: probe health, proxy the
 * panel plus its API paths, and embed the panel in an iframe. There is no
 * per-plugin rendering code.
 *
 * Fallback
 * --------
 * A connector without `panelPath` degrades to "live" mode: PluginHub proxies a
 * JSON endpoint and renders a generic card/table view from it.
 *
 * Routes
 * ------
 *   /p/<id>/*        → upstream, with path rewrites + injected headers
 *   /api/config      → dashboard config (connectors + health)
 *   /                → dashboard shell
 */

import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import YAML from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
function flag(name, def) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}

const UI_PORT = parseInt(flag('port', '7895'), 10)
const CONNECTOR_DIR = join(__dirname, 'connectors')

const dashboardHtml = readFileSync(join(__dirname, 'demo-dashboard.html'), 'utf-8')

// ── Connectors ───────────────────────────────────────────────────────────────

/** Load every *.yaml connector in the connectors directory. */
function loadConnectors() {
  if (!existsSync(CONNECTOR_DIR)) return []
  const out = []
  for (const name of readdirSync(CONNECTOR_DIR)) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue
    const raw = readFileSync(join(CONNECTOR_DIR, name), 'utf-8')
    let doc
    try {
      doc = YAML.parse(raw)
    } catch (e) {
      console.error(`[connector] ${name}: parse error: ${e.message}`)
      continue
    }
    if (!doc || typeof doc !== 'object' || !doc.id) {
      console.error(`[connector] ${name}: missing id, skipped`)
      continue
    }
    out.push({
      id: String(doc.id),
      name: doc.name || doc.id,
      icon: doc.icon || '🔌',
      kind: doc.kind === 'mcp' ? 'mcp' : 'panel',
      mcp: doc.mcp || null,
      // `upstream` may be a literal origin, or the string `auto` meaning
      // "discover it on this machine".
      upstreamRaw: doc.upstream == null ? 'auto' : String(doc.upstream),
      discover: doc.discover || null,
      launch: doc.launch || null,
      panelPath: doc.panelPath || null,
      pathPrefixes: Array.isArray(doc.pathPrefixes) ? doc.pathPrefixes.map(String) : [],
      health: doc.health || null,
      injectHeaders: doc.injectHeaders || {},
      openUrl: doc.openUrl || null,
      livePath: doc.livePath || null,
      // Shown when the plugin cannot be found and cannot be launched by us.
      offlineHint: doc.offlineHint || null,
    })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/** Parse an upstream origin into {hostname, port}. */
function parseUpstream(origin) {
  try {
    const u = new URL(origin)
    return { hostname: u.hostname, port: parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10), protocol: u.protocol }
  } catch {
    return null
  }
}

// ── Origin resolution (local discovery) ──────────────────────────────────────

/** connectorId → { origin, source, at } */
const resolved = new Map()
const RESOLVE_TTL_MS = 15000

/**
 * Resolve (and cache) the origin a connector should be addressed at.
 *
 * A literal `upstream` wins. `auto` resolves against this machine: env hints,
 * then port hints, then a listening-port scan — all validated by fingerprint.
 */
async function resolveConnector(connector, force = false) {
  if (connector.kind === 'mcp') return { origin: null, source: null }

  if (connector.upstreamRaw && connector.upstreamRaw !== 'auto') {
    return { origin: connector.upstreamRaw.replace(/\/$/, ''), source: 'configured' }
  }

  const cached = resolved.get(connector.id)
  if (!force && cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached

  const rt = await loadRuntime()
  const discover = connector.discover || (connector.panelPath ? { probe: { path: connector.panelPath } } : null)
  const result = await rt.resolveOrigin(discover)
  const record = { ...result, at: Date.now() }
  resolved.set(connector.id, record)
  return record
}

/** Forget a connector's resolved origin so the next request re-discovers. */
function invalidateResolution(id) {
  resolved.delete(id)
}

// ── Launch ───────────────────────────────────────────────────────────────────

/** Launch a plugin's web endpoint, then re-resolve where it landed. */
async function launchConnector(connector) {
  const spec = connector.launch
  if (!spec || !spec.command) {
    return { ok: false, error: '该连接器没有配置 launch 命令' }
  }

  // Never spawn a duplicate: if the plugin already answers somewhere on this
  // machine, point at that instance instead of starting another one.
  const already = await resolveConnector(connector, true)
  if (already.origin) {
    return { ok: true, alreadyRunning: true, origin: already.origin, source: already.source }
  }

  const rt = await loadRuntime()
  const discover = connector.discover || (connector.panelPath ? { probe: { path: connector.panelPath } } : null)
  const probe = (discover && discover.probe) || null

  // Poll the declared port hints, plus whatever was previously resolved.
  const hosts = (discover && discover.hosts) || ['127.0.0.1']
  const ports = (discover && discover.ports) || []
  const origins = []
  for (const h of hosts) for (const p of ports) origins.push(`http://${h}:${p}`)
  const prev = resolved.get(connector.id)
  if (prev && prev.origin) origins.unshift(prev.origin)
  if (!origins.length) {
    return { ok: false, error: '连接器需要 discover.ports 或已有解析结果才能判断启动是否成功' }
  }

  const result = await rt.launchAndWait(spec, probe, origins)
  invalidateResolution(connector.id)

  if (result.started) {
    const after = await resolveConnector(connector, true)
    return {
      ok: true,
      pid: result.pid,
      waitedMs: result.waitedMs,
      origin: after.origin,
      source: after.source || 'launched',
    }
  }
  return { ok: false, error: result.error || '启动失败', stderr: result.stderr, pid: result.pid }
}

// ── Runtime module (MCP client + local detect), bundled on startup ───────────

const inspectorHtml = readFileSync(join(__dirname, 'inspector.html'), 'utf-8')

let runtime = null
let runtimeError = null

/**
 * Bundle `src/demo-runtime.ts` (tested core modules) into a temporary ESM file
 * and import it. Building in memory avoids a separate build step and keeps the
 * demo from duplicating protocol or detection logic.
 */
async function loadRuntime() {
  if (runtime) return runtime
  if (runtimeError) throw runtimeError
  try {
    const { build } = await import('esbuild')
    const result = await build({
      entryPoints: [join(__dirname, 'src/demo-runtime.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: false,
      logLevel: 'silent',
    })
    const out = result.outputFiles[0].text
    const tmp = join(tmpdir(), `pluginhub-runtime-${process.pid}.mjs`)
    writeFileSync(tmp, out, 'utf-8')
    runtime = await import(pathToFileURL(tmp).href)
    return runtime
  } catch (e) {
    runtimeError = e
    throw e
  }
}

/** Live MCP server processes, keyed by connector id. */
const mcpSessions = new Map()

/**
 * Get (or lazily start) an MCP session for a connector.
 *
 * Sessions are shared per connector and reaped after `idleTimeoutMs`; a
 * concurrent second caller awaits the in-flight connect rather than spawning a
 * duplicate process.
 */
async function getMcpSession(connector) {
  const existing = mcpSessions.get(connector.id)
  if (existing) {
    existing.lastUsed = Date.now()
    if (existing.promise) return existing.promise
    if (existing.client && existing.client.connected) return existing
    // Dead session: drop it and reconnect below.
    mcpSessions.delete(connector.id)
  }

  const cfg = connector.mcp || {}
  if (cfg.transport && cfg.transport !== 'stdio') {
    throw new Error(`unsupported MCP transport: ${cfg.transport} (only stdio in this build)`)
  }
  if (!cfg.command) throw new Error('connector.mcp.command is required for stdio transport')

  const rt = await loadRuntime()
  const client = new rt.McpStdioClient({
    command: cfg.command,
    args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
    cwd: cfg.cwd || undefined,
    env: cfg.env || undefined,
    requestTimeoutMs: Number(cfg.requestTimeoutMs) || 120000,
    // Connectors that launch through a shim (npx, uvx) set this explicitly.
    shell: cfg.shell === true,
  })

  const session = { id: connector.id, client, lastUsed: Date.now(), promise: null, tools: null, server: null }

  session.promise = (async () => {
    const info = await client.connect()
    session.server = {
      name: info && info.serverInfo ? info.serverInfo.name : '',
      version: info && info.serverInfo ? info.serverInfo.version : '',
      protocolVersion: info ? info.protocolVersion : '',
      capabilities: info ? info.capabilities : {},
    }
    session.tools = await client.listTools()
    session.promise = null
    return session
  })()

  mcpSessions.set(connector.id, session)
  try {
    return await session.promise
  } catch (e) {
    mcpSessions.delete(connector.id)
    try { await client.close() } catch { /* already gone */ }
    throw e
  }
}

/** Stop sessions that have been idle longer than the connector allows. */
function reapMcpSessions(connectors) {
  const now = Date.now()
  for (const [id, s] of mcpSessions) {
    const c = connectors.find((x) => x.id === id)
    const idleMs = Number(c && c.mcp && c.mcp.idleTimeoutMs) || 300000
    if (s.promise) continue
    if (now - s.lastUsed > idleMs) {
      mcpSessions.delete(id)
      try { s.client.close() } catch { /* best effort */ }
      console.log(`[mcp] closed idle session ${id}`)
    }
  }
}

async function shutdownMcpSessions() {
  for (const [, s] of mcpSessions) {
    try { await s.client.close() } catch { /* best effort */ }
  }
  mcpSessions.clear()
}

// ── Health ───────────────────────────────────────────────────────────────────

/**
 * Decide whether a connector can actually be embedded/shown.
 *
 * When the connector declares a `panelPath`, panel availability is what matters
 * — an embeddable panel is the contract. Otherwise fall back to the declared
 * health probe.
 */
async function checkHealth(connector) {
  // MCP connectors have no HTTP surface to probe. Report the live session state
  // and let the inspector page surface connection errors in detail.
  if (connector.kind === 'mcp') {
    const s = mcpSessions.get(connector.id)
    if (s && s.promise) return { online: true, state: 'connecting' }
    if (s && s.client && s.client.connected) {
      return { online: true, state: 'connected', toolCount: Array.isArray(s.tools) ? s.tools.length : undefined }
    }
    if (connector._mcpError) return { online: false, error: connector._mcpError }
    return { online: true, state: 'idle' }
  }

  const res = await resolveConnector(connector)
  if (!res.origin) {
    return { online: false, error: res.error || '未在本机发现该插件', resolution: res }
  }

  const base = res.origin

  if (connector.panelPath) {
    try {
      const r = await fetch(`${base}${connector.panelPath}`, {
        method: 'GET',
        headers: connector.injectHeaders || {},
        signal: AbortSignal.timeout(4000),
      })
      if (!r.ok) {
        return {
          online: false,
          status: r.status,
          origin: base,
          source: res.source,
          error: `面板不可达：${connector.panelPath} → HTTP ${r.status}`,
        }
      }
      const ct = String(r.headers.get('content-type') || '')
      if (!ct.includes('text/html')) {
        return { online: false, status: r.status, origin: base, source: res.source, error: `面板内容类型异常：${ct || '(none)'}` }
      }
      return { online: true, status: r.status, origin: base, source: res.source }
    } catch (e) {
      return { online: false, origin: base, source: res.source, error: `面板不可达：${e.message}` }
    }
  }

  const h = connector.health
  if (!h || !h.path) return { online: true, origin: base, source: res.source }

  const headers = { ...(h.headers || {}) }
  const init = { method: h.method || 'GET', headers, signal: AbortSignal.timeout(4000) }
  if (h.body !== undefined) init.body = h.body

  try {
    const r = await fetch(`${base}${h.path}`, init)
    // 401/403 still proves something is listening with the right routes.
    const online = r.ok || r.status === 401 || r.status === 403
    return { online, status: r.status, origin: base, source: res.source }
  } catch (e) {
    return { online: false, origin: base, source: res.source, error: e.message }
  }
}

// ── Proxy ────────────────────────────────────────────────────────────────────

/**
 * Proxy one request to a connector's upstream.
 *
 * `rest` is the path after `/p/<id>`; the original path is reconstructed so the
 * plugin sees exactly the route it published.
 */
function proxyRequest(req, res, connector, rest, search) {
  const target = parseUpstream(connector._resolvedOrigin || '')
  if (!target) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unresolved-upstream', connector: connector.id }))
    return
  }

  const targetPath = rest + search
  const headers = { ...req.headers, host: `${target.hostname}:${target.port}` }
  // Drop the proxy-origin headers so upstream same-origin checks pass.
  delete headers.origin
  delete headers.referer
  // Ask upstream for an uncompressed body: the panel path is buffered and
  // rewritten as text, and a stray content-encoding would corrupt it.
  headers['accept-encoding'] = 'identity'
  for (const [k, v] of Object.entries(connector.injectHeaders)) headers[k.toLowerCase()] = String(v)

  const isPanel = connector.panelPath && stripSlash(rest) === stripSlash(connector.panelPath)

  const up = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: targetPath,
      method: req.method,
      headers,
    },
    (upRes) => {
      const outHeaders = { ...upRes.headers }
      outHeaders['access-control-allow-origin'] = '*'
      // Allow embedding.
      delete outHeaders['x-frame-options']
      delete outHeaders['content-security-policy']

      if (isPanel && String(upRes.headers['content-type'] || '').includes('text/html')) {
        const chunks = []
        upRes.on('data', (c) => chunks.push(c))
        upRes.on('end', () => {
          // Some upstreams compress even when asked not to; decode defensively
          // so the rewrite sees real HTML and the browser gets a clean body.
          const { text, encoding } = decodeBody(
            Buffer.concat(chunks),
            upRes.headers['content-encoding'],
          )
          if (encoding) delete outHeaders['content-encoding']
          const html = rewritePanel(text, connector)
          delete outHeaders['content-length']
          res.writeHead(upRes.statusCode || 200, outHeaders)
          res.end(html)
        })
      } else {
        res.writeHead(upRes.statusCode || 200, outHeaders)
        upRes.pipe(res)
      }
    },
  )

  up.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'proxy-error', detail: e.message }))
  })

  req.pipe(up)
}

function stripSlash(p) {
  return String(p || '').replace(/\/+$/, '')
}

/**
 * Decode an upstream body according to its content-encoding.
 *
 * Returns the text plus the encoding that was actually applied, so the caller
 * knows whether the response header must be removed.
 */
function decodeBody(buf, contentEncoding) {
  const enc = String(contentEncoding || '').toLowerCase().trim()
  if (!enc || enc === 'identity') return { text: buf.toString('utf-8'), encoding: null }
  try {
    if (enc === 'gzip' || enc === 'x-gzip') {
      return { text: gunzipSync(buf).toString('utf-8'), encoding: 'gzip' }
    }
    if (enc === 'deflate') {
      return { text: inflateSync(buf).toString('utf-8'), encoding: 'deflate' }
    }
    if (enc === 'br') {
      return { text: brotliDecompressSync(buf).toString('utf-8'), encoding: 'br' }
    }
  } catch {
    // Fall through: hand back the raw bytes rather than an empty page.
  }
  return { text: buf.toString('utf-8'), encoding: null }
}

/**
 * Rewrite a proxied panel page so its absolute API paths go through the proxy.
 *
 * Two layers, because plugins are written by different authors:
 *  1. literal rewrite of each declared pathPrefix inside string literals;
 *  2. a runtime fetch/XHR patch that prefixes any request whose path starts
 *     with a declared prefix. This catches template strings and dynamically
 *     built URLs that layer 1 cannot see.
 */
function rewritePanel(html, connector) {
  const base = `/p/${connector.id}`
  let out = html

  for (const prefix of connector.pathPrefixes) {
    const needle = `"${prefix}`
    out = out.split(needle).join(`"${base}${prefix}`)
    out = out.split(`'${prefix}`).join(`'${base}${prefix}`)
    out = out.split('`' + prefix).join('`' + base + prefix)
  }

  const prefixes = JSON.stringify(connector.pathPrefixes)
  const patch =
    '<scr' + 'ipt>' +
    '(function(){' +
    `var B=${JSON.stringify(base)};var PS=${prefixes};` +
    'function fix(u){try{' +
    'var s=String(u);' +
    'if(s.indexOf(B+"/")===0)return u;' +
    'for(var i=0;i<PS.length;i++){if(s.indexOf(PS[i])===0)return B+s;}' +
    'return u}catch(e){return u}}' +
    'var of=window.fetch;' +
    'window.fetch=function(i,n){' +
    'if(typeof i==="string")i=fix(i);' +
    'else if(i&&i.url){var u=fix(i.url);if(u!==i.url)i=new Request(u,i)}' +
    'return of.call(this,i,n)};' +
    'var oo=XMLHttpRequest.prototype.open;' +
    'XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=fix(u);return oo.apply(this,a)};' +
    '})();' +
    '</scr' + 'ipt>'

  if (out.includes('</head>')) out = out.replace('</head>', patch + '</head>')
  else if (out.includes('<head>')) out = out.replace('<head>', '<head>' + patch)
  else out = patch + out

  return out
}

// ── Config payload ───────────────────────────────────────────────────────────

async function buildConfig(connectors) {
  const health = await Promise.all(connectors.map(checkHealth))
  return {
    connectors: connectors.map((c, i) => {
      const h = health[i]
      const resolvedOrigin = h.origin || null
      c._resolvedOrigin = resolvedOrigin
      return {
        id: c.id,
        name: c.name,
        icon: c.icon,
        mode: c.kind === 'mcp' ? 'mcp' : c.panelPath ? 'iframe' : 'live',
        url:
          c.kind === 'mcp'
            ? `/mcp?id=${encodeURIComponent(c.id)}`
            : resolvedOrigin && c.panelPath
              ? `/p/${c.id}${c.panelPath}`
              : resolvedOrigin && c.livePath
                ? `/p/${c.id}${c.livePath}`
                : null,
        openUrl: c.openUrl || (resolvedOrigin ? resolvedOrigin + (c.panelPath || '/') : null),
        online: h.online,
        error: h.error,
        status: h.status,
        state: h.state,
        toolCount: h.toolCount,
        // Transparency: where did this endpoint come from, and can we start it?
        endpoint: resolvedOrigin,
        endpointSource: h.source || null,
        canLaunch: Boolean(c.kind !== 'mcp' && c.launch && c.launch.command && !h.online),
        launchHint: c.launch && c.launch.command
          ? [c.launch.command, ...(c.launch.args || [])].join(' ')
          : null,
        // Explanation for "cannot be found and we must not start it".
        offlineHint: c.offlineHint || null,
      }
    }),
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

async function main() {
  const connectors = loadConnectors()
  console.log(`🚀 PluginHub — ${connectors.length} connector(s) loaded from connectors/\n`)
  for (const c of connectors) {
    const mode =
      c.kind === 'mcp'
        ? `mcp ${c.mcp && c.mcp.command ? c.mcp.command + ' ' + (c.mcp.args || []).join(' ') : '(no command)'}`
        : c.panelPath
          ? `panel ${c.panelPath}`
          : c.livePath
            ? `live ${c.livePath}`
            : 'no panel'
    const where =
      c.kind === 'mcp'
        ? ''
        : c.upstreamRaw === 'auto'
          ? 'auto-discover'
          : c.upstreamRaw
    console.log(`   ${c.icon} ${c.id.padEnd(24)} ${String(where).padEnd(28)} ${mode}`)
  }
  console.log('')

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${UI_PORT}`)
    const path = url.pathname

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': '*',
        'Access-Control-Allow-Headers': '*',
      })
      res.end()
      return
    }

    if (path === '/api/config') {
      buildConfig(connectors)
        .then((cfg) => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify(cfg))
        })
        .catch((e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        })
      return
    }

    // ── Launch a plugin's web endpoint ─────────────────────────────────────
    const launchMatch = /^\/api\/launch\/([^/]+)$/.exec(path)
    if (launchMatch && req.method === 'POST') {
      const id = decodeURIComponent(launchMatch[1])
      const connector = connectors.find((c) => c.id === id)
      if (!connector) {
        sendJson(res, 404, { ok: false, error: `unknown connector: ${id}` })
        return
      }
      launchConnector(connector)
        .then((r) => sendJson(res, 200, r))
        .catch((e) => sendJson(res, 200, { ok: false, error: e.message }))
      return
    }

    // ── Re-run discovery for one connector or all ──────────────────────────
    if (path === '/api/rediscover' && req.method === 'POST') {
      resolved.clear()
      const rt = await loadRuntime()
      rt.invalidatePortCache()
      buildConfig(connectors)
        .then((cfg) => sendJson(res, 200, cfg))
        .catch((e) => sendJson(res, 500, { error: e.message }))
      return
    }

    // ── MCP: tool list ─────────────────────────────────────────────────────
    const mcpTools = /^\/api\/mcp\/([^/]+)\/tools$/.exec(path)
    if (mcpTools && req.method === 'GET') {
      const id = decodeURIComponent(mcpTools[1])
      const connector = connectors.find((c) => c.id === id && c.kind === 'mcp')
      if (!connector) {
        sendJson(res, 404, { ok: false, error: `unknown MCP connector: ${id}` })
        return
      }
      getMcpSession(connector)
        .then((s) => {
          sendJson(res, 200, { ok: true, tools: s.tools || [], server: s.server })
        })
        .catch((e) => {
          connector._mcpError = e.message
          sendJson(res, 200, { ok: false, error: e.message })
        })
      return
    }

    // ── MCP: tool call ─────────────────────────────────────────────────────
    const mcpCall = /^\/api\/mcp\/([^/]+)\/call$/.exec(path)
    if (mcpCall && req.method === 'POST') {
      const id = decodeURIComponent(mcpCall[1])
      const connector = connectors.find((c) => c.id === id && c.kind === 'mcp')
      if (!connector) {
        sendJson(res, 404, { ok: false, error: `unknown MCP connector: ${id}` })
        return
      }
      readJsonBody(req)
        .then(async (body) => {
          const name = body && body.name
          const args = (body && body.arguments) || {}
          if (!name) {
            sendJson(res, 400, { ok: false, error: 'body.name is required' })
            return
          }
          try {
            const s = await getMcpSession(connector)
            const result = await s.client.callTool(name, args)
            sendJson(res, 200, { ok: true, result })
          } catch (e) {
            sendJson(res, 200, { ok: false, error: e.message })
          }
        })
        .catch((e) => sendJson(res, 400, { ok: false, error: e.message }))
      return
    }

    // ── MCP inspector page ─────────────────────────────────────────────────
    if (path === '/mcp') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(inspectorHtml)
      return
    }

    // /p/<id>/... proxy
    const m = /^\/p\/([^/]+)(\/.*)?$/.exec(path)
    if (m) {
      const id = decodeURIComponent(m[1])
      const rest = m[2] || '/'
      const connector = connectors.find((c) => c.id === id)
      if (!connector) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unknown-connector', id }))
        return
      }
      if (connector.kind === 'mcp') {
        sendJson(res, 400, { error: 'mcp connectors are served at /mcp?id=<id>, not /p/<id>' })
        return
      }
      resolveConnector(connector)
        .then((r) => {
          if (!r.origin) {
            sendJson(res, 502, { error: 'unresolved-upstream', connector: connector.id, detail: r.error })
            return
          }
          connector._resolvedOrigin = r.origin
          proxyRequest(req, res, connector, rest, url.search)
        })
        .catch((e) => sendJson(res, 500, { error: e.message }))
      return
    }

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(dashboardHtml)
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  server.listen(UI_PORT, '127.0.0.1', () => {
    console.log(`🌐 http://127.0.0.1:${UI_PORT}\n`)
  })

  // Warm MCP sessions in the background so the dashboard reflects reality
  // without making /api/config wait on a child-process handshake.
  for (const c of connectors) {
    if (c.kind !== 'mcp') continue
    getMcpSession(c)
      .then((s) => console.log(`[mcp] ${c.id}: ${s.tools ? s.tools.length : 0} tool(s) ready`))
      .catch((e) => {
        c._mcpError = e.message
        console.error(`[mcp] ${c.id}: connect failed — ${e.message}`)
      })
  }

  const reaper = setInterval(() => reapMcpSessions(connectors), 30000)
  reaper.unref()

  const bye = async () => {
    console.log('\n[mcp] closing sessions…')
    await shutdownMcpSessions()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}

/** Small JSON body reader for the MCP call endpoint. */
function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`))
      }
    })
    req.on('error', reject)
  })
}

/** Write a JSON response. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

main().catch((e) => {
  console.error('❌', e)
  process.exit(1)
})
