import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:7895/'
const out = []
const errors = []

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()) })

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(3000)

const tabs = await page.$$eval('.tab', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
out.push('TABS(' + tabs.length + '): ' + JSON.stringify(tabs))

const header = await page.$eval('#header-sub', (e) => e.textContent.trim()).catch(() => '')
out.push('HEADER: ' + header)

const jobs = [
  {
    id: 'agent-memory-hub',
    shot: 'docs/04-demo/final-1-memory.png',
    expect: ['memhub console', 'accepted'],
    probe: /accepted\s+(\d+)/,
  },
  {
    id: 'token-usage-statistic',
    shot: 'docs/04-demo/final-2-token.png',
    expect: ['Token 用量统计', '按 Provider', '缓存命中率'],
    probe: /总 Tokens\s+([\d,]+)/,
  },
  {
    id: 'dsh-env-manager',
    shot: 'docs/04-demo/final-3-env.png',
    expect: ['环境管理器', '环境数', '服务数', '部署数'],
    probe: /环境数\s+(\d+)/,
  },
]

for (const job of jobs) {
  await page.click(`.tab[data-id="${job.id}"]`)
  await page.waitForTimeout(2500)

  const visible = await page.isVisible(`#f-${job.id}`)
  const frameEl = await page.$(`#f-${job.id} iframe`)
  if (!frameEl) {
    out.push(`${job.id}: ❌ NO IFRAME (visible=${visible})`)
    const txt = await page.$eval(`#f-${job.id}`, (e) => e.innerText.replace(/\s+/g, ' ').slice(0, 160)).catch(() => '')
    out.push('   body: ' + txt)
    continue
  }

  const frame = await frameEl.contentFrame()
  await frame.waitForTimeout(2200)
  const body = await frame.$eval('body', (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '')
  const missing = job.expect.filter((k) => !body.includes(k))
  const probed = job.probe.exec(body)
  const ok = missing.length === 0 && probed

  out.push(`${job.id}: ${ok ? '✅' : '❌'} visible=${visible} missing=${JSON.stringify(missing)} value=${probed ? probed[1] : '(none)'}`)
  out.push('   sample: ' + body.slice(0, 180))

  await page.screenshot({ path: `E:/009workspace/pluginhub/${job.shot}` })
  out.push('   shot → ' + job.shot)
}

await browser.close()
out.push('')
out.push('CONSOLE ERRORS: ' + (errors.length ? JSON.stringify(errors) : 'none'))
console.log(out.join('\n'))
