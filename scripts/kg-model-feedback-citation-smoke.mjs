import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness, learnerResponse, learnerReview } from './kg-model-learning-fixture-data.mjs'
import { counterexampleResponse } from './kg-model-comparison-fixture-data.mjs'
import { feedbackResponse } from './kg-model-feedback-fixture-data.mjs'
import { modelCitationFixture, modelCitationLocator, modelCitationPanelLocationSource } from './kg-model-citation-locator-fixture.mjs'

// Use actual saved/revealed predictions, typed results and correction receipts.
// Source-window responses are held at the real workbench navigation boundary.
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const component = value => value.slice(value.indexOf('function ModelFeedbackPanel('), value.indexOf('function ModelLearningPanel(')).replaceAll('host.call(', 'rpc(')
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
const env = { window: { React, confirm: () => true, addEventListener() {}, removeEventListener() {} }, console, URL, AbortController,
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
      state.tree = viewer.ModelFeedbackPanel(props); state.effects.splice(0).forEach(fn => fn())
      if (!state.updates.length) return
    }
    throw new Error('Component update loop')
  }
  const settle = async () => { for (let count = 0; count < 12; count++) { await new Promise(done => setImmediate(done)); if (mounted) render() } }
  const buttons = label => all(state.tree, item => item.type === 'button' && (text(item) === label || item.props['aria-label'] === label))
  const click = async label => { const button = buttons(label)[0]; assert(button, 'Missing ' + label); assert(!button.props.disabled);
    owner = state; button.props.onClick(); await settle() }
  const choose = async id => { const button = all(state.tree, item => item.type === 'button' && item.props.key === id)[0]; assert(button, id);
    owner = state; button.props.onClick(); await settle() }
  const input = label => all(state.tree, item => ['textarea', 'input', 'select'].includes(item.type) && item.props['aria-label'] === label)[0]
  const fill = async (label, value) => { const field = input(label); assert(field && !field.props.disabled, label);
    owner = state; field.props.onChange({ target: { value } }); await settle() }
  const unmount = () => { mounted = false; for (const item of state.slots) item.cleanup?.() }
  render(); return { state, props, settle, buttons, click, choose, input, fill, unmount }
}
function navigation(harness, fixture) {
  const nodes = [], paragraphs = [], changes = [], references = [], pending = [], completed = []
  const outside = viewer.makeView({ ...harness.store.getDocument(fixture.documentId), nodes: [], edges: [] }, fixture.sourceText)
  const context = { resultView: outside, fullText: fixture.sourceText, currentResultRef: { current: outside },
    paragraphLocateSeqRef: { current: 0 }, graphRevisionRef: { current: 1 }, graphCommitQueueRef: { current: Promise.resolve() },
    documentIdOfGraph: env.documentIdOfGraph, exactSourceQuoteTarget: env.target, makeView: viewer.makeView,
    loadGraphDocument: async args => { const hold = deferred(); pending.push(hold); await hold.promise;
      return hold.failure ? { error: { message: hold.failure } } : harness.post(args, 'document-load') },
    setResultView: value => changes.push(value), setContentScope: value => changes.push(value), navigateWorkspace: value => changes.push(value),
    setChapterFilter: value => changes.push(value), chapterSectionsOf: graph => graph.source.sections || [], graphViewMetadata: () => null,
    setGraphQueryDraft() {}, setGraphPageDraft() {}, setSelectedNodeId: value => nodes.push(value), setSelectedEdgeId() {}, setFocusReq: update => update({ seq: 0 }),
    setActivePara: value => paragraphs.push(value), setFlashPara() {}, ctx: { timeout: fn => fn() },
    document: { getElementById: id => ({ id }) }, scrollElIntoCenter: element => changes.push(element.id), changeReadMode: value => changes.push('read-mode:' + value) }
  context.locateConsumptionReference = modelCitationLocator(context)
  const receiver = new Function(...Object.keys(context), 'return ' + modelCitationPanelLocationSource())(...Object.values(context))
  return { nodes, paragraphs, changes, references, pending, completed,
    locate: (reference, stillCurrent = () => true) => { references.push(reference);
      const result = receiver(reference, stillCurrent); completed.push(result.then(() => true, () => false)); return result } }
}
let citationActions = 0, cancelledCases = 0, explicitCorrections = 0, explicitReviewVersions = 0
for (const variant of ['sparse', 'dense', 'long-source']) {
  const dense = variant === 'dense', fixture = modelCitationFixture({ dense, anchor: dense ? 2 : 1, long: variant === 'long-source' })
  const harness = await modelLearningHarness({ fixture }), uis = []
  try {
    const base = { documentId: fixture.documentId, modelId: 'taxi', expectedRevision: 1 }, predictions = {}
    for (const exercise of ['prediction', 'counterexample']) {
      const plan = await harness.post({ ...base, exercise, action: 'plan' }); assert(!plan.error)
      for (const id of ['first', 'second', 'hidden']) {
        const attemptId = exercise + '-' + id
        const saved = await harness.post({ ...base, exercise, action: 'save', taskId: plan.tasks[0].id, attemptId,
          selfRating: 'uncertain', response: exercise === 'counterexample' ? counterexampleResponse : learnerResponse }); assert(!saved.error)
        assert.equal(saved.attempt.task.references.length, 0)
        const prediction = id === 'hidden' ? saved.attempt : (await harness.post({ ...base, action: 'reveal', attemptId, expectedVersion: 1 })).attempt
        predictions[attemptId] = prediction
        const citation = prediction.task.references.find(item => item.nodeId === 'taxi')?.citations[0]
        // The selected continuous excerpt includes the table and its condition,
        // even when the full source citation exceeds the personal 2000 limit.
        const quote = citation?.quote.slice(-1900).trim()
        for (const name of id === 'first' ? ['a', 'b'] : ['a']) {
          const response = id === 'hidden' ? feedbackResponse('reflection') : { ...feedbackResponse('reference'), sourceName: '', sourceLocator: '',
            reference: { nodeId: 'taxi', paragraph: citation.paragraph, quote } }
          const result = await harness.post({ ...base, action: 'save-result', predictionId: attemptId, expectedVersion: prediction.version,
            attemptId: attemptId + '-result-' + name, response }); assert(!result.error, JSON.stringify(result.error))
        }
      }
    }
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
    const rows = () => harness.store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()
    let recordsBefore = JSON.stringify(rows())
    for (const exercise of ['prediction', 'counterexample']) {
      const prediction = predictions[exercise + '-first'], second = predictions[exercise + '-second'], hidden = predictions[exercise + '-hidden']
      const firstId = prediction.attemptId + '-result-a', secondId = prediction.attemptId + '-result-b'
      const result = (await harness.post({ ...base, action: 'get', exercise: 'feedback', attemptId: firstId })).attempt
      const reference = result.task.reference, citation = prediction.task.references.find(item => item.nodeId === 'taxi').citations[0]
      assert.equal(reference.quote, citation.quote.slice(-1900).trim()); assert(reference.quote.length <= 2000)
      if (citation.quote.includes('\n')) assert(reference.quote.includes('\n'))
      if (variant === 'long-source') {
        assert(citation.quote.length > 2000); assert.notEqual(reference.quote, citation.quote)
        const oversized = await harness.post({ ...base, action: 'save-result', predictionId: prediction.attemptId, expectedVersion: prediction.version,
          attemptId: exercise + '-oversized-excerpt', response: { ...result.response, reference: { ...result.response.reference, quote: citation.quote.slice(0, 2001) } } })
        assert.equal(oversized.error.code, 'invalid_input'); assert.equal(JSON.stringify(rows()), recordsBefore)
      }
      const open = async (nav, extra = {}) => { const ui = mount({ ...base, revision: 1, prediction, supported: true, call: args => harness.post(args), onLocate: nav.locate, ...extra });
        uis.push(ui); await ui.settle(); await ui.choose(firstId); return ui }
      const nav = navigation(harness, fixture), ui = await open(nav)
      await ui.click('定位结果所引原文')
      const actual = nav.references[0]
      for (const key of ['documentId', 'nodeId', 'paragraph', 'sourceId', 'quote', 'origin']) assert.equal(actual[key], reference[key], key)
      assert.equal(actual.revision, result.baseRevision); assert.equal(actual.sourceQuoteOnly, true)
      assert.equal(actual.sourceCitation, undefined, 'Personal excerpts keep the generic 2000-character navigation budget')
      assert.equal(nav.pending.length, 1); nav.pending[0].resolve(); await nav.completed[0]; await ui.settle()
      // This selected tail starts later than its >2000-character source unit.
      // Locating the full frozen quote would incorrectly return paragraph 1.
      const reading = dense ? 3 : variant === 'long-source' ? 10 : 1
      assert.deepEqual(nav.nodes, ['taxi']); assert.deepEqual(nav.paragraphs, [reading]); assert(nav.changes.includes('kg-para-' + reading))
      assert(text(ui.state.tree).includes(reference.quote) && text(ui.state.tree).includes('未独立核验')); citationActions++
      if (variant === 'sparse') {
        let reviewedPrediction
        for (const transition of ['selection', 'selection-back', 'draft', 'correction', 'prediction-back', 'hidden-back', 'version', 'revision', 'unsupported-back', 'focus', 'reload', 'reload-complete', 'unmount']) {
          for (const failure of [false, true]) {
            const old = navigation(harness, fixture), holds = []; let paused = false
            const current = await open(old, { call: async args => { if (paused) { const hold = deferred(); holds.push(hold); await hold.promise } return harness.post(args) } })
            await current.click('定位结果所引原文'); assert.equal(old.pending.length, 1)
            if (transition.startsWith('selection')) { await current.choose(secondId); if (transition.endsWith('back')) await current.choose(firstId) }
            else if (transition === 'draft') { await current.click('记录新结果'); await current.fill('实际观察结果', '尚未保存的个人结果草稿') }
            else if (transition === 'correction') { await current.click('追加结果更正'); await current.fill('结果更正理由', '仍需核对的更正草稿') }
            else if (transition === 'prediction-back' || transition === 'hidden-back') { current.props.prediction = transition === 'hidden-back' ? hidden : second;
              await current.settle(); current.props.prediction = prediction; await current.settle(); await current.choose(firstId) }
            else if (transition === 'version') {
              if (!reviewedPrediction) { const beforeReview = rows(), reviewed = await harness.post({ ...base, action: 'review', attemptId: prediction.attemptId,
                expectedVersion: prediction.version, review: learnerReview }); assert(!reviewed.error); reviewedPrediction = reviewed.attempt;
                assert.equal(reviewedPrediction.version, 3); assert.deepEqual(reviewedPrediction.response, prediction.response)
                assert.deepEqual(rows().filter(row => row.attempt_id !== prediction.attemptId), beforeReview.filter(row => row.attempt_id !== prediction.attemptId))
                recordsBefore = JSON.stringify(rows()); explicitReviewVersions++ }
              current.props.prediction = (await harness.post({ ...base, action: 'get', attemptId: prediction.attemptId })).attempt; await current.settle()
            }
            else if (transition === 'revision') { current.props.revision = 2; await current.settle() }
            else if (transition === 'unsupported-back') { current.props.supported = false; await current.settle(); current.props.supported = true; await current.settle() }
            else if (transition === 'focus') { current.props.focusRequest = { resultId: secondId, nonce: 1 }; await current.settle() }
            else if (transition.startsWith('reload')) { paused = true; await current.click('重新读取验证结果');
              assert(current.buttons('定位结果所引原文').every(button => button.props.disabled))
              if (transition === 'reload-complete') { paused = false; holds.forEach(hold => hold.resolve()); await current.settle() } }
            else current.unmount()
            if (failure) old.pending[0].failure = '旧结果引文读取失败'
            old.pending[0].resolve(); await old.completed[0]; await current.settle()
            assert.deepEqual(old.changes, [], transition); assert.deepEqual(old.nodes, []); assert.deepEqual(old.paragraphs, [])
            assert(!text(current.state.tree).includes('旧结果引文读取失败'), transition)
            if (transition === 'draft') assert.equal(current.input('实际观察结果').props.value, '尚未保存的个人结果草稿')
            if (transition === 'correction') assert.equal(current.input('结果更正理由').props.value, '仍需核对的更正草稿')
            paused = false; holds.forEach(hold => hold.resolve()); await current.settle(); cancelledCases++
          }
        }
        const newest = navigation(harness, fixture), twice = await open(newest)
        await twice.click('定位结果所引原文'); await twice.click('定位结果所引原文'); newest.pending[1].resolve(); await newest.completed[1]
        newest.pending[0].failure = '更早点击失败'; newest.pending[0].resolve(); await newest.completed[0]; await twice.settle()
        assert.deepEqual(newest.nodes, ['taxi']); assert.deepEqual(newest.paragraphs, [1]); assert(!text(twice.state.tree).includes('更早点击失败'))
        const failed = navigation(harness, fixture), broken = await open(failed)
        await broken.click('定位结果所引原文'); failed.pending[0].failure = '当前原文定位失败，请重试'; failed.pending[0].resolve(); await failed.completed[0]; await broken.settle()
        assert(text(broken.state.tree).includes('当前原文定位失败，请重试') && text(broken.state.tree).includes(reference.quote))
        await broken.choose(secondId); assert(!text(broken.state.tree).includes('当前原文定位失败，请重试'))
        const blocked = navigation(harness, fixture), oldSource = await open(blocked), captured = oldSource.buttons('定位结果所引原文')[0].props.onClick
        oldSource.props.revision = 2; await oldSource.settle(); assert(oldSource.buttons('定位结果所引原文').every(button => button.props.disabled))
        owner = oldSource.state; captured(); await oldSource.settle(); assert.equal(blocked.references.length, 0)
        oldSource.props.revision = 1; oldSource.props.prediction = hidden; await oldSource.settle()
        assert.equal(oldSource.buttons('定位结果所引原文').length, 0); owner = oldSource.state; captured(); await oldSource.settle(); assert.equal(blocked.references.length, 0)
        const unavailable = await open(navigation(harness, fixture), { onLocate: undefined }); assert(unavailable.buttons('定位结果所引原文').every(button => button.props.disabled))
        // Explicit correction alone may write: retain the earlier result and
        // require the latest correction parent, without rewriting predictions.
        const correction = await open(navigation(harness, fixture), { prediction: reviewedPrediction }), beforeCorrection = rows()
        await correction.click('追加结果更正'); await correction.fill('结果更正理由', '重新核对摘录的适用前提，旧结果保留。')
        await correction.click('保存结果记录'); assert(text(correction.state.tree).includes('结果已保存'))
        const after = rows(), added = after.filter(row => !beforeCorrection.some(previous => previous.attempt_id === row.attempt_id))
        assert.equal(added.length, 1); assert.deepEqual(after.filter(row => row.attempt_id !== added[0].attempt_id), beforeCorrection)
        assert.equal(harness.store.getLearningAttempt(firstId).task.reference.quote, reference.quote)
        const stale = await harness.post({ ...base, action: 'save-result', predictionId: prediction.attemptId, expectedVersion: reviewedPrediction.version,
          attemptId: exercise + '-stale-correction', response: { ...result.response, parentResultId: firstId, revisionReason: '过时基准不能分叉。' } })
        assert.equal(stale.error.code, 'attempt_conflict'); recordsBefore = JSON.stringify(rows()); explicitCorrections++
      }
      assert.equal(JSON.stringify(rows()), recordsBefore)
    }
    for (const ui of uis) ui.unmount()
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore)
    assert.equal(JSON.stringify(rows()), recordsBefore)
  } finally { for (const ui of uis) ui.unmount(); harness.stop() }
}
console.log(JSON.stringify({ ok: true, citationActions, cancelledCases, explicitCorrections, explicitReviewVersions, actualStoredResultsAndHttp: true,
  selectedContinuousExcerptAnd2000Limit: true, sparseAndDenseTargets: true, hiddenAndOldSourcesBlocked: true,
  currentFailuresVisible: true, newerClickWins: true, draftsAndCorrectionCasPreserved: true, sourceUnchanged: true }))
