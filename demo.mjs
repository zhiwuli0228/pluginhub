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
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
      upstream: String(doc.upstream || ''),
      panelPath: doc.panelPath || null,
      pathPrefixes: Array.isArray(doc.pathPrefixes) ? doc.pathPrefixes.map(String) : [],
      health: doc.health || null,
      injectHeaders: doc.injectHeaders || {},
      openUrl: doc.openUrl || doc.upstream || '',
      livePath: doc.livePath || null,
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

// ── Health ───────────────────────────────────────────────────────────────────

/**
 * Decide whether a connector can actually be embedded/shown.
 *
 * When the connector declares a `panelPath`, panel availability is what matters
 * — an embeddable panel is the contract. Otherwise fall back to the declared
 * health probe.
 */
async function checkHealth(connector) {
  const target = parseUpstream(connector.upstream)
  if (!target) return { online: false, error: `bad upstream: ${connector.upstream}` }

  const base = connector.upstream.replace(/\/$/, '')

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
          error: `面板不可达：${connector.panelPath} → HTTP ${r.status}`,
        }
      }
      const ct = String(r.headers.get('content-type') || '')
      if (!ct.includes('text/html')) {
        return { online: false, status: r.status, error: `面板内容类型异常：${ct || '(none)'}` }
      }
      return { online: true, status: r.status }
    } catch (e) {
      return { online: false, error: `面板不可达：${e.message}` }
    }
  }

  const h = connector.health
  if (!h || !h.path) return { online: true }

  const headers = { ...(h.headers || {}) }
  const init = { method: h.method || 'GET', headers, signal: AbortSignal.timeout(4000) }
  if (h.body !== undefined) init.body = h.body

  try {
    const r = await fetch(`${base}${h.path}`, init)
    // 401/403 still proves something is listening with the right routes.
    const online = r.ok || r.status === 401 || r.status === 403
    return { online, status: r.status }
  } catch (e) {
    return { online: false, error: e.message }
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
  const target = parseUpstream(connector.upstream)
  if (!target) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'bad-upstream', upstream: connector.upstream }))
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
    connectors: connectors.map((c, i) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      mode: c.panelPath ? 'iframe' : 'live',
      url: c.panelPath ? `/p/${c.id}${c.panelPath}` : c.livePath ? `/p/${c.id}${c.livePath}` : null,
      openUrl: c.openUrl,
      online: health[i].online,
      error: health[i].error,
      status: health[i].status,
    })),
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

async function main() {
  const connectors = loadConnectors()
  console.log(`🚀 PluginHub — ${connectors.length} connector(s) loaded from connectors/\n`)
  for (const c of connectors) {
    const mode = c.panelPath ? `panel ${c.panelPath}` : c.livePath ? `live ${c.livePath}` : 'no panel'
    console.log(`   ${c.icon} ${c.id.padEnd(24)} ${c.upstream.padEnd(28)} ${mode}`)
  }
  console.log('')

  const server = createServer((req, res) => {
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
      proxyRequest(req, res, connector, rest, url.search)
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

  process.on('SIGINT', () => {
    server.close()
    process.exit(0)
  })
}

main().catch((e) => {
  console.error('❌', e)
  process.exit(1)
})
