import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import hostPlugin from '../src/index.host.js'

const handlers = new Map()
globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({ get() { return null }, interval() { return () => {} } })

const graph = {
  ontology: 'learning-view-v1',
  nodes: [
    { id: 'concept', type: 'concept', text: '感觉：器官的加工阶段。', quote: '感觉：器官的加工阶段。', paragraph: 0 },
    { id: 'intension', type: 'intension_description', text: '感觉：器官的加工阶段。', quote: '感觉：器官的加工阶段。', paragraph: 0 },
    { id: 'same-a', type: 'concept', text: '同类概念', quote: '同类概念', paragraph: 0 },
    { id: 'same-b', type: 'concept', text: '同类概念', quote: '同类概念', paragraph: 0 },
  ],
  edges: [{ fromNodeId: 'intension', toNodeId: 'concept', relation: 'states_intension',
    evidence: [{ paragraph: 0, quote: '感觉：器官的加工阶段。' }] }],
}
const response = await handlers.get('verify-graph')({ text: '感觉：器官的加工阶段。同类概念。', graph, mode: 'quick' })
assert(!response.error, JSON.stringify(response.error))
const duplicateIssues = response.report.issues.filter(issue => issue.invariantCode === 'node_duplicate_suspected')
assert(!duplicateIssues.some(issue => issue.targetId === 'concept' && issue.title.includes('intension')),
  'a concept and its intension are distinct roles, not duplicate nodes')
assert(duplicateIssues.some(issue => issue.title.includes('same-a') && issue.title.includes('same-b')),
  'same-type similarity should still be available for manual review')
assert(duplicateIssues.every(issue => issue.proposedFix.action === 'none' && issue.confidence == null),
  'similarity alone must not authorize an automatic merge or claim calibrated confidence')

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = client.indexOf('      function bulkFixEligible(issue) {')
const end = client.indexOf('      function newNodeId() {', start)
assert(start >= 0 && end > start)
let patchCalls = 0
const { bulkFixEligible, applyAllFixable } = new Function('applyPatch', 'updateIssueStatus',
  client.slice(start, end) + '; return { bulkFixEligible, applyAllFixable }')(
  (current, issue) => { patchCalls++; return { ...current, applied: [...(current.applied || []), issue.id] } },
  (report, id) => ({ ...report, issues: report.issues.map(issue => issue.id === id ? { ...issue, status: 'applied' } : issue) }),
)
const legacyMerge = { id: 'old-merge', source: 'local', status: 'open', proposedFix: {
  action: 'merge_nodes', nodePatch: { id: 'concept' }, mergeIntoId: 'intension' } }
const unsafeLocal = { id: 'unsafe', source: 'local', status: 'open', proposedFix: { action: 'update_node' } }
const aiFix = { id: 'ai', source: 'ai', status: 'open', safeRepairable: true, proposedFix: { action: 'update_node' } }
const unstableDelete = { id: 'index-delete', source: 'local', status: 'open', safeRepairable: true,
  proposedFix: { action: 'delete_edge', edgePatch: { index: 0 } } }
const safeLocal = { id: 'safe', source: 'local', status: 'open', safeRepairable: true,
  proposedFix: { action: 'delete_edge', edgePatch: { fromNodeId: 'a', toNodeId: 'b', relation: 'supports' } } }
const report = { issues: [legacyMerge, unsafeLocal, aiFix, unstableDelete, safeLocal] }
assert.equal(bulkFixEligible(legacyMerge), false)
assert.equal(bulkFixEligible(unstableDelete), false, 'index-only edge deletion cannot survive earlier batch edits')
const applied = applyAllFixable({ nodes: [], edges: [] }, report)
assert.deepEqual(applied.graph.applied, ['safe'])
assert.equal(applied.applied, 1)
assert.equal(patchCalls, 1, 'legacy and unreviewed proposals must never reach the bulk patcher')

const patchStart = client.indexOf('      function applyPatch(graph, issue) {')
const patchEnd = client.indexOf('      function patchAlreadySatisfied(graph, issue) {', patchStart)
assert(patchStart >= 0 && patchEnd > patchStart)
const applyPatch = new Function('cloneNodes', 'cloneEdges',
  client.slice(patchStart, patchEnd) + '; return applyPatch')(
  nodes => nodes.map(node => ({ ...node })), edges => edges.map(edge => ({ ...edge })),
)
assert.equal(applyPatch(graph, legacyMerge), graph, 'individual cross-type merge must also be rejected')

console.log(JSON.stringify({ ok: true, crossTypePairIgnored: true, similarityManualOnly: true,
  staleBulkMergeBlocked: true, individualCrossTypeMergeBlocked: true }))
