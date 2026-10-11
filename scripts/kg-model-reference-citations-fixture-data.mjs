import { modelPortReuseFixture } from './kg-model-port-reuse-fixture-data.mjs'

export function modelReferenceCitationsFixture({ shared = true, structured = true, chunks = 64, quotes = 8, longText = false } = {}) {
  const document = modelPortReuseFixture({ chunks, structured })
  if (longText) {
    document.sourceUnits.forEach(unit => { unit.text += '条件、对象与时间仍需逐项核对。'.repeat(400) })
    document.sourceText = document.sourceUnits.map(unit => unit.text).join('\n\n')
    for (const node of document.graph.nodes) {
      node.evidence.forEach(record => { record.quote = document.sourceUnits[record.paragraph].text })
      if (node.modelStructure) {
        node.modelStructure.slots.forEach(slot => { slot.provenance.quote = document.sourceUnits.at(-1).text })
        for (const branch of node.modelStructure.branches) for (const key of ['condition', 'mapping', 'boundary']) branch[key].provenance.quote = document.sourceUnits.at(-1).text
      }
    }
    for (const edge of document.graph.edges) edge.evidence.forEach(record => { record.quote = document.sourceUnits[record.paragraph].text })
  }
  for (const node of document.graph.nodes) {
    if (node.type === 'concept') node.evidence = document.sourceUnits.slice(document.sourceUnits.length - quotes).map(unit => ({
      documentId: document.documentId, sourceId: document.graph.source.id, paragraph: unit.paragraph, quote: unit.text }))
    if (shared && node.modelStructure) node.modelStructure.slots.forEach((slot, index) => {
      slot.conceptId = 'port-0'; slot.label = '独立槽位 ' + index; slot.unit = '独立口径 ' + index; slot.state = '独立对象时间 ' + index
    })
  }
  return document
}

export const modelReferenceCitationsModes = [{ modelId: 'left' }, { modelId: 'left', diagnosis: true },
  { modelId: 'left', structureSources: true }, { modelId: 'left', structureEdit: true },
  { modelId: 'left', compareModelId: 'right' }, { modelId: 'left', compareModelId: 'right', structureEdit: true },
  {}, { offset: 20 }, { query: '暂记输入到输出' }, { conceptId: 'port-0', role: 'input' },
  { peerOf: 'left' }, { chainOf: 'left' }, { concepts: true }, { modelId: 'left', concepts: true },
  { modelId: 'left', expectedRevision: 0 }, { modelId: 'left', compareModelId: 'right', concepts: true }]
