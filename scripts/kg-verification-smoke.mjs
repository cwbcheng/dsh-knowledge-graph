import { readFileSync } from 'node:fs'
import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({ get() { return null }, interval() { return () => {} } })

const graph = {
  nodes: [
    { id: 'rule-1', type: 'rule', text: '规则节点' },
    { id: 'fact-1', type: 'fact', text: '事实节点' },
  ],
  edges: [{ fromNodeId: 'rule-1', toNodeId: 'fact-1', relation: 'example' }],
}
const checked = await handlers.get('verify-graph')({ text: '规则节点是一个例子。', graph, mode: 'quick' })
const issue = checked && checked.report && checked.report.issues && checked.report.issues.find((item) => item.title === '关系与源节点类型不匹配')
assert(issue, 'relation source-type mismatch was not reported')
assert(issue.targetKind === 'edge' && issue.targetId === 'rule-1>fact-1', 'mismatch target is incorrect')
assert(issue.proposedFix && issue.proposedFix.action === 'none', 'unsafe relation mismatch must not be auto-applied')

const scopedGraph = {
  nodes: [
    { id: 'n2', type: 'fact', text: '第二段事实', quote: '第二段事实', paragraph: 2 },
    { id: 'n10', type: 'fact', text: '第十段事实', quote: '第十段事实', paragraph: 10 },
  ],
  edges: [],
}
const scoped = await handlers.get('verify-graph')({
  text: 'x'.repeat(1000001),
  sourceUnits: [
    { paragraph: 2, text: '第二段事实。' },
    { paragraph: 10, text: '第十段事实。' },
  ],
  graph: scopedGraph,
  mode: 'quick',
})
assert(scoped && scoped.report && !scoped.error, 'source-unit scoped verification rejected cumulative text')
assert(scoped.report.scope && scoped.report.scope.kind === 'source-units', 'scoped verification metadata is missing')
assert(scoped.report.scope.ids.join(',') === '2,10', 'scoped paragraph map was not restored')

const clientSource = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
assert(clientSource.includes("'复核并提交'"), 'recheck button is not labeled as an immediate submission')
assert(clientSource.includes('submitQuestion(draft, target)'), 'recheck handler does not submit the targeted question')
assert(clientSource.includes('relationTypeFix'), 'relation mismatch repair option is missing')
assert(clientSource.includes('mergeNodeProvenance'), 'merge fix does not preserve node provenance')
assert(clientSource.includes('mergeEvidenceRecords(previous.evidence'), 'merge fix does not preserve duplicate edge evidence')
console.log(JSON.stringify({ ok: true, issue: issue.id, target: issue.targetId, client: 'recheck-submit-and-repair-option' }))
