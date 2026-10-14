import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { createGraphContract } from '../src/index.host.js'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json } from './kg-model-draft-diagnosis-fixture.mjs'
import { diagnosticIdentityFixture, diagnosticIdentityCases } from './kg-model-diagnostic-identities-fixture.mjs'

const tools = [createModelStructureTools()]
for (const file of ['src/index.host.js', 'src/index.client.js', 'lib/index.js', 'lib/client.js', 'extension/viewer.js']) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  const open = source.indexOf('// >>> GENERATED MODEL STRUCTURE TOOLS >>>'), end = source.indexOf('// <<< END MODEL STRUCTURE TOOLS <<<', open)
  assert(open >= 0 && end > open, file)
  tools.push(new Function(source.slice(open, end) + '\nreturn MODEL_STRUCTURE_TOOLS')())
}
const difference = report => report.items.some(item => item.code === 'legacy_difference')
let cases = 0
for (const test of diagnosticIdentityCases) {
  const { document, structure, ports } = diagnosticIdentityFixture(test.identity), before = JSON.stringify(document)
  const matching = tools[0].diagnose(structure, { ports })
  assert(!difference(matching)); assert(!matching.items.some(item => item.code === 'shape_invalid'))
  test.change(ports[0])
  const expected = tools[0].diagnose(structure, { ports })
  assert(difference(expected), test.name + ' must differ from the literal canonical ID')
  assert.deepEqual(expected.items.filter(item => item.code !== 'legacy_difference'), matching.items)
  for (const tool of tools) assert.deepEqual(tool.diagnose(structure, { ports }), expected)
  assert.equal(JSON.stringify(document), before); cases++
}
for (const identity of ['part:input', 'part:string:input', 'a:\u0000\ud83d\ude80', '__proto__', 'constructor']) {
  const { structure, ports } = diagnosticIdentityFixture(identity)
  const expected = tools[0].diagnose(structure, { ports })
  for (const tool of tools) assert.deepEqual(tool.diagnose(structure, { ports: ports.toReversed() }), expected)
  ports[1] = structuredClone(ports[0])
  for (const tool of tools) assert(difference(tool.diagnose(structure, { ports })), 'multiplicity and role remain part of endpoint identity')
  cases++
}
// A malformed draft can contain a delimiter in its role. It still needs both
// the shape error and the independent legacy difference, never a false match.
const raw = diagnosticIdentityFixture('part')
raw.structure.slots[0].role = 'extra:input'; raw.ports[0].node.nodeId = 'part:extra'
for (const tool of tools) {
  const report = tool.diagnose(raw.structure, { ports: raw.ports })
  assert(report.items.some(item => item.code === 'shape_invalid'))
  assert(difference(report)); assert.equal(report.basis, 'recorded_fields_not_semantic_truth')
}
const contract = createGraphContract(), fixture = diagnosticIdentityFixture()
const expected = contract.connectionModels(fixture.document, { expectedRevision: 1, modelId: 'taxi', diagnosis: true })
assert(!expected.error); assert(!difference(expected.diagnosis))
const harness = await modelLearningHarness({ fixture: fixture.document }), calls = []
let damage = false
const view = draftDiagnosisView(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), harness, {
  observe: call => calls.push(call),
  transform(args, result) {
    if (damage && args.structureEdit && !result.error) {
      const port = result.legacyPorts.find(item => item.node.nodeId === 'undefined')
      assert(port); delete port.node.nodeId
    }
    return result
  },
})
try {
  const before = JSON.stringify(harness.store.getDocument(fixture.document.documentId))
  const actual = await harness.post({ documentId: fixture.document.documentId, expectedRevision: 1, modelId: 'taxi', diagnosis: true }, 'connection-models')
  assert.deepEqual(actual, expected)
  view.render(); await view.settle(); await view.flushDebounce()
  assert(!difference(json(calls.at(-1).report)))
  damage = true; view.props.active = false; view.render(); await view.settle()
  view.props.active = true; view.render(); await view.settle()
  const refreshed = calls.at(-1)
  assert(difference(json(refreshed.report)), 'generated draft diagnosis must report the missing legacy identity')
  assert.deepEqual(json(refreshed.report), tools[0].diagnose(json(refreshed.spec), { ports: json(refreshed.ports), names: json(refreshed.names) }))
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.document.documentId)), before)
  assert.equal(harness.store.getDocumentRevision(fixture.document.documentId), 1)
  assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.document.documentId, modelId: 'taxi' })).attempts, [])
  assert.equal((await harness.post({ documentId: fixture.document.documentId, expectedRevision: 0, modelId: 'taxi', diagnosis: true }, 'connection-models')).error.code, 'revision_conflict')
  console.log(JSON.stringify({ ok: true, cases, generatedFactories: tools.length, malformedDraftKept: true,
    actualGeneratedDraft: true, actualHostSqliteHttp: true, canonicalAndLearningReadOnly: true }))
} finally { view.stop(); harness.stop() }
