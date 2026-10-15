import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { modelBranchCountsFixture } from './kg-model-branch-counts-fixture-data.mjs'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { draftDiagnosisView, draftDiagnosisJson as json } from './kg-model-draft-diagnosis-fixture.mjs'
import { draftCopyView, copyWorkSince } from './kg-model-draft-copy-fixture.mjs'

assert(process.argv[2], 'Usage: node scripts/kg-model-draft-copy-benchmark.mjs <baseline-commit>')
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', process.argv[2] + '^{commit}'], { encoding: 'utf8' }).trim()
const sources = [execFileSync('git', ['show', baselineCommit + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8e6 }),
  readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')]
const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[10], p95Ms: values[19] } }
const rows = []
for (const size of [{ slots: 2, branches: 3, examples: 3 }, { slots: 12, branches: 20, examples: 50 }, { slots: 40, branches: 40, examples: 100 }]) {
  const fixture = modelBranchCountsFixture(size), harness = await modelLearningHarness({ fixture }), calls = [[], []]
  const measured = sources.map((source, index) => draftCopyView(source, harness, { observe: value => calls[index].push(value) })), timed = []
  const prepare = async view => {
    view.render(); await view.settle(); await view.flushDebounce(); view.click('成对实例 (' + size.examples + ')'); view.change('选择编辑实例', 'example-1')
    for (let i = 0; i < 20; i++) view.change('推测过程', 'warm-' + i)
  }
  try {
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
    for (const view of measured) await prepare(view)
    for (const [label, values] of [['推测过程', ['', '仍需核对完整条件']], ['具体情境', ['', '独立情境']], ['实例原文段落 ', ['1e309', '', '1']]]) {
      for (const value of values) {
        for (const view of measured) view.change(label, value)
        assert.deepEqual(structuredClone(calls[1].at(-1)), structuredClone(calls[0].at(-1)))
        assert.deepEqual([...measured[1].cache.values()], [...measured[0].cache.values()])
      }
    }
    const start = measured.map(view => ({ ...view.work }))
    for (let i = 0; i < 20; i++) for (const view of measured) view.change('推测过程', '字段修改-' + i)
    const work = measured.map((view, index) => copyWorkSince(view, start[index]))
    assert.deepEqual(work[0], { specStringifies: 40, draftStringifies: 20, specParses: 20, draftParses: 0, storageWrites: 20 })
    assert.deepEqual(work[1], { specStringifies: 20, draftStringifies: 20, specParses: 0, draftParses: 20, storageWrites: 20 })
    for (const source of sources) { const view = draftDiagnosisView(source, harness); timed.push(view); await prepare(view) }
    const samples = [[], []]
    for (let sample = 0; sample < 21; sample++) {
      const elapsed = [0, 0]
      for (let repeat = 0; repeat < 24; repeat++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
        // Fresh event closure outside timing: each edit starts from the preceding
        // committed draft, as it does after React updates the actual input.
        const event = timed[index].field('推测过程').props.onChange
        const start = performance.now(); event({ target: { value: '保留条件-' + sample + '-' + repeat } }); timed[index].render()
        elapsed[index] += performance.now() - start
      }
      for (const index of [0, 1]) samples[index].push(elapsed[index] / 24)
    }
    assert.deepEqual(json(timed[1].report()), json(timed[0].report()))
    assert.deepEqual([...timed[1].cache.values()], [...timed[0].cache.values()])
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
    assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
    assert.deepEqual((await harness.post({ action: 'attempts', documentId: fixture.documentId, modelId: 'taxi' })).attempts, [])
    const row = { ...size, characters: JSON.stringify(fixture.graph.nodes.find(node => node.id === 'taxi').modelStructure).length,
      editsCounted: 20, baselineWork: work[0], currentWork: work[1], baseline: stats(samples[0]), current: stats(samples[1]) }
    rows.push(row); console.log(JSON.stringify(row))
  } finally { for (const view of [...measured, ...timed]) view.stop(); harness.stop() }
}
console.log(JSON.stringify({ ok: true, baselineCommit, fullDraftReportCacheAndNonFiniteParity: true, canonicalAndLearningUnchanged: true,
  timing: 'counterless_generated_edit_event_render_alternating_21x24_fresh_event_each_edit',
  noBrowserStorageIoDomNetworkOrHeapClaim: true, noTimingGate: true, rows }))
