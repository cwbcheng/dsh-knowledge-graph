import assert from 'node:assert/strict'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'

// Literal IDs are ordinary canonical identities, never inferred endpoint roles.
export function diagnosticIdentityFixture(identity = 'undefined') {
  const document = modelStructureFixture()
  for (const node of document.graph.nodes) {
    if (node.id === 'distance') node.id = identity
    for (const slot of node.modelStructure?.slots || []) if (slot.conceptId === 'distance') slot.conceptId = identity
  }
  for (const edge of document.graph.edges) for (const key of ['fromNodeId', 'toNodeId']) if (edge[key] === 'distance') edge[key] = identity
  const structure = document.graph.nodes.find(node => node.id === 'taxi').modelStructure
  const ports = structure.slots.map(slot => ({ edgeKey: 'record-' + slot.id, edgeIndex: 0, role: slot.role, editable: true,
    node: { nodeId: slot.conceptId, type: 'concept', text: slot.label, citations: [] }, citations: [] }))
  assert.deepEqual(createModelStructureTools().errors(document.graph, new Map(document.sourceUnits.map(unit => [unit.paragraph, unit.text]))), [])
  return { document, structure, ports }
}

export const diagnosticIdentityCases = [
  { name: 'absent endpoint', identity: 'undefined', change: port => { delete port.node } },
  { name: 'absent endpoint ID', identity: 'undefined', change: port => { delete port.node.nodeId } },
  { name: 'null ID', identity: 'null', change: port => { port.node.nodeId = null } },
  { name: 'numeric ID', identity: '7', change: port => { port.node.nodeId = 7 } },
  { name: 'boolean ID', identity: 'false', change: port => { port.node.nodeId = false } },
  { name: 'object ID', identity: '[object Object]', change: port => { port.node.nodeId = {} } },
]

// Observation stays outside assertions and restores all raw record descriptors.
export function diagnosticIdentityTrace(diagnose, structure, ports, failAt = null) {
  const trace = [], descriptors = []
  const install = (object, fields, label) => {
    if (!object || typeof object !== 'object') return
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(object, field)
      if (!descriptor || !('value' in descriptor)) continue
      const key = label + '.' + field
      Object.defineProperty(object, field, { enumerable: descriptor.enumerable, configurable: true, get() {
        trace.push(key)
        if (failAt?.key === key && trace.filter(item => item === key).length === failAt.occurrence) throw new TypeError('diagnostic read: ' + key)
        return descriptor.value
      } })
      descriptors.push([object, field, descriptor])
    }
  }
  for (const [index, slot] of (structure?.slots || []).entries()) install(slot, ['conceptId', 'role', 'label', 'state', 'provenance'], 'slot-' + index)
  for (const [index, port] of ports.entries()) {
    install(port.node, ['nodeId', 'text', 'citations'], 'node-' + index)
    install(port, ['node', 'role', 'editable', 'citations', 'edgeKey', 'edgeIndex'], 'port-' + index)
  }
  let outcome
  try { outcome = { response: diagnose(structure, { ports }) } }
  catch (error) { outcome = { exception: { name: error.name, message: error.message, code: error.code } } }
  finally { for (const [object, key, descriptor] of descriptors) Object.defineProperty(object, key, descriptor) }
  return { outcome, trace }
}
