import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { SqliteKnowledgeStore } from '../lib/kg-store.mjs'
import dynamicHost from '../src/index.host.js'

const documentId = 'paragraph-location:exact-identity'
const paragraphs = Array.from({ length: 12002 }, (_, i) => 'Source observation ' + i + '.')
paragraphs[0] = paragraphs[1] = 'A repeated observation.'
const idAt = i => 'record:' + i.toString(36) + ':source'
const sourceText = paragraphs.join('\n\n')
const fixture = { documentId, sourceText, sourceUnits: paragraphs.map((text, paragraph) => ({ text, paragraph })),
  graph: { source: { id: documentId, documentId, title: 'Paragraph location fixture', paragraphCount: paragraphs.length },
    nodes: paragraphs.slice(0, 12000).map((quote, paragraph) => ({ id: idAt(paragraph), type: 'fact', text: quote, quote, paragraph })),
    edges: [{ fromNodeId: idAt(11998), toNodeId: idAt(11999), relation: 'supports' }] } }
fixture.graph.nodes.push({ id: 'legacy-null', type: 'fact', text: paragraphs[42], quote: paragraphs[42] },
  { id: 'stale-paragraph', type: 'fact', text: paragraphs[5], quote: paragraphs[5], paragraph: 4 })
const harness = await modelLearningHarness({ fixture })
const { store, handler } = harness
const baseline = store.getDocument(documentId)
// Combining paragraph navigation with cached canonical diagnostics must not
// hydrate the full graph for rejected location requests.
let diagnosticInspections = 0
const inspectLocation = graph => { diagnosticInspections++; return { canonicalNodeCount: graph.nodes.length } }
const inspectedWindow = store.getDocumentWindow(documentId, { limit: 200, includeSourceText: false }, inspectLocation)
assert.equal(inspectedWindow.graphStructureQuality.canonicalNodeCount, fixture.graph.nodes.length)
for (const [options, code] of [
  [{ focusParagraph: -1, expectedRevision: 1 }, 'invalid_input'],
  [{ focusParagraph: 11999, expectedRevision: 2 }, 'revision_conflict'],
  [{ focusParagraph: 11999, expectedRevision: 1, query: 'other' }, 'invalid_input'],
]) assert.equal(store.getDocumentWindow(documentId, options, inspectLocation).error.code, code)
assert.equal(diagnosticInspections, 1, 'Rejected locations must skip canonical diagnostic hydration')
const server = createServer((req, res) => handler(req, res))
const originalDocument = SqliteKnowledgeStore.prototype.getDocument
const originalWindow = SqliteKnowledgeStore.prototype.getDocumentWindow
let requests = 0, hydratedNodes = 0, maxHydratedNodes = 0

// The paragraph read must not invoke the full-graph diagnostics hydration used
// by ordinary document opening. Inspect actual SQL row payloads on the HTTP owner.
SqliteKnowledgeStore.prototype.getDocument = function () { throw new Error('Unexpected full canonical graph hydration') }
SqliteKnowledgeStore.prototype.getDocumentWindow = function (...args) {
  const prepare = this.db.prepare
  this.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (sql.startsWith('SELECT * FROM graph_nodes')) {
      const all = statement.all
      statement.all = function (...bindings) {
        const rows = all.apply(this, bindings)
        hydratedNodes += rows.length
        maxHydratedNodes = Math.max(maxHydratedNodes, rows.length)
        return rows
      }
    }
    return statement
  }
  try { return originalWindow.apply(this, args) } finally { this.db.prepare = prepare }
}

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const sandbox = { window: { React: {} }, console }
let helpers
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

