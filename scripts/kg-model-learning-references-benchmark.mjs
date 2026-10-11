import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createGraphContract } from '../src/index.host.js'
import { getOntology } from '../src/kg-ontology.mjs'
import { modelPortReuseFixture } from './kg-model-port-reuse-fixture-data.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-learning-references-benchmark.mjs <baseline-commit>')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { cwd, encoding: 'utf8' }).trim()
const source = execFileSync('git', ['show', baselineCommit + ':src/index.host.js'], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
const currentSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const load = async text => (await import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'))).createGraphContract().learningPlan
const baseline = await load(source), current = createGraphContract().learningPlan
const oldPredicate = 'other => other.nodeId === item.nodeId', identityCheck = 'seenReferences.has(item.nodeId)'
assert.equal(source.split(oldPredicate).length, 2); assert.equal(currentSource.split(identityCheck).length, 2)
const countedBaseline = await load(source.replace(oldPredicate, 'other => { globalThis.referenceWork++; return other.nodeId === item.nodeId }'))
const countedCurrent = await load(currentSource.replace(identityCheck, '(globalThis.referenceWork++, seenReferences.has(item.nodeId))'))
const count = (query, document, options, expected) => {
  globalThis.referenceWork = 0
  assert.deepEqual(query(document, options), expected)
  return globalThis.referenceWork
}
const stats = values => {
  values.sort((a, b) => a - b)
  return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.floor(values.length * 0.95)] }
}
const rows = []
for (const [structured, slots] of [[false, 40], [false, 512], [false, 4096], [false, 8192], [true, 40]]) {
  const document = modelPortReuseFixture({ chunks: 8, slots, structured }), before = JSON.stringify(document)
  const relations = new Map(getOntology(document.graph.ontology).relationTypes.map(relation => [relation.id, relation]))
  const nodeTypes = new Map(document.graph.nodes.map(node => [node.id, node.type]))
  for (const edge of document.graph.edges) {
    const relation = relations.get(edge.relation)
    assert(relation && relation.from.includes(nodeTypes.get(edge.fromNodeId)) && relation.to.includes(nodeTypes.get(edge.toNodeId)))
  }
  for (const exercise of ['prediction', 'counterexample', 'understanding']) {
    const options = { modelId: 'left', expectedRevision: 1, exercise }, expected = baseline(document, options)
    assert.equal(expected.error, undefined)
    assert.deepEqual(current(document, options), expected, 'Every field, role, condition, boundary, citation and reference priority must match')
    const baselinePredicateVisits = count(countedBaseline, document, options, expected)
    const currentIdentityChecks = count(countedCurrent, document, options, expected)
    assert.equal(currentIdentityChecks, slots + 1)
    for (let warm = 0; warm < 3; warm++) { baseline(document, options); current(document, options) }
    const oldSamples = [], newSamples = []
    // Instrumentation and assertions are excluded; alternate actual implementations in one runtime.
    for (let index = 0; index < 11; index++) for (const [query, samples] of index % 2
      ? [[current, newSamples], [baseline, oldSamples]] : [[baseline, oldSamples], [current, newSamples]]) {
      const start = performance.now(); query(document, options); samples.push(performance.now() - start)
    }
    const row = { structured, ports: slots, exercise, referenceCount: expected.tasks[0].references.length,
      baselinePredicateVisits, currentIdentityChecks, baseline: stats(oldSamples), current: stats(newSamples) }
    rows.push(row); console.log(JSON.stringify(row))
  }
  assert.equal(JSON.stringify(document), before)
}
let edgeCases = 0
for (const structured of [false, true]) for (const change of [
  document => { document.graph.nodes[0].evidence = [] },
  document => { document.graph.nodes.find(node => node.id === 'left').evidence = [] },
  document => { document.graph.nodes[0].evidence[0].documentId = 'wrong-document' },
  document => { document.graph.nodes[0].evidence[0].sourceId = 'wrong-source' },
  document => { document.graph.nodes[0].evidence[0].quote = 'Absent quotation' },
  document => { document.graph.nodes[0].state = 'rejected' },
  document => { document.graph.nodes[0].text = document.graph.nodes[1].text },
  document => { document.graph.edges.push({ ...structuredClone(document.graph.edges[0]), role: 'unknown' }) },
  document => { document.graph.nodes = document.graph.nodes.filter(node => node.id !== 'port-0') },
  document => { document.graph.edges = [] },
  document => { const model = document.graph.nodes.find(node => node.id === 'left'); if (model.modelStructure) {
    model.modelStructure.slots[1].conceptId = 'port-0'; model.modelStructure.slots[1].label = '另一个时间的同一概念'
  } },
  document => { const model = document.graph.nodes.find(node => node.id === 'left'); if (model.modelStructure) model.modelStructure.slots[0].role = 'unknown' },
  document => { for (let index = 0; index < 25; index++) {
    document.graph.nodes.push({ ...structuredClone(document.graph.nodes[0]), id: 'material-' + index, type: 'factor_material' })
    document.graph.edges.push({ fromNodeId: 'material-' + index, toNodeId: 'left', relation: 'builds',
      evidence: structuredClone(document.graph.nodes[0].evidence) })
  } document.graph.edges.push({ fromNodeId: 'port-0', toNodeId: 'left', relation: 'transfers_from',
    evidence: structuredClone(document.graph.nodes[0].evidence) }) },
]) {
  const document = modelPortReuseFixture({ chunks: 8, structured }); change(document)
  const before = JSON.stringify(document)
  for (const exercise of ['prediction', 'counterexample', 'understanding']) for (const expectedRevision of [1, 0, undefined]) {
    const options = { modelId: 'left', expectedRevision, exercise }
    assert.deepEqual(current(document, options), baseline(document, options))
    edgeCases++
  }
  assert.equal(JSON.stringify(document), before)
}
delete globalThis.referenceWork
console.log(JSON.stringify({ ok: true, baselineCommit, node: process.version,
  timedScope: 'Actual source learning-plan computation only; excludes instrumentation, equality checks, SQLite, HTTP and browser rendering',
  samples: 11, alternatedImplementations: true, completeResponseCases: rows.length, edgeCases, canonicalReadOnly: true, rows }, null, 2))
