import { modelCatalogueSearchFixture } from './kg-model-catalogue-search-fixture-data.mjs'

export const browseDocumentIds = {
  alias: 'history-document:'.padEnd(160, 'x'),
  selected: 'history-document:'.padEnd(160, 'x') + ':actual-document',
  peer: 'history-document:'.padEnd(160, 'x') + ':other-document',
  plain: 'space-sensitive-document',
  spaced: ' space-sensitive-document ',
  unicode: '命名空间:文档 "甲">:A:' + '概念'.repeat(90),
  normalizedPeer: '命名空间:文档 "甲">:Ａ:' + '概念'.repeat(90),
  maximum: 'bounded-history:'.padEnd(4096, 'x'),
  oversized: 'bounded-history:'.padEnd(4096, 'x') + 'Y',
}

export function documentBrowseIdentityFixture(documentId, marker = 'SELECTEDDOCUMENT', title = '选中的长标识文档') {
  const fixture = modelCatalogueSearchFixture()
  fixture.documentId = documentId
  fixture.graph.source.documentId = documentId
  fixture.graph.source.title = title
  fixture.graph.summary = marker + ': exact canonical document, not a prefix alias.'
  const condition = fixture.graph.nodes.find(node => node.id === 'search-condition').modelStructure.branches[0].condition
  condition.text = marker + ': recorded condition for this object and time only.'
  condition.provenance = { kind: 'source', paragraph: fixture.sourceUnits.length, quote: condition.text, note: '' }
  fixture.sourceUnits.push({ paragraph: condition.provenance.paragraph, text: condition.text })
  fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
  for (const item of [...fixture.graph.nodes, ...fixture.graph.edges]) {
    item.documentId = documentId
    for (const evidence of item.evidence || []) evidence.documentId = documentId
  }
  return fixture
}
