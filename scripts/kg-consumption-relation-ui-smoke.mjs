import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { getOntology } from '../src/kg-ontology.mjs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

const component = path => {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  const start = source.indexOf('function KnowledgeConsumePanel('), end = source.indexOf('// Preview geometry', start)
  assert(start >= 0 && end > start)
  return source.slice(start, end)
}
const source = component('src/index.client.js'), generated = component('lib/client.js')
assert.equal(source.replaceAll('host.call(', 'rpc('), generated)
const profile = getOntology('learning-view-v1'), legacy = getOntology('proposition-v1')
const presentation = ontology => ({ relationTypes: ontology.relationTypes.map(({ id, zh }) => ({ id, zh })) })
const fixture = modelStructureFixture()
fixture.graph.nodes.push({ ...structuredClone(fixture.graph.nodes[0]), id: 'same-name', text: fixture.graph.nodes[0].text })
fixture.graph.edges.push({ fromNodeId: 'unknown', toNodeId: 'same-name', relation: 'maps_between' })
const harness = await modelLearningHarness({ fixture, llm: async () => { modelCalls++; throw new Error('No model calls permitted') } })
const server = createServer((request, response) => harness.handler(request, response))
let modelCalls = 0, checks = 0
const plain = value => JSON.parse(JSON.stringify(value))
const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test))
  : !node || typeof node !== 'object' ? [] : [...(test(node) ? [node] : []), ...all(node.props?.children, test)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')

function mount(code, initial, transport, draftState) {
  let cursor = 0, tree
  const slots = [], effects = [], updates = [], saved = [], located = [], calls = [], consumed = []
  const slot = init => slots[cursor++] ||= init()
  const environment = { h: (type, props, ...children) => ({ type, props: { ...props, children } }),
    React: { Fragment: 'fragment' },
    useState(initial) { const item = slot(() => ({ value: initial })); return [item.value, next => updates.push(() => {
      item.value = typeof next === 'function' ? next(item.value) : next
    })] },
    useRef: initial => slot(() => ({ current: initial })),
    useEffect(fn, deps) { const item = slot(() => ({})); if (!item.deps || deps.some((value, index) => !Object.is(value, item.deps[index]))) {
      effects.push(() => { item.cleanup?.(); item.cleanup = fn() }); item.deps = deps
    } },
    documentIdOfGraph: graph => graph.source.documentId, chapterSectionsOf: () => [],
    TYPE_ORDER: profile.consumptionTypes, TYPE_META: {},
    PROPOSITION_REL_LABEL: Object.fromEntries(legacy.relationTypes.map(({ id, zh }) => [id, zh])),
    MODEL_STRUCTURE_TOOLS: createModelStructureTools(),
    REL_LABEL: { unrelated_global_label: 'Must not leak from another graph' },
  }
  const call = async (method, payload) => { calls.push({ method, payload: plain(payload) }); return transport(method, payload) }
  environment.host = { call }; environment.rpc = call
  runInNewContext(code + '\nthis.Component = KnowledgeConsumePanel', environment)
  const props = { ctx: { timeout() { throw new Error('No task polling in this contract test') } }, graph: initial, draftState,
    onStateChange: state => saved.push(plain(state)), onLocateReference: reference => { located.push(plain(reference)); return true },
    onRestoreConsumed: request => {
      consumed.push(plain(request))
      if (props.restoreState?.seq === request.seq && props.restoreState.documentId === request.documentId && props.restoreState.revision === request.revision) {
        props.restoreState = { ...props.restoreState, consumedSeq: request.seq }
      }
    }, readOnly: true }
  const render = () => { for (let count = 0; count < 20; count++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0; tree = environment.Component(props); effects.splice(0).forEach(fn => fn())
    if (!updates.length) return
  } throw new Error('Component update loop') }
  const control = name => { const node = all(tree, item => item.props['aria-label'] === name || item.type === 'button' && text(item) === name)[0]
    assert(node, 'Missing control: ' + name); return node }
  const settle = async () => { for (let count = 0; count < 5; count++) { await Promise.resolve(); render() } }
  const change = (name, value) => { control(name).props.onChange({ target: { value } }); render() }
  const search = async () => { await control('查找').props.onClick(); await settle() }
  render()
  return { props, calls, saved, located, consumed, render, control, change, search, settle,
    tree: () => tree, options: () => all(control('关系上下文筛选'), item => item.type === 'option').map(item => [item.props.value, text(item)]),
    dispose: () => slots.forEach(item => item.cleanup?.()) }
}

try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/'
  const post = async (method, payload) => {
    const response = await fetch(base + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    assert.equal(response.status, 200); return response.json()
  }
  const identity = { documentId: harness.document.documentId, expectedRevision: 1 }
  const initial = { ...harness.store.getDocument(identity.documentId), revision: 1, graphOntology: presentation(profile) }
  let held, delay = false
  const transport = (method, payload) => {
    if (method === 'answer-graph' && payload.relations?.[0] === 'maps_between') {
      return { error: { code: 'isolated_no_model', message: 'Model admission deliberately blocked by the test transport' } }
    }
    if (delay) { delay = false; return new Promise(resolve => { held = { payload: plain(payload), resolve } }) }
    return post(method, payload)
  }
  for (const code of [source, generated]) {
    const ui = mount(code, initial, transport)
    try {
      assert.deepEqual(ui.options(), [['all', '全部关系上下文'], ...profile.relationTypes.map(({ id, zh }) => [id, zh]), ['visual_source', '解读自图片'], ['visual_reference', '正文引用图片']])
      ui.change('关系上下文筛选', 'maps_between'); await ui.search()
      assert.deepEqual(ui.calls.at(-1).payload.relations, ['maps_between'])
      assert.equal(ui.calls.at(-1).payload.query, '')
      assert.equal(ui.saved.at(-1).filters.relation, 'maps_between')
      assert.equal(ui.calls.at(-1).payload.expectedRevision, 1)
      const cards = all(ui.tree(), node => node.props.className === 'kg-consume-result')
      assert(cards.length > 0, 'Relation-only admission must retrieve actual canonical endpoints')
      for (const card of cards) { await card.props.onClick(); await ui.settle() }
      assert(ui.located.some(reference => reference.nodeId === 'same-name'))
      assert(ui.located.some(reference => reference.nodeId === 'distance'), 'Same text must not collapse distinct concept identities')
      delay = true; const previousContext = ui.search()
      ui.change('关系上下文筛选', 'has_rule')
      held.resolve(await post('graph-query', held.payload)); await previousContext
      const stamp = all(ui.tree(), node => node.type === 'span' && text(node).startsWith(' · 关系上下文：'))[0]
      assert.equal(text(stamp), ' · 关系上下文：' + profile.relationTypes.find(item => item.id === 'maps_between').zh
        + '（' + (await post('graph-query', held.payload)).metrics.returnedEdges + ' 条记录）', 'Result provenance must describe its request, not changed controls')
      ui.change('关系上下文筛选', 'visual_source'); await ui.search()
      assert.equal(all(ui.tree(), node => node.props.className === 'kg-consume-result').length, 0)
      assert(text(ui.tree()).includes('没有匹配节点'), 'An allowed relation with no records must remain empty')
      ui.control('清除筛选').props.onClick(); ui.render()
      assert.equal(ui.control('关系上下文筛选').props.value, 'all')
      const before = ui.calls.length; await ui.search()
      assert.equal(ui.calls.length, before, 'Clear all must not issue an unbounded empty query')
      ui.props.restoreState = { seq: 1, ...identity, revision: 1, state: { tab: 'search', query: 'taxi',
        filters: { type: 'all', section: 'all', grounding: 'all', entailment: 'all' } } }; ui.render()
      assert.equal(ui.control('关系上下文筛选').props.value, 'all', 'Legacy perspectives retain their original broad relation context')
      ui.props.restoreState = { ...ui.props.restoreState, seq: 2, state: { ...ui.props.restoreState.state,
        filters: { ...ui.props.restoreState.state.filters, relation: 'maps_between' } } }; ui.render()
      delay = true; const pending = ui.search()
      ui.props.graph = { ...initial, revision: 2 }; ui.render()
      assert.equal(ui.control('关系上下文筛选').props.value, 'maps_between')
      held.resolve(await post('graph-query', held.payload)); await pending
      assert.equal(all(ui.tree(), node => node.props.className === 'kg-consume-result').length, 0, 'Old query cannot restore actions after scope changes')
      await ui.search()
      assert(text(ui.tree()).includes('版本'), 'Actual Host must reject stale revisions without clearing the draft')
      assert.equal(ui.control('查找知识的关键词').props.value, 'taxi')
      assert.equal(ui.control('关系上下文筛选').props.value, 'maps_between')
      ui.props.graph = initial; ui.render()
      ui.control('证据问答').props.onClick(); ui.render()
      assert(ui.control('依据原文回答').props.disabled)
      ui.props.readOnly = false; ui.render(); ui.change('向知识图提问', 'What connects these concepts?')
      await ui.control('依据原文回答').props.onClick(); await ui.settle()
      assert.deepEqual(ui.calls.at(-1).payload.relations, ['maps_between'], 'Answer retrieval must not lose the selected context')
      assert.equal(ui.control('向知识图提问').props.value, 'What connects these concepts?')
      assert(text(ui.tree()).includes('deliberately blocked'))
      ui.props.graph = { ...initial, graphOntology: presentation(legacy) }; ui.render()
      assert(ui.options().some(([id, label]) => id === 'maps_between' && label.includes('当前分类方案未定义')))
      assert(!ui.options().some(([id]) => id === 'has_rule' || id === 'unrelated_global_label'))
      ui.props.graph = { ...initial, graphOntology: undefined }; ui.render()
      assert.deepEqual(ui.options().filter(([id]) => id !== 'maps_between'),
        [['all', '全部关系上下文'], ...legacy.relationTypes.map(({ id, zh }) => [id, zh]), ['visual_source', '解读自图片'], ['visual_reference', '正文引用图片']], 'Descriptor-free legacy graphs use immutable proposition labels, not another graph global')
      const cached = { documentId: identity.documentId, state: ui.saved.at(-1) }
      const remounted = mount(code, { ...initial, revision: 2 }, transport, cached)
      try {
        assert.equal(remounted.control('向知识图提问').props.value, 'What connects these concepts?')
        remounted.control('查找知识').props.onClick(); remounted.render()
        assert.equal(remounted.control('查找知识的关键词').props.value, 'taxi')
        assert.equal(remounted.control('关系上下文筛选').props.value, 'maps_between')
        assert.equal(all(remounted.tree(), node => node.props.className === 'kg-consume-result').length, 0, 'Remount restores only draft inputs, never prior results')
        remounted.props.restoreState = { seq: 20, documentId: identity.documentId, revision: 2, state: {
          tab: 'search', query: 'APPLIED VIEW', filters: { type: 'all', relation: 'has_rule', section: 'all', grounding: 'all', entailment: 'all' },
        } }; remounted.render()
        assert.equal(remounted.props.restoreState.consumedSeq, remounted.props.restoreState.seq)
        assert.equal(remounted.consumed.length, 1)
        remounted.change('查找知识的关键词', 'AFTER VIEW APPLICATION'); remounted.change('关系上下文筛选', 'maps_between')
        remounted.control('证据问答').props.onClick(); remounted.render()
        const returned = mount(code, { ...initial, revision: 2 }, transport, { documentId: identity.documentId, state: remounted.saved.at(-1) })
        try {
          returned.props.restoreState = remounted.props.restoreState; returned.render()
          assert.equal(returned.control('向知识图提问').props.value, 'What connects these concepts?')
          assert.equal(returned.consumed.length, 0, 'A consumed restore cannot replay after panel remount')
          returned.control('查找知识').props.onClick(); returned.render()
          assert.equal(returned.control('查找知识的关键词').props.value, 'AFTER VIEW APPLICATION')
          assert.equal(returned.control('关系上下文筛选').props.value, 'maps_between')
          assert.equal(all(returned.tree(), node => node.props.className === 'kg-consume-result').length, 0)
        } finally { returned.dispose() }
        remounted.props.graph = { ...initial, source: { ...initial.source, documentId: 'another-document' } }; remounted.render()
        assert.equal(remounted.control('查找知识的关键词').props.value, '')
        assert.equal(remounted.control('关系上下文筛选').props.value, 'all')
        remounted.control('证据问答').props.onClick(); remounted.render()
        assert.equal(remounted.control('向知识图提问').props.value, '', 'Changing documents cannot inherit the previous question draft')
      } finally { remounted.dispose() }
      const foreign = mount(code, { ...initial, source: { ...initial.source, documentId: 'another-document' } }, transport, cached)
      try {
        assert.equal(foreign.control('查找知识的关键词').props.value, '')
        assert.equal(foreign.control('关系上下文筛选').props.value, 'all', 'Another document cannot receive a cached relation draft')
      } finally { foreign.dispose() }
      checks += 31
    } finally { ui.dispose() }
  }
  const state = { tab: 'search', query: '', filters: { relation: 'maps_between' } }
  const saved = await post('perspectives', { documentId: identity.documentId, action: 'save', perspective: { expectedRevision: 1, name: 'Relation context', state } })
  assert(!saved.error, JSON.stringify(saved.error))
  assert.equal(saved.perspective.state.filters.relation, 'maps_between')
  assert(!Object.hasOwn(saved.perspective.state, 'question'), 'Unsaved question drafts must not be silently persisted as task perspectives')
  assert.equal((await post('perspectives', { documentId: identity.documentId, action: 'resolve', id: saved.perspective.id })).resolved.state.filters.relation, 'maps_between')
  const old = { ...saved.perspective.state, filters: { ...saved.perspective.state.filters } }; delete old.filters.relation
  harness.store.db.prepare('INSERT INTO document_perspectives VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('legacy', identity.documentId, 'Legacy', JSON.stringify(old), 1, 1, 10, 10)
  const legacyBytes = harness.store.db.prepare('SELECT * FROM document_perspectives WHERE perspective_id = ?').get('legacy')
  const resolved = await post('perspectives', { documentId: identity.documentId, action: 'resolve', id: 'legacy' })
  assert.equal(resolved.resolved.state.filters.relation, 'all')
  assert.deepEqual(harness.store.db.prepare('SELECT * FROM document_perspectives WHERE perspective_id = ?').get('legacy'), legacyBytes)
  for (const relation of [null, 17, [], {}, 'r'.repeat(81)]) {
    const result = await post('perspectives', { documentId: identity.documentId, action: 'save',
      perspective: { expectedRevision: 1, name: 'Invalid', state: { ...state, filters: { relation } } } })
    assert.equal(result.error?.code, 'invalid_input', 'Malformed perspective relation must not be saved as all'); checks++
  }
  const before = harness.store.getCanonicalDocument(identity.documentId)
  const changed = { ...structuredClone(before), ontology: 'proposition-v1', nodes: [], edges: [] }
  harness.store.saveGraph(changed, { sourceText: harness.document.sourceText, sourceUnits: harness.document.sourceUnits, expectedRevision: 1 })
  const retained = await post('perspectives', { documentId: identity.documentId, action: 'resolve', id: saved.perspective.id })
  assert.equal(retained.resolved.state.filters.relation, 'maps_between', 'Ontology changes cannot silently broaden saved relation intent')
  assert(retained.resolved.revisionChanged)
  const stale = mount(source, { ...initial, revision: 2, graphOntology: presentation(legacy) }, post)
  try {
    stale.props.restoreState = { seq: 1, documentId: identity.documentId, revision: 2, state: retained.resolved.state }; stale.render()
    assert.equal(stale.control('关系上下文筛选').props.value, 'maps_between')
    await stale.search()
    assert(text(stale.tree()).includes('relations'), 'Unsupported restored relation must reach strict canonical validation, not a broadened query')
    stale.control('证据问答').props.onClick(); stale.render(); stale.props.readOnly = false; stale.render()
    stale.change('向知识图提问', 'Check old relation')
    await stale.control('依据原文回答').props.onClick(); await stale.settle()
    assert(text(stale.tree()).includes('relations'))
    const activity = await fetch(base + 'task-active'); assert.equal(activity.status, 200)
    assert.equal((await activity.json()).busy, false)
    stale.control('查找知识').props.onClick(); stale.render()
    stale.change('关系上下文筛选', 'supports'); await stale.search()
    assert(text(stale.tree()).includes('没有匹配节点'))
  } finally { stale.dispose() }
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM image_reviews').get().n, 0)
  checks += 12
  assert.equal(modelCalls, 0)
  console.log(JSON.stringify({ ok: true, checks, actualHostHTTP: true, generatedComponentParity: true,
    canonicalOptions: true, relationOnly: true, legacyPerspectiveBytesPreserved: true, staleIntentRetained: true,
    invalidRestoreNotBroadened: true, modelCalls, evidenceBoundary: 'Relations are recorded context, not semantic compatibility or truth' }))
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await harness.stop() }
