#!/usr/bin/env node

/**
 * PluginHub — Reverse Proxy + Unified Plugin Dashboard
 *
 * Design:
 *  - Plugins with a standalone panel (Agent Memory Hub) are embedded as-is via
 *    an iframe. Their internal absolute /api/* calls are rewritten through the
 *    proxy so no re-rendering is needed.
 *  - Plugins whose UI only exists inside the DSH React tree
 *    (token-usage-statistic, dsh-env-manager) cannot be iframed: DSH requires
 *    an authenticated session that cannot be proxied. For those, PluginHub
 *    serves their live API data through the proxy and links out to the real
 *    panel in a new window, where the browser session authenticates normally.
 *
 * Routes:
 *   /proxy/memory/*        → http://127.0.0.1:7777/*
 *   /proxy/dsh/*           → http://127.0.0.1:59618/*
 *   /api/live/token        → token usage summary (proxied)
 *   /api/live/env          → environment list (proxied)
 *   /                      → dashboard
 */

import { createServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ──

const args = process.argv.slice(2)
function getArg(name, def) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const DSH_PORT = getArg('dsh-port', '59618')
const MEM_PORT = getArg('memory-port', '7777')
const UI_PORT = parseInt(getArg('port', '7895'), 10)
const DSH_HOST = `127.0.0.1:${DSH_PORT}`
const MEM_HOST = `127.0.0.1:${MEM_PORT}`

const dashboardHtml = readFileSync(join(__dirname, 'demo-dashboard.html'), 'utf-8')

// ── Reverse proxy ──

function proxyRequest(req, res, targetPort, targetPath) {
  const opts = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
  }
  // Drop origin so the backend's same-origin check does not reject us.
  delete opts.headers.origin
  delete opts.headers.referer
  if (targetPath.startsWith('/env-manager/')) {
    opts.headers['x-env-manager-request'] = '1'
  }

  const isPanel = targetPath === '/panel' || targetPath === '/panel/'

  const proxy = httpRequest(opts, (proxyRes) => {
    const headers = { ...proxyRes.headers }
    headers['access-control-allow-origin'] = '*'
    delete headers['x-frame-options']
    delete headers['content-security-policy']

    if (isPanel) {
      const chunks = []
      proxyRes.on('data', (c) => chunks.push(c))
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf-8')
        if ((proxyRes.headers['content-type'] || '').includes('text/html')) {
          body = rewritePanelHtml(body)
        }
        delete headers['content-length']
        res.writeHead(proxyRes.statusCode || 200, headers)
        res.end(body)
      })
    } else {
      res.writeHead(proxyRes.statusCode || 200, headers)
      proxyRes.pipe(res)
    }
  })

  proxy.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Proxy error', detail: e.message }))
  })

  req.pipe(proxy)
}

/**
 * Rewrite a proxied panel so its absolute `/api/*` calls go through the proxy.
 * A <base> tag cannot do this for absolute paths, so we rewrite both the
 * literal string form and patch fetch/XHR at runtime as a safety net.
 */
function rewritePanelHtml(html) {
  let out = html.replace(/(['"`])\/api\//g, '$1/proxy/memory/api/')

  const patch =
    '<scr' + 'ipt>' +
    '(function(){' +
    'var P="/proxy/memory";' +
    'function fix(u){try{var s=String(u);if(s.charAt(0)==="/"&&s.indexOf(P+"/")!==0)return P+s;return u}catch(e){return u}}' +
    'var of=window.fetch;' +
    'window.fetch=function(i,n){' +
    'if(typeof i==="string")i=fix(i);' +
    'else if(i&&i.url){var u=fix(i.url);if(u!==i.url)i=new Request(u,i)}' +
    'return of.call(this,i,n)};' +
    'var oo=XMLHttpRequest.prototype.open;' +
    'XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=fix(u);return oo.apply(this,a)};' +
    '})();' +
    '</scr' + 'ipt>'

  if (out.includes('<head>')) out = out.replace('<head>', '<head>' + patch)
  else out = patch + out
  return out
}

// ── Upstream helpers ──

async function fetchJson(url, init) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000), ...(init || {}) })
    const text = await r.text()
    let body
    try { body = JSON.parse(text) } catch { body = { _raw: text } }
    return { ok: r.ok, status: r.status, body }
  } catch (e) {
    return { ok: false, status: 0, body: { error: e.message } }
  }
}

async function getTokenUsage() {
  return fetchJson(`http://${DSH_HOST}/token-usage-statistic/api/summary?days=7`)
}

async function getEnvList() {
  return fetchJson(`http://${DSH_HOST}/env-manager/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-env-manager-request': '1' },
    body: JSON.stringify({ op: 'list', payload: { kind: 'environment' } }),
  })
}

async function getMemoryStatus() {
  return fetchJson(`http://${MEM_HOST}/api/status`)
}

// ── Config payload for the dashboard ──

async function buildConfig() {
  const [token, env, mem] = await Promise.all([getTokenUsage(), getEnvList(), getMemoryStatus()])

  return {
    plugins: [
      {
        id: 'memory',
        name: 'Agent 记忆中心',
        icon: '🧠',
        mode: 'iframe',
        url: '/proxy/memory/panel',
        online: mem.ok,
        error: mem.ok ? undefined : (mem.body && mem.body.error) || 'Memory Hub 未运行',
        detail: mem.ok
          ? `accepted ${mem.body.acceptedCount ?? '?'} 条`
          : undefined,
      },
      {
        id: 'token',
        name: 'Token 用量统计',
        icon: '📊',
        mode: 'live',
        liveUrl: '/api/live/token',
        openUrl: `http://127.0.0.1:${DSH_PORT}/`,
        online: token.ok,
        error: token.ok ? undefined : (token.body && token.body.error) || 'DSH 未运行',
      },
      {
        id: 'env',
        name: '环境管理器',
        icon: '🔧',
        mode: 'live',
        liveUrl: '/api/live/env',
        openUrl: `http://127.0.0.1:${DSH_PORT}/`,
        online: env.ok,
        error: env.ok ? undefined : (env.body && env.body.error) || 'DSH 未运行',
      },
    ],
    proxyInfo: `/proxy/memory → :${MEM_PORT} · /proxy/dsh → :${DSH_PORT}`,
  }
}

// ── Server ──

async function main() {
  console.log('🚀 PluginHub — reverse proxy + unified plugin dashboard\n')
  console.log(`   /proxy/memory/*  → http://${MEM_HOST}/*`)
  console.log(`   /proxy/dsh/*     → http://${DSH_HOST}/*`)
  console.log(`   /api/live/token  → DSH token summary`)
  console.log(`   /api/live/env    → DSH environment list\n`)

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
      buildConfig()
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

    if (path === '/api/live/token') {
      getTokenUsage().then((r) => {
        res.writeHead(r.ok ? 200 : 502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify(r.body))
      })
      return
    }

    if (path === '/api/live/env') {
      getEnvList().then((r) => {
        res.writeHead(r.ok ? 200 : 502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify(r.body))
      })
      return
    }

    if (path.startsWith('/proxy/memory/')) {
      const target = path.slice('/proxy/memory'.length) || '/'
      proxyRequest(req, res, parseInt(MEM_PORT, 10), target + url.search)
      return
    }

    if (path.startsWith('/proxy/dsh/')) {
      const target = path.slice('/proxy/dsh'.length) || '/'
      proxyRequest(req, res, parseInt(DSH_PORT, 10), target + url.search)
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
