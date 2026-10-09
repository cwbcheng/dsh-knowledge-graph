import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { getOntology } from '../src/kg-ontology.mjs'

const sources = ['src/index.client.js', 'lib/client.js'].map(path => readFileSync(new URL('../' + path, import.meta.url), 'utf8'))
const component = source => {
  const start = source.indexOf('function KnowledgeConsumePanel('), end = source.indexOf('// Preview geometry', start)
  assert(start >= 0 && end > start)
  return source.slice(start, end)
}
assert.equal(component(sources[0]).replaceAll('host.call(', 'rpc('), component(sources[1]), 'Persistent consumption component drifted beyond its transport rewrite')
const styles = sources.map(source => {
  const match = source.match(/(?:styles\.insert|insertStyles)\(`([\s\S]*?)`\)/)
  assert(match, 'Missing generated stylesheet')
  return match[1]
})
assert.equal(styles[0], styles[1])
const viewerStyles = readFileSync(new URL('../extension/viewer.css', import.meta.url), 'utf8')
assert.equal(viewerStyles, styles[0].replace('--kg-win-bg: #ffffff; position: fixed;', '--kg-win-bg: #ffffff; position: relative;'))
assert.match(styles[0], /\.kg-consume-panel \{[^}]*container-name: kg-consume;/)
assert.match(styles[0], /@container kg-consume \(min-width: 800px\)/)
assert.match(styles[0], /@container kg-consume \(max-width: 240px\)/)
assert(!/@media[^{}]*\{[^}]*\.kg-consume-form/.test(styles[0]), 'Workbench viewport width cannot determine the panel grid')
assert.match(styles[0], /\.kg-consume-result \{[^}]*overflow-wrap: anywhere;/)
assert.match(styles[0], /\.kg-consume-result-top > \.kg-consume-identity \{[^}]*white-space: pre-wrap;/)

const ids = ['model:' + 'namespace:'.repeat(16) + 'A', 'model:' + 'namespace:'.repeat(16) + 'B',
  ' 模型：输入时间:t0／m/s → 输出时间:t1／km/h ', 'model:' + 'unbroken'.repeat(500) + 'unique-end']
const rows = ids.map((id, index) => ({ id, type: 'connection_model', paragraph: index,
  sectionId: 'section', sectionTitle: 'section:' + 'unbroken'.repeat(28),
  text: 'usually:' + 'unbroken'.repeat(80), quote: 'evidence:' + 'unbroken'.repeat(60), entailmentStatus: 'unverified' }))
const graph = { revision: 1, source: { documentId: ' exact document ' } }
let owner, cursor, tree
const updates = [], calls = [], located = [], saved = []
const slot = init => { const index = cursor++; return owner.slots[index] ||= init() }
const state = initial => {
  const value = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
  return [value.value, next => updates.push(() => { value.value = typeof next === 'function' ? next(value.value) : next })]
}
const effect = (fn, deps) => {
  const value = slot(() => ({}))
  if (!value.deps || deps.some((item, index) => !Object.is(item, value.deps[index]))) {
    owner.effects.push(() => { value.cleanup?.(); value.cleanup = fn() }); value.deps = deps
  }
}
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const environment = { h, React: { Fragment: 'fragment' }, useState: state, useEffect: effect,
  useRef: initial => slot(() => ({ current: initial })),
  documentIdOfGraph: value => value.source.documentId, chapterSectionsOf: () => [{ id: 'section', title: 'Chapter' }],
  TYPE_ORDER: ['connection_model'], TYPE_META: { connection_model: { label: 'Model', color: '#3b82f6' } },
  PROPOSITION_REL_LABEL: Object.fromEntries(getOntology('proposition-v1').relationTypes.map(({ id, zh }) => [id, zh])),
  host: { call(method, payload) { assert.equal(method, 'graph-query', 'Layout tests must not initiate model or write operations')
    return new Promise(resolve => calls.push({ method, payload, resolve })) } }, console,
}
runInNewContext(component(sources[0]) + '\nthis.Component = KnowledgeConsumePanel', environment)
const props = { ctx: { timeout() { throw new Error('No model calls in layout tests') } }, graph,
  onLocateReference: reference => { located.push(reference); return true }, onStateChange: value => saved.push(value), readOnly: true }
