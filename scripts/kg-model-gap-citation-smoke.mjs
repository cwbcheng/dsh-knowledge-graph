import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelCitationFixture, modelCitationLocator, modelCitationPanelLocationSource } from './kg-model-citation-locator-fixture.mjs'

// First assertion is a genuine Host regression: the old gap lost its quote.
const contract = createGraphContract(), sample = modelCitationFixture({ legacyGaps: true })
const request = { documentId: sample.documentId, expectedRevision: 1, modelId: 'taxi', diagnosis: true }
const first = contract.connectionModels(sample, request).diagnosis.items.find(item => item.code === 'legacy_port')
assert.equal(first.citations?.[0]?.quote, sample.sourceUnits[1].text, 'Legacy gaps must retain the actual recorded citation, including its conditions')

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const component = value => value.slice(value.indexOf('function ModelGapList('), value.indexOf('// >>> GENERATED TARGET MAP TOOLS >>>')).replaceAll('host.call(', 'rpc(')
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
const env = { window: { React, confirm: () => true }, console, AbortController,
  sessionStorage: { getItem: key => owner.storage.get(key), setItem: (key, value) => owner.storage.set(key, value), removeItem: key => owner.storage.delete(key) },
  documentIdOfGraph: graph => graph?.source?.documentId, setTimeout: () => 1, clearTimeout() {} }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), env)
runInNewContext(source.slice(source.indexOf('function exactSourceQuoteTarget('), source.indexOf('function KnowledgeConsumePanel(')) + '\nthis.target=exactSourceQuoteTarget', env)
const panelStart = source.indexOf('const locateInDetail =', source.indexOf('function ConnectionModelPanel('))
const panelRelay = source.slice(panelStart + 'const locateInDetail ='.length, source.indexOf('\n        const sequence', panelStart)).trim()
const locationEnv = { ...env, useRef: React.useRef, useEffect: React.useEffect }
runInNewContext(source.slice(source.indexOf('function useConnectionModelLocation('), source.indexOf('function ConnectionModelPanel('))
  + '\nthis.locationHook=useConnectionModelLocation', locationEnv)
