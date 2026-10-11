import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelDraftPortReuseFixture } from './kg-model-draft-port-reuse-fixture.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json, draftDiagnosisText as text } from './kg-model-draft-diagnosis-fixture.mjs'

const baseline = process.argv[2] ? execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { encoding: 'utf8' }).trim() : null
const generated = baseline ? execFileSync('git', ['show', baseline + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8e6 })
  : readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const tools = createModelStructureTools(), leafPaths = (value, prefix = []) => value && typeof value === 'object'
  ? Object.keys(value).flatMap(key => leafPaths(value[key], [...prefix, key])) : [prefix]
const at = (value, path) => path.reduce((item, key) => item[key], value)
for (const structured of [true, false]) {
  const fixture = modelDraftPortReuseFixture()
  if (!structured) for (const node of fixture.graph.nodes) delete node.modelStructure
  const harness = await modelLearningHarness({ fixture }), calls = [], reads = []
  let mutation = null, invalid = '', late = null
  const view = draftDiagnosisView(generated, harness, { observe: value => calls.push(value),
    transform(args, result, signal) {
      if (args.structureEdit && !result.error) {
        mutation?.(result.legacyPorts)
        if (invalid === 'document') result.documentId = 'another-document'
        if (invalid === 'model') result.model.nodeId = 'another-model'
        if (invalid === 'version') result.revision = 2
        reads.push(json(result))
        if (invalid === 'late') return new Promise(resolve => { late = { resolve: () => resolve(result), signal } })
      }
      return result
    },
  })
  const full = () => {
    const value = calls.at(-1); assert(value)
    assert.deepEqual(json(value.report), tools.diagnose(json(value.spec), { ports: json(value.ports), names: json(value.names) }))
    assert.equal(value.report.basis, 'recorded_fields_not_semantic_truth'); return value
  }
  const reload = async () => {
    view.props.active = false; view.render(); await view.settle()
    view.props.active = true; view.render(); await view.settle(); await view.flushDebounce()
    full()
  }
  try {
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
    view.render(); await view.settle(); await view.flushDebounce()
    const initial = full(), firstRead = reads[0], original = json(initial.spec), count = calls.length
    for (const id of ['__proto__', 'spaced/id:opaque identity']) assert(initial.ports.some(port => port.node.nodeId === id))
    for (let i = 0; i < 12; i++) {
      await reload(); assert.deepEqual(reads.at(-1), firstRead)
      assert.deepEqual(json(view.report()), json(initial.report).items.length > 20
        ? { ...json(initial.report), items: json(initial.report).items.slice(0, 20) } : json(initial.report))
    }
    assert.equal(reads.length, 13)
    assert.equal(calls.length, count, 'equal full legacy-port responses must reuse the whole draft report')
    assert.equal(full().ports, initial.ports); assert.equal(full().spec, initial.spec); assert.equal(full().names, initial.names)

    // Change every scalar in a real Host port, including nested endpoint and
    // relation citations. Comparing names alone would miss these changes.
    const paths = leafPaths(initial.ports[0])
    assert(paths.some(path => path[0] === 'citations' && path.at(-1) === 'quote'))
    assert(paths.some(path => path[0] === 'node' && path.includes('citations') && path.at(-1) === 'quote'))
    for (const path of paths) {
      const value = at(initial.ports[0], path)
      mutation = ports => {
        const owner = at(ports[0], path.slice(0, -1))
        owner[path.at(-1)] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : String(value ?? '') + ':changed'
      }
      const beforeChange = calls.length; await reload(); assert.equal(calls.length, beforeChange + 1, path.join('.'))
      assert.deepEqual(json(full().ports), reads.at(-1).legacyPorts)
      const accepted = full().ports, afterChange = calls.length; await reload()
      assert.equal(calls.length, afterChange); assert.equal(full().ports, accepted)
      mutation = null; await reload(); assert.equal(calls.length, afterChange + 1)
      assert.deepEqual(json(full().ports), json(initial.ports))
    }
    const variations = [
      ports => ports.reverse(), ports => ports.pop(), ports => ports.push(json(ports[0])),
      ports => { ports[0].additionalContext = { sourceId: 'new-source', quote: '完整额外来源' } },
      ports => { delete ports[0].editable }, ports => ports.splice(0),
    ]
    for (const change of variations) {
      mutation = change; const count = calls.length; await reload(); assert.equal(calls.length, count + 1)
      assert.deepEqual(json(full().ports), reads.at(-1).legacyPorts)
      const retained = full().ports; await reload(); assert.equal(calls.length, count + 1); assert.equal(full().ports, retained)
      mutation = null; await reload(); assert.equal(calls.length, count + 2)
    }
    const retained = full(), retainedVisible = json(view.report())
    mutation = ports => { ports[0].role = 'unknown'; ports[0].citations[0].quote += ':changed' }
    for (const mode of ['document', 'model', 'version']) {
      invalid = mode; const count = calls.length; await reload(); assert.equal(calls.length, count)
      assert.equal(full().ports, retained.ports); assert.deepEqual(json(view.report()), retainedVisible)
      assert(text(view.tree).includes('结构读取身份或版本不一致'))
    }
    invalid = 'late'; await reload(); assert(late)
    invalid = ''; mutation = null; await reload(); assert.equal(late.signal.aborted, true)
    const beforeLate = calls.length; late.resolve(); await view.settle(); assert.equal(calls.length, beforeLate)
    assert.equal(full().ports, retained.ports); assert.deepEqual(json(view.report()), retainedVisible)
    view.props.revision = 2; view.render(); await view.settle()
    assert.equal(calls.length, beforeLate + 1, 'a new document revision always diagnoses again')
    view.props.revision = 1; view.render(); await view.settle(); full()
    assert.deepEqual(json(full().spec), original); assert.equal(view.cache.size, 0)
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
    assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
    assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
    console.log(JSON.stringify({ structured, equalActualStructureReads: 12, fullDiagnoses: 0, changedPortLeafFields: paths.map(path => path.join('.')) }))
  } finally { view.stop(); harness.stop() }
}
console.log(JSON.stringify({ ok: true, equalFullDraftPortsReuse: true, everyActualPortLeafRecomputes: true,
  orderedPortArraysAndOptionalMetadata: true, emptyFullPortResponseReuses: true, literalEndpointIdsPreserved: true,
  foreignDocumentModelVersionAndLatePortsRejected: true, changedScopeRecomputed: true, fullDefensiveReportParity: true,
  conditionsEvidenceBindingsAndCanonicalUnchanged: true, actualGeneratedEditorAndHost: true, canonicalReadOnly: true }))
