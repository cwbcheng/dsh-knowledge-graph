import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness, learnerResponse, learnerReview } from './kg-model-learning-fixture-data.mjs'
import { counterexampleResponse } from './kg-model-comparison-fixture-data.mjs'
import { modelCitationFixture, modelCitationLocator, modelCitationPanelLocationSource } from './kg-model-citation-locator-fixture.mjs'

// Hold the real node-window route while changing a saved prediction. Records,
// including reveal/review versions, come from the actual SQLite/HTTP lifecycle.
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const component = value => value.slice(value.indexOf('function ModelLearningPanel('), value.indexOf('function LearningModePanel(')).replaceAll('host.call(', 'rpc(')
for (const path of ['../lib/client.js', '../extension/viewer.js']) assert.equal(component(source), component(readFileSync(new URL(path, import.meta.url), 'utf8')))
let owner, cursor = 0
const slot = initial => { const index = cursor++; return owner.slots[index] ||= initial() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) { const opening = owner, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    return [state.value, next => opening.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
    owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
  } },
}
const env = { window: { React, confirm: () => true, addEventListener() {}, removeEventListener() {} }, console, AbortController,
  sessionStorage: { getItem: key => owner.storage.get(key), setItem: (key, value) => owner.storage.set(key, value), removeItem: key => owner.storage.delete(key) },
  documentIdOfGraph: graph => graph?.source?.documentId }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), env)
