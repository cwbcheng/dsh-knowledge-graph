import assert from 'node:assert/strict'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

export function modelConceptQueryFixture({ models = 32 } = {}) {
  const document = modelStructureFixture(), concept = document.graph.nodes[0]
  const { modelStructure, ...model } = document.graph.nodes.find(node => node.id === 'taxi')
  for (let i = 0; i < 128; i++) document.graph.nodes.push({ ...structuredClone(concept), id: 'search-concept-' + i, text: '检索概念 ' + i })
  for (const id of ['__proto__', 'constructor', 'spaced/id:opaque identity', '__PROTO__'])
    document.graph.nodes.push({ ...structuredClone(concept), id, text: '同名目录概念' })
  document.graph.nodes.push({ ...structuredClone(concept), id: 'rejected-concept', state: 'rejected', text: '已拒绝的检索概念' })
  for (let i = 0; i < models; i++) {
    const id = 'dense-model-' + i
    document.graph.nodes.push({ ...structuredClone(model), id })
    for (const [toNodeId, role] of [['distance', 'input'], ['fare', 'output']])
      document.graph.edges.push({ fromNodeId: id, toNodeId, relation: 'maps_between', role, evidence: [] })
  }
  return document
}

// Count only the actual input-array callbacks, separately from uninstrumented timing.
export function conceptQueryWork(query, document, options, expected) {
  const nodes = document.graph.nodes, edges = document.graph.edges
  const nodeMap = Object.getOwnPropertyDescriptor(nodes, 'map'), edgeEach = Object.getOwnPropertyDescriptor(edges, 'forEach')
  const map = nodes.map, forEach = edges.forEach
  let indexedNodes = 0, indexedEdges = 0
  Object.defineProperty(nodes, 'map', { configurable: true, value(callback, ...args) {
    return map.call(this, (...values) => { indexedNodes++; return callback(...values) }, ...args)
  } })
  Object.defineProperty(edges, 'forEach', { configurable: true, value(callback, ...args) {
    return forEach.call(this, (...values) => { indexedEdges++; return callback(...values) }, ...args)
  } })
  try { assert.deepEqual(query(document, options), expected) }
  finally {
    if (nodeMap) Object.defineProperty(nodes, 'map', nodeMap); else delete nodes.map
    if (edgeEach) Object.defineProperty(edges, 'forEach', edgeEach); else delete edges.forEach
  }
  return { indexedNodes, indexedEdges }
}

export const conceptQueryModes = [
  { concepts: true }, { concepts: true, query: '检索概念', offset: 20 },
  { concepts: true, query: 'concept-12' }, { concepts: true, query: ' ＳＥＡＲＣＨ－ＣＯＮＣＥＰＴ－１２ ' },
  { concepts: true, query: 'missing' }, { concepts: true, query: '__proto__' },
  { concepts: true, query: '同名目录概念' }, { concepts: true, query: 'rejected-concept' },
  { concepts: true, query: ' '.repeat(210) }, { concepts: true, offset: 999 },
  { concepts: true, offset: -1 }, { concepts: true, offset: '20' },
  { concepts: true, modelId: 'multi', structureEdit: true },
  { concepts: true, modelId: 'taxi', diagnosis: true },
  { concepts: true, modelId: 'taxi', compareModelId: 'multi' },
  { concepts: true, modelId: 'taxi', chainDraft: {} },
  { concepts: true, modelId: 'multi', conceptNames: ['__proto__'] },
  { concepts: true, expectedRevision: 0 },
]
