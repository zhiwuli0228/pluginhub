import { chromium } from 'playwright'

const out = []
const errors = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()) })

// ── 1. Dashboard shows the MCP tab ──
await page.goto('http://127.0.0.1:7895/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
const tabs = await page.$$eval('.tab', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
out.push('TABS: ' + JSON.stringify(tabs))

await page.click('.tab[data-id="mcp-filesystem"]')
await page.waitForTimeout(3000)
const frameEl = await page.$('#f-mcp-filesystem iframe')
out.push('MCP IFRAME PRESENT: ' + Boolean(frameEl))

const frame = await frameEl.contentFrame()
await frame.waitForTimeout(2500)

// ── 2. Tool list rendered from tools/list ──
const toolCount = await frame.$eval('#hdr-count', (e) => e.textContent.trim()).catch(() => 'n/a')
const proto = await frame.$eval('#hdr-proto', (e) => e.textContent.trim()).catch(() => 'n/a')
const toolNames = await frame.$$eval('.tool .n', (els) => els.map((e) => e.textContent.trim()))
out.push('HEADER: ' + toolCount + '  |  ' + proto)
out.push('TOOLS(' + toolNames.length + '): ' + JSON.stringify(toolNames.slice(0, 6)) + ' …')

// ── 3. Pick list_directory, fill a path, invoke ──
await frame.click('.tool[data-name="list_directory"]')
await frame.waitForTimeout(800)
const fields = await frame.$$eval('.field label', (els) => els.map((e) => e.textContent.trim()))
out.push('FORM FIELDS for list_directory: ' + JSON.stringify(fields))

await frame.fill('#f_path', 'E:\\009workspace\\pluginhub\\connectors')
await frame.click('#invoke')
await frame.waitForTimeout(4000)

const resultText = await frame.$eval('#result', (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '')
const okRun = resultText.includes('agent-memory-hub.yaml') || resultText.includes('[FILE]')
out.push('INVOKE list_directory: ' + (okRun ? '✅ result contains file listing' : '❌ no listing'))
out.push('   result: ' + resultText.slice(0, 220))

await page.screenshot({ path: 'E:/009workspace/pluginhub/docs/04-demo/final-4-mcp.png' })

// ── 4. Schema with nested/array type: search_files ──
await frame.click('.tool[data-name="search_files"]')
await frame.waitForTimeout(800)
const sfFields = await frame.$$eval('.field label', (els) => els.map((e) => e.textContent.trim()))
out.push('FORM FIELDS for search_files: ' + JSON.stringify(sfFields))

await browser.close()
out.push('')
out.push('CONSOLE ERRORS: ' + (errors.length ? JSON.stringify(errors) : 'none'))
console.log(out.join('\n'))
