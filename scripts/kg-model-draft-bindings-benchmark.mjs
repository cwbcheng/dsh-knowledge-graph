import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'
import { countExampleBindingReads } from './kg-model-example-bindings-fixture-data.mjs'
import { diagnosticGetterFixture } from './kg-model-diagnostic-pair-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json } from './kg-model-draft-diagnosis-fixture.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-draft-bindings-benchmark.mjs <baseline-commit>')
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { encoding: 'utf8' }).trim()
const oldSource = execFileSync('git', ['show', baselineCommit + ':src/kg-model-structure.mjs'], { encoding: 'utf8' })
const oldTools = (await import('data:text/javascript;base64,' + Buffer.from(oldSource).toString('base64'))).createModelStructureTools()
const tools = createModelStructureTools()
const sources = [execFileSync('git', ['show', baselineCommit + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8e6 }),
  readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')]
const stats = values => { values.sort((a,b) => a-b); return { medianMs: values[7], p95Ms: values[14] } }
const work = (run, expected) => {
  const measured = countExampleBindingReads(run); assert.deepEqual(measured.response, expected)
  const { response, ...counts } = measured; return counts
}
const rows = []
for (const size of [{ slots: 2, branches: 3, examples: 3 }, { slots: 12, branches: 20, examples: 50 }, { slots: 40, branches: 40, examples: 100 }]) {
  const fixture = modelBranchCountsFixture(size), spec = fixture.graph.nodes.find(node => node.id === 'taxi').modelStructure
  const expected = oldTools.diagnose(spec)
  const baselineWork = work(() => oldTools.diagnose(spec), expected), currentWork = work(() => tools.diagnoseOwnedDraft(spec), expected)
  assert(currentWork.bindingSomeVisits <= baselineWork.bindingSomeVisits)
  const harness = await modelLearningHarness({ fixture }), calls = [[], []]
  const observed = sources.map((source, i) => draftDiagnosisView(source, harness, { observe: value => calls[i].push(value) }))
  const views = []
  try {
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
    for (const view of observed) { view.render(); await view.settle(); await view.flushDebounce(); view.click('成对实例 (' + size.examples + ')'); view.change('选择编辑实例', 'example-1') }
    for (const value of ['第一次推测', '条件待核对', '']) {
      for (const view of observed) view.change('推测过程', value)
      assert.deepEqual(json(calls[1].at(-1)), json(calls[0].at(-1)))
    }
    // Separate uninstrumented generated event + render samples: includes JSON
    // cloning, storage and React element creation, excludes UI lookup and I/O.
    for (const source of sources) {
      const view = draftDiagnosisView(source, harness); views.push(view)
      view.render(); await view.settle(); await view.flushDebounce(); view.click('成对实例 (' + size.examples + ')'); view.change('选择编辑实例', 'example-1')
      for (let warm = 0; warm < 10; warm++) view.change('推测过程', 'warm-' + warm)
    }
    const events = views.map(view => view.field('推测过程').props.onChange), samples = [[], []]
    for (let sample = 0; sample < 15; sample++) for (const i of sample % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now()
      for (let repeat = 0; repeat < 16; repeat++) { events[i]({ target: { value: '推测条件-' + sample + '-' + repeat } }); views[i].render() }
      samples[i].push((performance.now() - start) / 16)
    }
    assert.deepEqual(json(views[1].report()), json(views[0].report()))
    assert.deepEqual([...views[1].cache.values()], [...views[0].cache.values()])
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
    assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
    const row = { ...size, characters: JSON.stringify(spec).length, baselineWork, currentWork,
      baseline: stats(samples[0]), current: stats(samples[1]) }
    rows.push(row); console.log(JSON.stringify(row))
  } finally { for (const view of [...observed, ...views]) view.stop(); harness.stop() }
}
// Public raw diagnosis retains accessor/toJSON execution and exception order.
const outcome = run => { try { return { report: run() } } catch (e) { return { error: { name: e.name, message: e.message, code: e.code } } } }
for (const factory of [() => diagnosticGetterFixture(modelBranchCountsFixture), () => {
  const s = modelBranchCountsFixture().graph.nodes.find(n => n.id === 'taxi').modelStructure
  s.toJSON = () => { throw new Error('raw stringify failure') }; return s
}]) assert.deepEqual(outcome(() => tools.diagnose(factory())), outcome(() => oldTools.diagnose(factory())))
const readTrace = tool => {
  const s = modelBranchCountsFixture({ slots: 40 }).graph.nodes.find(n => n.id === 'taxi').modelStructure, trace = []
  for (const [i, e] of s.examples.entries()) for (const key of ['inputs', 'outputs']) for (const [j, b] of e[key].entries()) {
    const value = b.value
    Object.defineProperty(b, 'value', { enumerable: true, get() { trace.push(i + ':' + key + ':' + j); return value } })
  }
  return { outcome: outcome(() => tool.diagnose(s)), trace }
}
assert.deepEqual(readTrace(tools), readTrace(oldTools))
console.log(JSON.stringify({ ok: true, baselineCommit, fullOrderedReportParity: true, rawAccessorAndExceptionParity: true,
  canonicalAndLearningUnchanged: true, timing: 'generated_editor_edit_event_render_alternating_15x16_no_counters_no_io',
  noBrowserNetworkHeapOrWallClockGate: true, rows }))
