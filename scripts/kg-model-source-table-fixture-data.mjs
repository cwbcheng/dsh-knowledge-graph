import { modelSourceContextFixture } from './kg-model-source-context-fixture-data.mjs'

// Synthetic table fragments with retained paragraph identities, not live data.
export function modelSourceTableFixture({ dense = false, gap = false, peer = false } = {}) {
  const fixture = modelSourceContextFixture(), oldQuote = fixture.sourceUnits[1].text
  fixture.sourceUnits[1].text = '计价原文：仅对本次行程说明。\n<table><caption>仅限白天、无附加收费；表中映射未作独立验证。</caption><tr><th>行驶距离（输入）</th><th>费用（输出）</th></tr><tr><td>不超过 3 km</td><td>10 元</td></tr>'
  fixture.sourceUnits[2].text = '<tr><td>超过 3 km</td><td>10 元 + 超出部分 × 2 元/km</td></tr>'
  fixture.sourceUnits[3].text = '<tr><td colspan="2">不保证必然成立</td></tr></table>\n边界：夜间加价不在此模型范围内，不能直接套用。'
  const update = value => {
    if (Array.isArray(value)) return value.map(update)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, update(item)]))
    return value === oldQuote ? fixture.sourceUnits[1].text : value
  }
  fixture.graph = update(fixture.graph)
  if (gap) {
    fixture.sourceUnits[3].text = '<tr><td>表格中段</td><td>条件不能省略</td></tr>'
    fixture.sourceUnits[4].text = '<tr><td>未展示的限制</td><td>必须另行核对</td></tr>'
    fixture.sourceUnits.push(
      { paragraph: 2000001000, text: '<tr><td>未展示的边界</td><td>不得跳过</td></tr>' },
      { paragraph: 2000002000, text: '<tr><td>另一段</td><td>条件仍需保留</td></tr>' },
      { paragraph: 2000003000, text: '</table>\n表格结束后的原文材料。' },
      { paragraph: 2000004000, text: '结束后的边界：仍须先核验。' },
      { paragraph: 2000005000, text: '下一主题。' },
    )
    const last = fixture.sourceUnits[7]
    const evidence = [{ documentId: fixture.documentId, sourceId: fixture.graph.source.id, paragraph: last.paragraph, quote: last.text }]
    fixture.graph.nodes.push({ id: 'table-end-material', type: 'relation_material', text: '表格结束后的原文材料',
      paragraph: last.paragraph, quote: last.text, evidence })
    fixture.graph.edges.push({ fromNodeId: 'table-end-material', toNodeId: 'taxi', relation: 'states_mapping', evidence })
  }
  if (dense) {
    const ids = new Map(fixture.sourceUnits.map((unit, index) => [unit.paragraph, index]))
    const remap = value => {
      if (Array.isArray(value)) return value.map(remap)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, key === 'paragraph' && ids.has(item) ? ids.get(item) : remap(item)]))
      return value
    }
    fixture.graph = remap(fixture.graph); fixture.sourceUnits = remap(fixture.sourceUnits)
  }
  if (peer) {
    const model = structuredClone(fixture.graph.nodes[0]); model.id = 'taxi-peer'; model.text = '另一个明确选择的计价模型'
    fixture.graph.nodes.push(model)
    fixture.graph.edges.push(...fixture.graph.edges.filter(edge => edge.fromNodeId === 'taxi')
      .map(edge => ({ ...structuredClone(edge), fromNodeId: model.id })))
  }
  fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
  fixture.graph.source.paragraphCount = fixture.sourceUnits.length
  fixture.graph.source.title = '联结模型计价表的条件与边界'
  return fixture
}
