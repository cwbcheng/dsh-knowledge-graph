import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelCitationFixture, modelCitationLocator, modelCitationPanelLocationSource } from './kg-model-citation-locator-fixture.mjs'

// Real stored learning snapshots, generated component and workbench receiver.
// Node-window responses are held while the reader changes the visible snapshot.
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const component = value => value.slice(value.indexOf('function ModelUnderstandingPanel('), value.indexOf('function ModelFeedbackPanel(')).replaceAll('host.call(', 'rpc(')
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
const env = { window: { React, confirm: () => true, addEventListener() {}, removeEventListener() {} },
  console, AbortController, setTimeout, clearTimeout,
  sessionStorage: { getItem: key => owner.storage.get(key), setItem: (key, value) => owner.storage.set(key, value), removeItem: key => owner.storage.delete(key) },
  documentIdOfGraph: graph => graph?.source?.documentId }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), env)
runInNewContext(source.slice(source.indexOf('function exactSourceQuoteTarget('), source.indexOf('function KnowledgeConsumePanel(')) + '\nthis.target=exactSourceQuoteTarget', env)
const makeView = env.window.KGViewer.makeView
const all = (node, predicate) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, predicate)) : !node || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const response = (mapping, parentAttemptId = '') => ({ inputs: '本次行程距离', mapping, outputs: '费用', conditions: '白天、无附加收费',
  boundary: '不能外推到夜间；未独立验证', questions: '条件是否充分？', revisionReason: parentAttemptId ? '对照后仍有疑问' : '', parentAttemptId, practiceIds: [] })
