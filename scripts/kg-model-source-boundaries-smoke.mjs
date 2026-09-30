import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'

const documentId = 'document-stored-source-boundaries'
const sourceUnits = [
  { paragraph: 0, text: 'AtomicCodeSegment_'.repeat(14) },
  { paragraph: 7, text: 'Device A supplies Device B.' },
  { paragraph: 1000000000, text: 'This third unit records the permitted outcome.' },
]
const sourceText = sourceUnits.map(unit => unit.text).join('\n\n')
const evidence = unit => ({ documentId, sourceId: 'source-stored-boundaries', paragraph: unit.paragraph, quote: unit.text })
const graph = { summary: 'Stored paragraph identities', ontology: 'proposition-v1',
  source: { documentId, id: 'source-stored-boundaries', title: 'Stored source units', paragraphCount: 3 },
  nodes: sourceUnits.slice(1).map((unit, i) => ({ id: 'node-' + i, type: 'fact', text: unit.text,
    paragraph: unit.paragraph, quote: unit.text, evidence: [evidence(unit)], groundingStatus: 'grounded', entailmentStatus: 'unverified' })),
  edges: [{ fromNodeId: 'node-0', toNodeId: 'node-1', relation: 'supports', evidence: [evidence(sourceUnits[1])] }],
}
const contract = createGraphContract()
assert(contract.splitParagraphs(sourceText).length > sourceUnits.length, 'fixture must expose parser-versus-stored boundary drift')
assert(contract.validateGraphInvariants(graph, sourceText).blockingIssues.length > 0)
const accepted = contract.validateGraphInvariants(graph, sourceText, { sourceUnits, includeQuality: true })
assert.equal(accepted.blockingIssues.length, 0)
assert.equal(accepted.metrics.paragraphCoverage, 67, 'coverage uses stored identities without allocating sparse arrays')
const authenticated = structuredClone(graph)
contract.authenticateGraphEvidence(authenticated, sourceText, sourceUnits)
assert.deepEqual(authenticated.nodes.map(node => node.evidence), graph.nodes.map(node => node.evidence))
assert.deepEqual(authenticated.edges[0].evidence, graph.edges[0].evidence)
const misplaced = structuredClone(graph); misplaced.nodes[0].paragraph = 0
const mismatch = contract.validateGraphInvariants(misplaced, sourceText, { sourceUnits }).blockingIssues.find(issue => issue.code === 'node_paragraph_mismatch')
assert.equal(mismatch.proposedFix.nodePatch.patch.paragraph, 7, 'repair suggestions use original stored ids, not index positions')
const mutableUnits = structuredClone(sourceUnits)
contract.validateGraphInvariants(graph, sourceText, { sourceUnits: mutableUnits })
mutableUnits[1].text = 'The evidence has changed.'
assert(contract.validateGraphInvariants(graph, sourceText, { sourceUnits: mutableUnits }).blockingIssues.some(issue => issue.code === 'edge_relation_evidence_missing'),
  'mutating stored units must invalidate the cached source index')
for (const bad of [[...sourceUnits, sourceUnits[1]], [{ paragraph: -1, text: 'invalid' }], [{ paragraph: 0, text: '' }]]) {
  assert.throws(() => contract.validateGraphInvariants(graph, sourceText, { sourceUnits: bad }), error => error.code === 'source_units_invalid')
}

// Expose only canonical seeding; all commits still execute the shipped dynamic handlers.
let hostSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = "       harness.handle('document-load',"
assert.equal(hostSource.split(marker).length, 2)
hostSource = hostSource.replace(marker, '       harness.seedCanonical = rememberCanonicalGraphHost\n' + marker)
const { default: dynamicPlugin } = await import('data:text/javascript;base64,' + Buffer.from(hostSource).toString('base64'))
const oldHarness = globalThis.harness, handlers = new Map()
globalThis.harness = { handle: (name, fn) => handlers.set(name, fn) }
const harness = await modelLearningHarness({ fixture: { documentId, graph, sourceText, sourceUnits } })
try {
  dynamicPlugin().apply({ get() { return null }, interval() {} })
  globalThis.harness.seedCanonical(structuredClone(graph), sourceText, 1, sourceUnits)
  const readers = [
    { read: args => handlers.get('document-load')(args), post: (body, method) => handlers.get(method)(body) },
    { read: () => Promise.resolve({ graph: harness.store.getDocument(documentId) }), post: harness.post },
  ]
  for (const api of readers) {
    const saved = (await api.read({ documentId })).graph
    const body = { documentId, expectedRevision: 1, graph: saved, baseNodeIds: saved.nodes.map(node => node.id),
      baseEdgeKeys: saved.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation) }
    const forged = structuredClone(body)
    forged.graph.nodes[0].quote = 'Fabricated quotation'
    forged.graph.nodes[0].evidence = [{ paragraph: 7, quote: forged.graph.nodes[0].quote }]
    forged.sourceUnits = [{ paragraph: 7, text: forged.graph.nodes[0].quote }]
    assert.equal((await api.post(forged, 'graph-commit-preview')).error.code, 'invalid_evidence_quote', 'client source units cannot override canonical source authority')
    const wrongParagraph = structuredClone(body)
    wrongParagraph.graph.nodes[0].paragraph = 0
    assert.equal((await api.post(wrongParagraph, 'graph-commit')).error.code, 'invalid_evidence_quote', 'an exact quote in the wrong stored paragraph must be rejected')
    assert.equal((await api.post(body, 'graph-commit-preview')).valid, true)
    assert.equal((await api.post(body, 'graph-commit')).revision, 2)
    const restored = (await api.read({ documentId })).graph
    assert.deepEqual(restored.nodes.map(node => node.evidence), graph.nodes.map(node => node.evidence))
    assert.deepEqual(restored.edges[0].evidence, graph.edges[0].evidence)
    const onceMore = { ...body, graph: restored, expectedRevision: 2 }
    assert.equal((await api.post(onceMore, 'graph-commit-preview')).valid, true, 'source identities survive canonical saves')
  }
  assert.deepEqual(harness.store.getDocumentSourceUnits(documentId).map(unit => ({ ...unit })), sourceUnits)
  assert.equal(harness.store.getDocument(documentId).sourceText, sourceText)
} finally {
  harness.stop()
  if (oldHarness === undefined) delete globalThis.harness
  else globalThis.harness = oldHarness
}
console.log(JSON.stringify({ ok: true, storedParagraphsAuthoritative: true, sparseIdsPreserved: true, evidenceRetained: true,
  strictWrongParagraphAndForgeryRejection: true, dynamicPersistentCommitParity: true, sourceCacheInvalidated: true }))
