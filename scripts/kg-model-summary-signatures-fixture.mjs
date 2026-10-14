import assert from 'node:assert/strict'
import { modelEndpointCitationsFixture } from './kg-model-endpoint-citations-fixture-data.mjs'
import { createModelStructureTools } from '../src/kg-model-structure.mjs'
import { getOntology } from '../src/kg-ontology.mjs'

// A saved structure may cover fewer slots than the existing graph relations.
// Explicit, unverified records; this fixture makes no mapping or truth claim.
export function modelSummarySignaturesFixture({ models = 16, endpoints = 256, structured = true } = {}) {
  const document = modelEndpointCitationsFixture({ models, chunks: 16, structured })
  const modelNodes = document.graph.nodes.filter(node => node.type === 'connection_model'), template = document.graph.nodes[0]
  if (endpoints < 40) document.graph.edges = document.graph.edges.filter(edge => Number(edge.toNodeId.slice(5)) < endpoints)
  for (let index = 40; index < endpoints; index++) {
    const concept = { ...structuredClone(template), id: 'port-' + index, text: '独立旧端点 ' + index }
    document.graph.nodes.push(concept)
    for (const model of modelNodes) document.graph.edges.push({ fromNodeId: model.id, toNodeId: concept.id,
      relation: 'maps_between', role: index % 2 ? 'output' : 'input', evidence: structuredClone(template.evidence) })
  }
  const nodes = new Map(document.graph.nodes.map(node => [node.id, node])), units = new Map(document.sourceUnits.map(unit => [unit.paragraph, unit.text]))
  assert.deepEqual(createModelStructureTools().errors(document.graph, units), [])
  const relation = getOntology(document.graph.ontology).relationTypes.find(item => item.id === 'maps_between')
  for (const edge of document.graph.edges) assert(relation.from.includes(nodes.get(edge.fromNodeId).type) && relation.to.includes(nodes.get(edge.toNodeId).type))
  return document
}

export function summarySignaturesWork(query, document, options, expected) {
  const sort = Object.getOwnPropertyDescriptor(Array.prototype, 'sort'), stringify = Object.getOwnPropertyDescriptor(JSON, 'stringify')
  const chunks = document.graph.staging.chunks, find = chunks.find
  const signature = value => Array.isArray(value) && value.length && value.every(item => typeof item === 'string' && /^port-\d+:(input|output|unknown)$/.test(item))
  let sortCalls = 0, sortValues = 0, jsonCalls = 0, jsonCharacters = 0, sourceLookups = 0, response
  Array.prototype.sort = function (...args) { if (signature(this)) { sortCalls++; sortValues += this.length }; return sort.value.apply(this, args) }
  JSON.stringify = function (...args) { const result = stringify.value.apply(this, args); if (signature(args[0])) { jsonCalls++; jsonCharacters += result.length }; return result }
  chunks.find = function (...args) { sourceLookups++; return find.apply(this, args) }
  try { response = query(document, options) }
  finally {
    Object.defineProperty(Array.prototype, 'sort', sort); Object.defineProperty(JSON, 'stringify', stringify)
    delete chunks.find
  }
  assert.deepEqual(response, expected)
  return { sortCalls, sortValues, jsonCalls, jsonCharacters, sourceLookups }
}
