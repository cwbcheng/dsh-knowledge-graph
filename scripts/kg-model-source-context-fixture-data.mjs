// Synthetic source identities, including gaps retained by older imports/parsers.
export function modelSourceContextFixture() {
  const documentId = 'connection-fixture', sourceId = 'sparse-model-source'
  const sourceUnits = [
    { paragraph: 0, text: '先决条件：仅在白天、没有附加收费时使用，往往适用但不保证必然成立。' },
    { paragraph: 7, text: '行驶距离为输入，费用为输出；3 km 以内固定 10 元。' },
    { paragraph: 31, text: '超过 3 km 的部分每公里增加 2 元，仍须满足前述条件。' },
    { paragraph: 1000000000, text: '边界：夜间加价不在此模型范围内，不能直接套用。' },
    { paragraph: 2000000000, text: '下一主题，与上述计价模型无关。' },
  ]
  const quote = sourceUnits[1].text
  const origin = () => ({ kind: 'source', paragraph: 7, quote, note: '原文引用不等于经验验证。' })
  const unknown = () => ({ kind: 'unknown', paragraph: null, quote: '', note: '' })
  const field = (text, provenance = unknown()) => ({ text, provenance })
  const node = (id, type, text) => ({ id, type, text, paragraph: 7, quote,
    evidence: [{ documentId, sourceId, paragraph: 7, quote }], state: 'candidate', entailmentStatus: 'unverified' })
  const model = node('taxi', 'connection_model', '行驶距离 → 打车费用')
  model.modelStructure = { version: 1, identity: 'assertion',
    slots: [
      { id: 'distance-slot', conceptId: 'distance', label: '行驶距离', role: 'input', unit: 'km', state: '本次行程', provenance: origin() },
      { id: 'fare-slot', conceptId: 'fare', label: '费用', role: 'output', unit: '元', state: '本次行程', provenance: origin() },
    ],
    branches: [{ id: 'base', label: '原文计价模型', condition: field(''), mapping: field(quote, origin()), boundary: field('') }], examples: [] }
  const graph = { ontology: 'learning-view-v1', summary: '联结模型原文上下文隔离测试',
    source: { documentId, id: sourceId, title: '稀疏段落的原文条件与边界', paragraphCount: sourceUnits.length },
    nodes: [model, node('distance', 'concept', '行驶距离'), node('fare', 'concept', '费用'), node('rule', 'rule', quote)],
    edges: [
      { fromNodeId: 'taxi', toNodeId: 'distance', relation: 'maps_between', role: 'input' },
      { fromNodeId: 'taxi', toNodeId: 'fare', relation: 'maps_between', role: 'output' },
      { fromNodeId: 'taxi', toNodeId: 'rule', relation: 'has_rule' },
    ].map(edge => ({ ...edge, evidence: [{ documentId, sourceId, paragraph: 7, quote }] })),
  }
  return { documentId, revision: 1, graph, sourceUnits, sourceText: sourceUnits.map(unit => unit.text).join('\n\n') }
}
