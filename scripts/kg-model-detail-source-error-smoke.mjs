import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelSourceEvidenceFixture } from './kg-model-source-evidence-fixture-data.mjs'
import { modelCitationLocator, modelCitationPanelLocationSource } from './kg-model-citation-locator-fixture.mjs'

// Exercise the production panel's error ownership through real canonical HTTP
// reads and the workbench receiver. Duplicate evidence really is ambiguous.
const fixture = modelSourceEvidenceFixture(), harness = await modelLearningHarness({ fixture })
const server = createServer((request, response) => harness.handler(request, response))
const owners = [], requests = new Set()
let current, cursor = 0, actualHttpRequests = 0, cases = 0
const slot = initial => { const index = cursor++; return current.slots[index] ||= initial() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) {
    const owner = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [state.value, next => owner.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useMemo(fn, deps) {
    const state = slot(() => ({}))
    if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) { state.value = fn(); state.deps = deps }
    return state.value
  },
  useEffect(fn, deps) {
    const state = slot(() => ({}))
    if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
      current.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    }
  },
}
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const panelCode = value => value.slice(value.indexOf('function useConnectionModelLocation('), value.indexOf('const MODEL_FEEDBACK_TYPES'))
for (const file of ['../lib/client.js', '../extension/viewer.js']) assert.equal(panelCode(source), panelCode(readFileSync(new URL(file, import.meta.url), 'utf8')))
const environment = { window: { React, confirm: () => true }, console, AbortController, setTimeout: () => 1, clearTimeout() {},
  sessionStorage: { getItem: () => null, setItem() {} }, documentIdOfGraph: graph => graph?.source?.documentId }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), environment)
