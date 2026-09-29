// Real Chrome with controlled React scheduling, against a disposable fixture only.
const assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core')

async function main() {
  const url = new URL(process.argv[2])
  assert(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
  assert(url.port && !['3099', '3109', '3119'].includes(url.port), 'Disposable fixture only')
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' }) })
  const output = path.resolve(__dirname, '../output/playwright')
  mkdirSync(output, { recursive: true })
  try {
    for (const deferred of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      const stats = async () => {
        const value = await (await page.request.get(new URL('/fixture/stats', url).href)).json()
        assert.equal(value.visualInspectorFixture, true)
        return value
      }
      const before = await stats()
      if (deferred) {
        await page.route('**/client.js', async route => {
          const response = await route.fetch()
          const source = await response.text()
          const setter = 'selected: visualSelection, setSelected: setVisualSelection,'
          assert.equal(source.split(setter).length, 2)
          // A pending parent update prevents React's eager state shortcut.
          const body = source.replace(setter, 'selected: visualSelection, setSelected: next => React.startTransition(() => { setVisualSelection(ids => [...ids]); setVisualSelection(next) }),')
          await route.fulfill({ response, body })
        })
      }
      try {
        await page.goto(url.href)
        await page.getByRole('button', { name: '图片解读与节点', exact: true }).click()
        const panel = page.getByRole('region', { name: '图片视觉解读', exact: true })
        await panel.getByText('这张图片尚未解读，未生成解读内容节点。', { exact: true }).waitFor()
        const check = i => panel.getByRole('checkbox', { name: '选择图片 images/figure-' + i + '.png', exact: true })
        const toggle = async (i, checked) => {
          assert.notEqual(await check(i).isChecked(), checked)
          await check(i).click()
          // Deferred renders need to finish; a DOM-only immediate check is insufficient.
          await page.waitForFunction(({ label, checked }) =>
            [...document.querySelectorAll('input[type="checkbox"]')].some(input => input.getAttribute('aria-label') === label && input.checked === checked),
          { label: '选择图片 images/figure-' + i + '.png', checked }, { timeout: 10000 })
          assert.equal(await check(i).isChecked(), checked)
        }
        await toggle(1, true)
        assert.equal(await check(1).isChecked(), true, 'Checking must survive controlled DOM restoration')
        await toggle(1, false)
        assert.equal(await check(1).isChecked(), false)
        await check(2).focus()
        await page.keyboard.press('Space')
        await panel.getByText('已选 1/4 张', { exact: true }).waitFor()
        assert.equal(await check(2).isChecked(), true, 'Keyboard selection must persist')
        for (const i of [3, 4, 5]) await toggle(i, true)
        assert.equal(await check(6).isDisabled(), true)
        assert.equal(await check(2).isDisabled(), false, 'Can still uncheck at the limit')
        await panel.getByRole('button', { name: '下一页图片', exact: true }).click()
        assert.equal(await check(14).isDisabled(), true, 'Off-page selections still count toward the limit')
        await panel.getByRole('button', { name: '清空选择', exact: true }).click()
        await panel.getByText('已选 0/4 张', { exact: true }).waitFor()
        await toggle(14, true)
        await panel.getByRole('button', { name: '上一页图片', exact: true }).click()
        await toggle(3, true)
        await panel.getByRole('searchbox', { name: '搜索图片', exact: true }).fill('figure-14')
        assert.equal(await check(14).isChecked(), true, 'Filtering must retain off-page selections')
        await toggle(14, false)
        await panel.getByRole('searchbox', { name: '搜索图片', exact: true }).fill('')
        assert.equal(await check(3).isChecked(), true)
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 })
          await toggle(3, false)
          await toggle(3, true)
          await panel.scrollIntoViewIfNeeded()
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
          await page.screenshot({ path: path.join(output, 'visual-selection-' + (deferred ? 'deferred-' : 'normal-') + width + '.png') })
        }
        const after = await stats()
        for (const key of ['revision', 'commits', 'modelCalls', 'visualCalls', 'submissions']) {
          assert.equal(after[key] || 0, before[key] || 0, 'Selection must not change ' + key)
        }
        assert.deepEqual(errors, [])
        console.log(JSON.stringify({ ok: true, deferred, keyboard: true, pagination: true,
          filtering: true, selectionLimit: true, widths: [1440, 390], noWritesOrModelCalls: true }))
      } catch (error) {
        await page.screenshot({ path: path.join(output, 'visual-selection-' + (deferred ? 'deferred' : 'normal') + '-failure.png'), fullPage: true }).catch(() => {})
        throw error
      } finally { await page.close() }
    }
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
