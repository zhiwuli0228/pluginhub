/**
 * Isolated harness for verifying a plugin's self-contained panel page
 * WITHOUT restarting the DSH host.
 *
 * It serves the panel HTML from the plugin's source at the same path the host
 * would use, and proxies the plugin's API paths to the already-running host,
 * so the panel behaves exactly as it will in production.
 *
 * Usage: npx tsx harness-panel.mjs <pluginDir> <panelModulePath> <exportName> <prefix> <apiTarget> <port>
 * e.g.   npx tsx harness-panel.mjs ../dsh/token-usage-statistic ./src/host/panel.ts PANEL_HTML /token-usage-statistic/ http://127.0.0.1:59618 7801
 */

import { createServer, request as httpRequest } from 'node:http'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const [, , pluginDir, panelModule, exportName, prefix, apiTarget, portArg] = process.argv
const PORT = parseInt(portArg || '7801', 10)

const modulePath = resolve(pluginDir, panelModule.replace(/^\.\//, ''))
const mod = await import(pathToFileURL(modulePath).href)
const html = mod[exportName]
if (typeof html !== 'string' || !html.length) {
  console.error(`export ${exportName} not found or empty in ${panelModule}`)
  process.exit(1)
}
console.log(`[harness] ${exportName}: ${html.length} chars`)
console.log(`[harness] serving ${prefix}panel on :${PORT}, proxying ${prefix} → ${apiTarget}`)

const target = new URL(apiTarget)

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  if (path === `${prefix}panel` || path === `${prefix}panel/`) {
    const body = Buffer.from(html, 'utf-8')
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.byteLength),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }

  if (path.startsWith(prefix)) {
    // Strip origin/referer: the harness stands in for the host, so upstream
    // same-origin checks must see a same-origin (originless) request.
    const fwdHeaders = { ...req.headers, host: `${target.hostname}:${target.port}` }
    delete fwdHeaders.origin
    delete fwdHeaders.referer

    const up = httpRequest(
      {
        hostname: target.hostname,
        port: parseInt(target.port || '80', 10),
        path: path + url.search,
        method: req.method,
        headers: fwdHeaders,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 200, { ...upRes.headers, 'access-control-allow-origin': '*' })
        upRes.pipe(res)
      },
    )
    up.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    })
    req.pipe(up)
    return
  }

  res.writeHead(404)
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => console.log(`[harness] ready http://127.0.0.1:${PORT}${prefix}panel`))
