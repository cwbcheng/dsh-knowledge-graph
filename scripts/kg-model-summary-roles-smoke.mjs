import assert from 'node:assert/strict'
import { createGraphContract } from '../src/index.host.js'
import { modelSummaryRolesFixture, summaryRolesWork } from './kg-model-summary-roles-fixture.mjs'
import { modelCatalogueSelectorsFixture } from './kg-model-catalogue-selectors-fixture-data.mjs'

const contract = createGraphContract(), query = (document, options = {}) => contract.connectionModels(document,
  { expectedRevision: document.revision, ...options })
const rows = []
for (const structured of [false, true]) {
  const document = modelSummaryRolesFixture({ structured }), before = JSON.stringify(document)
  const response = query(document), work = summaryRolesWork(query, document, {}, response)
  assert.equal(response.totalModels, 128); assert.equal(response.topics[0].count, 128)
  assert.equal(work.roleReads, 128 * 40 * (structured ? 3 : 1), 'Summary roles are read once; structured legacy warnings retain their own reads')
  for (const item of response.items) {
    assert.equal(item.inputs.length, 20); assert.equal(item.outputs.length, 20)
    assert.equal(item.structureComplete, true)
    assert.equal(item.entailmentStatus, 'unverified')
    assert.deepEqual(item.inputs.map(node => node.nodeId), Array.from({ length: 20 }, (_, i) => 'port-' + i * 2))
    assert.deepEqual(item.outputs.map(node => node.nodeId), Array.from({ length: 20 }, (_, i) => 'port-' + (i * 2 + 1)))
    assert.equal(item.inputs[0].citations.length, 8)
  }
  assert.equal(JSON.stringify(document), before)
  rows.push({ structured, ...work })
}
for (const structured of [false, true]) {
  const document = modelCatalogueSelectorsFixture({ structured }), before = JSON.stringify(document)
  const unknown = query(document, { modelId: 'catalogue-003' })
  assert.equal(unknown.model.structureComplete, false)
  assert(unknown.model.warnings.includes('存在未定角色或异常端点'))
  assert(!unknown.model.inputs.some(node => node.nodeId === 'port-1'))
  assert(!unknown.model.outputs.some(node => node.nodeId === 'port-1'))
  const sameName = query(document, { conceptId: 'other-port-1', role: 'input' })
  assert.deepEqual(sameName.items.map(node => node.nodeId), ['catalogue-002'])
  const dual = query(document, { modelId: 'catalogue-004' })
  if (structured) {
    assert(dual.model.inputs.some(node => node.nodeId === 'port-1'))
    assert(dual.model.outputs.some(node => node.nodeId === 'port-1'))
    assert.notEqual(dual.ports[1].unit, dual.ports[39].unit)
    assert.notEqual(dual.ports[1].timeState, dual.ports[39].timeState)
  }
  assert.equal(JSON.stringify(document), before)
}
console.log(JSON.stringify({ ok: true, rows, explicitRolesAndIdentity: true, unknownRolesRemainUnassigned: true,
  separateSlotsAndConditions: true, fullSourceValidation: true, canonicalReadOnly: true }))
