// Optional real-browser check against kg-verification-ui-fixture.mjs --review --markdown-image.
const assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core')

async function main() {
  const url = new URL(process.argv[2])
  assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol === 'http:')
  assert(url.port && !['3099', '3109', '3119'].includes(url.port), 'Use only a disposable fixture, never a deployed service')
  const output = path.resolve(__dirname, '../output/playwright')
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' }) })
  const errors = [], sizes = []
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => errors.push(error.message))
    const stats = async () => {
      const response = await page.request.get(new URL('/fixture/stats', url).href)
      assert(response.ok())
      const data = await response.json()
      assert(Number.isInteger(data.modelCalls) && Number.isInteger(data.commits), 'Fixture identity required')
      return data
    }
    const before = await stats()
    const calls = []
    page.on('request', request => { if (request.method() === 'POST') calls.push(new URL(request.url()).pathname) })
    const tab = id => page.locator('#kg-workspace-tab-' + id)
    const panel = id => page.locator('#kg-workspace-' + id)
    const select = async id => {
      await tab(id).click()
      assert.equal(await tab(id).getAttribute('aria-selected'), 'true')
      assert.equal(await page.getByRole('tabpanel').count(), 1, 'Only one workspace exposed to assistive technology')
      assert.equal(await page.locator('.kg-workspace-tabs [tabindex="0"]').count(), 1)
      assert.equal(await panel(id).isVisible(), true)
    }
    await page.goto(url.href)
    await tab('read').waitFor()
    await page.locator('svg .kg-node').first().waitFor()
    const graphTop = await page.locator('.kg-cols').evaluate(el => el.getBoundingClientRect().top)
    assert(graphTop < 500, 'Primary reading surface should appear in the first viewport')

    await tab('read').focus()
    await page.keyboard.press('ArrowLeft')
    assert.equal(await tab('source').evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Home')
    assert.equal(await tab('read').evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('ArrowRight')
    assert.equal(await tab('use').evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('End')
    assert.equal(await tab('source').evaluate(el => el === document.activeElement), true)

    const draft = '未提交的追加资料，切换工作区不能丢失。'
    await page.getByRole('textbox', { name: '资料正文', exact: true }).fill(draft)
    await select('use')
    const search = page.getByRole('textbox', { name: '知识图检索关键词' })
    await search.fill('Fixture observation 3')
    await page.getByRole('button', { name: '检索', exact: true }).click()
    await page.locator('.kg-consume-result').first().waitFor()
    const results = await page.locator('.kg-consume-list').innerText()
    await select('review')
    await page.getByRole('button', { name: '错误 2', exact: true }).click()
    await panel('review').locator('summary').filter({ hasText: '对知识图提问' }).click()
    const question = panel('review').locator('.kg-question-input').first()
    await question.fill('这条结论是否遗漏适用条件？')
    const handles = await page.evaluateHandle(() => ({
      source: document.querySelector('#kg-workspace-source textarea'),
      query: document.querySelector('#kg-workspace-use input'),
      question: document.querySelector('#kg-workspace-review .kg-question-input'),
    }))
    await select('read')
    await select('source')
    assert.equal(await page.getByRole('textbox', { name: '资料正文', exact: true }).inputValue(), draft)
    await select('use')
    assert.equal(await search.inputValue(), 'Fixture observation 3')
    assert.equal(await page.locator('.kg-consume-list').innerText(), results)
    await select('review')
    assert.equal(await question.inputValue(), '这条结论是否遗漏适用条件？')
    assert.equal(await page.getByRole('button', { name: '错误 2', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.evaluate(prior =>
      prior.source === document.querySelector('#kg-workspace-source textarea') &&
      prior.query === document.querySelector('#kg-workspace-use input') &&
      prior.question === document.querySelector('#kg-workspace-review .kg-question-input'), handles), true,
    'Navigation must retain component instances, not reconstruct their drafts')
    await handles.dispose()

    await page.getByRole('button', { name: '查看图文', exact: true }).first().click()
    await panel('read').waitFor()
    assert.equal(await panel('read').evaluate(el => el === document.activeElement), true)
    await page.locator('svg .kg-node[data-node-id="n0"]').first().focus()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '质疑此节点', exact: true }).click()
    await panel('review').waitFor()
    assert.equal(await question.evaluate(el => el === document.activeElement), true, 'Question entry is focused after cross-workspace navigation')
    assert.match(await panel('review').innerText(), /目标.*n0/)
    await page.getByRole('button', { name: '外部事实核查', exact: true }).click()
    assert.equal(await page.locator('#kg-fact-panel-workbench').evaluate(el => el.closest('details').open), true)

    await select('use')
    await page.locator('.kg-consume-result').first().click()
    await panel('read').waitFor()
    assert.equal(await panel('read').evaluate(el => el === document.activeElement), true)
    await select('use')
    assert.equal(await search.inputValue(), 'Fixture observation 3')
    await select('read')
    const closeDetail = page.getByRole('button', { name: '关闭详情', exact: true })
    if (await closeDetail.count()) await closeDetail.click()

    for (const width of [1440, 2560, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const id of ['read', 'use', 'review', 'source']) {
        await select(id)
        if (id === 'read') {
          await page.waitForFunction(() => {
            const node = document.querySelector('svg .kg-node[data-node-id="n3"]')
            if (!node) return false
            const n = node.getBoundingClientRect(), g = node.closest('.kg-graph').getBoundingClientRect()
            return g.width > 0 && Math.abs((n.left + n.right - g.left - g.right) / 2) < 4
          })
        }
        const geometry = await page.locator('.kg-workbench').evaluate(root => ({
          width: window.innerWidth, documentWidth: document.documentElement.scrollWidth,
          overflow: [...root.querySelectorAll('input,select,button,summary')].filter(el => {
            if (!el.getClientRects().length || el.closest('svg')) return false
            const rect = el.getBoundingClientRect()
            return rect.left < -1 || rect.right > window.innerWidth + 1
          }).map(el => el.getAttribute('aria-label') || el.textContent.trim()),
        }))
        assert(geometry.documentWidth <= width + 1, JSON.stringify({ id, ...geometry }))
        assert.deepEqual(geometry.overflow, [], JSON.stringify({ id, ...geometry }))
        sizes.push({ width, tab: id, overflow: false })
        if (width !== 2560) {
          await page.evaluate(() => window.scrollTo(0, 0))
          await page.screenshot({ path: path.join(output, `workbench-${id}-${width}.png`), fullPage: true })
        }
      }
    }
    const after = await stats()
    for (const key of ['submissions', 'modelCalls', 'commits', 'questionRequests', 'revision']) {
      assert.equal(after[key], before[key], `Workspace navigation must not change ${key}`)
    }
    assert(!calls.some(route => /task-cancel|task-resume|verify-graph|question-graph|graph-commit$/.test(route)),
      'Tab navigation cannot start, cancel, resume tasks or commit graph changes')

    await select('read')
    for (const name of ['任务视图', '导出', '图谱状态与生成记录']) {
      const summary = panel('read').locator('summary').filter({ hasText: name })
      await summary.click()
      assert.equal(await summary.evaluate(el => el.parentElement.open), true)
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), name + ' overflows on mobile')
      await summary.click()
    }
    await page.getByRole('button', { name: '重新开始', exact: true }).click()
    await page.getByRole('heading', { name: '新建知识图', exact: true }).waitFor()
    assert.equal(await page.getByRole('tabpanel').count(), 0)
    assert.equal(await page.getByRole('tablist', { name: '知识图工作区' }).count(), 0)
    assert.equal(await page.getByRole('textbox', { name: '资料正文', exact: true }).isVisible(), true)
    assert.equal((await stats()).revision, before.revision, 'New draft must not delete the saved graph')
    await page.screenshot({ path: path.join(output, 'workbench-empty-390.png'), fullPage: true })

    await page.reload()
    await select('review')
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'AI 全图深度审校', exact: true }).click()
    await page.locator('.kg-verify-progress').getByRole('button', { name: '取消审校', exact: true }).waitFor()
    for (const id of ['use', 'source', 'read']) {
      await select(id)
      assert.equal(await page.locator('.kg-verify-progress').isVisible(), true, 'Running task remains visible outside the workspace')
    }
    assert.equal((await stats()).submissions, before.submissions + 1, 'Tab changes never resubmit the running review')
    await page.request.post(new URL('/fixture/complete', url).href)
    const openReport = page.getByRole('button', { name: '查看审校报告', exact: true })
    await openReport.waitFor({ timeout: 60000 })
    await openReport.click()
    await panel('review').waitFor()
    assert.equal(await tab('review').getAttribute('aria-selected'), 'true')
    assert.equal(await page.getByRole('heading', { name: '审校结果与处理', exact: true }).isVisible(), true)

    await select('source')
    const appendText = ['追加图例。', '图例含有两个标记。', '连线描述如下。', '关系：A → B；图中依据：可见箭头。'].join('\n\n')
    const input = page.getByRole('textbox', { name: '资料正文', exact: true })
    await input.fill(appendText)
    const appendRoute = '**/api/dsh-knowledge-graph/append-extract'
    const beforeRejectedAppend = await stats()
    await page.route(appendRoute, route => route.fulfill({ json: { error: {
      code: 'fixture_rejection', message: 'Controlled append rejection',
    } } }))
    await page.getByRole('button', { name: '追加拆分', exact: true }).click()
    await page.getByText('Controlled append rejection', { exact: false }).waitFor()
    assert.equal(await tab('source').getAttribute('aria-selected'), 'true')
    assert.equal(await input.inputValue(), appendText, 'Rejected append must retain the source draft')
    assert.equal((await stats()).revision, beforeRejectedAppend.revision)
    await page.unroute(appendRoute)
    await page.getByRole('button', { name: '追加拆分', exact: true }).click()
    await tab('read').waitFor({ timeout: 60000 })
    assert.equal(await tab('read').getAttribute('aria-selected'), 'true',
      'Successful append on the same document must reveal the updated graph, not a collapsed source panel')
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-kg-result-v2')).documentId), 'verification-fixture')
    assert((await stats()).revision > beforeRejectedAppend.revision, 'Append must persist in the isolated SQLite fixture')

    await select('use')
    await page.getByRole('button', { name: '历史', exact: true }).click()
    await page.locator('.kg-history-item').first().click()
    await panel('read').waitFor()
    assert.equal(await tab('read').getAttribute('aria-selected'), 'true', 'Reopening the current document also reveals the graph')
    assert(!calls.some(route => /task-cancel|task-resume/.test(route)), 'Navigation must never cancel or resume the fixture task')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ rovingKeyboard: true, retainedDraftsAndFilters: true, retainedSearchResults: true,
      crossWorkspaceFocus: true, cameraCenterPreserved: true, emptyState: true, secondaryControls: true,
      navigationOnlyZeroModelsOrWrites: true, controlledReviewLifecycle: true,
      rejectedAppendRetainsDraft: true, successfulAppendAndHistoryRevealGraph: true, graphTop, sizes }))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
