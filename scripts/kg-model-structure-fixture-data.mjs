import { connectionFixture } from './kg-connection-model-fixture-data.mjs'

export function modelStructureFixture() {
  const document = connectionFixture()
  const provenance = (kind = 'user') => ({ kind, paragraph: null, quote: '', note: '' })
  const cited = { kind: 'source', paragraph: 0, quote: document.sourceUnits[0].text, note: '简化模型，不是实际账单' }
  const field = (text, source = provenance()) => ({ text, provenance: { ...source } })
  const slot = (id, conceptId, label, role, unit, state = '') => ({ id, conceptId, label, role, unit, state, provenance: provenance() })
  document.graph.edges = document.graph.edges.filter(edge => edge.relation !== 'states_variable')
  const taxi = document.graph.nodes.find(node => node.id === 'taxi')
  taxi.modelStructure = { version: 1, identity: 'assertion',
    slots: [slot('distance-slot', 'distance', '行驶距离', 'input', 'km', '本次行程'), slot('fare-slot', 'fare', '基础费用', 'output', '元', '本次行程')],
    branches: [
      { id: 'base', label: '不超过 3 km', condition: field('0 <= 行驶距离 <= 3 km', cited), mapping: field('基础费用 = 10 元', cited), boundary: field('距离不能为负，不包含附加收费') },
      { id: 'extra', label: '超过 3 km', condition: field('行驶距离 > 3 km', cited), mapping: field('基础费用 = 10 + (行驶距离 - 3) × 2 元', cited), boundary: field('仅为简化计价模型') },
      { id: 'unreviewed', label: '附加收费未整理', condition: field('', provenance('unknown')), mapping: field('尚无规律'), boundary: field('') },
    ],
    examples: [
      { id: 'two-km', title: '2 km 的短途行程', scenario: '本次行驶 2 km，没有附加收费。', branchId: 'base',
        inputs: [{ slotId: 'distance-slot', value: '2' }], outputs: [{ slotId: 'fare-slot', value: '10' }], reasoning: '2 km 属于基础计费范围。', provenance: provenance() },
      { id: 'five-km', title: '5 km 的行程', scenario: '本次行驶 5 km，没有附加收费。', branchId: 'extra',
        inputs: [{ slotId: 'distance-slot', value: '5' }], outputs: [{ slotId: 'fare-slot', value: '14' }], reasoning: '超过部分为 2 km，增加 4 元。', provenance: provenance() },
      { id: 'missing-distance', title: '尚缺距离的情境', scenario: '只记录了价格，还未记录行驶距离。', branchId: 'extra',
        inputs: [], outputs: [{ slotId: 'fare-slot', value: '14' }], reasoning: '', provenance: provenance() },
    ] }
  document.graph.nodes.find(node => node.id === 'multi').modelStructure = { version: 1, identity: 'hypothesis',
    slots: [slot('initial-speed', 'speed', '初速度', 'input', 'm/s', '初始时刻'), slot('net-force', 'force', '合外力', 'input', 'N', '运动期间'),
      slot('final-speed', 'speed', '后续速度', 'output', 'm/s', '后续时刻')],
    branches: [{ id: 'motion', label: '运动过程', condition: field('必要时间、质量等条件尚未记录'), mapping: field('多个因素共同影响后续速度，定量关系未核验'), boundary: field('不能仅由两个输入作出确定数值预测') }], examples: [] }
  return document
}
