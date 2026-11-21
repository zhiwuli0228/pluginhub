import { chromium } from 'playwright'

/**
 * Screenshot the two distinct offline states:
 *  - a plugin PluginHub may start itself  -> launch command + 启动 button
 *  - a DSH-hosted plugin                   -> hint only, no launch button
 *
 * The config is mocked so the real running system is untouched; the rendering is
 * the real dashboard code.
 */

const DS_HINT =
  '需要先启动 DSH（Web 或桌面版）。该插件的路由挂在 DSH 的 webServer 上，PluginHub 不会代为拉起宿主。'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

await page.route('**/api/config', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      connectors: [
        {
          id: 'token-usage-statistic',
          name: 'Token 用量统计',
          icon: '📊',
          mode: 'iframe',
          url: null,
          online: false,
          error: '未在本机找到该插件（尝试了 37 个端口）',
          endpoint: null,
          endpointSource: null,
          canLaunch: false,
          launchHint: null,
          offlineHint: DS_HINT,
        },
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
          offlineHint: null,
        },
      ],
    }),
  }),
)

await page.goto('http://127.0.0.1:7895/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

// DSH-hosted: hint, no launch button
const dshCard = await page.$eval('#f-token-usage-statistic', (e) => e.innerText.replace(/\s+/g, ' '))
const dshButtons = await page.$$eval('#f-token-usage-statistic button', (els) => els.map((b) => b.textContent.trim()))
console.log('DSH-hosted offline card:', dshCard.slice(0, 220))
console.log('DSH-hosted buttons:', JSON.stringify(dshButtons))

await page.screenshot({ path: 'E:/009workspace/pluginhub/docs/04-demo/final-7-no-launch.png' })

// Launchable: command + 启动 button
await page.click('.tab[data-id="agent-memory-hub"]')
await page.waitForTimeout(600)
const memButtons = await page.$$eval('#f-agent-memory-hub button', (els) => els.map((b) => b.textContent.trim()))
console.log('Launchable buttons:', JSON.stringify(memButtons))
await page.screenshot({ path: 'E:/009workspace/pluginhub/docs/04-demo/final-8-launchable.png' })

await browser.close()
console.log('CONSOLE ERRORS:', errors.length ? JSON.stringify(errors) : 'none')
