import assert from 'node:assert/strict'
import { modelMaterialPageFixture } from './kg-model-material-page-fixture-data.mjs'

export const diagnosisRelatedFixture = (options = {}) => modelMaterialPageFixture({ materials: 64, chunks: 64, distributed: true, rules: true, ...options })
export const diagnosisRelatedModes = [{}, { offset: 20 }, { offset: 64 }, { offset: 1000 }, { offset: -1 }, { offset: '20' },
  { diagnosis: true }, { diagnosis: true, diagnosisOffset: 20 }, { diagnosis: true, diagnosisOffset: -1 },
  { diagnosis: true, diagnosisOffset: '20' }, { diagnosis: true, structureSources: true },
  { structureSources: true }, { structureSources: true, sourceOffset: 12 }, { structureSources: true, sourceOffset: 1000 },
  { structureEdit: true }, { compareModelId: 'right' }, { compareModelId: 'right', diagnosis: true },
  { compareModelId: 'right', structureSources: true }, { concepts: true }, { conceptNames: [] },
  { diagnosis: true, branchId: 'conditional' }, { diagnosis: true, branchId: 'missing' },
  { expectedRevision: 0 }, { expectedRevision: undefined }, { modelId: 'missing', diagnosis: true },
  ...['prediction', 'counterexample', 'understanding'].map(exercise => ({ exercise }))]

export const diagnosisRelatedQuery = (contract, document, options = {}) => (options.exercise ? contract.learningPlan : contract.connectionModels)(document,
  { modelId: 'left', expectedRevision: document.revision, ...options })

// Count unused material collection separately from timings. Preserve and restore
// every descriptor even if a query throws; never count all unrelated Map writes.
export function diagnosisRelatedWork(query, document, options, expected) {
  const nodes = new Set(document.graph.nodes), descriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'set')
  let relatedEntries = 0
  Map.prototype.set = function (key, value) {
    if (nodes.has(value?.node) && Array.isArray(value.links)) relatedEntries++
    return descriptor.value.call(this, key, value)
  }
  try { assert.deepEqual(query(document, options), expected) }
  finally { Object.defineProperty(Map.prototype, 'set', descriptor) }
  return { relatedEntries }
}

// These reads can throw before diagnosis. Avoiding link allocation must retain
// their order, including indirect has_rule material identities and rule types.
export function diagnosisRelatedTrace(query, document, options = {}, failAt = null) {
  const trace = [], descriptors = []
  const install = (object, field, identity) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, field)
    if (!descriptor || !('value' in descriptor)) return
    const label = identity + '.' + field
    Object.defineProperty(object, field, { enumerable: descriptor.enumerable, configurable: true, get() {
      trace.push(label)
      if (failAt?.label === label && trace.filter(item => item === label).length === failAt.occurrence) throw new TypeError('fixture read: ' + label)
      return descriptor.value
    } })
    descriptors.push([object, field, descriptor])
  }
  for (const [index, node] of document.graph.nodes.entries()) for (const field of ['id', 'type']) install(node, field, 'node-' + index)
  for (const [index, edge] of document.graph.edges.entries()) for (const field of ['fromNodeId', 'toNodeId', 'relation']) install(edge, field, 'edge-' + index)
  let outcome
  try { outcome = { response: query(document, options) } }
  catch (error) { outcome = { exception: { name: error.name, message: error.message, code: error.code } } }
  finally { for (const [object, field, descriptor] of descriptors) Object.defineProperty(object, field, descriptor) }
  return { outcome, trace }
}
