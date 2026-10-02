import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { getOntology } from '../src/kg-ontology.mjs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelSearchFixture } from './kg-consumption-model-search-fixture-data.mjs'

const fixture = modelSearchFixture()
const many = structuredClone(fixture.graph.nodes.find(node => node.id === 'search-condition'))
many.id = 'many-fields'
many.modelStructure.branches = Array.from({ length: 5 }, (_, index) => {
  const branch = structuredClone(many.modelStructure.branches[0]); branch.id = 'branch_' + 'x'.repeat(70) + '_' + index
  branch.label = 'Repeated label'
  for (const field of ['condition', 'mapping', 'boundary']) branch[field] = {
    text: 'MANYFIELDTOKEN <img src=x onerror=attack()> ' + field,
    provenance: { kind: 'unknown', paragraph: null, quote: '', note: '' },
  }
  return branch
})
many.modelStructure.examples = []
fixture.graph.nodes.push(many)
for (const [id, operator] of [['operator-a', '>'], ['operator-b', '<']]) {
  const model = structuredClone(fixture.graph.nodes.find(node => node.id === 'search-condition'))
  model.id = id
  model.modelStructure.branches[0].condition.text = 'OPERATORCASE x ' + operator + ' 3; recorded condition only.'
  fixture.graph.nodes.push(model)
}
const harness = await modelLearningHarness({ fixture })
const server = createServer((req, res) => harness.handler(req, res))
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
  const get = async query => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/graph-query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        documentId: fixture.documentId, expectedRevision: 1, query, types: ['connection_model'], hops: 1,
      }),
    })
    assert.equal(response.status, 200)
    const result = await response.json(); assert(!result.error, JSON.stringify(result.error)); return result
  }
  const responses = []
  for (const query of ['ONLYAFTERMIDNIGHT', 'FAREBRANCHONLY', 'NOTOBSERVATION', 'fullwidthcondition',
    'UNICODEPHRASE NORMALIZEDWORD', 'ONLYAFTERMIDNIGHT UNMATCHED', 'MANYFIELDTOKEN',
    'CONFLICTBRANCHCASE', 'ROLEBRANCHCASE']) responses.push(await get(query))
  const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
  const generated = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const extract = value => value.slice(value.indexOf('function KnowledgeConsumePanel('), value.indexOf('// Preview geometry', value.indexOf('function KnowledgeConsumePanel(')))
  assert.equal(extract(source).replaceAll('host.call(', 'rpc('), extract(generated))
  let slots = [], cursor = 0, effects = [], updates = [], tree
  const slot = init => slots[cursor++] ||= init()
  const state = initial => {
    const value = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [value.value, next => updates.push(() => { value.value = typeof next === 'function' ? next(value.value) : next })]
  }
  const environment = { h: (type, props, ...children) => ({ type, props: { ...props, children } }),
    React: { Fragment: 'fragment' }, useState: state, useRef: initial => slot(() => ({ current: initial })),
    useEffect: (fn, deps) => { const value = slot(() => ({})); if (!value.deps || deps.some((item, index) => !Object.is(item, value.deps[index]))) {
      effects.push(fn); value.deps = deps
    } }, documentIdOfGraph: graph => graph.source.documentId, chapterSectionsOf: () => [],
    TYPE_ORDER: ['connection_model'], TYPE_META: { connection_model: { label: 'Model', color: '#147d64' } },
    PROPOSITION_REL_LABEL: Object.fromEntries(getOntology('proposition-v1').relationTypes.map(({ id, zh }) => [id, zh])),
    MODEL_STRUCTURE_TOOLS: createModelStructureTools(),
  }
  const requests = []
  environment.host = { call(method, payload) { assert.equal(method, 'graph-query');
    return new Promise(resolve => requests.push({ payload, resolve })) } }
  runInNewContext(extract(source) + '\nthis.Component=KnowledgeConsumePanel', environment)
  const props = { ctx: { timeout() { throw new Error('No model calls') } }, graph: { source: { documentId: fixture.documentId }, revision: 1 } }
  const render = () => { for (let index = 0; index < 20; index++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0; tree = environment.Component(props)
    effects.splice(0).forEach(fn => fn()); if (!updates.length) return
  } throw new Error('Update loop') }
  const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test)) : !node || typeof node !== 'object' ? []
    : [...(test(node) ? [node] : []), ...all(node.props.children, test)]
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : String(node ?? '')
  const control = name => { const value = all(tree, node => node.props['aria-label'] === name || node.type === 'button' && text(node) === name)[0]; assert(value, name); return value }
  const settle = async () => { for (let index = 0; index < 5; index++) { await Promise.resolve(); render() } }
  const display = async result => {
    control('知识图检索关键词').props.onChange({ target: { value: result.query } }); render()
    control('检索').props.onClick(); render(); requests.at(-1).resolve(structuredClone(result)); await settle()
  }
  render()
  for (const result of responses) {
    await display(result)
    const positions = all(tree, node => node.props.className === 'kg-consume-field-hit')
    const expected = result.matches.reduce((n, match) => n + (match.modelFieldMatches?.items.length || 0), 0)
    console.log(JSON.stringify({ query: result.query, recordedLocations: expected, renderedLocations: positions.length }))
    assert.equal(positions.length, expected, 'Recorded branch field locations must be visible, not just the model title')
    for (const match of result.matches) {
      const card = all(tree, node => node.props.className === 'kg-consume-result').find(node => text(node).includes(match.nodeId))
      assert(card)
      const core = result.modelContexts.items.find(item => item.modelId === match.nodeId && item.status === 'recorded_core')
      for (const item of match.modelFieldMatches?.items || []) {
        assert(text(card).includes(item.branchId), 'Opaque branch identity must remain exact')
        const branch = core?.structure.branches.find(branch => branch.id === item.branchId)
        if (branch) assert(text(card).includes(branch[item.field].text), 'Display the whole recorded field without dropping qualifiers')
      }
      if (match.modelFieldMatches?.omitted) assert(text(card).includes('另有 ' + match.modelFieldMatches.omitted + ' 处命中位置未返回'))
    }
    assert.equal(all(tree, node => Object.hasOwn(node.props, 'dangerouslySetInnerHTML')).length, 0)
    assert(!text(tree).includes('条件已满足') && !text(tree).includes('已掌握'))
  }
  const partial = responses[5]; await display(partial)
  assert(text(tree).includes('部分词命中') && !text(tree).includes('短语命中'))
  for (const [index, label] of [[0, '个人表述'], [1, 'AI 建议'], [2, '原文记录'], [6, '来源未判定']]) {
    await display(responses[index]); assert(text(tree).includes(label))
  }
  await display(responses[2]); assert(text(tree).includes('错误示例') && text(tree).includes('语义未验证'))
  await display(responses[8]); assert(text(tree).includes('语义不支持'), 'Search highlighting cannot promote unsupported models')
  const operators = await get('OPERATORCASE x > 3')
  await display(operators)
  assert(text(tree).includes('OPERATORCASE x > 3;') && text(tree).includes('OPERATORCASE x < 3;'),
    'Broad text retrieval must retain both recorded operators, not interpret them as equivalent conditions')
  assert(text(tree).includes('规范化短语命中'), 'Broad retrieval normalizes punctuation; phrase labels must not imply literal equality')
  for (const mutation of [value => { value.modelContexts.items = [] },
    value => { value.modelContexts.items[0].revision = 2 }, value => { value.modelContexts.items[0].documentId += ' ' },
    value => { value.modelContexts.items[0].modelId += ' ' }]) {
    const result = structuredClone(responses[0]); mutation(result); await display(result)
    assert(text(tree).includes('字段内容未随本次检索返回'))
    assert.equal(all(tree, node => node.props.className === 'kg-consume-field-text').length, 0)
  }
  const invalid = structuredClone(responses[0]); invalid.matches[0].modelFieldMatches.basis = 'verified_applicability'
  await display(invalid); assert.equal(all(tree, node => node.props.className === 'kg-consume-field-hit').length, 0)
  await display(responses[0])
  control('检索').props.onClick(); render(); const pending = requests.at(-1)
  props.graph.revision = 2; render(); pending.resolve(responses[0]); await settle()
  assert.equal(all(tree, node => node.props.className === 'kg-consume-field-hit').length, 0)
  control('检索').props.onClick(); render(); requests.at(-1).resolve({ error: { code: 'revision_conflict', message: 'Version changed' } }); await settle()
  assert.equal(all(tree, node => node.props.className === 'kg-consume-result').length, 0)
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  console.log(JSON.stringify({ ok: true, actualHttpQueries: responses.length + 1, nonMutating: true,
    exactBranches: true, partialNotPhrase: true, normalizedPhraseNotLiteralEquality: true,
    oppositeOperatorsRetained: true, escapedMarkup: true, versionFenced: true, modelCalls: 0 }))
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
