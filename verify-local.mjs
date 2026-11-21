import { chromium } from 'playwright'

const out = []
const errors = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })

// ── 1. Real dashboard: 4 connectors discovered without any hard-coded port ──
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()) })

await page.goto('http://127.0.0.1:7895/', { waitUntil: 'networkidle' })
await page.waitForTimeout(3000)

const cfg = await page.evaluate(() => fetch('/api/config').then((r) => r.json()))
out.push('CONNECTORS:')
for (const c of cfg.connectors) {
  out.push(
    `  ${c.online ? 'ONLINE ' : 'OFFLINE'} ${c.id.padEnd(22)} endpoint=${(c.endpoint || '-').padEnd(23)} source=${c.endpointSource || '-'}`,
  )
}
const allOnline = cfg.connectors.every((c) => c.online)
const noHardcoded = cfg.connectors
  .filter((c) => c.mode !== 'mcp')
  .every((c) => Boolean(c.endpointSource))
out.push('ALL ONLINE: ' + allOnline)
out.push('EVERY ENDPOINT DISCOVERED (not configured): ' + noHardcoded)

await page.screenshot({ path: 'E:/009workspace/pluginhub/docs/04-demo/final-5-discovery.png' })

// ── 2. Offline + launch UI (config mocked so the real system is untouched) ──
const page2 = await browser.newPage({ viewport: { width: 1500, height: 950 } })
await page2.route('**/api/config', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      connectors: [
        {
          id: 'agent-memory-hub',
          name: 'Agent 记忆中心',
          icon: '🧠',
          mode: 'iframe',
          url: null,
          online: false,
          error: '未在本机找到该插件（尝试了 37 个端口）',
          endpoint: null,
          endpointSource: null,
          canLaunch: true,
          launchHint: 'node dist/cli.js serve --root E:\\009workspace\\dsh\\dsh-plugin-dev --port 7331',
        },
      ],
    }),
  }),
)
await page2.goto('http://127.0.0.1:7895/', { waitUntil: 'domcontentloaded' })
await page2.waitForTimeout(1500)
const offlineText = await page2.$eval('.offline', (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '')
out.push('')
out.push('OFFLINE CARD: ' + offlineText.slice(0, 260))
await page2.screenshot({ path: 'E:/009workspace/pluginhub/docs/04-demo/final-6-launch.png' })

await browser.close()
out.push('')
out.push('CONSOLE ERRORS: ' + (errors.length ? JSON.stringify(errors) : 'none'))
console.log(out.join('\n'))