const mount = (harness, onLocate) => {
  const state = { slots: [], updates: [], effects: [], storage: new Map(), tree: null }, requests = []
  const props = { documentId: harness.document.documentId, modelId: 'taxi', revision: 1, active: true, onLocate,
    call: args => { requests.push(args); return harness.post(args) } }
  let mounted = true
  const render = () => {
    for (let count = 0; count < 30; count++) {
      owner = state; state.updates.splice(0).forEach(fn => fn()); cursor = 0
      state.tree = env.window.KGViewer.ModelUnderstandingPanel(props); state.effects.splice(0).forEach(fn => fn())
      if (!state.updates.length) return
    }
    throw new Error('Component update loop')
  }
  const settle = async () => { for (let count = 0; count < 12; count++) { await new Promise(done => setImmediate(done)); if (mounted) render() } }
  const click = async label => {
    owner = state
    const button = all(state.tree, item => item.type === 'button' && (text(item) === label || item.props['aria-label'] === label))[0]
    assert(button, 'Missing ' + label); assert(!button.props.disabled); button.props.onClick(); await settle()
  }
  const history = async index => {
    owner = state
    const list = all(state.tree, item => item.props.className === 'kg-learning-history')[0]
    const button = all(list, item => item.type === 'button')[index]; assert(button && !button.props.disabled)
    button.props.onClick(); await settle()
  }
  const unmount = () => { mounted = false; for (const item of state.slots) item.cleanup?.() }
  render(); return { state, props, requests, render, settle, click, history, unmount }
}
const navigation = (harness, fixture, target) => {
  const loads = [], nodes = [], paragraphs = [], changes = [], references = [], pending = [], completed = []
  const outside = makeView({ ...harness.store.getDocument(fixture.documentId), nodes: [], edges: [] }, fixture.sourceText)
  const context = { resultView: outside, fullText: fixture.sourceText, currentResultRef: { current: outside },
    paragraphLocateSeqRef: { current: 0 }, graphRevisionRef: { current: 1 }, graphCommitQueueRef: { current: Promise.resolve() },
    documentIdOfGraph: env.documentIdOfGraph, exactSourceQuoteTarget: env.target, makeView,
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
  return { loads, nodes, paragraphs, changes, references, pending, completed, target,
    locate: (reference, stillCurrent = () => true) => {
      references.push(reference)
      const result = receiver(reference, stillCurrent); completed.push(result.then(() => true, () => false)); return result
    } }
}
let cancelledCases = 0, citationActions = 0
for (const variant of ['sparse', 'dense', 'long']) {
  const dense = variant === 'dense', fixture = modelCitationFixture({ dense, anchor: dense ? 2 : 1, long: variant === 'long' })
  const harness = await modelLearningHarness({ fixture }), uis = []
  try {
    const base = { documentId: fixture.documentId, modelId: 'taxi', exercise: 'understanding', expectedRevision: 1 }
    const plan = await harness.post({ ...base, action: 'plan' }); assert(!plan.error)
    const original = plan.tasks[0].references[0].citations[0]
    assert.equal(original.quote, fixture.sourceUnits[dense ? 2 : 1].text, 'Host retains newlines and complete qualifiers')
    const first = await harness.post({ ...base, action: 'save', taskId: plan.tasks[0].id, attemptId: 'first',
      selfRating: 'not_assessed', response: response('第一份个人表述，不是正式事实') }); assert(!first.error)
    const second = await harness.post({ ...base, action: 'save', taskId: plan.tasks[0].id, attemptId: 'second',
      selfRating: 'not_assessed', response: response('修订后的个人表述，仍未判定掌握', 'first') }); assert(!second.error)
    assert.equal(second.attempt.task.references[0].citations[0].quote, original.quote, 'Stored snapshots retain the exact quote')
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
    const attemptsBefore = JSON.stringify(harness.store.listLearningAttempts(fixture.documentId, 'taxi', 'understanding'))
    const open = async nav => { const ui = mount(harness, nav.locate); uis.push(ui); await ui.settle(); return ui }
    const clickCitation = ui => ui.click('定位原文')
    const nav = navigation(harness, fixture, dense ? 3 : 1), ui = await open(nav)
    await clickCitation(ui)
    const actual = nav.references[0]
    assert.equal(actual.documentId, fixture.documentId); assert.equal(actual.revision, 1)
    assert.equal(actual.paragraph, original.paragraph); assert.equal(actual.nodeId, 'taxi')
    assert.equal(actual.sourceId, original.sourceId); assert.equal(actual.quote, original.quote)
    assert.equal(actual.sourceQuoteOnly, true); assert.equal(actual.sourceCitation, true)
    assert.equal(nav.pending.length, 1); nav.pending[0].resolve(); await nav.completed[0]; await ui.settle()
    assert.deepEqual(nav.nodes, ['taxi']); assert.deepEqual(nav.paragraphs, [nav.target]); assert(nav.changes.includes('kg-para-' + nav.target))
    citationActions++
    await ui.click('修订这份理解')
    const field = all(ui.state.tree, item => item.type === 'textarea' && item.props['aria-label'] === '我的联结规律')[0]
    owner = ui.state; field.props.onChange({ target: { value: '仍须核对的个人草稿' } }); await ui.settle()
    const draftBefore = JSON.stringify([...ui.state.storage])
    await clickCitation(ui); nav.pending[1].resolve(); await nav.completed[1]; await ui.settle()
    assert.equal(JSON.stringify([...ui.state.storage]), draftBefore, 'Reading evidence does not save, discard or rewrite a personal draft')
    assert(!ui.requests.some(request => request.action === 'save')); citationActions++
    if (variant === 'sparse') {
      for (const transition of ['reload', 'history', 'history-back', 'revision', 'document', 'model', 'hide-back', 'unmount', 'revise', 'draft-back']) {
        for (const failure of [false, true]) {
          const nav = navigation(harness, fixture, 1), ui = await open(nav)
          await clickCitation(ui); assert.equal(nav.pending.length, 1)
          if (transition === 'reload') await ui.click('重新读取个人表述')
          else if (transition.startsWith('history')) { await ui.history(1); if (transition.endsWith('back')) await ui.history(0) }
          else if (transition === 'revision') { ui.props.revision = 2; await ui.settle() }
          else if (transition === 'document') { ui.props.documentId = 'foreign'; await ui.settle() }
          else if (transition === 'model') { ui.props.modelId = 'taxi-peer'; await ui.settle() }
          else if (transition === 'hide-back') { ui.props.active = false; await ui.settle(); ui.props.active = true; await ui.settle() }
          else if (transition === 'unmount') ui.unmount()
          else { await ui.click('修订这份理解'); if (transition === 'draft-back') await ui.click('放弃草稿') }
          if (failure) nav.pending[0].failure = '旧快照窗口读取失败'
          nav.pending[0].resolve(); await nav.completed[0]; await ui.settle()
          assert.deepEqual(nav.nodes, [], 'Understanding ' + transition + ' must discard old navigation')
          assert.deepEqual(nav.paragraphs, []); assert.deepEqual(nav.changes, [])
          assert(!text(ui.state.tree).includes('旧快照窗口读取失败')); assert(!text(ui.state.tree).includes('旧定位已取消'))
          cancelledCases++
        }
      }
      const newer = navigation(harness, fixture, 1), fresh = await open(newer)
      await clickCitation(fresh); await clickCitation(fresh)
      newer.pending[1].resolve(); await newer.completed[1]; newer.pending[0].resolve(); await newer.completed[0]; await fresh.settle()
      assert.deepEqual(newer.nodes, ['taxi']); assert.deepEqual(newer.paragraphs, [1])
      const failed = navigation(harness, fixture, 1), broken = await open(failed)
      await clickCitation(broken); failed.pending[0].failure = '当前窗口读取失败，请重试'; failed.pending[0].resolve(); await failed.completed[0]; await broken.settle()
      assert(text(broken.state.tree).includes('当前窗口读取失败，请重试') && text(broken.state.tree).includes(original.quote))
      const old = navigation(harness, fixture, 1), historic = await open(old)
      historic.props.revision = 2; await historic.settle()
      const disabled = all(historic.state.tree, item => item.type === 'button' && text(item) === '定位原文')
      assert(disabled.length && disabled.every(button => button.props.disabled))
      owner = historic.state; disabled[0].props.onClick(); await historic.settle()
      assert.equal(old.references.length, 0, 'Even an old callback cannot locate a snapshot from a different source version')
    }
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore)
    assert.equal(JSON.stringify(harness.store.listLearningAttempts(fixture.documentId, 'taxi', 'understanding')), attemptsBefore)
    assert(uis.every(ui => !ui.requests.some(request => !['plan', 'attempts', 'get'].includes(request.action))))
  } finally { for (const ui of uis) ui.unmount(); harness.stop() }
}
console.log(JSON.stringify({ ok: true, citationActions, cancelledCases, actualStoredSnapshotsAndHttp: true,
  currentAndDraftCitationsExact: true, fullNewlinesAndLongQuote: true, sparseAndDenseTargets: true,
  oldSnapshotDisabled: true, newerClickWins: true, currentFailuresVisible: true, personalDraftAndRecordsUnchanged: true }))
