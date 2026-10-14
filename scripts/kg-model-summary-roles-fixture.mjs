import assert from 'node:assert/strict'
import { modelEndpointCitationsFixture } from './kg-model-endpoint-citations-fixture-data.mjs'

export function modelSummaryRolesFixture({ structured = true, models = 128 } = {}) {
  return modelEndpointCitationsFixture({ structured, models, chunks: 16 })
}

export function summaryRolesWork(query, document, options, expected) {
  const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map'), ports = [], seen = new WeakSet()
  const chunks = document.graph.staging.chunks, find = chunks.find
  let roleReads = 0, sourceLookups = 0, response
  Array.prototype.map = function (...args) {
    const result = map.value.apply(this, args)
    for (const port of result) {
      if (!port || typeof port !== 'object' || !Object.hasOwn(port, 'storedRole') || !Object.hasOwn(port, 'edgeIndex')
        || !Object.hasOwn(port, 'node') || seen.has(port)) continue
      const descriptor = Object.getOwnPropertyDescriptor(port, 'role')
      if (!descriptor || !('value' in descriptor)) continue
      seen.add(port); ports.push([port, descriptor])
      Object.defineProperty(port, 'role', { enumerable: descriptor.enumerable, configurable: true,
        get() { roleReads++; return descriptor.value } })
    }
    return result
  }
  chunks.find = function (...args) { sourceLookups++; return find.apply(this, args) }
  try { response = query(document, options) }
  finally {
    Object.defineProperty(Array.prototype, 'map', map)
    delete chunks.find
    for (const [port, descriptor] of ports) Object.defineProperty(port, 'role', descriptor)
  }
  // Restore descriptors before assertions so observation adds no assertion reads.
  assert.deepEqual(response, expected)
  return { projectedPorts: ports.length, roleReads, sourceLookups }
}

// Observe raw records separately from the owned projections counted above.
export function summaryRolesTrace(query, document, options, failAt = null) {
  const trace = [], descriptors = []
  const install = (object, fields, identity) => {
    if (!object || typeof object !== 'object') return
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(object, field)
      if (!descriptor || !('value' in descriptor)) continue
      const label = identity + '.' + field
      Object.defineProperty(object, field, { enumerable: descriptor.enumerable, configurable: true, get() {
        trace.push(label)
        if (failAt?.label === label && trace.filter(item => item === label).length === failAt.occurrence) throw new TypeError('fixture read: ' + label)
        return descriptor.value
      } })
      descriptors.push([object, field, descriptor])
    }
  }
  for (const [index, node] of document.graph.nodes.entries()) {
    install(node, ['id', 'type', 'text', 'paragraph', 'state', 'entailmentStatus'], 'node-' + index)
    for (const [slotIndex, slot] of (node.modelStructure?.slots || []).entries()) {
      install(slot, ['conceptId', 'role', 'label', 'unit', 'state'], 'slot-' + index + '-' + slotIndex)
      install(slot.provenance, ['kind', 'paragraph', 'quote'], 'slot-source-' + index + '-' + slotIndex)
    }
    for (const [branchIndex, branch] of (node.modelStructure?.branches || []).entries()) for (const key of ['condition', 'mapping', 'boundary']) {
      install(branch[key], ['text'], 'branch-' + index + '-' + branchIndex + '-' + key)
      install(branch[key].provenance, ['kind', 'paragraph', 'quote'], 'branch-source-' + index + '-' + branchIndex + '-' + key)
    }
  }
  for (const [index, edge] of document.graph.edges.entries()) install(edge, ['fromNodeId', 'toNodeId', 'relation', 'role', 'state'], 'edge-' + index)
  let outcome
  try { outcome = { response: query(document, options) } }
  catch (error) { outcome = { exception: { name: error.name, message: error.message, code: error.code } } }
  finally { for (const [object, field, descriptor] of descriptors) Object.defineProperty(object, field, descriptor) }
  return { outcome, trace }
}
