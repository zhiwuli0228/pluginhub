import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:7895/'
const out = []

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
page.on('pageerror', (e) => out.push('PAGEERROR: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') out.push('CONSOLE: ' + m.text()) })

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(3000)

const tabs = await page.$$eval('.tab', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
out.push('TABS: ' + JSON.stringify(tabs))

const jobs = [
  { id: 'agent-memory-hub', expect: ['memhub console', 'accepted'] },
  { id: 'token-usage-statistic', expect: ['Token 用量统计', '按 Provider'] },
  { id: 'dsh-env-manager', expect: ['环境管理器', '环境数'] },
]

for (const job of jobs) {
  await page.click(`.tab[data-id="${job.id}"]`)
  await page.waitForTimeout(2500)
  const visible = await page.isVisible(`#f-${job.id}`)
  const frameEl = await page.$(`#f-${job.id} iframe`)
  if (!frameEl) {
    out.push(`${job.id}: NO IFRAME (visible=${visible})`)
    const txt = await page.$eval(`#f-${job.id}`, (e) => e.innerText.replace(/\s+/g, ' ').slice(0, 200)).catch(() => '')
    out.push(`   body: ${txt}`)
    continue
  }
  const frame = await frameEl.contentFrame()
  await frame.waitForTimeout(2000)
  const body = await frame.$eval('body', (e) => e.innerText.replace(/\s+/g, ' ').slice(0, 400)).catch(() => '')
  const missing = job.expect.filter((k) => !body.includes(k))
  out.push(`${job.id}: visible=${visible} frameOK=${Boolean(frame)} missingMarkers=${JSON.stringify(missing)}`)
  out.push(`   sample: ${body.slice(0, 260)}`)
}

await page.screenshot({ path: 'E:/009workspace/pluginhub/verify-chain.png', fullPage: false })
await browser.close()
console.log(out.join('\n'))
