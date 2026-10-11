import { modelEndpointCitationsFixture } from './kg-model-endpoint-citations-fixture-data.mjs'

// Explicit candidate records, never a compatibility or truth assessment.
export function modelCatalogueSelectorsFixture({ structured = true } = {}) {
  const document = modelEndpointCitationsFixture({ structured })
  const models = document.graph.nodes.filter(node => node.type === 'connection_model')
  for (const model of models) model.text = model.id + '：' + model.text
  const role = (model, index, value, conceptId = 'port-' + index) => {
    if (structured) Object.assign(model.modelStructure.slots[index], { role: value, conceptId })
    Object.assign(document.graph.edges.filter(edge => edge.fromNodeId === model.id)[index], { role: value, toNodeId: conceptId })
  }
  role(models[1], 0, 'output'); role(models[1], 1, 'input')
  const sameNamed = { ...structuredClone(document.graph.nodes[1]), id: 'other-port-1' }
  document.graph.nodes.push(sameNamed)
  role(models[2], 0, 'output'); role(models[2], 1, 'input', sameNamed.id)
  role(models[3], 0, 'output'); role(models[3], 1, 'unknown')
  // Separate slots may share a concept; canonical edges still have unique identities.
  document.graph.edges = document.graph.edges.filter(edge => !(edge.fromNodeId === models[4].id && edge.toNodeId === 'port-39'))
  if (structured) {
    Object.assign(models[4].modelStructure.slots[39], { role: 'input', conceptId: 'port-1' })
    models[4].modelStructure.slots[39].unit = '另一单位口径'
    models[4].modelStructure.slots[39].state = '另一对象时间'
  }
  return document
}

export const modelCatalogueSelectorsModes = [{}, { offset: 20 }, { conceptId: 'port-1', role: 'input' },
  { conceptId: 'port-1', role: 'output' }, { peerOf: 'catalogue-000' }, { chainOf: 'catalogue-000' },
  { query: '端点 1' }, { query: 'absent' },
  { peerOf: 'catalogue-000', chainOf: 'catalogue-000', conceptId: 'port-1', role: 'input', query: '端点' },
  { query: '暂记输入到输出', needsReview: true }, { query: '未定', sectionId: 'measured' },
  { sectionId: 'measured', excludeModelId: 'catalogue-001' }, { modelId: 'catalogue-004' },
  { modelId: 'catalogue-004', diagnosis: true }, { modelId: 'catalogue-004', structureSources: true },
  { modelId: 'catalogue-004', compareModelId: 'catalogue-001' },
  { modelId: 'catalogue-004', compareModelId: 'catalogue-001', concepts: true }, { expectedRevision: 0 }]