try {
  const scopeStart = source.indexOf('      function contentScopeForNode(')
  const scopeEnd = source.indexOf('      function contentScopeCanvasProps(', scopeStart)
  assert(scopeStart >= 0 && scopeEnd > scopeStart)
  runInNewContext(viewer.replace('window.KGViewer = {', source.slice(scopeStart, scopeEnd)
    + 'window.KGViewer = { loadParagraphWindow, graphViewMetadata, contentScopeForNode,'), sandbox)
  helpers = sandbox.window.KGViewer
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/document-load'
  const post = async args => {
    requests++
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId, ...args }) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const location = (paragraph, limit = 800) => post({ focusParagraph: paragraph, nodeLimit: limit, expectedRevision: 1, includeSourceText: false })
  let tail
  for (const limit of [200, 800, 2000]) {
    for (const paragraph of [0, 1, 799, 5999, 11999]) {
      const read = await location(paragraph, limit)
      assert(!read.error)
      assert.equal(read.graph.view.focusParagraph, paragraph)
      assert.equal(read.graph.view.focusNodeId, idAt(paragraph))
      assert(read.graph.nodes.some(node => node.id === idAt(paragraph)))
      assert(read.graph.nodes.length <= limit)
      assert.equal(read.graph.view.kind, 'window')
      assert.equal(read.graph.view.nodeOffset % limit, 0, 'Location must land on an ordinary page')
      assert.equal(read.graph.view.totalNodes, 12002)
      assert.equal(read.sourceText, '', 'Do not transfer the whole source again')
      assert.equal(read.revision, 1); assert.equal(read.graph.source.revision, 1)
      const expected = store.getDocumentWindow(documentId, { limit, offset: read.graph.view.nodeOffset, includeSourceText: false })
      assert.deepEqual(read.graph.nodes, expected.nodes, 'NULL-first and node-id ordering must match ordinary pages')
      assert.deepEqual(read.graph.edges, expected.edges)
      if (limit === 800 && paragraph === 11999) tail = read
    }
  }
  const empty = await location(12001)
  assert.equal(empty.graph.view.focusNodeId, ''); assert.equal(empty.graph.nodes.length, 0)
  for (const focusParagraph of [null, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await post({ focusParagraph, expectedRevision: 1 })).error.code, 'invalid_input')
  }
  for (const expectedRevision of [undefined, null, '1', -1, 1.5]) {
    assert.equal((await post({ focusParagraph: 0, expectedRevision })).error.code, 'invalid_input')
  }
  assert.equal((await post({ focusParagraph: 0, expectedRevision: 1, query: 'other' })).error.code, 'invalid_input')
  assert.equal((await post({ documentId: 'missing', focusParagraph: 0, expectedRevision: 1 })).error.code, 'not_found')
  assert.equal((await post({ focusParagraph: 0, expectedRevision: 2 })).error.code, 'revision_conflict')

  const base = helpers.makeView(store.getDocumentWindow(documentId, { limit: 800 }), sourceText)
  const componentRanges = [
    ['workbench', source.indexOf('function WorkbenchBody('), source.indexOf('function TrajectoryTab(')],
    ['trajectory', source.indexOf('function TrajectoryTab('), source.length],
  ]
  function uiHarness(kind, overrides = {}) {
    const [, begin, end] = componentRanges.find(row => row[0] === kind)
    const paragraphStart = source.indexOf('        const handleParagraphClick = async', begin)
    const paragraphEnd = source.indexOf(kind === 'workbench' ? '        const loadHistoryEntry =' : '        const changeLayoutMode =', paragraphStart)
    const nodeStart = source.indexOf('        const handleSelectNode =', begin)
    const nodeEnd = source.indexOf(kind === 'workbench' ? '        const locateConsumptionReference =' : '        const locateTrajectoryConsumptionReference =', nodeStart)
    const edgeStart = source.indexOf('        const handleSelectEdge =', nodeEnd)
    assert(paragraphStart > begin && paragraphEnd < end && nodeStart > begin && nodeEnd < edgeStart && edgeStart < paragraphStart)
    const calls = [], nodes = [], views = [], toasts = [], focus = [], active = []
    const env = { ...helpers, resultView: base, displayView: base, view: base, gatherProjection: null,
      currentResultRef: { current: base }, currentViewRef: { current: base }, paragraphLocateSeqRef: { current: 0 },
      graphRevisionRef: { current: 1 }, trajRevisionRef: { current: 1 },
      graphCommitQueueRef: { current: Promise.resolve() }, trajCommitQueueRef: { current: Promise.resolve() },
      sessionId: 'fixture-session', mountedSessionRef: { current: 'fixture-session' }, contentScope: 'all',
      loadGraphDocument: async body => { calls.push(body); return post(body) },
      setContentScope() {}, setActivePara: value => active.push(value), setSelectedNodeId: value => nodes.push(value),
      setSelectedEdgeId() {}, setFocusReq: update => focus.push(update({ seq: focus.length })),
      setResultView: value => views.push(value), setView: value => views.push(value), setChapterFilter() {},
      setGraphPageDraft() {}, setGraphQueryDraft() {}, setFlashPara() {},
      toastStore: { show: text => toasts.push(text) }, showToast: text => toasts.push(text),
      document: { getElementById: () => ({}) }, scrollElIntoCenter() {}, ctx: { timeout() {} }, ...overrides }
    const body = source.slice(nodeStart, nodeEnd) + source.slice(edgeStart, paragraphStart) + source.slice(paragraphStart, paragraphEnd)
    const actions = new Function(...Object.keys(env), body + '; return { paragraph: handleParagraphClick, node: handleSelectNode, edge: handleSelectEdge }')(...Object.values(env))
    return { ...actions, env, calls, nodes, views, toasts, focus, active }
  }
  for (const kind of ['workbench', 'trajectory']) {
    let ui = uiHarness(kind)
    await ui.paragraph(11999)
    assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].focusParagraph, 11999)
    assert.equal(ui.calls[0].expectedRevision, 1); assert.equal(ui.calls[0].query, undefined)
    assert.deepEqual(ui.nodes, [idAt(11999)]); assert.equal(ui.views.length, 1)
    assert.equal(ui.views[0].sourceText, sourceText); assert.equal(ui.views[0].anchors[idAt(11999)], sourceText.indexOf(paragraphs[11999]))
    assert.equal(ui.focus[0].nodeId, idAt(11999))
    ui = uiHarness(kind); await ui.paragraph(1)
    assert.equal(ui.calls.length, 0, 'In-window repeated quotes retain their paragraph identity')
    assert.deepEqual(ui.nodes, [idAt(1)])
    ui = uiHarness(kind); await ui.paragraph(12001)
    assert.equal(ui.nodes.length, 0); assert.equal(ui.views.length, 0); assert.equal(ui.toasts.length, 1)
    // Old source clicks cannot overtake newer source / node / edge navigation.
    for (const newer of ['paragraph', 'node', 'edge', 'view', 'revision', 'queue', 'unmount', 'session']) {
      if (newer === 'session' && kind !== 'trajectory') continue
      const pending = deferred()
      ui = uiHarness(kind, { loadGraphDocument: () => pending.promise })
      const old = ui.paragraph(11999); await flush()
      if (newer === 'paragraph') await ui.paragraph(1)
      else if (newer === 'node') ui.node(idAt(1))
      else if (newer === 'edge') ui.edge(0)
      else if (newer === 'view') { ui.env.currentResultRef.current = {}; ui.env.currentViewRef.current = {} }
      else if (newer === 'revision') { ui.env.graphRevisionRef.current++; ui.env.trajRevisionRef.current++ }
      else if (newer === 'queue') { ui.env.graphCommitQueueRef.current = Promise.resolve(); ui.env.trajCommitQueueRef.current = Promise.resolve() }
      else if (newer === 'unmount') ui.env.paragraphLocateSeqRef.current++
      else ui.env.mountedSessionRef.current = 'another-session'
      pending.resolve(tail); await old
      assert.equal(ui.views.length, 0, kind + ': old response after ' + newer)
      assert(!ui.nodes.includes(idAt(11999)), kind + ': old selection after ' + newer)
    }
    // Errors, unsupported Host versions and stale anchors do not replace the view.
    const moved = structuredClone(tail)
    const focusId = moved.graph.view.focusNodeId
    const movedNode = moved.graph.nodes.find(node => node.id === focusId)
    movedNode.paragraph = 11998; movedNode.quote = paragraphs[11998]
    const unsupported = structuredClone(tail); delete unsupported.graph.view.focusParagraph
    const wrongIdentity = structuredClone(tail); wrongIdentity.documentId = 'other-document'
    const missingTarget = structuredClone(tail); missingTarget.graph.nodes = []
    for (const response of [{ error: { code: 'revision_conflict', message: 'Changed revision' } }, unsupported, wrongIdentity, missingTarget, moved]) {
      ui = uiHarness(kind, { loadGraphDocument: async () => response }); await ui.paragraph(11999)
      assert.equal(ui.views.length, 0); assert.equal(ui.nodes.length, 0)
    }
    const pendingCommit = deferred()
    ui = uiHarness(kind, { graphCommitQueueRef: { current: pendingCommit.promise }, trajCommitQueueRef: { current: pendingCommit.promise } })
    const old = ui.paragraph(11999); await flush(); await ui.paragraph(1)
    pendingCommit.resolve(); await old
    assert.equal(ui.calls.length, 0, 'Superseded queued reads never start')
    ui = uiHarness(kind, { gatherProjection: { nodes: [{ id: 'gathered-only' }], anchors: { 'gathered-only': base.paragraphs[11999].start } } })
    await ui.paragraph(11999)
    assert.deepEqual(ui.nodes, ['gathered-only']); assert.equal(ui.calls.length, 0, 'Already gathered neighbors retain the local fast path')
  }

  // Execute the actual renderer's focus effect and exit path. A source node
  // already in the base page must become visible without restoring the old
  // neighborhood's selection or source scroll position.
  const rendererStart = source.indexOf('      function GraphViewer(props) {')
  const exitStart = source.indexOf('        const exit = (restoreContext = true) => {', rendererStart)
  const exitEnd = source.indexOf('        const gather = ', exitStart)
  const focusStart = source.indexOf('        useEffect(() => {\n          const nodeId = props.focusReq?.nodeId', rendererStart)
  const focusEnd = source.indexOf('        const focused = ', focusStart)
  assert(rendererStart > 0 && exitStart > rendererStart && exitEnd > exitStart && focusStart > exitEnd && focusEnd > focusStart)
  function rendererFocus(focusReq, result, request = { centerId: idAt(0) }, restoreFocus = { nodeId: idAt(0), seq: 1 }) {
    const calls = [], scroll = { isConnected: true, scrollTop: 10 }, restored = { count: 0 }
    const env = { props: { nodes: base.graph.nodes, focusReq }, result, request,
      restore: { current: { selection: { focusReq: restoreFocus }, element: scroll, top: 91,
        callback: () => { restored.count++ } } }, sequence: { current: 5 }, localPrepared: { current: {} },
      active: { current: { abort: () => calls.push(['abort']) } },
      latest: { current: { onGatherProjection: value => calls.push(['projection', value]),
        onGatherRequestChange: value => calls.push(['query', value]) } },
      useEffect: action => action(), setSelection: value => calls.push(['selection', value]) }
    for (const name of ['setRequest', 'setResult', 'setStatus', 'setHistory']) env[name] = value => calls.push([name, value])
    new Function(...Object.keys(env), source.slice(exitStart, exitEnd) + source.slice(focusStart, focusEnd))(...Object.values(env))
    return { calls, scroll, restored, env }
  }
  const neighborhood = { nodes: [{ id: idAt(0) }, { id: 'gathered-only' }] }
  for (const result of [neighborhood, null]) {
    const rendered = rendererFocus({ nodeId: idAt(1), seq: 2 }, result)
    assert(rendered.calls.some(([name]) => name === 'abort'), 'Exit must cancel the old neighborhood request')
    assert(rendered.calls.some(([name, value]) => name === 'setRequest' && value === null))
    assert(!rendered.calls.some(([name]) => name === 'selection'), 'The new base selection stays owned by the parent')
    assert.equal(rendered.restored.count, 0, 'Do not restore the previous source selection')
    assert.equal(rendered.scroll.scrollTop, 10, 'Do not scroll away from the new source target')
    assert.equal(rendered.env.restore.current, null)
  }
  const visibleNeighbor = rendererFocus({ nodeId: 'gathered-only', seq: 2 }, neighborhood)
  assert.deepEqual(visibleNeighbor.calls, [['selection', { node: 'gathered-only', edge: null }]])
  const oldFocus = { nodeId: idAt(1), seq: 1 }
  assert.deepEqual(rendererFocus(oldFocus, neighborhood, undefined, oldFocus).calls, [], 'Entering a neighborhood keeps its captured base focus')
  assert.deepEqual(rendererFocus({ nodeId: 'missing-node', seq: 2 }, neighborhood).calls, [], 'An unconfirmed target cannot close the current view')

  SqliteKnowledgeStore.prototype.getDocument = originalDocument
  assert.deepEqual(store.getDocument(documentId), baseline, 'All HTTP and UI reads preserve canonical graph / revision')
  assert.deepEqual(store.getDocumentSourceUnits(documentId).map(({ paragraph, text }) => ({ paragraph, text })), fixture.sourceUnits)
  assert.equal(store.listLearningAttempts(documentId).length, 0)

  // The dynamic sandbox uses the same request and bounded-page contract.
  const handlers = new Map(), previousHarness = globalThis.harness
  globalThis.harness = { handle: (name, fn) => handlers.set(name, fn) }
  const dynamicParagraphs = Array.from({ length: 801 }, (_, i) => 'P' + i)
  dynamicHost().apply({ get: name => name === 'kgExtractor' ? async () => ({ nodes: dynamicParagraphs.map((quote, paragraph) => ({
    id: idAt(paragraph), type: 'fact', text: quote, quote, paragraph })), edges: [] }) : null, interval: () => () => {} })
  try {
    const task = await handlers.get('extract')({ title: 'Dynamic source location', text: dynamicParagraphs.join('\n\n') })
    let status
    for (let i = 0; i < 100; i++) {
      status = await handlers.get('task-status')({ taskId: task.taskId })
      if (status.status !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(status.status, 'succeeded')
    const id = status.result.source.documentId
    const full = await handlers.get('document-export')({ documentId: id })
    const args = { documentId: id, focusParagraph: 800, expectedRevision: full.revision, nodeLimit: 200, includeSourceText: false }
    const page = await handlers.get('document-load')(args)
    assert(!page.error); assert.equal(page.sourceText, ''); assert.equal(page.graph.view.focusParagraph, 800)
    assert.equal(page.graph.view.focusNodeId, full.graph.nodes.find(node => node.paragraph === 800).id)
    assert(page.graph.nodes.some(node => node.id === page.graph.view.focusNodeId)); assert(page.graph.nodes.length <= 200)
    assert.equal((await handlers.get('document-load')({ ...args, expectedRevision: full.revision + 1 })).error.code, 'revision_conflict')
    assert.equal((await handlers.get('document-load')({ ...args, focusParagraph: null })).error.code, 'invalid_input')
  } finally { if (previousHarness === undefined) delete globalThis.harness; else globalThis.harness = previousHarness }
  console.log(JSON.stringify({ ok: true, canonicalNodes: 12002, actualHttp: true, requests, hydratedNodes, maxHydratedNodes,
    noFullGraphHydration: true, ordinaryPagination: true, repeatedQuotes: true, staleAnchorsRejected: true,
    workbenchAndTrajectory: true, lateResponseGuards: true, neighborhoodFocusRouting: true, dynamicParity: true, canonicalUnchanged: true }))
} finally {
  SqliteKnowledgeStore.prototype.getDocument = originalDocument
  SqliteKnowledgeStore.prototype.getDocumentWindow = originalWindow
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  harness.stop()
}