const viewer = env.window.KGViewer
const all = (node, predicate) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, predicate)) : !node || typeof node !== 'object' ? []
  : node.type === viewer.ModelGapList ? all(viewer.ModelGapList(node.props), predicate)
    : [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function mount(Component, props) {
  const state = { slots: [], updates: [], effects: [], storage: new Map(), tree: null }; let mounted = true
  const render = () => {
    for (let count = 0; count < 30; count++) {
      owner = state; state.updates.splice(0).forEach(fn => fn()); cursor = 0
      state.tree = Component(props); state.effects.splice(0).forEach(fn => fn()); if (!state.updates.length) return
    }
    throw new Error('Component update loop')
  }
  const settle = async () => { for (let count = 0; count < 12; count++) { await new Promise(setImmediate); if (mounted) render() } }
  const buttons = label => { owner = state; return all(state.tree, node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label)) }
  const click = async label => { const button = buttons(label)[0]; assert(button && !button.props.disabled, label); owner = state;
    button.props.onClick(); await settle() }
  const unmount = () => { mounted = false; state.slots.forEach(item => item.cleanup?.()) }
  render(); return { state, props, settle, buttons, click, unmount }
}
function navigation(harness, fixture, readingSource = fixture.sourceText) {
  const references = [], paragraphs = [], changes = [], pending = [], completed = []
  const view = viewer.makeView(harness.store.getDocument(fixture.documentId), readingSource)
  const context = { resultView: view, fullText: fixture.sourceText, currentResultRef: { current: view }, graphRevisionRef: { current: 1 },
    paragraphLocateSeqRef: { current: 0 }, graphCommitQueueRef: { current: Promise.resolve() }, documentIdOfGraph: env.documentIdOfGraph,
    exactSourceQuoteTarget: env.target, makeView: viewer.makeView, loadGraphDocument: () => assert.fail('A gap citation must not invent a node window'),
    setResultView: value => changes.push(value), setContentScope: value => changes.push(value), navigateWorkspace: value => changes.push(value),
    setChapterFilter: value => changes.push(value), chapterSectionsOf: graph => graph.source.sections || [], graphViewMetadata: () => null,
    setGraphQueryDraft() {}, setGraphPageDraft() {}, setSelectedNodeId: () => assert.fail('Checking a legacy quote does not establish a node role'), setSelectedEdgeId() {}, setFocusReq() {},
    setActivePara: value => paragraphs.push(value), setFlashPara() {}, ctx: { timeout: fn => fn() }, document: { getElementById: id => ({ id }) },
    scrollElIntoCenter: element => changes.push(element.id), changeReadMode: value => changes.push(value) }
  context.locateConsumptionReference = modelCitationLocator(context)
  const receiver = new Function(...Object.keys(context), 'return ' + modelCitationPanelLocationSource())(...Object.values(context))
  let paused = false
  return { references, paragraphs, changes, pending, completed, pause: () => { paused = true }, resume: () => { paused = false },
    locate(reference, stillCurrent = () => true) {
      references.push(reference)
      const result = (async () => { if (paused) { const hold = deferred(); pending.push(hold); await hold.promise; if (hold.failure) throw new Error(hold.failure) }
        return receiver(reference, stillCurrent) })()
      completed.push(result.then(() => true, () => false)); return result
    } }
}
let citations = 0, cancelledCases = 0
for (const variant of ['sparse', 'dense', 'long-source']) {
  const dense = variant === 'dense', fixture = modelCitationFixture({ dense, anchor: dense ? 2 : 1, long: variant === 'long-source', legacyGaps: true, gapPages: !dense })
  const harness = await modelLearningHarness({ fixture }), uis = []
  try {
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
    const records = () => JSON.stringify(harness.store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()), recordsBefore = records()
    const load = args => harness.post(args, 'connection-models'), writes = []
    async function open(nav, editor = false, extras = {}) {
      const boundary = mount(() => {
        const location = locationEnv.locationHook('gap-parent', true)
        return new Function('location', 'api', 'setDetailError', 'return ' + panelRelay)(location, { current: { onLocate: nav.locate } },
          () => assert.fail('The nested gap caller must display its own current error'))
      }, {})
      uis.push(boundary)
      const ui = mount(editor ? viewer.ModelStructureEditor : viewer.ModelGapPanel, { documentId: fixture.documentId, revision: 1, modelId: 'taxi', active: true,
        load, onCommit: args => writes.push(args), onLocate: boundary.state.tree, busy: false, ...extras })
      uis.push(ui); await ui.settle(); return ui
    }
    const response = await load({ ...request, documentId: fixture.documentId }), gap = response.diagnosis.items.find(item => item.code === 'legacy_port')
    const unit = fixture.sourceUnits[dense ? 2 : 1], label = '核对原文 P' + (unit.paragraph + 1)
    assert.equal(gap.citationBasis, 'stored_relation_context'); assert.equal(gap.citations[0].quote, unit.text)
    assert.equal(gap.citations[0].documentId, fixture.documentId); assert.equal(gap.citations[0].revision, 1)
    assert.equal(gap.citations[0].sourceId, fixture.graph.source.id); assert.equal(gap.citations[0].chunkId, null)
    for (const editor of [false, true]) {
      const nav = navigation(harness, fixture), ui = await open(nav, editor)
      await ui.click(label); await nav.completed[0]; await ui.settle()
      const ref = nav.references[0]; assert.equal(ref.documentId, fixture.documentId); assert.equal(ref.revision, 1)
      assert.equal(ref.sourceId, fixture.graph.source.id); assert.equal(ref.quote, unit.text); assert.equal(ref.paragraph, unit.paragraph)
      assert.equal(ref.sourceQuoteOnly, true); assert.equal(ref.sourceCitation, true); assert.equal(ref.nodeId, undefined)
      assert.deepEqual(nav.paragraphs, [dense ? 3 : 1]); assert.equal(writes.length, 0); citations++
    }
    if (variant === 'sparse') for (const editor of [false, true]) {
      const transitions = editor ? ['page', 'page-back', 'busy', 'busy-back', 'section', 'draft', 'document', 'revision', 'model', 'active', 'unmount']
        : ['page', 'page-back', 'reload', 'reload-complete', 'busy', 'busy-back', 'document', 'revision', 'model', 'active', 'unmount']
      for (const transition of transitions) for (const failure of [false, true]) {
        const nav = navigation(harness, fixture), reads = []; let holdReads = false
        const ui = await open(nav, editor, { load: async args => { if (holdReads) { const hold = deferred(); reads.push(hold); await hold.promise } return load(args) } })
        nav.pause(); await ui.click(label); assert.equal(nav.pending.length, 1)
        if (transition.startsWith('page')) { await ui.click(editor ? '下一页草稿待补充内容' : '下一页待补充内容')
          if (transition.endsWith('back')) await ui.click(editor ? '上一页草稿待补充内容' : '上一页待补充内容') }
        else if (transition.startsWith('reload')) { holdReads = true; await ui.click('刷新待补充内容'); assert.equal(ui.buttons(label).length, 0)
          if (transition === 'reload-complete') { holdReads = false; reads.forEach(hold => hold.resolve()); await ui.settle() } }
        else if (transition.startsWith('busy')) { ui.props.busy = true; await ui.settle(); if (transition.endsWith('back')) { ui.props.busy = false; await ui.settle() } }
        else if (transition === 'section') await ui.click('条件分支 (1)')
        else if (transition === 'draft') { owner = ui.state; const select = all(ui.state.tree, node => node.props['aria-label'] === '模型内容性质')[0];
          select.props.onChange({ target: { value: 'hypothesis' } }); await ui.settle() }
        else if (transition === 'active') { ui.props.active = false; await ui.settle() }
        else if (transition === 'unmount') ui.unmount()
        else { ui.props[transition === 'document' ? 'documentId' : transition === 'model' ? 'modelId' : 'revision'] = transition === 'revision' ? 2 : 'other'; await ui.settle() }
        if (failure) nav.pending[0].failure = '旧缺口定位失败'
        nav.pending[0].resolve(); await nav.completed[0]; await ui.settle()
        assert.deepEqual(nav.paragraphs, [], (editor ? 'draft:' : 'saved:') + transition); assert.deepEqual(nav.changes, [], transition)
        assert(!text(ui.state.tree).includes('旧缺口定位失败'), transition); cancelledCases++
        holdReads = false; reads.forEach(hold => hold.resolve()); await ui.settle()
      }
      const latest = navigation(harness, fixture), twice = await open(latest, editor); latest.pause()
      await twice.click(label); await twice.click('核对原文 P1')
      latest.pending[1].resolve(); await latest.completed[1]; latest.pending[0].failure = '更早缺口定位失败'; latest.pending[0].resolve(); await latest.completed[0]; await twice.settle()
      assert.deepEqual(latest.paragraphs, [0]); assert(!text(twice.state.tree).includes('更早缺口定位失败'))
      const failed = navigation(harness, fixture), broken = await open(failed, editor); failed.pause()
      await broken.click(label); failed.pending[0].failure = '当前缺口定位失败，请重试'; failed.pending[0].resolve(); await failed.completed[0]; await broken.settle()
      assert(text(broken.state.tree).includes('当前缺口定位失败，请重试'))
      failed.resume(); await broken.click(label); await failed.completed[1]; await broken.settle()
      assert(!text(broken.state.tree).includes('当前缺口定位失败，请重试')); assert.deepEqual(failed.paragraphs, [1])
      for (const mismatch of ['missing', 'duplicate']) {
        const sourceText = mismatch === 'missing' ? fixture.sourceText.replace(unit.text, '原文片段已变化') : fixture.sourceText + '\n\n' + unit.text
        const exact = navigation(harness, fixture, sourceText), rejected = await open(exact, editor)
        await rejected.click(label); await exact.completed[0]; await rejected.settle()
        assert.deepEqual(exact.paragraphs, []); assert.deepEqual(exact.changes, [])
        assert(text(rejected.state.tree).includes(mismatch === 'missing' ? '没有逐字匹配' : '多个相同片段'))
      }
      const blocked = navigation(harness, fixture), disabled = await open(blocked, editor), callback = disabled.buttons(label)[0].props.onClick
      disabled.props.busy = true; await disabled.settle(); assert(disabled.buttons(label)[0].props.disabled)
      owner = disabled.state; callback(); await disabled.settle(); assert.equal(blocked.references.length, 0)
    }
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore); assert.equal(records(), recordsBefore)
    assert.equal(writes.length, 0)
  } finally { uis.forEach(ui => ui.unmount()); harness.stop() }
}
// Never replace a missing/mismatched relation quote with a model-name guess.
for (const bad of ['missing', 'foreign-document', 'foreign-source', 'wrong-quote']) {
  const fixture = modelCitationFixture({ legacyGaps: true }), edge = fixture.graph.edges[0], node = fixture.graph.nodes.find(node => node.id === 'distance')
  edge.evidence = [{ ...edge.evidence[0] }]; delete node.quote; node.evidence = []
  if (bad === 'missing') edge.evidence = []
  if (bad === 'foreign-document') edge.evidence[0].documentId = 'other'
  if (bad === 'foreign-source') edge.evidence[0].sourceId = 'other'
  if (bad === 'wrong-quote') edge.evidence[0].quote = '费用必然成立'
  const gap = contract.connectionModels(fixture, request).diagnosis.items.find(item => item.code === 'legacy_port')
  assert.equal(gap.citations.length, 0, bad)
  const list = viewer.ModelGapList({ report: { counts: {}, origins: {}, items: [gap], total: 1 }, documentId: fixture.documentId, revision: 1,
    onLocate: () => assert.fail('Missing exact context must not navigate'), busy: false })
  assert.equal(all(list, node => node.type === 'button').length, 0); assert(text(list).includes('没有可定位的逐字引用'))
}
const fallback = modelCitationFixture({ legacyGaps: true }); fallback.graph.edges[0].evidence = []
const fallbackGap = contract.connectionModels(fallback, request).diagnosis.items.find(item => item.code === 'legacy_port')
assert.equal(fallbackGap.citationBasis, 'stored_endpoint_context'); assert.equal(fallbackGap.citations[0].quote, fallback.sourceUnits[1].text)
const multiple = modelCitationFixture({ legacyGaps: true }), second = multiple.sourceUnits[2]
multiple.graph.edges[0].evidence.push({ documentId: multiple.documentId, sourceId: multiple.graph.source.id, paragraph: second.paragraph, quote: second.text })
multiple.graph.staging = { chunks: [{ startParagraph: 7, endParagraph: 7, sourceId: multiple.graph.source.id, chunkId: 'retained-source-chunk' }] }
const multipleGap = contract.connectionModels(multiple, request).diagnosis.items.find(item => item.code === 'legacy_port')
assert.equal(multipleGap.citations.length, 2); assert.equal(multipleGap.citations[0].chunkId, 'retained-source-chunk')
assert.equal(multipleGap.citations[1].quote, second.text)
for (const field of ['documentId', 'revision', 'paragraph', 'quote']) {
  const invalid = structuredClone(multipleGap); invalid.citations = [invalid.citations[0]]
  invalid.citations[0][field] = { documentId: 'foreign', revision: 2, paragraph: -1, quote: '' }[field]
  const list = viewer.ModelGapList({ report: { counts: {}, origins: {}, items: [invalid], total: 1 }, documentId: multiple.documentId, revision: 1,
    onLocate: () => assert.fail('Malformed citation must stay disabled'), busy: false })
  const button = all(list, node => node.type === 'button')[0]; assert(button.props.disabled); button.props.onClick()
}
console.log(JSON.stringify({ ok: true, citations, cancelledCases, actualHttpAndSqlite: true, savedAndDraftGapEntries: true,
  sparseDenseLongContext: true, recordedRelationOrEndpointContext: true, currentFailuresVisible: true, latestClickWins: true,
  missingAndForeignQuotesBlocked: true, duplicateSourceAndRetry: true, fullMultipleQuotesAndChunkIdentity: true,
  noRoleGuessOrCanonicalAndLearningWrites: true }))
