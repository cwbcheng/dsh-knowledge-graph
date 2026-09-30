export function connectionFixture() {
  const paragraphs = [
    '行驶距离与打车费用。3 km 以内固定 10 元，超过部分每公里增加 2 元。',
    '距离为输入，费用为输出。仅为简化计价模型，不包含附加收费。',
    '具体情境：2 km 对应 10 元，5 km 对应 14 元。',
    '联结模型是输入变量与输出变量之间的映射。',
    '图片中的学偏联结模型是错误模型，视觉转写待复核。',
    '多个输入共同确定输出，初速度与后速度使用同一个速度概念。',
    '变量描述材料尚未整理为概念端点。',
    '第二章：检索与版本隔离测试。',
  ]
  const documentId = 'connection-fixture'
  const sourceId = 'connection-source'
  const node = (id, type, text, paragraph = 0) => ({ id, type, text, paragraph,
    quote: paragraphs[paragraph], evidence: [{ documentId, sourceId, paragraph, quote: paragraphs[paragraph] }],
    state: 'candidate', entailmentStatus: 'unverified' })
  const edge = (fromNodeId, toNodeId, relation, role) => ({ fromNodeId, toNodeId, relation,
    ...(role ? { role } : {}), evidence: [{ documentId, sourceId, paragraph: 1, quote: paragraphs[1] }] })
  const nodes = [
    node('distance', 'concept', '行驶距离 (km)'), node('fare', 'concept', '打车费用 (元)'),
    node('taxi', 'connection_model', '行驶距离 → 打车费用：3 km 以内 10 元；超过部分每公里增加 2 元。'),
    node('rule', 'rule', '分段计价；不包含其他附加收费。', 1),
    node('example', 'segment_example_group', paragraphs[2], 2),
    node('unknown', 'connection_model', '方向待核对的计价模型', 1),
    node('definition', 'connection_model', paragraphs[3], 3),
    node('wrong', 'connection_model', paragraphs[4], 4),
    node('multi', 'connection_model', paragraphs[5], 5),
    node('speed', 'concept', '速度', 5), node('force', 'concept', '合外力', 5),
    node('legacy', 'connection_model', '变量描述存在，但尚未连接概念。', 6),
    node('factor', 'factor_material', paragraphs[6], 6),
    ...Array.from({ length: 25 }, (_, i) => node('model-' + i, 'connection_model', '模型 ' + i + (i === 24 ? ' ＴＡＩＬ 跨窗口目标' : ''), 7)),
  ]
  const edges = [edge('taxi', 'distance', 'maps_between', 'input'), edge('taxi', 'fare', 'maps_between', 'output'),
    edge('taxi', 'rule', 'has_rule'), edge('example', 'rule', 'exemplifies'),
    edge('unknown', 'distance', 'maps_between'), edge('unknown', 'fare', 'maps_between'),
    edge('wrong', 'distance', 'maps_between', 'input'), edge('wrong', 'fare', 'maps_between', 'output'),
    edge('multi', 'speed', 'maps_between', 'input'), edge('multi', 'force', 'maps_between', 'input'),
    edge('multi', 'fare', 'maps_between', 'output'), edge('legacy', 'factor', 'states_variable')]
  return { documentId, revision: 1, sourceText: paragraphs.join('\n\n'), sourceUnits: paragraphs.map((text, paragraph) => ({ paragraph, text })),
    graph: { ontology: 'learning-view-v1', summary: '联结模型隔离测试', source: { documentId, id: sourceId, sections: [
      { id: 'first', title: '第一章 · 模型与实例', startParagraph: 0, endParagraph: 6 },
      { id: 'second', title: '第二章 · 全图查询', startParagraph: 7, endParagraph: 7 },
    ] }, nodes, edges } }
}
