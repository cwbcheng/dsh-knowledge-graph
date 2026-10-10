import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createGraphContract } from '../src/index.host.js'
import { modelSourceTableFixture } from './kg-model-source-table-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelCitationFixture, modelCitationLocator, modelCitationLocatorSource } from './kg-model-citation-locator-fixture.mjs'

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const quoteSource = source.slice(source.indexOf('function exactSourceQuoteTarget('), source.indexOf('function KnowledgeConsumePanel('))
const components = value => value.slice(value.indexOf('function ConnectionModelPanel('), value.indexOf('function ConnectionModelChain('))
assert.equal(modelCitationLocatorSource(source), modelCitationLocatorSource(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')))
for (const file of ['../lib/client.js', '../extension/viewer.js']) assert.equal(components(source), components(readFileSync(new URL(file, import.meta.url), 'utf8')))
const fixture = modelSourceTableFixture({ peer: true }), contract = createGraphContract(), harness = await modelLearningHarness({ fixture })
const canonical = harness.store.getDocument(fixture.documentId), before = JSON.stringify(canonical)
const unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
let current, cursor = 0
const slot = initial => { const index = cursor++; return current.slots[index] ||= initial() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    return [state.value, next => current.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
  useRef: initial => slot(() => ({ current: initial })),
  useMemo(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) { state.value = fn(); state.deps = deps }; return state.value },
  useEffect(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
    current.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
  } },
}
const environment = { window: { React }, console, AbortController, setTimeout: () => 1, clearTimeout() {}, documentIdOfGraph: graph => graph?.source?.documentId }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), environment)
runInNewContext(quoteSource + '\nthis.target=exactSourceQuoteTarget', environment)
const makeView = environment.window.KGViewer.makeView
const view = makeView(canonical, fixture.sourceText)
const records = value => Array.isArray(value) ? value.flatMap(records) : value && typeof value === 'object'
  ? [...(value.citations || []), ...Object.entries(value).filter(([key]) => key !== 'citations').flatMap(([, item]) => records(item))] : []
