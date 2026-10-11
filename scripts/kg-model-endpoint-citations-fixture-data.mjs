import { modelMaterialPageFixture } from './kg-model-material-page-fixture-data.mjs'

// Shared canonical concept identities, explicit roles and full synthetic, unverified evidence.
export function modelEndpointCitationsFixture({ structured = true, models = 24, chunks = 64, distributed = false } = {}) {
  const document = modelMaterialPageFixture({ structured, materials: 0, chunks, distributed })
  const template = document.graph.nodes.find(node => node.id === 'left')
  const edges = document.graph.edges.filter(edge => edge.fromNodeId === 'left')
  document.graph.nodes = document.graph.nodes.filter(node => node.type === 'concept'); document.graph.edges = []
  for (let index = 0; index < models; index++) {
    const model = structuredClone(template); model.id = 'catalogue-' + String(index).padStart(3, '0')
    document.graph.nodes.push(model)
    document.graph.edges.push(...edges.map(edge => ({ ...structuredClone(edge), fromNodeId: model.id })))
  }
  return document
}
