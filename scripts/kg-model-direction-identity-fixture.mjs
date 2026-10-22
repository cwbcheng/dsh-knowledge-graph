// Isolated polysemy: mass and quality are distinct concepts, not time slots.
export function directionIdentityFixture({ extraMaterials = 0 } = {}) {
  const documentId = 'direction-identity-fixture', sourceId = 'direction-identity-source'
  const sourceUnits = [
    { paragraph: 0, text: '仅作有待核验的联结假设：在工艺、原料种类与设备状态固定时，研究原料质量与产品质量的关系；不保证必然成立。' },
    { paragraph: 7, text: '原料的“质量”指 mass，单位 kg，是不同于品质的物理概念；此处是候选输入，方向仍须人工核对。' },
    { paragraph: 31, text: '产品的“质量”指 quality，以合格率 % 表征，是不同于质量 mass 的品质概念；此处是候选输出，方向仍须人工核对。' },
    { paragraph: 1000000000, text: '边界：工艺或原料种类变化时不可直接套用；目前没有实际观测支持，不能据此保证合格率。' },
  ]
  const evidence = paragraph => [{ documentId, sourceId, paragraph, quote: sourceUnits.find(unit => unit.paragraph === paragraph).text }]
  const node = (id, type, text, paragraph) => ({ id, type, text, paragraph,
    quote: sourceUnits.find(unit => unit.paragraph === paragraph).text, evidence: evidence(paragraph), state: 'candidate', entailmentStatus: 'unverified' })
  const graph = { ontology: 'learning-view-v1', summary: '同名不同含义的概念方向核对',
    source: { documentId, id: sourceId, title: '原料 mass 与产品 quality 的条件性假设', paragraphCount: sourceUnits.length },
    nodes: [node('mass-quality', 'connection_model', '固定工艺下的原料质量与产品质量（仅假设，未核验）', 0),
      node('raw-mass', 'concept', '质量', 7), node('product-quality', 'concept', '质量', 31),
      node('conditions', 'rule', sourceUnits[0].text, 0), node('boundary', 'rule', sourceUnits[3].text, 1000000000)],
    edges: [
      { fromNodeId: 'mass-quality', toNodeId: 'raw-mass', relation: 'maps_between', evidence: evidence(7), state: 'candidate' },
      { fromNodeId: 'mass-quality', toNodeId: 'product-quality', relation: 'maps_between', evidence: evidence(31), state: 'candidate' },
      { fromNodeId: 'mass-quality', toNodeId: 'conditions', relation: 'has_rule', evidence: evidence(0), state: 'candidate' },
      { fromNodeId: 'mass-quality', toNodeId: 'boundary', relation: 'has_rule', evidence: evidence(1000000000), state: 'candidate' },
    ] }
  for (let index = 0; index < extraMaterials; index++) {
    const id = 'mapping-material-' + index
    graph.nodes.push(node(id, 'relation_material', '分页测试映射材料 ' + (index + 1), 0))
    graph.edges.push({ fromNodeId: id, toNodeId: 'mass-quality', relation: 'states_mapping', evidence: evidence(0), state: 'candidate' })
  }
  return { documentId, revision: 1, graph, sourceUnits, sourceText: sourceUnits.map(unit => unit.text).join('\n\n') }
}