runInNewContext(source.slice(source.indexOf('function exactSourceQuoteTarget('), source.indexOf('function KnowledgeConsumePanel(')) + '\nthis.target=exactSourceQuoteTarget', environment)
const all = (node, predicate) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, predicate)) : !node || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const alerts = ui => all(ui.owner.tree, node => node.props.role === 'alert').map(text)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
  const post = args => {
    actualHttpRequests++
    const request = fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    }).then(response => { assert.equal(response.status, 200); return response.json() })
    requests.add(request); request.finally(() => requests.delete(request)).catch(() => {})
    return request
  }
  const view = environment.window.KGViewer.makeView(harness.store.getDocument(fixture.documentId), fixture.sourceText)
  const navigation = () => {
    const references = [], completed = [], paragraphs = [], modes = [], scrolls = [], holds = []
    const env = { resultView: view, fullText: fixture.sourceText, currentResultRef: { current: view }, graphRevisionRef: { current: 1 },
      paragraphLocateSeqRef: { current: 0 }, graphCommitQueueRef: { current: Promise.resolve() },
      documentIdOfGraph: environment.documentIdOfGraph, exactSourceQuoteTarget: environment.target, makeView: environment.window.KGViewer.makeView,
      loadGraphDocument: () => { throw new Error('Source-only lookup must not load a node window') },
      setResultView() {}, setContentScope() {}, navigateWorkspace() {}, setChapterFilter() {}, chapterSectionsOf: () => [], graphViewMetadata: () => null,
      setGraphQueryDraft() {}, setGraphPageDraft() {}, setSelectedNodeId() {}, setSelectedEdgeId() {}, setFocusReq: update => update({ seq: 0 }),
      setActivePara: value => paragraphs.push(value), setFlashPara() {}, ctx: { timeout: fn => fn() },
      document: { getElementById: id => ({ id }) }, scrollElIntoCenter: element => scrolls.push(element.id), changeReadMode: value => modes.push(value) }
    env.locateConsumptionReference = modelCitationLocator(env)
    const receiver = new Function(...Object.keys(env), 'return ' + modelCitationPanelLocationSource(source))(...Object.values(env))
    const nav = { references, completed, paragraphs, modes, scrolls, holds, paused: false,
      locate(reference, isCurrent) {
        references.push({ ...reference })
        const hold = nav.paused ? deferred() : null
        if (hold) holds.push(hold)
        const promise = (async () => { if (hold) await hold.promise; return receiver(reference, isCurrent) })()
        completed.push(promise); promise.catch(() => {})
        return promise
      } }
    return nav
  }
  const mount = async (nav, extra = {}) => {
    const owner = { slots: [], effects: [], updates: [], tree: null }, props = { documentId: fixture.documentId, revision: 1, active: true,
      focusRequest: { documentId: fixture.documentId, revision: 1, nodeId: 'source-duplicate', type: 'connection_model' },
      load: post, onLocate: nav.locate, ...extra }
    let mounted = true
    const render = () => {
      for (let count = 0; count < 30; count++) {
        current = owner; owner.updates.splice(0).forEach(fn => fn()); cursor = 0
        owner.tree = environment.window.KGViewer.ConnectionModelPanel(props); owner.effects.splice(0).forEach(fn => fn())
        if (!owner.updates.length) return
      }
      throw new Error('Panel update loop')
    }
    const settle = async () => {
      for (let count = 0; count < 12; count++) {
        await Promise.allSettled([...requests]); await Promise.resolve(); if (mounted) render()
      }
    }
    const click = async label => {
      const button = all(owner.tree, node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label))[0]
      assert(button, 'Missing ' + label); assert(!button.props.disabled); current = owner; button.props.onClick(); await settle()
    }
    const select = async id => {
      let row
      for (let page = 0; page < 10; page++) {
        row = all(owner.tree, node => node.props['data-model-catalogue-row'] === id)[0]
        if (row) break
        await click('下一页')
      }
      assert(row, 'Missing model ' + id)
      current = owner; all(row, node => node.type === 'button' && node.props.className === 'kg-model-list-item')[0].props.onClick(); await settle()
    }
    const unmount = () => { mounted = false; for (const state of owner.slots) state.cleanup?.() }
    owners.push(owner); render(); await settle()
    return { owner, props, render, settle, click, select, unmount }
  }
  const field = (ui, key) => {
    const node = all(ui.owner.tree, node => typeof node.type === 'function' && node.type.name === 'ModelStructureEvidence'
      && node.props.value?.quote.startsWith(key === 'condition' ? 'FIELD DUPLICATE:' : 'FIELD MAPPING:'))[0]
    assert(node, 'Missing field evidence ' + key)
    const tree = node.type(node.props), button = all(tree, node => node.type === 'button')[0]
    assert(button && !button.props.disabled)
    return { node, button }
  }
  const clickField = async (ui, key) => { current = ui.owner; field(ui, key).button.props.onClick(); await ui.settle() }
  const fail = async ui => { await clickField(ui, 'condition'); assert(alerts(ui).some(value => value.includes('多个相同片段'))) }
  const nav = navigation(), ui = await mount(nav)
  await fail(ui)
  assert.deepEqual(nav.paragraphs, []); assert.deepEqual(nav.modes, [])
  await clickField(ui, 'mapping')
  assert.equal(alerts(ui).length, 0, 'A successful unique field citation clears the previous duplicate-quote location error')
  assert.deepEqual(nav.modes, ['graph']); assert.deepEqual(nav.scrolls, ['kg-para-' + nav.paragraphs[0]])
  const mapping = fixture.graph.nodes.find(node => node.id === 'source-duplicate').modelStructure.branches[0].mapping.provenance
  assert.equal(nav.references[1].quote, mapping.quote); assert.equal(nav.references[1].paragraph, mapping.paragraph)
  assert.equal(nav.references[1].documentId, fixture.documentId); assert.equal(nav.references[1].revision, 1)
  assert.equal(nav.references[1].sourceQuoteOnly, true); assert.equal(nav.references[1].nodeId, undefined)
  await fail(ui); await fail(ui); await clickField(ui, 'mapping'); assert.deepEqual(alerts(ui), []); cases += 2

  const operation = await mount(navigation(), { onRefresh: async () => { throw new Error('模型刷新失败，请重新读取') } })
  await operation.click('重新读取模型'); await fail(operation)
  assert.equal(alerts(operation).length, 2, 'Both failures have independent owners')
  await clickField(operation, 'mapping')
  assert.deepEqual(alerts(operation), ['模型刷新失败，请重新读取'], 'Source recovery must not erase an unrelated operation error'); cases++
  let failRead = false
  const readNav = navigation(), read = await mount(readNav, { load: args => args.modelId && failRead
    ? Promise.resolve({ error: { message: '模型详情读取失败，请重新读取' } }) : post(args) })
  const oldClick = field(read, 'mapping').button.props.onClick
  failRead = true; await read.click('重新读取模型'); current = read.owner; oldClick(); await read.settle()
  assert.deepEqual(alerts(read), ['模型详情读取失败，请重新读取']); assert.equal(readNav.references.length, 0); cases++

  for (const transition of ['tab', 'model', 'branch', 'revision', 'document', 'inactive-return']) {
    const scoped = await mount(navigation()); await fail(scoped)
    if (transition === 'tab') await scoped.click('原文依据')
    else if (transition === 'model') await scoped.select('source-fields')
    else if (transition === 'branch') {
      await scoped.click('Recorded qualified branch')
    } else if (transition === 'inactive-return') { scoped.props.active = false; await scoped.settle(); scoped.props.active = true; await scoped.settle() }
    else { scoped.props[transition === 'revision' ? 'revision' : 'documentId'] = transition === 'revision' ? 2 : 'another-document'; await scoped.settle() }
    assert(!alerts(scoped).some(value => value.includes('多个相同片段')), transition + ' drops only the old source-location error'); cases++
  }
  const staleNav = navigation(), stale = await mount(staleNav)
  const staleClick = field(stale, 'mapping').button.props.onClick
  await stale.select('source-fields'); await stale.select('source-duplicate'); await fail(stale)
  const count = staleNav.references.length; current = stale.owner; staleClick(); await stale.settle()
  assert.equal(staleNav.references.length, count); assert(alerts(stale).some(value => value.includes('多个相同片段'))); cases++

  for (const oldField of ['condition', 'mapping']) {
    const latestNav = navigation(), latest = await mount(latestNav)
    latestNav.paused = true; await clickField(latest, oldField); assert.equal(latestNav.holds.length, 1)
    latestNav.paused = false; await clickField(latest, oldField === 'condition' ? 'mapping' : 'condition')
    const expected = [...alerts(latest)], selected = [...latestNav.paragraphs]
    latestNav.holds[0].resolve(); await Promise.allSettled(latestNav.completed); await latest.settle()
    assert.deepEqual(alerts(latest), expected); assert.deepEqual(latestNav.paragraphs, selected); cases++
  }
  for (const transition of ['tab', 'model-return', 'inactive-return', 'revision', 'document', 'unmount']) {
    const pendingNav = navigation(), pending = await mount(pendingNav)
    pendingNav.paused = true; await clickField(pending, 'condition')
    if (transition === 'tab') await pending.click('原文依据')
    else if (transition === 'model-return') { await pending.select('source-fields'); await pending.select('source-duplicate') }
    else if (transition === 'inactive-return') { pending.props.active = false; await pending.settle(); pending.props.active = true; await pending.settle() }
    else if (transition === 'unmount') pending.unmount()
    else { pending.props[transition === 'revision' ? 'revision' : 'documentId'] = transition === 'revision' ? 2 : 'another-document'; await pending.settle() }
    pendingNav.holds[0].resolve(); await Promise.allSettled(pendingNav.completed); await pending.settle()
    assert(!alerts(pending).some(value => value.includes('多个相同片段'))); assert.deepEqual(pendingNav.modes, []); cases++
  }
  const childNav = navigation(), relay = await mount(childNav), evidence = field(relay, 'condition').node
  const reference = { documentId: fixture.documentId, revision: 1, ...evidence.props.value, sourceQuoteOnly: true }
  await assert.rejects(evidence.props.onLocate(reference, () => true), /多个相同片段/); await relay.settle()
  assert.deepEqual(alerts(relay), [], 'A nested caller retains its own error handler')
  assert.equal(await evidence.props.onLocate(reference, () => false), false); cases++
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  console.log(JSON.stringify({ ok: true, cases, actualHttpRequests, productionPanel: true, productionWorkbenchReceiver: true,
    realDuplicateQuoteFailure: true, retryRecovery: true, unrelatedErrorsRetained: true, nestedCallerErrorOwnership: true,
    currentFailuresVisible: true, latestClickAndScopeGuards: true, fullQuoteAndIdentity: true, readOnly: true }))
} finally {
  for (const owner of owners) for (const state of owner.slots) state.cleanup?.()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop()
}