runInNewContext(source.slice(source.indexOf('function exactSourceQuoteTarget('), source.indexOf('function KnowledgeConsumePanel(')) + '\nthis.target=exactSourceQuoteTarget', env)
const viewer = env.window.KGViewer
const all = (node, predicate) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, predicate)) : !node || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function mount(props) {
  const state = { slots: [], updates: [], effects: [], storage: new Map(), tree: null }
  let mounted = true
  const render = () => {
    for (let count = 0; count < 30; count++) {
      owner = state; state.updates.splice(0).forEach(fn => fn()); cursor = 0
      state.tree = viewer.ModelLearningPanel(props); state.effects.splice(0).forEach(fn => fn())
      if (!state.updates.length) return
    }
    throw new Error('Component update loop')
  }
  const settle = async () => { for (let count = 0; count < 12; count++) { await new Promise(done => setImmediate(done)); if (mounted) render() } }
  const buttons = label => all(state.tree, item => item.type === 'button' && (text(item) === label || item.props['aria-label'] === label))
  const click = async (label, index = 0) => { const button = buttons(label)[index]; assert(button, 'Missing ' + label); assert(!button.props.disabled);
    owner = state; button.props.onClick(); await settle() }
  const choose = async id => { const button = all(state.tree, item => item.type === 'button' && item.props.key === id)[0]; assert(button, id);
    owner = state; button.props.onClick(); await settle() }
  const input = label => all(state.tree, item => item.type === 'textarea' && item.props['aria-label'] === label)[0]
  const fill = async (label, value) => { const field = input(label); assert(field && !field.props.disabled, label);
    owner = state; field.props.onChange({ target: { value } }); await settle() }
  const unmount = () => { mounted = false; for (const item of state.slots) item.cleanup?.() }
  render(); return { state, props, render, settle, buttons, click, choose, input, fill, unmount }
}
function navigation(harness, fixture) {
  const loads = [], nodes = [], paragraphs = [], changes = [], references = [], pending = [], completed = []
  const outside = viewer.makeView({ ...harness.store.getDocument(fixture.documentId), nodes: [], edges: [] }, fixture.sourceText)
  const context = { resultView: outside, fullText: fixture.sourceText, currentResultRef: { current: outside },
    paragraphLocateSeqRef: { current: 0 }, graphRevisionRef: { current: 1 }, graphCommitQueueRef: { current: Promise.resolve() },
    documentIdOfGraph: env.documentIdOfGraph, exactSourceQuoteTarget: env.target, makeView: viewer.makeView,
    loadGraphDocument: async args => { const hold = deferred(); loads.push(args); pending.push(hold); await hold.promise;
      return hold.failure ? { error: { message: hold.failure } } : harness.post(args, 'document-load') },
    setResultView: value => changes.push(value), setContentScope: value => changes.push(value), navigateWorkspace: value => changes.push(value),
    setChapterFilter: value => changes.push(value), chapterSectionsOf: graph => graph.source.sections || [], graphViewMetadata: () => null,
    setGraphQueryDraft() {}, setGraphPageDraft() {}, setSelectedNodeId: value => nodes.push(value), setSelectedEdgeId() {}, setFocusReq: update => update({ seq: 0 }),
    setActivePara: value => paragraphs.push(value), setFlashPara() {}, ctx: { timeout: fn => fn() },
    document: { getElementById: id => ({ id }) }, scrollElIntoCenter: element => changes.push(element.id), changeReadMode: value => changes.push('read-mode:' + value) }
  context.locateConsumptionReference = modelCitationLocator(context)
  const receiver = new Function(...Object.keys(context), 'return ' + modelCitationPanelLocationSource())(...Object.values(context))
  return { loads, nodes, paragraphs, changes, references, pending, completed,
    locate: (reference, stillCurrent = () => true) => { references.push(reference);
      const result = receiver(reference, stillCurrent); completed.push(result.then(() => true, () => false)); return result } }
}
let citationActions = 0, cancelledCases = 0, explicitReviewVersions = 0
for (const variant of ['sparse', 'dense', 'long']) {
  const dense = variant === 'dense', fixture = modelCitationFixture({ dense, anchor: dense ? 2 : 1, long: variant === 'long' })
  const harness = await modelLearningHarness({ fixture }), uis = []
  try {
    const base = { documentId: fixture.documentId, modelId: 'taxi', expectedRevision: 1 }
    for (const exercise of ['prediction', 'counterexample']) {
      const plan = await harness.post({ ...base, exercise, action: 'plan' }); assert(!plan.error)
      for (const id of ['first', 'second', 'hidden']) {
        const saved = await harness.post({ ...base, exercise, action: 'save', taskId: plan.tasks[0].id, attemptId: exercise + '-' + id,
          selfRating: 'uncertain', response: exercise === 'counterexample' ? counterexampleResponse : learnerResponse })
        assert(!saved.error); assert.equal(saved.attempt.task.references.length, 0, 'Actual unrevealed response conceals all citations')
        if (id !== 'hidden') assert(!(await harness.post({ ...base, exercise, action: 'reveal', attemptId: exercise + '-' + id, expectedVersion: 1 })).error)
      }
    }
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
    const learningRows = () => harness.store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()
    let recordsBefore = JSON.stringify(learningRows())
    for (const exercise of ['prediction', 'counterexample']) {
      const firstId = exercise + '-first', secondId = exercise + '-second', hiddenId = exercise + '-hidden'
      const original = (await harness.post({ ...base, exercise, action: 'get', attemptId: firstId })).attempt.task.references.find(item => item.nodeId === 'taxi').citations[0]
      assert.equal(original.quote, fixture.sourceUnits[dense ? 2 : 1].text)
      const open = async (nav, extra = {}) => { const ui = mount({ ...base, revision: 1, exercise, active: true, call: args => harness.post(args), onLocate: nav.locate, ...extra });
        uis.push(ui); await ui.settle(); await ui.choose(firstId); return ui }
      const nav = navigation(harness, fixture), ui = await open(nav)
      await ui.click('定位原文')
      const actual = nav.references[0]
      assert.equal(actual.documentId, fixture.documentId); assert.equal(actual.revision, 1); assert.equal(actual.nodeId, 'taxi')
      assert.equal(actual.paragraph, original.paragraph); assert.equal(actual.sourceId, original.sourceId); assert.equal(actual.quote, original.quote)
      assert.equal(actual.sourceQuoteOnly, true); assert.equal(actual.sourceCitation, true)
      assert.equal(nav.pending.length, 1); nav.pending[0].resolve(); await nav.completed[0]; await ui.settle()
      assert.deepEqual(nav.nodes, ['taxi']); assert.deepEqual(nav.paragraphs, [dense ? 3 : 1]); assert(nav.changes.includes('kg-para-' + (dense ? 3 : 1)))
      assert.equal(all(ui.state.tree, item => item.type === viewer.ModelFeedbackPanel)[0].props.onLocate, nav.locate, 'Feedback retains its existing caller predicate')
      citationActions++
      if (variant === 'sparse') {
        // The explicit review legitimately changes the opened version from 2
        // to 3. Navigation must cancel without affecting this durable write.
        const versionNav = navigation(harness, fixture), reviewed = await open(versionNav)
        assert.equal(JSON.stringify(learningRows()), recordsBefore, 'Successful navigation does not change stored records')
        const rowsBeforeReview = learningRows(), predictionBeforeReview = (await harness.post({ ...base, exercise, action: 'get', attemptId: firstId })).attempt
        await reviewed.click('定位原文'); await reviewed.fill('保留或修改的理由', learnerReview.reflection); await reviewed.fill('下一步验证', learnerReview.nextCheck)
        await reviewed.click('保存复盘'); assert(text(reviewed.state.tree).includes('复盘已保存'))
        const predictionAfterReview = (await harness.post({ ...base, exercise, action: 'get', attemptId: firstId })).attempt
        assert.equal(predictionAfterReview.version, 3); assert.deepEqual(predictionAfterReview.response, predictionBeforeReview.response)
        assert.deepEqual(learningRows().filter(row => row.attempt_id !== firstId), rowsBeforeReview.filter(row => row.attempt_id !== firstId), 'Explicit review changes only its selected record')
        recordsBefore = JSON.stringify(learningRows())
        versionNav.pending[0].resolve(); await versionNav.completed[0]; await reviewed.settle(); assert.deepEqual(versionNav.changes, [])
        explicitReviewVersions++
        for (const transition of ['selection', 'selection-back', 'start', 'draft-back', 'exercise-back', 'model-back', 'document', 'revision', 'inactive-back', 'focus', 'reload', 'reload-complete', 'unmount']) {
          for (const failure of [false, true]) {
            const old = navigation(harness, fixture), holds = []; let paused = false
            const current = await open(old, { call: async args => { if (paused) { const hold = deferred(); holds.push(hold); await hold.promise } return harness.post(args) } })
            // Preserve a real draft while opening the saved record.
            await current.click('另开一次预测'); await current.fill(exercise === 'counterexample' ? '改变后的预测' : '我的预测', '尚未保存的预测草稿')
            await current.choose(firstId); await current.click('定位原文'); assert.equal(old.pending.length, 1)
            if (transition.startsWith('selection')) { await current.choose(secondId); if (transition.endsWith('back')) await current.choose(firstId) }
            else if (transition === 'start') await current.click('另开一次预测')
            else if (transition === 'draft-back') { await current.click('返回未保存的预测草稿'); assert.equal(current.input(exercise === 'counterexample' ? '改变后的预测' : '我的预测').props.value, '尚未保存的预测草稿'); await current.choose(firstId) }
            else if (transition === 'exercise-back') { current.props.exercise = exercise === 'prediction' ? 'counterexample' : 'prediction'; await current.settle(); current.props.exercise = exercise; await current.settle(); await current.choose(firstId) }
            else if (transition === 'model-back') { current.props.modelId = 'taxi-peer'; await current.settle(); current.props.modelId = 'taxi'; await current.settle(); await current.choose(firstId) }
            else if (transition === 'document') { current.props.documentId = 'other-document'; await current.settle() }
            else if (transition === 'revision') { current.props.revision = 2; await current.settle() }
            else if (transition === 'inactive-back') { current.props.active = false; await current.settle(); current.props.active = true; await current.settle() }
            else if (transition === 'focus') { current.props.focusRequest = { attemptId: secondId, nonce: 1 }; await current.settle() }
            else if (transition.startsWith('reload')) { paused = true; await current.click('重新读取学习记录');
              assert(current.buttons('定位原文').every(button => button.props.disabled), 'Loading saved records suspends navigation')
              if (transition === 'reload-complete') { paused = false; holds.forEach(hold => hold.resolve()); await current.settle() } }
            else current.unmount()
            if (failure) old.pending[0].failure = '旧预测窗口读取失败'
            old.pending[0].resolve(); await old.completed[0]; await current.settle()
            assert.deepEqual(old.changes, [], transition); assert.deepEqual(old.nodes, []); assert.deepEqual(old.paragraphs, [])
            assert(!text(current.state.tree).includes('旧预测窗口读取失败'), transition)
            paused = false; holds.forEach(hold => hold.resolve()); await current.settle(); cancelledCases++
          }
        }
        const newest = navigation(harness, fixture), twice = await open(newest)
        await twice.click('定位原文'); await twice.click('定位原文'); newest.pending[1].resolve(); await newest.completed[1]
        newest.pending[0].failure = '更早点击失败'; newest.pending[0].resolve(); await newest.completed[0]; await twice.settle()
        assert.deepEqual(newest.nodes, ['taxi']); assert.deepEqual(newest.paragraphs, [1]); assert(!text(twice.state.tree).includes('更早点击失败'))
        const failed = navigation(harness, fixture), broken = await open(failed)
        await broken.choose(secondId); await broken.fill('保留或修改的理由', '另一条待对照的复盘草稿')
        await broken.click('定位原文'); failed.pending[0].failure = '当前原文定位失败，请重试'; failed.pending[0].resolve(); await failed.completed[0]; await broken.settle()
        assert(text(broken.state.tree).includes('当前原文定位失败，请重试') && text(broken.state.tree).includes(original.quote))
        assert.equal(broken.input('保留或修改的理由').props.value, '另一条待对照的复盘草稿')
        await broken.choose(firstId); assert(!text(broken.state.tree).includes('当前原文定位失败，请重试'))
        await broken.choose(secondId); assert.equal(broken.input('保留或修改的理由').props.value, '另一条待对照的复盘草稿')
        const blocked = navigation(harness, fixture), hidden = await open(blocked)
        const captured = hidden.buttons('定位原文')[0].props.onClick
        await hidden.choose(hiddenId); assert.equal(hidden.buttons('定位原文').length, 0); assert(text(hidden.state.tree).includes('展开原文对照'))
        owner = hidden.state; captured(); await hidden.settle(); assert.equal(blocked.references.length, 0, 'Old callbacks cannot reveal or locate a hidden snapshot')
        await hidden.choose(firstId); hidden.props.revision = 2; await hidden.settle()
        assert(hidden.buttons('定位原文').every(button => button.props.disabled))
        owner = hidden.state; hidden.buttons('定位原文')[0].props.onClick(); await hidden.settle(); assert.equal(blocked.references.length, 0, 'Old source callbacks fail closed')
        const unavailable = await open(navigation(harness, fixture), { onLocate: undefined }); assert(unavailable.buttons('定位原文').every(button => button.props.disabled))
      }
      assert.equal(JSON.stringify(learningRows()), recordsBefore, 'Citation reads, cancellations and session drafts do not change saved learning records')
    }
    for (const ui of uis) ui.unmount()
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore)
    assert.equal(JSON.stringify(learningRows()), recordsBefore)
  } finally { for (const ui of uis) ui.unmount(); harness.stop() }
}
console.log(JSON.stringify({ ok: true, citationActions, cancelledCases, explicitReviewVersions, actualStoredPredictionAndCounterexampleSnapshotsAndHttp: true,
  fullNewlinesAndLongQuote: true, sparseAndDenseTargets: true, hiddenAndOldSnapshotsBlocked: true, currentFailuresVisible: true,
  newerClickWins: true, draftsAndExplicitReviewPreserved: true, sourceUnchanged: true, descendantFeedbackAdapterPreserved: true }))
