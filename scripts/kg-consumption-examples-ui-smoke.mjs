import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { getOntology } from '../src/kg-ontology.mjs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelExamplesFixture } from './kg-consumption-model-examples-fixture-data.mjs'

const fixture = modelExamplesFixture()
const hostile = structuredClone(fixture.graph.nodes.find(node => node.id === 'pair-user'))
hostile.id = 'pair-hostile'
hostile.text = 'PAIREDCONTEXT pair-hostile'
hostile.modelStructure.examples[0].scenario = '<img src=x onerror=attack()> x > 3, not x < 3; only sometimes.'
hostile.modelStructure.examples[0].reasoning = 'Often, not always. No conversion of units or time states is established.'
fixture.graph.nodes.push(hostile)
const harness = await modelLearningHarness({ fixture })
const server = createServer((req, res) => harness.handler(req, res))
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
  const get = async query => {
    const nodeIds = fixture.graph.nodes.filter(node => node.id === query || query.endsWith('-') && node.id.startsWith(query)).map(node => node.id)
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/graph-query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        documentId: fixture.documentId, expectedRevision: 1, query, nodeIds, types: ['connection_model'], hops: 0, maxNodes: nodeIds.length,
      }),
    })
    assert.equal(response.status, 200)
    const result = await response.json(); assert(!result.error, JSON.stringify(result.error)); return result
  }
  const queries = fixture.graph.nodes.filter(node => node.id.startsWith('pair-') && !node.id.startsWith('pair-many-')
    && !node.id.startsWith('pair-pressure-')).map(node => node.id).concat('pair-many-', 'pair-pressure-')
  const responses = new Map()
  for (const query of queries) responses.set(query, await get(query))
  const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
  const generated = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const extract = value => value.slice(value.indexOf('function KnowledgeConsumePanel('), value.indexOf('// Preview geometry', value.indexOf('function KnowledgeConsumePanel(')))
  assert.equal(extract(source).replaceAll('host.call(', 'rpc('), extract(generated))
  const quoteHelper = value => value.slice(value.indexOf('function exactSourceQuoteTarget('), value.indexOf('function KnowledgeConsumePanel('))
  assert.equal(quoteHelper(source), quoteHelper(generated))
  const quoteEnvironment = { documentIdOfGraph: graph => graph?.source?.documentId }
  runInNewContext(quoteHelper(source) + '\nthis.target=exactSourceQuoteTarget', quoteEnvironment)
  const quoteView = { graph: { source: { documentId: fixture.documentId }, revision: 1 }, sourceText: 'prefix\n\nfull quote; final qualifier.\n\nend',
    paragraphs: [{ start: 0, end: 6 }, { start: 8, end: 19 }, { start: 20, end: 36 }, { start: 38, end: 41 }] }
  const reference = { documentId: fixture.documentId, revision: 1, paragraph: 9, quote: 'full quote; final qualifier.' }
  assert.equal(JSON.stringify(quoteEnvironment.target(quoteView, reference)), JSON.stringify({ first: 1, last: 2 }), 'Map the complete exact source span, not the stored unit index or first sentence only')
  for (const mutate of [value => { value.documentId += ' ' }, value => { value.revision = 2 }, value => { value.paragraph = -1 },
    value => { value.quote = '' }, value => { value.quote = 'FULL QUOTE' }, value => { value.quote = 'not present' }, value => { value.quote = 'x'.repeat(2001) }]) {
    const invalid = { ...reference }; mutate(invalid); assert.throws(() => quoteEnvironment.target(quoteView, invalid))
  }
  assert.throws(() => quoteEnvironment.target({ ...quoteView, sourceText: quoteView.sourceText + reference.quote }, reference), /多个相同片段/)
  assert.throws(() => quoteEnvironment.target({ ...quoteView, paragraphs: [] }, reference), /阅读范围/)
  let slots = [], cursor = 0, effects = [], updates = [], tree
  const slot = init => slots[cursor++] ||= init()
  const state = initial => {
    const value = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [value.value, next => updates.push(() => { value.value = typeof next === 'function' ? next(value.value) : next })]
  }
  const tools = createModelStructureTools()
  const environment = { h: (type, props, ...children) => ({ type, props: { ...props, children } }),
    React: { Fragment: 'fragment' }, useState: state, useRef: initial => slot(() => ({ current: initial })),
    useEffect: (fn, deps) => { const value = slot(() => ({})); if (!value.deps || deps.some((item, index) => !Object.is(item, value.deps[index]))) {
      effects.push(fn); value.deps = deps
    } }, documentIdOfGraph: graph => graph.source.documentId, chapterSectionsOf: () => [],
    TYPE_ORDER: ['connection_model'], TYPE_META: { connection_model: { label: 'Model', color: '#147d64' } },
    PROPOSITION_REL_LABEL: Object.fromEntries(getOntology('proposition-v1').relationTypes.map(({ id, zh }) => [id, zh])),
    MODEL_STRUCTURE_TOOLS: tools,
  }
  const requests = [], located = []
  environment.host = { call(method, payload) { assert.equal(method, 'graph-query')
    return new Promise((resolve, reject) => requests.push({ payload, resolve, reject })) } }
  runInNewContext(extract(source) + '\nthis.Component=KnowledgeConsumePanel', environment)
  const props = { ctx: { timeout() { throw new Error('No model calls') } }, graph: { source: { documentId: fixture.documentId }, revision: 1 },
    onLocateReference(reference) { located.push(reference); return true } }
  const render = () => { for (let index = 0; index < 20; index++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0; tree = environment.Component(props)
    effects.splice(0).forEach(fn => fn()); if (!updates.length) return
  } throw new Error('Update loop') }
  const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test)) : !node || typeof node !== 'object' ? []
    : [...(test(node) ? [node] : []), ...all(node.props.children, test)]
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : String(node ?? '')
  const css = name => all(tree, node => node.props.className === name)
  const control = name => { const value = all(tree, node => node.props['aria-label'] === name || node.type === 'button' && text(node) === name)[0]; assert(value, name); return value }
  const settle = async () => { for (let index = 0; index < 5; index++) { await Promise.resolve(); render() } }
  const display = async result => {
    control('知识图检索关键词').props.onChange({ target: { value: result.query } }); render()
    control('检索').props.onClick(); render(); requests.at(-1).resolve(structuredClone(result)); await settle()
  }
  const group = id => { const found = css('kg-consume-result-group').find(node => node.props['data-model-id'] === id); assert(found, id); return found }
  render()
  for (const [query, result] of responses) {
    await display(result)
    const items = result.modelExampleContexts.items.filter(item => result.matches.some(match => match.nodeId === item.modelId))
    console.log(JSON.stringify({ query, returnedPairs: items.length, visiblePairs: css('kg-consume-example').length }))
    assert.equal(css('kg-consume-example').length, items.length, 'Returned paired situations, inputs, mapping and outputs must be readable')
    for (const item of items) {
      const card = group(item.modelId), body = text(card), core = result.modelContexts.items.find(core => core.modelId === item.modelId)
      const example = item.example
      for (const field of ['id', 'title', 'scenario', 'reasoning']) assert(body.includes(example[field]), field)
      const expected = tools.exampleStatus(core.structure, example)
      const article = all(card, node => node.props.className === 'kg-consume-example' && node.props['data-example-id'] === example.id)[0]
      assert(article)
      assert.equal(article.props['data-field-complete'], String(expected.complete))
      for (const slot of core.structure.slots) {
        const row = all(article, node => node.props['data-slot-id'] === slot.id)[0]; assert(row, slot.id)
        for (const key of ['id', 'conceptId', 'unit', 'state']) assert(text(row).includes(slot[key]), key)
        const binding = [...example.inputs, ...example.outputs].find(binding => binding.slotId === slot.id)
        if (binding?.value.trim()) assert(text(row).includes(binding.value), 'Never truncate or substitute a binding')
        else assert(text(row).includes(slot.role === 'unknown' ? '方向未判定' : '未填写'))
      }
      const branch = core.structure.branches.find(branch => branch.id === example.branchId)
      if (branch) for (const field of ['condition', 'mapping', 'boundary']) assert(body.includes(branch[field].text))
      else assert(body.includes('尚未关联分支'))
      assert(body.includes(example.provenance.quote) && body.includes(example.provenance.note))
      const buttons = all(article, node => node.type === 'button')
      assert.equal(buttons.length, example.provenance.kind === 'source' ? 1 : 0, 'User/AI/unknown quotes must not masquerade as source provenance')
      if (buttons.length) {
        await buttons[0].props.onClick(); await settle()
        const reference = located.at(-1)
        assert.equal(reference.documentId, fixture.documentId); assert.equal(reference.revision, 1)
        assert.equal(reference.paragraph, example.provenance.paragraph); assert.equal(reference.quote, example.provenance.quote)
        assert.equal(reference.sourceQuoteOnly, true)
        assert.equal(reference.nodeId, undefined, 'Example evidence may be in a different chapter from the model; do not filter it to the model chapter')
      }
    }
    for (const meta of result.modelExampleContexts.models || []) {
      if (!result.matches.some(match => match.nodeId === meta.modelId)) continue
      const body = text(group(meta.modelId))
      assert(body.includes('本次 ' + meta.examplesIncluded + ' / 已记录 ' + meta.totalExamples))
      if (meta.examplesOmitted) assert(body.includes(meta.examplesOmitted + ' 个未返回'))
    }
    assert.equal(all(tree, node => Object.hasOwn(node.props, 'dangerouslySetInnerHTML')).length, 0)
    for (const button of all(tree, node => node.type === 'button')) assert.equal(all(button.props.children, node => ['button', 'details', 'summary', 'input', 'select'].includes(node.type)).length, 0)
    assert(!text(tree).includes('已掌握') && !text(tree).includes('条件已满足') && !text(tree).includes('独立验证通过'))
  }
  for (const [id, label] of [['pair-wrong-model', '错误示例'], ['pair-type-model', '类型说明'],
    ['pair-uncited', '假设'], ['pair-unsupported-model', '语义不支持'], ['pair-no-reasoning', '尚未记录推测过程']]) {
    await display(responses.get(id)); assert(text(group(id)).includes(label), id + ': ' + label)
  }
  const valid = responses.get('pair-incomplete')
  const forged = structuredClone(valid)
  forged.modelExampleContexts.items[0].fieldCheck.complete = true
  forged.modelExampleContexts.items[0].fieldCheck.missingBindings = []
  await display(forged)
  assert.equal(css('kg-consume-example')[0].props['data-field-complete'], 'false', 'Recompute shared field checks instead of trusting a claimed success')
  assert(text(tree).includes('未填写'))
  const sourceResult = responses.get('pair-source')
  const mutations = [
    value => { delete value.modelExampleContexts },
    value => { value.modelExampleContexts.basis = 'verified' },
    value => { value.modelExampleContexts.items[0].documentId += ' ' },
    value => { value.modelExampleContexts.items[0].revision = 2 },
    value => { value.modelExampleContexts.items[0].modelId += ' ' },
    value => { value.modelExampleContexts.items[0].status = 'validated' },
    value => { value.modelContexts.items[0].documentId += ' ' },
    value => { value.modelContexts.items[0].revision = 2 },
    value => { value.modelContexts.items.push(structuredClone(value.modelContexts.items[0])) },
    value => { value.modelExampleContexts.models.push(structuredClone(value.modelExampleContexts.models[0])) },
    value => { value.modelExampleContexts.models[0].totalExamples++ },
    value => { value.modelExampleContexts.items.push(structuredClone(value.modelExampleContexts.items[0])); value.modelExampleContexts.examplesIncluded++; value.modelExampleContexts.models[0].examplesIncluded++ },
    value => { value.modelExampleContexts.items[0].example.branchId = 'absent-branch' },
    value => { value.modelExampleContexts.items[0].example.inputs[0].slotId = 'absent-slot' },
    value => { value.modelExampleContexts.items[0].example.outputs[0].slotId = value.modelExampleContexts.items[0].example.inputs[0].slotId },
    value => { value.modelExampleContexts.items[0].example.inputs.push(structuredClone(value.modelExampleContexts.items[0].example.inputs[0])) },
    value => { value.modelExampleContexts.items[0].example.scenario = 'x'.repeat(2001) },
    value => { value.modelExampleContexts.items[0].example.provenance.paragraph = -1 },
    value => { value.modelExampleContexts.items[0].example.provenance.kind = 'validated_source' },
    value => { value.modelExampleContexts.models[0].examplesOmitted = -1 },
    value => { value.modelExampleContexts.items = Array.from({ length: 9 }, () => structuredClone(value.modelExampleContexts.items[0])) },
    value => { value.modelExampleContexts.extra = 'x'.repeat(12001) },
  ]
  for (const mutate of mutations) {
    const result = structuredClone(sourceResult); mutate(result); await display(result)
    assert.equal(css('kg-consume-example').length, 0, 'Malformed/ambiguous/foreign/oversized context must not fall back to full raw node examples')
    assert(text(tree).includes('成对实例未随本次检索有效返回'))
    assert(css('kg-consume-result').length > 0, 'A missing example projection must not hide the model result')
  }
  await display(responses.get('pair-huge'))
  assert.equal(css('kg-consume-example').length, 0)
  assert(text(group('pair-huge')).includes('本次 0 / 已记录 1') && text(tree).includes('1 个未返回'))
  await display(sourceResult)
  control('检索').props.onClick(); render(); requests.at(-1).reject(new Error('Read failed')); await settle()
  assert.equal(css('kg-consume-example').length, 0); assert(text(tree).includes('Read failed'))
  assert.equal(control('知识图检索关键词').props.value, 'pair-source')
  control('检索').props.onClick(); render(); const pending = requests.at(-1)
  props.graph.revision = 2; render(); pending.resolve(sourceResult); await settle()
  assert.equal(css('kg-consume-example').length, 0)
  assert.equal(control('知识图检索关键词').props.value, 'pair-source')
  const revised = await get('pair-source'); revised.revision = 2
  await display(revised); assert.equal(css('kg-consume-example').length, 0, 'Response version must not bless old example/core versions')
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 0)
  console.log(JSON.stringify({ ok: true, actualHttpQueries: responses.size + 1, negativeContexts: mutations.length, negativeSourceTargets: 9,
    completeBindingsAndQualifiers: true, exactOpaqueIdentities: true, missingAndUnknownRoles: true,
    conflictingOriginsRetained: true, noTruthPromotion: true, sourceActionsExact: true, noNestedControls: true,
    noRawFallback: true, boundedCounts: true, errorsAndVersions: true, nonMutating: true, modelCalls: 0 }))
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