owner = { slots: [], effects: [] }
const render = () => {
  for (let index = 0; index < 20; index++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0
    tree = environment.Component(props); owner.effects.splice(0).forEach(fn => fn())
    if (!updates.length) return
  }
  throw new Error('Component update loop')
}
const all = (node, test) => Array.isArray(node) ? node.flatMap(child => all(child, test))
  : !node || typeof node !== 'object' ? [] : [...(test(node) ? [node] : []), ...all(node.props?.children, test)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const control = name => {
  const item = all(tree, node => node.props['aria-label'] === name || node.type === 'button' && text(node) === name)[0]
  assert(item, 'Missing control: ' + name); return item
}
const settle = async () => { for (let index = 0; index < 5; index++) { await Promise.resolve(); render() } }
const respond = async (request, response = { graph: { nodes: rows }, matches: rows.map(row => ({ nodeId: row.id, score: 1 })), metrics: { candidateMatches: rows.length } }) => {
  request.resolve(response); await settle()
}
render()
assert.equal(tree.props.className, 'kg-card kg-consume-panel')
control('查找知识的关键词').props.onChange({ target: { value: 'full identity' } }); render()
control('查找').props.onClick(); render()
assert(control('查找中…').props.disabled)
await respond(calls.at(-1))
assert.equal(calls.at(-1).payload.documentId, ' exact document ')
assert.equal(calls.at(-1).payload.expectedRevision, 1)
const cards = all(tree, node => node.props.className === 'kg-consume-result')
assert.equal(cards.length, ids.length)
for (let index = 0; index < cards.length; index++) {
  const card = cards[index], identity = all(card, node => node.props.className === 'kg-hint kg-consume-identity')[0]
  assert.equal(text(identity), ids[index] + ' · P' + index + ' · ' + rows[index].sectionTitle)
  assert(text(card).includes(rows[index].text) && text(card).includes(rows[index].quote))
  assert.equal(all(card, node => Object.hasOwn(node.props, 'dangerouslySetInnerHTML')).length, 0)
  await card.props.onClick(); await settle()
  assert.equal(located.at(-1).nodeId, ids[index], 'Wrapping must not truncate or normalize the click identity')
}
assert.equal(new Set(located.map(item => item.nodeId)).size, ids.length)
control('查找').props.onClick(); render()
await respond(calls.at(-1), { error: { code: 'revision_conflict', message: 'Version changed: ' + ids[3] } })
assert.equal(all(tree, node => node.props.className === 'kg-consume-result').length, 0, 'Errors must hide stale result actions')
assert.equal(control('查找知识的关键词').props.value, 'full identity')
assert(text(tree).includes('Version changed: ' + ids[3]))
control('查找').props.onClick(); render()
const pending = calls.at(-1)
props.graph = { ...graph, revision: 2 }; render()
await respond(pending)
assert.equal(all(tree, node => node.props.className === 'kg-consume-result').length, 0, 'Old response must not restore actions after a source version change')
control('查找').props.onClick(); render(); await respond(calls.at(-1))
assert.equal(calls.at(-1).payload.expectedRevision, 2)
control('证据问答').props.onClick(); render()
assert.equal(control('向知识图提问').props['aria-label'], '向知识图提问')
assert(control('依据原文回答').props.disabled, 'Responsive layout must not override read-only model admission')
assert.equal(saved.at(-1).query, 'full identity')
owner.slots.forEach(value => value.cleanup?.())
console.log(JSON.stringify({ ok: true, exactRenderedIdentities: ids.length, generatedComponentParity: 2, stylesheetParity: 3,
  actualClickIdentity: true, staleResponseFenced: true, queryPreserved: true, modelCalls: 0,
  layoutProof: 'Separate native browser container, line-range and suffix visibility acceptance required' }))
