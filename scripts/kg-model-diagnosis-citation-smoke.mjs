import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness, learnerResponse, learnerReview } from './kg-model-learning-fixture-data.mjs'
import { feedbackResponse } from './kg-model-feedback-fixture-data.mjs'
import { modelCitationFixture, modelCitationLocator, modelCitationPanelLocationSource } from './kg-model-citation-locator-fixture.mjs'

// Real saved/revealed predictions and results; hold the actual node-window route
// while changing the diagnosis or the parent result selection.
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const components = value => value.slice(value.indexOf('function ModelDiagnosisMaterials('), value.indexOf('function ModelLearningPanel(')).replaceAll('host.call(', 'rpc(')
for (const path of ['../lib/client.js', '../extension/viewer.js']) assert.equal(components(source), components(readFileSync(new URL(path, import.meta.url), 'utf8')))
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
const env = { window: { React, confirm: () => true, addEventListener() {}, removeEventListener() {} },
  console, AbortController, setTimeout, clearTimeout,
  sessionStorage: { getItem: key => owner.storage.get(key), setItem: (key, value) => owner.storage.set(key, value), removeItem: key => owner.storage.delete(key) },
  documentIdOfGraph: graph => graph?.source?.documentId }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), env)
runInNewContext(source.slice(source.indexOf('function exactSourceQuoteTarget('), source.indexOf('function KnowledgeConsumePanel(')) + '\nthis.target=exactSourceQuoteTarget', env)
const viewer = env.window.KGViewer
const all = (node, predicate) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, predicate)) : !node || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function mount(name, props) {
  const state = { slots: [], updates: [], effects: [], storage: new Map(), tree: null }
  let mounted = true
  const render = () => {
    for (let count = 0; count < 30; count++) {
      owner = state; state.updates.splice(0).forEach(fn => fn()); cursor = 0
      state.tree = viewer[name](props); state.effects.splice(0).forEach(fn => fn())
      if (!state.updates.length) return
    }
    throw new Error('Component update loop')
  }
  const settle = async () => { for (let count = 0; count < 12; count++) { await new Promise(done => setImmediate(done)); if (mounted) render() } }
  const buttons = label => all(state.tree, item => item.type === 'button' && (text(item) === label || item.props['aria-label'] === label))
  const click = async (label, index = 0) => {
    const button = buttons(label)[index]; assert(button, 'Missing ' + label); assert(!button.props.disabled)
    owner = state; button.props.onClick(); await settle()
  }
  const unmount = () => { mounted = false; for (const item of state.slots) item.cleanup?.() }
  render(); return { state, props, render, settle, buttons, click, unmount }
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
    document: { getElementById: id => ({ id }) }, scrollElIntoCenter: element => changes.push(element.id) }
  context.locateConsumptionReference = modelCitationLocator(context)
  context.changeReadMode = value => changes.push('read-mode:' + value)
  const receiver = new Function(...Object.keys(context), 'return ' + modelCitationPanelLocationSource())(...Object.values(context))
  return { loads, nodes, paragraphs, changes, references, pending, completed,
    locate: (reference, stillCurrent = () => true) => {
      references.push(reference)
      const result = receiver(reference, stillCurrent); completed.push(result.then(() => true, () => false)); return result
    } }
}
let citationActions = 0, cancelledCases = 0, parentCases = 0
for (const variant of ['sparse', 'dense', 'long']) {
  const dense = variant === 'dense', fixture = modelCitationFixture({ dense, anchor: dense ? 2 : 1, long: variant === 'long' })
  const harness = await modelLearningHarness({ fixture }), uis = []
  try {
    const base = { documentId: fixture.documentId, modelId: 'taxi', expectedRevision: 1 }
    const plan = await harness.post({ ...base, action: 'plan' }); assert(!plan.error)
    const saved = await harness.post({ ...base, action: 'save', taskId: plan.tasks[0].id, attemptId: 'first', selfRating: 'uncertain', response: learnerResponse })
    assert(!saved.error); assert.equal(saved.attempt.task.references.length, 0, 'Unrevealed route hides source references')
    const first = (await harness.post({ ...base, action: 'reveal', attemptId: 'first', expectedVersion: 1 })).attempt
    const secondSave = await harness.post({ ...base, action: 'save', taskId: plan.tasks[0].id, attemptId: 'second', selfRating: 'uncertain', response: learnerResponse })
    assert(!secondSave.error)
    const second = (await harness.post({ ...base, action: 'reveal', attemptId: 'second', expectedVersion: 1 })).attempt
    for (const attemptId of ['result-first', 'result-second']) {
      const result = await harness.post({ ...base, action: 'save-result', attemptId, predictionId: 'first', expectedVersion: first.version,
        response: { ...feedbackResponse('reflection'), diagnosis: 'mapping', content: attemptId + ' · 个人诊断，尚未核验' } }); assert(!result.error)
    }
    const reviewed = await harness.post({ ...base, action: 'review', attemptId: 'first', expectedVersion: first.version, review: learnerReview })
    assert(!reviewed.error)
    const original = first.task.references.find(item => item.nodeId === 'taxi').citations[0]
    assert.equal(original.quote, fixture.sourceUnits[dense ? 2 : 1].text, 'Full source includes newlines and qualifiers')
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
    const attemptsBefore = JSON.stringify(harness.store.listLearningAttempts(fixture.documentId, 'taxi'))
    const open = async (nav, props = {}) => { const ui = mount('ModelDiagnosisMaterials', { prediction: first, diagnosis: 'mapping', revision: 1, onLocate: nav.locate, ...props });
      uis.push(ui); await ui.settle(); return ui }
    const clickCitation = ui => ui.click('对照材料原文')
    for (const diagnosis of ['mapping', 'input']) {
      const nav = navigation(harness, fixture), ui = await open(nav, { diagnosis })
      await clickCitation(ui)
      const expectedNode = diagnosis === 'input' ? 'distance' : 'taxi', actual = nav.references[0]
      assert.equal(actual.documentId, fixture.documentId); assert.equal(actual.revision, 1)
      assert.equal(actual.paragraph, original.paragraph); assert.equal(actual.nodeId, expectedNode)
      assert.equal(actual.sourceId, original.sourceId); assert.equal(actual.quote, original.quote)
      assert.equal(actual.sourceQuoteOnly, true); assert.equal(actual.sourceCitation, true)
      assert.equal(nav.pending.length, 1); nav.pending[0].resolve(); await nav.completed[0]; await ui.settle()
      assert.deepEqual(nav.nodes, [expectedNode]); assert.deepEqual(nav.paragraphs, [dense ? 3 : 1])
      assert(nav.changes.includes('kg-para-' + (dense ? 3 : 1))); citationActions++
    }
    if (variant === 'sparse') {
      for (const transition of ['diagnosis', 'diagnosis-back', 'prediction', 'prediction-back', 'version', 'revision', 'hidden-back', 'inactive-back', 'unmount']) {
        for (const failure of [false, true]) {
          const nav = navigation(harness, fixture), ui = await open(nav)
          await clickCitation(ui); assert.equal(nav.pending.length, 1)
          if (transition.startsWith('diagnosis')) { ui.props.diagnosis = 'input'; await ui.settle(); if (transition.endsWith('back')) ui.props.diagnosis = 'mapping' }
          else if (transition.startsWith('prediction')) { ui.props.prediction = second; await ui.settle(); if (transition.endsWith('back')) ui.props.prediction = first }
          else if (transition === 'version') ui.props.prediction = reviewed.attempt
          else if (transition === 'revision') ui.props.revision = 2
          else if (transition === 'hidden-back') { ui.props.prediction = saved.attempt; await ui.settle(); ui.props.prediction = first }
          else if (transition === 'inactive-back') { ui.props.active = false; await ui.settle(); ui.props.active = true }
          else ui.unmount()
          await ui.settle(); if (failure) nav.pending[0].failure = '旧诊断窗口读取失败'
          nav.pending[0].resolve(); await nav.completed[0]; await ui.settle()
          assert.deepEqual(nav.nodes, [], transition); assert.deepEqual(nav.paragraphs, []); assert.deepEqual(nav.changes, [])
          assert(!text(ui.state.tree).includes('旧诊断窗口读取失败')); cancelledCases++
        }
      }
      for (const transition of ['result', 'result-back', 'reload', 'reload-complete', 'focus', 'unsupported']) {
        for (const failure of [false, true]) {
          const nav = navigation(harness, fixture), holds = []
          let paused = false
          const parent = mount('ModelFeedbackPanel', { ...base, revision: 1, prediction: first, supported: true, onLocate: nav.locate,
            focusRequest: { resultId: 'result-first', nonce: 1 }, call: async args => { if (paused) { const hold = deferred(); holds.push(hold); await hold.promise } return harness.post(args) } })
          uis.push(parent); await parent.settle(); await parent.click('查看诊断对应材料')
          const materialProps = () => all(parent.state.tree, item => item.type === viewer.ModelDiagnosisMaterials)[0]?.props
          assert(materialProps()); assert.equal(materialProps().onLocate, nav.locate, 'Learning/result adapters preserve the caller predicate')
          const child = await open(nav, materialProps()); await clickCitation(child)
          if (transition.startsWith('result')) {
            const choose = async id => {
              owner = parent.state
              const button = all(parent.state.tree, item => item.type === 'button' && item.props.key === id)[0]; assert(button); button.props.onClick(); await parent.settle()
              Object.assign(child.props, materialProps()); await child.settle()
            }
            await choose('result-second'); if (transition.endsWith('back')) await choose('result-first')
          } else {
            paused = true
            if (transition.startsWith('reload')) await parent.click('重新读取验证结果')
            else if (transition === 'focus') { parent.props.focusRequest = { resultId: 'result-second', nonce: 2 }; await parent.settle() }
            else { parent.props.supported = false; await parent.settle() }
            Object.assign(child.props, materialProps()); await child.settle()
            if (transition === 'reload-complete') { paused = false; holds.forEach(hold => hold.resolve()); await parent.settle(); Object.assign(child.props, materialProps()); await child.settle() }
          }
          if (failure) nav.pending[0].failure = '旧结果窗口读取失败'
          nav.pending[0].resolve(); await nav.completed[0]; await child.settle()
          assert.deepEqual(nav.changes, [], 'Parent ' + transition); assert.deepEqual(nav.nodes, []); assert.deepEqual(nav.paragraphs, [])
          assert(!text(child.state.tree).includes('旧结果窗口读取失败')); parentCases++
          paused = false; holds.forEach(hold => hold.resolve()); await parent.settle()
        }
      }
      const newer = navigation(harness, fixture), fresh = await open(newer)
      await clickCitation(fresh); await clickCitation(fresh)
      newer.pending[1].resolve(); await newer.completed[1]; newer.pending[0].resolve(); await newer.completed[0]; await fresh.settle()
      assert.deepEqual(newer.nodes, ['taxi']); assert.deepEqual(newer.paragraphs, [1])
      const failed = navigation(harness, fixture), broken = await open(failed)
      await clickCitation(broken); failed.pending[0].failure = '当前诊断窗口读取失败，请重试'; failed.pending[0].resolve(); await failed.completed[0]; await broken.settle()
      assert(text(broken.state.tree).includes('当前诊断窗口读取失败，请重试') && text(broken.state.tree).includes(original.quote))
      broken.props.diagnosis = 'input'; await broken.settle(); assert(!text(broken.state.tree).includes('当前诊断窗口读取失败，请重试'))
      const historic = await open(navigation(harness, fixture), { revision: 2 })
      assert(historic.buttons('对照材料原文').length && historic.buttons('对照材料原文').every(button => button.props.disabled))
      const blocked = navigation(harness, fixture), old = await open(blocked)
      const callback = old.buttons('对照材料原文')[0].props.onClick
      old.props.prediction = saved.attempt; await old.settle(); assert.equal(old.buttons('对照材料原文').length, 0)
      owner = old.state; callback(); await old.settle(); assert.equal(blocked.references.length, 0, 'Hidden snapshots reject prior callbacks')
      old.props.prediction = first; old.props.revision = 2; await old.settle()
      owner = old.state; old.buttons('对照材料原文')[0].props.onClick(); await old.settle(); assert.equal(blocked.references.length, 0, 'Old source callbacks are also disabled')
      const linked = [], linking = await open(navigation(harness, fixture), { onUnderstanding: value => linked.push(value) })
      await linking.click('带这次预测修订我的理解'); assert.equal(linked[0], first, 'Linking retains the explicit prediction identity')
    }
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore)
    assert.equal(JSON.stringify(harness.store.listLearningAttempts(fixture.documentId, 'taxi')), attemptsBefore)
  } finally { for (const ui of uis) ui.unmount(); harness.stop() }
}
console.log(JSON.stringify({ ok: true, citationActions, cancelledCases, parentCases, actualStoredPredictionSnapshotsAndHttp: true,
  fullNewlinesAndLongQuote: true, sparseAndDenseTargets: true, hiddenAndOldSnapshotsBlocked: true,
  newerClickWins: true, currentFailuresVisible: true, sourceAndLearningRecordsUnchanged: true, explicitUnderstandingLinkPreserved: true }))
