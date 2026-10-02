import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelCatalogueSearchFixture } from './kg-model-catalogue-search-fixture-data.mjs'

// CSS contracts supplement, not replace, native drag/resize geometry acceptance.
const css = readFileSync(new URL('../extension/viewer.css', import.meta.url), 'utf8')
assert(css.includes('container: kg-models / inline-size'), 'Resizable model workspace needs its own width container')
assert(css.includes('container: kg-model-detail / inline-size'), 'Detail flow must use its own available width')
assert(css.includes('@container kg-models (min-width: 840px)'), 'Directory columns must follow the model pane, not the viewport')
assert(css.includes('@container kg-model-detail (min-width: 640px)'), 'Readable flow columns require enough detail width')
assert(css.includes('@container kg-model-detail (min-width: 560px)'), 'Paired examples and forms need a detail-width gate')
assert(css.includes('.kg-model-workspace { display: grid; grid-template-columns: minmax(0,1fr);'))
assert(css.includes('.kg-model-flow { display: grid; grid-template-columns: minmax(0,1fr);'))
assert(css.includes('.kg-model-arrow { align-self: center; justify-self: center; width: 20px; height: 27px; line-height: 27px; text-align: center; font-size: 18px; transform: rotate(90deg); pointer-events: none; }'), 'The vertical decorative arrow must retain fixed bounds and not intercept adjacent source controls')
for (const selector of ['.kg-model-learning-grid', '.kg-model-feedback-fields', '.kg-model-structure-grid', '.kg-model-compare-grid', '.kg-model-compare-choices', '.kg-model-review-row']) {
  assert(css.includes('.kg-models ' + selector), selector + ' must retain readable single-column defaults inside the model workbench')
}

let modelCalls = 0
const fixture = modelCatalogueSearchFixture()
const harness = await modelLearningHarness({ fixture, llm: { async createMessage() { modelCalls++; throw new Error('Layout cannot call models') } } })
const server = createServer(harness.handler)
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/connection-models'
const before = JSON.stringify(harness.store.getDocument(fixture.documentId))
const units = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
const read = async args => {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
  assert.equal(response.status, 200)
  const result = await response.json(); assert(!result.error); return result
}
try {
  const catalogue = await read({ documentId: fixture.documentId, expectedRevision: 1, query: 'DENSECATALOGUERECORD' })
  const model = catalogue.items[0]
  assert.equal(model.nodeId, 'catalogue-dense')
  assert.equal(model.modelFieldMatches.items.length, 8)
  assert.equal(model.modelFieldMatches.omitted, 28)
  const full = await read({ documentId: fixture.documentId, expectedRevision: 1, modelId: model.nodeId })
  assert.equal(full.structure.branches.length, 12, 'Layout must not prune dense model content')
  for (const hit of model.modelFieldMatches.items) {
    const detail = await read({ documentId: fixture.documentId, expectedRevision: 1, modelId: model.nodeId, branchId: hit.branchId })
    assert.equal(detail.model.nodeId, model.nodeId)
    assert(detail.structure.branches.some(branch => branch.id === hit.branchId))
  }
  const tail = await read({ documentId: fixture.documentId, expectedRevision: 1, query: 'BRANCHTAILCATALOGUE' })
  assert.equal(tail.items[0].nodeId, 'catalogue-tail-branch')
  assert.equal(tail.items[0].modelFieldMatches.items[0].branchId, 'tail-39')
  const last = await read({ documentId: fixture.documentId, expectedRevision: 1, modelId: 'catalogue-tail-branch', branchId: 'tail-39' })
  assert.equal(last.structure.branches.length, 40)
  assert(last.structure.branches.find(branch => branch.id === 'tail-39').condition.text.includes('BRANCHTAILCATALOGUE'))
  assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
  assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), units)
  for (const table of ['learning_attempts', 'image_reviews', 'document_perspectives']) assert.equal(harness.store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n, 0)
  assert.equal(modelCalls, 0)
  console.log(JSON.stringify({ namedContainerContracts: true, actualHttpReads: 12, allFortyBranchesRetained: true,
    hitBudgetPreserved: true, dataUnchanged: true, modelCalls, nativeGeometryRequiredSeparately: true }))
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); harness.stop() }
