import { createTargetMapTools } from '../src/kg-target-map.mjs'
export function targetMapFixture() {
  const documentId = 'target-map-fixture', sourceId = 'target-map-source'
  const text = ['牛顿第一定律：若合外力为零，后续速度等于原速度。例子包括冰面小球、太空飞船和书架上的书。',
    '正外部性判别：具有免费让第三方受益的属性。两个正例和一个负例。',
    '同名速度的对象和时间状态不能省略，未知方向不凭线条推断。']
  const node = (id, type, label, paragraph) => ({ id, type, text: label, paragraph, quote: text[paragraph],
    documentId, sourceId, entailmentStatus: 'unverified', state: 'candidate', evidence: [{ documentId, sourceId, paragraph, quote: text[paragraph] }] })
  return { documentId, revision: 1, sourceText: text.join('\n\n'), sourceUnits: text.map((text, paragraph) => ({ text, paragraph })),
    graph: { ontology: 'learning-view-v1', summary: '渐构靶图隔离验收', source: { documentId, id: sourceId },
      nodes: [node('motion', 'connection_model', text[0], 0), node('externality', 'concept', '正外部性', 1),
        node('judge', 'discrimination_model', text[1], 1), node('speed-before', 'concept', '速度', 2), node('speed-after', 'concept', '速度', 2),
        node('unknown', 'connection_model', '方向未知的速度关系', 2),
        ...Array.from({ length: 22 }, (_, i) => node('extra-' + i, 'connection_model', '独立模型 ' + i, 2))],
      edges: [{ fromNodeId: 'unknown', toNodeId: 'speed-before', relation: 'maps_between', evidence: [] },
        { fromNodeId: 'unknown', toNodeId: 'speed-after', relation: 'maps_between', evidence: [] }] } }
}
export function motionTargetMap() {
  const tools = createTargetMapTools(), map = tools.blank(targetMapFixture().graph.nodes[0])
  map.title = '牛一 · 我的渐构靶图'
  map.slots = [{ id: 'force', role: 'input', name: '合外力', meaning: '来自物体外部的共同作用', unit: 'N', scope: '同一物体，所考察期间' },
    { id: 'before', role: 'input', name: '速度', meaning: '原位移与时间的比，矢量', unit: 'm/s', scope: '同一物体，原状态' },
    { id: 'after', role: 'output', name: '速度', meaning: '后续位移与时间的比，矢量', unit: 'm/s', scope: '同一物体，后续状态' }]
  map.mapping = '若合外力为 0，则后速度 = 原速度。一般情境的阻力仍需核对。'
  map.conditions = '同一对象、同一惯性参考系；单位与时间状态不能混用。'
  map.boundary = '不是根据一次同名或连线就能得出的判断。'
  map.outcomes = [{ id: 'uniform', slotId: 'after', label: '匀速直线运动', detail: '' }, { id: 'rest', slotId: 'after', label: '静止', detail: '' },
    { id: 'acceleration', slotId: 'after', label: '变速运动', detail: '可出现在输出范围中，不等于已有例子产生这个结果。' }]
  map.examples = ['冰面上匀速运动的小球，忽略阻力和摩擦', '太空中轻推后不再受净外力的飞船'].map((context, index) => {
    const item = tools.example(map, 'material-' + index)
    item.context = context; item.exposure = 'known'; item.inputs[0].value = '0 N'; item.inputs[1].value = '原速度 v，非零'
    item.process = '同一物体合外力为零，依据记录的规律，后续速度保持 v。'
    item.outputs[0].outcomeId = 'uniform'; return item
  })
  return map
}
