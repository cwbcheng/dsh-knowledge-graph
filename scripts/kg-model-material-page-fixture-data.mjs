import assert from 'node:assert/strict'
import { getOntology } from '../src/kg-ontology.mjs'
import { modelPortReuseFixture } from './kg-model-port-reuse-fixture-data.mjs'

// Synthetic, unverified source records: valid citation positions do not prove a mapping.
export function modelMaterialPageFixture({ materials = 64, chunks = 64, structured = true, distributed = false, rules = false } = {}) {
  const document = modelPortReuseFixture({ chunks, slots: 40, structured })
  if (distributed) {
    const remap = value => {
      if (Array.isArray(value)) return value.map(remap)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, ['paragraph', 'startParagraph', 'endParagraph'].includes(key) && Number.isInteger(item) ? item * 1000 + 7 : remap(item)]))
      return value
    }
    document.graph = remap(document.graph); document.sourceUnits = remap(document.sourceUnits)
  }
  const template = document.graph.nodes[0]
  const addNode = (id, type, index) => {
    const node = { ...structuredClone(template), id, type, text: '隔离材料 ' + id + '：仍需核对条件与边界。' }
    if (distributed) {
      const unit = document.sourceUnits[index % chunks]
      node.paragraph = unit.paragraph
      node.evidence = [{ documentId: document.documentId, sourceId: document.graph.source.id, paragraph: unit.paragraph, quote: unit.text }]
    }
    document.graph.nodes.push(node)
    return node
  }
  const link = (fromNodeId, toNodeId, relation) => document.graph.edges.push({ fromNodeId, toNodeId, relation,
    evidence: structuredClone(document.graph.nodes.find(node => node.id === fromNodeId).evidence) })
  for (let index = 0; index < materials; index++) { addNode('material-' + index, 'factor_material', index); link('material-' + index, 'left', 'builds') }
  if (rules) {
    for (const [id, type] of [['rule-a', 'rule'], ['rule-b', 'rule'], ['mapping-material', 'relation_material'],
      ['verification-material', 'verification_material'], ['example-material', 'segment_example_group']]) addNode(id, type, materials + 1)
    for (const rule of ['rule-a', 'rule-b']) {
      link('left', rule, 'has_rule')
      link('mapping-material', rule, 'states_mapping')
      link('verification-material', rule, 'verifies')
      link('example-material', rule, 'exemplifies')
    }
    link('mapping-material', 'left', 'states_mapping')
    link('example-material', 'left', 'builds')
  }
  const relations = new Map(getOntology(document.graph.ontology).relationTypes.map(item => [item.id, item]))
  const types = new Map(document.graph.nodes.map(node => [node.id, node.type]))
  for (const edge of document.graph.edges) {
    const relation = relations.get(edge.relation)
    assert(relation && relation.from.includes(types.get(edge.fromNodeId)) && relation.to.includes(types.get(edge.toNodeId)), 'Fixture edges must use declared ontology directions')
  }
  return document
}
