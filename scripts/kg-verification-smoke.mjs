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
const missingRelationEvidence = checked.report.issues.find((item) => item.title === '关系边缺少直接原文证据')
assert(missingRelationEvidence && missingRelationEvidence.targetKind === 'edge', 'quick verification did not reject endpoint-only relation provenance')

const scopedGraph = {
  nodes: [
    { id: 'n2', type: 'fact', text: '第二段事实', quote: '第二段事实', paragraph: 2 },
    { id: 'n10', type: 'fact', text: '第十段事实', quote: '第十段事实', paragraph: 10 },
    { id: 'n20', type: 'fact', text: '第二十段事实', quote: '第二十段事实', paragraph: 20 },
  ],
  edges: [{ fromNodeId: 'n10', toNodeId: 'n20', relation: 'supports', evidence: [{ paragraph: 20, quote: '第二十段事实' }] }],
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
assert(scoped.report.metrics && scoped.report.metrics.checkedNodes === 2, 'nodes outside the selected source scope were still verified')
assert(scoped.report.metrics.checkedEdges === 0, 'edge with an out-of-scope endpoint was still verified')

const clientSource = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const hostSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
assert(!clientSource.includes('j-space') && !clientSource.includes('JSpaceToggle'), 'J-space client integration is still present')
assert(!hostSource.includes('j-space') && !hostSource.includes('skillContextFor'), 'J-space Host integration is still present')
assert(clientSource.includes("'复核并提交'"), 'recheck button is not labeled as an immediate submission')
assert(clientSource.includes('submitQuestion(draft, target)'), 'recheck handler does not submit the targeted question')
assert(clientSource.includes('relationTypeFix'), 'relation mismatch repair option is missing')
assert(clientSource.includes('mergeNodeProvenance'), 'merge fix does not preserve node provenance')
assert(clientSource.includes('mergeEvidenceRecords(previous.evidence'), 'merge fix does not preserve duplicate edge evidence')
assert(clientSource.includes('evidence: mergeEvidenceRecords([], p.evidence)'), 'edge add/update fixes can bypass relation evidence')
assert(hostSource.includes("(action === 'update_edge' || action === 'add_edge')"), 'Host does not require relation evidence for edge-changing fixes')
assert(clientSource.includes('qNeedsManualRepair'), 'question result does not expose the safe no-fix state')
assert(!clientSource.includes('const qCanDelete ='), 'question result still synthesizes a destructive delete fallback')
assert(!clientSource.includes("questionTarget.kind === 'edge' ? '删除此关系' : '删除此节点'"), 'question result still offers target deletion as the only repair')
assert(hostSource.includes('必须返回 add_edge'), 'question prompt does not require missing relations to become add_edge fixes')
assert(hostSource.includes('不得删除仍有原文依据的节点'), 'question prompt does not forbid destructive fixes for supported nodes')
assert(hostSource.includes('question_fix_dropped:verdict_'), 'question result does not enforce verdict/fix consistency')
assert(clientSource.includes('rememberLocalGraph'), 'graph commits persist local history before canonical acceptance')
assert(clientSource.includes('restoreAfterCommitFailure'), 'graph commit rejection does not restore the previous local graph')
assert(clientSource.includes('确定性验收未通过，未更新 canonical graph'), 'graph commit rejection does not explain canonical rollback')
console.log(JSON.stringify({ ok: true, issue: issue.id, target: issue.targetId, client: 'safe-question-repair-and-transactional-commit' }))
