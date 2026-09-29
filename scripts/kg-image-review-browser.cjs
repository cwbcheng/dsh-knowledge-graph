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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const endpoint = value => new URL(value, url).href
  const stats = async () => (await page.request.get(endpoint('/fixture/stats'))).json()
  const post = async (name, data) => (await page.request.post(endpoint('/api/dsh-knowledge-graph/' + name), { data })).json()
  const documentId = 'verification-fixture'
  const canonical = () => post('document-export', { documentId, includeSourceText: true })
  try {
    assert.equal((await stats()).imageReviewFixture, true, 'Verify disposable fixture before mutations')
    const before = await canonical()
    const expectedRevision = before.revision
    const read = () => post('image-review', { action: 'list', documentId, expectedRevision })
    const panel = () => page.getByRole('region', { name: '图片视觉解读', exact: true })
    const form = () => panel().getByRole('region', { name: '对照原图核对', exact: true })
    const row = i => panel().getByRole('button', { name: '查看图片 images/figure-' + i + '.png', exact: true })
    const acknowledge = () => form().getByRole('checkbox', { name: '已对照原图检查转写内容', exact: true })
    const open = async () => {
      await page.getByRole('button', { name: '图片解读与节点', exact: true }).click()
      await panel().getByRole('button', { name: '核对转写', exact: true }).waitFor()
      await panel().locator('.kg-visual-original img').evaluate(img => img.decode())
    }
    await page.goto(url.href)
    await open()
    assert((await row(1).innerText()).includes('待核对'))
    assert.equal(await form().getByRole('button', { name: '保存核对', exact: true }).isDisabled(), true)
    await panel().getByRole('button', { name: '核对转写', exact: true }).click()
    let release, started, saveCount = 0, rejectSave = false, rejectList = false
    const held = new Promise(resolve => { release = resolve })
    const saving = new Promise(resolve => { started = resolve })
    await page.route('**/api/dsh-knowledge-graph/image-review', async route => {
      const payload = route.request().postDataJSON()
      if (payload.action === 'list' && rejectList) {
        rejectList = false
        return route.fulfill({ json: { error: { code: 'fixture', message: '受控核对状态读取失败' } } })
      }
      if (payload.action === 'save') {
        saveCount++
        if (saveCount === 1) { started(); await held }
        if (rejectSave) {
          rejectSave = false
          return route.fulfill({ json: { error: { code: 'fixture', message: '受控核对保存失败' } } })
        }
      }
      return route.continue()
    })
    await form().getByRole('textbox', { name: '核对备注' }).fill('已检查转写中的限定条件。')
    await acknowledge().check()
    await form().getByRole('button', { name: '保存核对', exact: true }).evaluate(button => { button.click(); button.click() })
    await saving
    assert.equal(saveCount, 1, 'Double click must create only one write')
    await row(2).click()
    await form().waitFor()
    assert.equal(await acknowledge().isChecked(), false, 'Confirmation must not transfer to another image')
    release()
    await row(1).filter({ hasText: '人工核对一致' }).waitFor()
    assert((await row(2).innerText()).includes('待核对'), 'A late save cannot mark the newly selected image')
    assert.deepEqual(await canonical(), before, 'Manual review must not change canonical data or revision')
    await row(1).click()
    await form().getByRole('button', { name: '撤销核对', exact: true }).waitFor()
    assert.equal(await form().getByRole('textbox', { name: '核对备注' }).inputValue(), '已检查转写中的限定条件。')

    await form().getByRole('radio', { name: '发现转写问题', exact: true }).check()
    await form().getByRole('textbox', { name: '核对备注' }).fill('')
    await acknowledge().check()
    assert.equal(await form().getByRole('button', { name: '保存核对', exact: true }).isDisabled(), true, 'Problems need a reviewable note')
    const note = '箭头方向不清晰；<script>这只是文字</script>'
    await form().getByRole('textbox', { name: '核对备注' }).fill(note)
    rejectSave = true
    await form().getByRole('button', { name: '保存核对', exact: true }).click()
    await form().getByRole('alert').filter({ hasText: '受控核对保存失败' }).waitFor()
    assert.equal(await form().getByRole('textbox', { name: '核对备注' }).inputValue(), note)
    assert.equal((await read()).reviews[0].status, 'matched', 'Failed save must not report success')
    await row(2).click()
    await row(1).click()
    await form().waitFor()
    assert.equal(await form().getByRole('textbox', { name: '核对备注' }).inputValue(), note, 'Switching images retains the unsaved note')
    await acknowledge().check()
    await form().getByRole('button', { name: '保存核对', exact: true }).click()
    await row(1).filter({ hasText: '有转写问题' }).waitFor()
    await page.reload()
    await open()
    await panel().getByRole('combobox', { name: '图片解读状态' }).selectOption('review_needs_correction')
    assert.equal(await panel().locator('.kg-visual-image-row').count(), 1)
    assert.equal(await form().getByRole('textbox', { name: '核对备注' }).inputValue(), note)
    await form().getByRole('button', { name: '撤销核对', exact: true }).click()
    await panel().getByRole('combobox', { name: '图片解读状态' }).selectOption('all')
    await row(1).filter({ hasText: '待核对' }).waitFor()

    const old = (await read()).reviews[0]
    const external = await post('image-review', { action: 'save', documentId, expectedRevision, imageId: old.imageId,
      expectedVersion: old.version, fingerprint: old.fingerprint, status: 'needs_correction', note: '另一窗口的核对记录', confirmed: true })
    assert.equal(external.review.status, 'needs_correction')
    await form().getByRole('radio', { name: '与原图一致', exact: true }).check()
    await form().getByRole('textbox', { name: '核对备注' }).fill('当前窗口尚未保存的备注')
    await acknowledge().check()
    await form().getByRole('button', { name: '保存核对', exact: true }).click()
    await form().getByRole('alert').filter({ hasText: '未覆盖已有记录' }).waitFor()
    assert.equal((await read()).reviews[0].note, '另一窗口的核对记录')
    await form().getByRole('button', { name: '刷新核对状态', exact: true }).click()
    await row(1).filter({ hasText: '有转写问题' }).waitFor()
    assert.equal(await form().getByRole('textbox', { name: '核对备注' }).inputValue(), '当前窗口尚未保存的备注')
    assert.equal(await acknowledge().isChecked(), false)
    rejectList = true
    await form().getByRole('button', { name: '刷新核对状态', exact: true }).click()
    await panel().getByRole('alert').filter({ hasText: '受控核对状态读取失败' }).waitFor()
    assert.equal(await form().count(), 0, 'Unknown review state cannot be silently presented as pending')
    await panel().getByRole('button', { name: '重试核对状态', exact: true }).click()
    await form().waitFor()
    assert.equal(await form().getByRole('textbox', { name: '核对备注' }).inputValue(), '当前窗口尚未保存的备注')
    const output = path.resolve(__dirname, '../output/playwright')
    mkdirSync(output, { recursive: true })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await panel().scrollIntoViewIfNeeded()
      await panel().locator('.kg-visual-original img').evaluate(img => img.decode())
      assert.equal(await panel().locator('.kg-visual-original img').evaluate(img => img.naturalWidth), 128)
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page overflow at ' + width)
      assert(await panel().evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Review overflow at ' + width)
      await panel().screenshot({ path: path.join(output, 'image-review-' + width + '.png') })
    }
    const after = await stats()
    assert.equal(after.modelCalls, 0)
    assert.equal(after.visualCalls || 0, 0)
    assert.deepEqual(await canonical(), before)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ ok: true, realBrowser: true, reviewAndRevoke: true, reload: true,
      lateSaveIsolation: true, conflictFence: true, draftRetention: true, readFailure: true,
      noCanonicalWrites: true, modelCalls: 0, viewports: [1440, 390] }))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
