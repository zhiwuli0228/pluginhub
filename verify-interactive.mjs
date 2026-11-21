import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:7895/'
const results = []

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })

page.on('pageerror', (e) => results.push('PAGE ERROR: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') results.push('CONSOLE ERROR: ' + m.text())
})

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

// 1. Tabs rendered
const tabs = await page.$$eval('.tab', (els) => els.map((e) => e.textContent.trim()))
results.push('TABS: ' + JSON.stringify(tabs))

// 2. Default active tab is memory, iframe present
const memIframe = await page.$('#f-memory iframe')
results.push('MEMORY IFRAME PRESENT: ' + Boolean(memIframe))

// 3. Read memory panel content inside iframe
if (memIframe) {
  const frame = await memIframe.contentFrame()
  if (frame) {
    await frame.waitForTimeout(1500)
    const header = await frame.$eval('header', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => 'NO HEADER')
    results.push('MEMORY HEADER: ' + header)
    const proposals = await frame.$$eval('.proposal, [class*="proposal"], li[class*="item"]', (els) => els.length).catch(() => 0)
    results.push('MEMORY PROPOSAL NODES: ' + proposals)
    const bodyText = await frame.$eval('body', (e) => e.innerText.slice(0, 300).replace(/\s+/g, ' ')).catch(() => '')
    results.push('MEMORY BODY SAMPLE: ' + bodyText)
  }
}

// 4. Click Token tab -> verify live data renders with real numbers
await page.click('.tab[data-id="token"]')
await page.waitForTimeout(2000)
const tokenVisible = await page.isVisible('#f-token')
const tokenCards = await page.$$eval('#f-token .card', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
results.push('TOKEN TAB VISIBLE: ' + tokenVisible)
results.push('TOKEN CARDS: ' + JSON.stringify(tokenCards))

// 5. Click Env tab
await page.click('.tab[data-id="env"]')
await page.waitForTimeout(2000)
const envRows = await page.$$eval('#f-env table tr', (els) => els.slice(1).map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
results.push('ENV ROWS: ' + JSON.stringify(envRows))

// 6. Back to memory tab
await page.click('.tab[data-id="memory"]')
await page.waitForTimeout(800)
const memBack = await page.isVisible('#f-memory')
results.push('BACK TO MEMORY VISIBLE: ' + memBack)

// 7. URL hash updated
results.push('URL AFTER SWITCH: ' + page.url())

await page.screenshot({ path: 'E:/009workspace/pluginhub/verify-interactive.png', fullPage: false })
await browser.close()

console.log(results.join('\n'))
