import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      async function weaveRelationsHost('
assert.equal(source.split(marker).length, 2)
const instrumented = source.replace(marker, `      harness.semanticCacheTest = { weaveRelationsHost, attach(task) { activeTask = task } }
${marker}`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
const previousHarness = globalThis.harness
const harness = { handle() {} }
globalThis.harness = harness
let calls = 0
plugin().apply({ get(name) { return name === 'kgExtractor' ? { async weaveRelations() { calls++; return { edges: [] } } } : null }, interval() {} })
const api = harness.semanticCacheTest
const text = 'A worked example describes a general condition.'
const graph = {
  nodes: [
    { id: 'a', type: 'positive_example', text: 'A worked example', quote: 'A worked example', paragraph: 0, stage: 'data' },
    { id: 'b', type: 'intension_description', text: 'a general condition', quote: 'a general condition', paragraph: 0, relKind: 'basic' },
  ],
  edges: [{ fromNodeId: 'a', toNodeId: 'b', relation: 'exemplifies', role: 'input', mode: 'contrast', evidence: [{ paragraph: 0, quote: text }] }],
}
const hash = value => createHash('sha256').update(value).digest('hex')
async function weave(base, journal, sourceText = text) {
  let saved = journal
  const task = { title: '', kind: 'relation-retry', ontology: 'learning-view-v1', progress: {}, cancelled: false,
    relationWeave: journal, async persistRelationWeave(next) { saved = structuredClone(next) },
  }
  api.attach(task)
  const acc = { nodes: new Map(base.nodes.map(node => [node.id, structuredClone(node)])), edges: structuredClone(base.edges),
    edgeKeys: new Set(base.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation)), warnings: [],
  }
  const result = await api.weaveRelationsHost(task, null, acc, [sourceText], { documentId: 'semantic-cache' }, sourceText)
  return { result, saved }
}
try {
  const first = await weave(graph)
  assert.equal(calls, 1)
  assert.equal(Object.keys(first.saved.results).length, 1)
  const resumed = await weave(graph, first.saved)
  assert.equal(calls, 1, 'unchanged semantics must reuse successful empty results')
  assert.equal(resumed.result.coverage.remainingTargets, 0)
  for (const mutate of [
    base => { base.edges[0].role = 'output' },
    base => { base.edges[0].mode = 'analogy' },
    base => { base.nodes[0].stage = 'processed' },
  ]) {
    const changed = structuredClone(graph), cached = structuredClone(first.saved)
    mutate(changed)
    await assert.rejects(weave(changed, cached), error => error.code === 'checkpoint_invalid', 'changed relation meaning must not reuse an old search result')
    assert.equal(calls, 1, 'invalid recovery must not spend further model calls')
    assert.deepEqual(cached, first.saved, 'refusal must not rewrite saved candidates')
  }
  assert.equal(first.saved.version, 2)
  await assert.rejects(weave(graph, { ...first.saved, version: 999 }), error => error.code === 'checkpoint_invalid')

  // Frozen version-1 payload: the base omitted attributes, whereas the shared
  // context already contained declared node attributes in the previous release.
  const base = JSON.stringify({ summary: '',
    nodes: graph.nodes.map(({ id, type, text, quote, paragraph }) => ({ id, type, text, quote, paragraph })),
    edges: graph.edges.map(({ fromNodeId, toNodeId, relation, evidence }) => ({ fromNodeId, toNodeId, relation, evidence })),
  })
  const context = [
    { paragraph: 0, text },
    { id: 'a', type: 'positive_example', paragraph: 0, text: 'A worked example', stage: 'data' },
    { id: 'b', type: 'intension_description', paragraph: 0, text: 'a general condition', relKind: 'basic' },
  ].map(item => JSON.stringify(item)).join('\n')
  // A historical v1 journal had neither v2 output partitions nor recoveryStats.
  // Copy only its actual codec fields; do not attach a v2 root proof to a v1 binding.
  const legacy = { version: 1, binding: hash(JSON.stringify({
    policy: 'relation-weave-v1', ontology: 'learning-view-v1', sourceText: text, base,
    groups: [{ ids: ['a', 'b'], targets: ['a', 'b'], context }],
  })), totalGroups: first.saved.totalGroups, results: structuredClone(first.saved.results),
    coverage: structuredClone(first.saved.coverage) }
  assert(!Object.hasOwn(legacy, 'partitions') && !Object.hasOwn(legacy, 'recoveryStats'))
  assert.equal((await weave(graph, legacy)).result.coverage.remainingTargets, 0)
  assert.equal(calls, 1, 'compatible legacy journals must not regenerate saved groups')
  for (const journal of [first.saved, legacy]) {
    const staleSource = structuredClone(journal)
    await assert.rejects(weave(graph, staleSource, text + ' An additional source statement changes this search context.'),
      error => error.code === 'checkpoint_invalid', 'Neither legacy nor current results can survive a changed actual source')
    assert.deepEqual(staleSource, journal, 'Source mismatch must not rewrite cached work')
    const tampered = structuredClone(journal)
    tampered.results[0].norm.warnings.push('synthetic cache tamper without a matching norm hash')
    const before = structuredClone(tampered)
    await assert.rejects(weave(graph, tampered), error => error.code === 'checkpoint_invalid')
    assert.deepEqual(tampered, before, 'Refusal must leave the caller checkpoint untouched')
    assert.equal(calls, 1, 'Source or payload tampering must be rejected before any further provider call')
  }
  console.log(JSON.stringify({ ok: true, semanticCacheBinding: true, unchangedResultsReused: true, noCallsOnMismatch: true,
    legacyJournalCompatible: true, authenticV1WithoutPartitions: true, sourceAndPayloadTamperRejected: true }))
} finally {
  globalThis.harness = previousHarness
}