const originalCitations = records(contract.connectionModels(fixture, { documentId: fixture.documentId, expectedRevision: 1, modelId: 'taxi', compareModelId: 'taxi-peer' }))
const all = (node, predicate) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, predicate)) : !node || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const buttons = node => all(node, item => item.type === 'button' && text(item) === '原文 P8')
const owners = [], located = []
const mount = (name, extra = {}, document = fixture) => {
  const owner = { slots: [], effects: [], updates: [], tree: null }, Component = environment.window.KGViewer[name]
  const props = { documentId: fixture.documentId, revision: 1, modelId: 'taxi', active: true,
    focusRequest: { documentId: fixture.documentId, revision: 1, nodeId: 'taxi', type: 'connection_model' },
    load: args => Promise.resolve(contract.connectionModels(document, args)), onLocate: reference => located.push({ ...reference }), ...extra }
  const render = () => {
    for (let count = 0; count < 30; count++) {
      current = owner; owner.updates.splice(0).forEach(fn => fn()); cursor = 0
      owner.tree = Component(props); owner.effects.splice(0).forEach(fn => fn()); if (!owner.updates.length) return
    }
    throw new Error('Component update loop')
  }
  const settle = async () => { for (let count = 0; count < 8; count++) { current = owner; await Promise.resolve(); render() } }
  const click = async label => {
    current = owner
    const button = all(owner.tree, item => item.type === 'button' && text(item) === label)[0]
    assert(button, 'Missing ' + label); assert(!button.props.disabled); button.props.onClick(); await settle()
  }
  owners.push(owner); render(); return { owner, props, settle, click }
}
const navigation = (opening = view, overrides = {}) => {
  const loads = [], changes = [], paragraphs = [], nodes = [], scrolls = []
  const env = { resultView: opening, fullText: fixture.sourceText, currentResultRef: { current: opening },
    paragraphLocateSeqRef: { current: 0 }, graphRevisionRef: { current: 1 }, graphCommitQueueRef: { current: Promise.resolve() },
    documentIdOfGraph: environment.documentIdOfGraph, exactSourceQuoteTarget: environment.target, makeView,
    loadGraphDocument: async args => { loads.push(args); return harness.post(args, 'document-load') },
    setResultView: next => changes.push(next), setContentScope: value => changes.push(value),
    navigateWorkspace: mode => changes.push(mode), setChapterFilter: value => changes.push(value),
    chapterSectionsOf: graph => graph.source.sections || [], graphViewMetadata: () => null,
    setGraphQueryDraft: value => changes.push(value), setGraphPageDraft: value => changes.push(value),
    setSelectedNodeId: value => nodes.push(value), setSelectedEdgeId() {}, setFocusReq: update => update({ seq: 0 }),
    setActivePara: value => paragraphs.push(value), setFlashPara() {}, ctx: { timeout: fn => fn() },
    document: { getElementById: id => ({ id }) }, scrollElIntoCenter: element => scrolls.push(element.id), ...overrides }
  return { env, loads, changes, paragraphs, nodes, scrolls, locate: modelCitationLocator(env) }
}
const checkReferences = async () => {
  const count = located.length
  assert(count > 0)
  for (const reference of located.splice(0)) {
    assert.equal(reference.documentId, fixture.documentId); assert.equal(reference.revision, 1)
    assert.equal(reference.paragraph, 7)
    assert(originalCitations.some(citation => citation.paragraph === reference.paragraph && citation.quote === reference.quote
      && citation.nodeId === reference.nodeId && citation.sourceId === reference.sourceId), 'Keep the actual citation identity, including unknown source ids')
    assert.equal(reference.quote, fixture.sourceUnits[1].text); assert.equal(reference.sourceQuoteOnly, true); assert.equal(reference.sourceCitation, true)
    const ui = navigation(); assert.equal(await ui.locate(reference), true)
    assert.deepEqual(ui.paragraphs, [1]); assert.deepEqual(ui.scrolls, ['kg-para-1'])
    assert.deepEqual(ui.nodes, reference.nodeId ? [reference.nodeId] : [])
    assert.equal(ui.loads.length, 0)
  }
  return count
}
let citationActions = 0, receiverCases = 0
try {
  const panel = mount('ConnectionModelPanel'); await panel.settle(); await panel.click('原文依据')
  const sourcePanel = all(panel.owner.tree, node => node.props.className === 'kg-model-source')[0]
  buttons(sourcePanel)[0].props.onClick(); await panel.settle(); citationActions += await checkReferences()
  const port = all(panel.owner.tree, node => node.props.className === 'kg-model-port')[0]
  buttons(port)[0].props.onClick(); await panel.settle(); assert.equal(located[0].nodeId, 'distance'); citationActions += await checkReferences()
  await panel.click('下上对照')
  for (const article of all(panel.owner.tree, node => node.type === 'article' && node.props.className === 'kg-model-material')) {
    for (const button of buttons(article)) button.props.onClick()
  }
  await panel.settle(); citationActions += await checkReferences()
  const legacy = all(panel.owner.tree, node => node.props.className === 'kg-model-structure')[0]
  for (const button of buttons(legacy)) button.props.onClick()
  await panel.settle(); assert(located.some(reference => reference.nodeId === null), 'Edge citations remain source actions without an invented node identity')
  citationActions += await checkReferences()
  const comparison = mount('ConnectionModelComparison'); await comparison.settle()
  const peer = all(comparison.owner.tree, node => node.type === 'button' && text(node).includes('taxi-peer · '))[0]
  assert(peer); peer.props.onClick(); await comparison.settle()
  for (const button of buttons(comparison.owner.tree)) button.props.onClick()
  await comparison.settle(); citationActions += await checkReferences()
  for (const ui of [panel, comparison]) assert.equal(all(ui.owner.tree, node => node.props.dangerouslySetInnerHTML).length, 0)
  const dense = modelCitationFixture({ dense: true, anchor: 2 }), densePanel = mount('ConnectionModelPanel', {}, dense)
  await densePanel.settle(); await densePanel.click('原文依据'); await densePanel.click('原文 P3')
  const denseReference = located.pop(), denseView = makeView({ ...dense.graph, revision: 1 }, dense.sourceText)
  assert.equal(denseReference.paragraph, 2); assert.equal(environment.target(denseView, denseReference).first, 3, 'Re-parsing also changes reading positions when stored ids are dense')

  const reference = { documentId: fixture.documentId, revision: 1, paragraph: 7, quote: fixture.sourceUnits[1].text,
    sourceId: 'sparse-model-source', nodeId: 'distance', sourceQuoteOnly: true, sourceCitation: true }
  const outside = makeView({ ...canonical, nodes: [], edges: [] }, fixture.sourceText)
  const ui = navigation(outside); assert.equal(await ui.locate(reference), true)
  assert.equal(ui.loads.length, 1); assert.equal(ui.loads[0].expectedRevision, 1); assert.equal(ui.loads[0].query, 'distance')
  assert.deepEqual(ui.nodes, ['distance']); assert.deepEqual(ui.paragraphs, [1]); receiverCases++
  const otherChapter = makeView({ ...canonical, nodes: canonical.nodes.map(node => ({ ...node, sectionId: 'model-chapter' })) }, fixture.sourceText)
  const crossChapter = navigation(otherChapter, { chapterSectionsOf: () => [{ id: 'model-chapter' }] })
  await crossChapter.locate(reference)
  assert.equal(crossChapter.changes.at(-1), 'all', 'A source citation may point outside its node chapter; keep the exact source paragraph visible')
  receiverCases++
  // Invalid exact references fail before a node query or any reading state changes.
  const invalid = [{ ...reference, documentId: 'foreign' }, { ...reference, revision: 2 }, { ...reference, paragraph: -1 },
    { ...reference, quote: reference.quote + '缺失' }, { ...reference, quote: 'x'.repeat(2001) }]
  for (const candidate of invalid) {
    const ui = navigation(outside); await assert.rejects(ui.locate(candidate))
    assert.equal(ui.loads.length, 0); assert.deepEqual(ui.changes, []); assert.deepEqual(ui.nodes, []); receiverCases++
  }
  const duplicate = makeView(canonical, fixture.sourceText + '\n\n' + reference.quote)
  const ambiguous = navigation(duplicate); await assert.rejects(ambiguous.locate(reference), /多个相同片段/)
  assert.deepEqual(ambiguous.changes, []); assert.deepEqual(ambiguous.nodes, []); receiverCases++
  const loaded = await harness.post({ documentId: fixture.documentId, query: 'distance', includeSourceText: false }, 'document-load')
  for (const response of [{ ...loaded, documentId: 'foreign' }, { ...loaded, revision: 2 },
    { ...loaded, graph: { ...loaded.graph, revision: 2 } }, { ...loaded, graph: { ...loaded.graph, nodes: [] } },
    { error: { message: '加载失败' } }]) {
    const ui = navigation(outside, { loadGraphDocument: async () => response }); await assert.rejects(ui.locate(reference))
    assert.deepEqual(ui.changes, []); assert.deepEqual(ui.nodes, []); assert.deepEqual(ui.paragraphs, []); receiverCases++
  }
  for (const change of ['click', 'revision', 'queue', 'document']) {
    let resolve
    const pending = new Promise(done => { resolve = done })
    const ui = navigation(outside, { loadGraphDocument: () => pending }), attempt = ui.locate(reference)
    await Promise.resolve(); await Promise.resolve()
    if (change === 'click') ui.env.paragraphLocateSeqRef.current++
    else if (change === 'revision') ui.env.graphRevisionRef.current++
    else if (change === 'queue') ui.env.graphCommitQueueRef.current = Promise.resolve()
    else ui.env.currentResultRef.current = {}
    resolve(loaded); await assert.rejects(attempt, /旧定位已取消/)
    assert.deepEqual(ui.changes, []); assert.deepEqual(ui.nodes, []); receiverCases++
  }
  const broken = mount('ConnectionModelPanel', { onLocate: navigation(duplicate).locate }); await broken.settle(); await broken.click('原文依据')
  buttons(all(broken.owner.tree, node => node.props.className === 'kg-model-source')[0])[0].props.onClick(); await broken.settle()
  assert(text(broken.owner.tree).includes('多个相同片段') && text(broken.owner.tree).includes(reference.quote), 'Failed lookup keeps the full quote and a visible panel error')
  comparison.props.onLocate = navigation(duplicate).locate; await comparison.settle()
  buttons(comparison.owner.tree)[0].props.onClick(); await comparison.settle()
  assert(text(comparison.owner.tree).includes('多个相同片段') && text(comparison.owner.tree).includes(reference.quote), 'Comparison also keeps the quote and its visible error')
  const long = structuredClone(fixture), longQuote = long.sourceUnits[1].text + '仅限本段条件。'.repeat(350)
  long.sourceUnits[1].text = longQuote; long.sourceText = long.sourceUnits.map(unit => unit.text).join('\n\n')
  long.graph.nodes[0].quote = longQuote; long.graph.nodes[0].evidence[0].quote = longQuote
  const oversized = mount('ConnectionModelPanel', { onLocate: reference => { located.push({ ...reference }); environment.target(makeView({ ...long.graph, revision: 1 }, long.sourceText), reference) } }, long)
  await oversized.settle(); await oversized.click('原文依据')
  buttons(all(oversized.owner.tree, node => node.props.className === 'kg-model-source')[0])[0].props.onClick(); await oversized.settle()
  assert.equal(located.at(-1).quote, longQuote); assert(text(oversized.owner.tree).includes(longQuote))
  assert(!text(oversized.owner.tree).includes('原文定位记录不完整'), 'Full valid model citations remain locatable without truncating qualifiers')
  const longView = makeView({ ...long.graph, revision: 1 }, long.sourceText), longReference = located.at(-1)
  assert.equal(environment.target(longView, longReference).first, 1)
  assert.throws(() => environment.target(longView, { ...longReference, sourceCitation: false }), /记录不完整/, 'Unmarked structure/context actions retain the original quote budget')
  assert.throws(() => environment.target(longView, { ...longReference, quote: longReference.quote + '缺失' }), /逐字匹配/)
  assert.throws(() => environment.target({ ...longView, sourceText: long.sourceText + '\n\n' + longQuote }, longReference), /多个相同片段/)
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  console.log(JSON.stringify({ ok: true, citationActions, receiverCases, productionComponents: true, productionWorkbenchReceiver: true,
    actualNodeWindowRoute: true, originalIdentityAndFullQuote: true, exactReadingTarget: true, staleLoadsDiscarded: true, visibleFailures: true, readOnly: true }))
} finally { for (const owner of owners) for (const state of owner.slots) state.cleanup?.(); harness.stop() }
