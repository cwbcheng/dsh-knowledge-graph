import assert from 'node:assert/strict'
import { diagnosisRelatedFixture, diagnosisRelatedModes, diagnosisRelatedTrace } from './kg-model-diagnosis-related-fixture.mjs'

export const materialLinksFixture = diagnosisRelatedFixture
export const materialLinksTrace = diagnosisRelatedTrace
export const materialLinksModes = [...diagnosisRelatedModes, ...[19, 24, 25, 44, 63, 65, 69, 4096, 4101, Number.MAX_SAFE_INTEGER,
  NaN, Infinity, null, false, {}, [], 1.5].map(offset => ({ offset })),
  { compareModelId: 'right', offset: 4096 }, { structureSources: false, offset: 20 },
  { structureSources: true, offset: 64 }, { structureEdit: true, offset: 64 }]

export const materialLinksQuery = (contract, document, options = {}) => (options.exercise ? contract.learningPlan : contract.connectionModels)(document,
  { modelId: 'left', expectedRevision: document.revision, ...options })

// Observe only per-query material collections, never unrelated Maps. Counters
// are restored even when the real query throws and are excluded from timings.
export function materialLinksWork(query, document, options, expected) {
  const nodes = new Set(document.graph.nodes), collections = [], maps = new WeakSet(), descriptors = ['set', 'get', 'has'].map(field => [field, Object.getOwnPropertyDescriptor(Map.prototype, field)])
  const original = Object.fromEntries(descriptors.map(([field, descriptor]) => [field, descriptor.value]))
  let collectionLookups = 0
  Map.prototype.set = function (key, value) {
    if (nodes.has(value?.node) && Object.hasOwn(value, 'links')) { collections.push(value); maps.add(this) }
    return original.set.call(this, key, value)
  }
  for (const field of ['get', 'has']) Map.prototype[field] = function (key) { if (maps.has(this)) collectionLookups++; return original[field].call(this, key) }
  try { assert.deepEqual(query(document, options), expected) }
  finally { for (const [field, descriptor] of descriptors) Object.defineProperty(Map.prototype, field, descriptor) }
  return { relatedEntries: collections.length, linkArrays: collections.filter(item => Array.isArray(item.links)).length,
    constructedLinks: collections.reduce((sum, item) => sum + (item.links?.length || 0), 0), collectionLookups }
}

const duplicate = (document, id, extra, first = false) => document.graph.nodes[first ? 'unshift' : 'push']({
  ...structuredClone(document.graph.nodes.find(node => node.id === id)), ...extra })
export const materialLinksChanges = [() => {}, document => document.graph.nodes.reverse(), document => document.graph.edges.reverse(), document => document.sourceUnits.reverse(),
  ...[{}, { text: '最后一条同身份内容' }, { state: 'rejected' }, { type: 'concept' }].map(extra => document => duplicate(document, 'material-0', extra)),
  document => duplicate(document, 'left', { type: 'concept' }), document => duplicate(document, 'left', { type: 'concept' }, true),
  document => { document.graph.nodes.find(node => node.id === 'material-1').text = document.graph.nodes.find(node => node.id === 'material-0').text },
  document => { document.graph.edges.push(structuredClone(document.graph.edges.find(edge => edge.fromNodeId === 'mapping-material'))) },
  document => { document.graph.edges.push({ fromNodeId: 'left', toNodeId: 'left', relation: 'composes' }) },
  document => { document.graph.edges = document.graph.edges.filter(edge => edge.relation !== 'maps_between') },
  document => { document.graph.edges = [] }, document => { document.graph.edges = [null] }, document => { document.graph.edges = Array(2) },
  document => { document.graph.nodes = document.graph.nodes.filter(node => node.id !== 'material-0') },
  document => { document.graph.nodes = document.graph.nodes.filter(node => node.id !== 'rule-a') },
  document => { document.graph.nodes.find(node => node.id === 'rule-a').type = 'concept' },
  ...['foreign-source', null].map(sourceId => document => { document.graph.nodes.find(node => node.id === 'material-20').evidence[0].sourceId = sourceId }),
  document => { document.graph.nodes.find(node => node.id === 'material-20').evidence[0].documentId = 'foreign-document' },
  document => { document.graph.nodes.find(node => node.id === 'material-20').evidence[0].quote = '原文没有这句' },
  document => { document.graph.nodes.find(node => node.id === 'material-20').evidence[0].paragraph = 999999 },
  document => { document.sourceUnits = document.sourceUnits.filter((unit, index) => index % 3 !== 0) },
  document => { document.sourceUnits = [null] }, document => { document.sourceUnits = Array(2) },
  document => { document.graph.nodes.push(null) }, document => { delete document.graph.nodes[0] },
  document => { const model = document.graph.nodes.find(node => node.id === 'left'); if (model.modelStructure) model.modelStructure.slots[0].conceptId = 'missing-concept' },
  document => { const model = document.graph.nodes.find(node => node.id === 'left'); if (model.modelStructure) model.modelStructure.branches[0].condition.provenance.quote = '原文没有这句' },
  document => { for (const node of document.graph.nodes) node.state = 'rejected' },
  document => { for (const [index, id] of ['__proto__', '__PROTO__', 'constructor', 'spaced/id:opaque identity'].entries()) {
    const old = 'material-' + index; document.graph.nodes.find(node => node.id === old).id = id
    for (const edge of document.graph.edges) { if (edge.fromNodeId === old) edge.fromNodeId = id; if (edge.toNodeId === old) edge.toNodeId = id }
  } },
]
