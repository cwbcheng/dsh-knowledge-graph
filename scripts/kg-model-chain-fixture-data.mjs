import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

export function modelChainFixture() {
  const document = modelStructureFixture(), graph = document.graph
  const provenance = { kind: 'source', paragraph: 0, quote: document.sourceUnits[0].text, note: '合成测试材料，不是书中或现实规则' }
  const field = text => ({ text, provenance: { ...provenance } })
  const slot = (id, conceptId, label, role, unit = '元', state = '本次行程') => ({ id, conceptId, label, role, unit, state, provenance: { ...provenance } })
  const taxi = graph.nodes.find(node => node.id === 'taxi')
  for (const branch of taxi.modelStructure.branches.slice(0, 2)) branch.boundary.provenance = { ...provenance }
  graph.nodes.push({ id: 'budget', type: 'concept', text: '预算', paragraph: 0 }, { id: 'remaining', type: 'concept', text: '余额', paragraph: 0 },
    { id: 'fare-other', type: 'concept', text: '基础费用', paragraph: 0 })
  const add = (id, modifier = () => {}) => {
    const structure = { version: 1, identity: 'hypothesis',
      slots: [slot('expense', 'fare', '行程基础费用', 'input'), slot('available', 'budget', '行程预算', 'input'), slot('remaining', 'remaining', '剩余预算', 'output')],
      branches: [{ id: 'subtract', label: '无其他支出', condition: field('同一行程，没有其他支出'), mapping: field('剩余预算 = 行程预算 - 行程基础费用；往往还需核对附加支出'), boundary: field('预算已明确，不代表实际账单') }], examples: [] }
    modifier(structure)
    graph.nodes.push({ id, type: 'connection_model', text: '基础费用与预算 → 剩余预算（合成假设，往往需要更多条件）', paragraph: 0, modelStructure: structure })
  }
  add('budget-model')
  add('source:model-beta')
  add('模型乙')
  add('units', structure => { structure.slots[0].unit = '分' })
  add('times', structure => { structure.slots[0].state = '下一次行程' })
  add('same-name', structure => { structure.slots[0].conceptId = 'fare-other' })
  add('unknown-unit', structure => { structure.slots[0].unit = '' })
  add('unknown-state', structure => { structure.slots[0].state = '' })
  add('wrong-model', structure => { structure.identity = 'wrong_example' })
  add('type-model', structure => { structure.identity = 'type_definition' })
  add('unknown-role', structure => { structure.slots[1].role = 'unknown' })
  add('uncited', structure => { structure.branches[0].condition.provenance = { kind: 'ai', paragraph: null, quote: '', note: '' } })
  add('return-model', structure => { structure.slots[2].conceptId = 'distance' })
  add('duplicate-concept', structure => { structure.slots.splice(1, 0, slot('other-expense', 'fare', '另一时段费用', 'input', '元', '此前行程')) })
  add('rejected-model')
  graph.nodes.find(node => node.id === 'rejected-model').state = 'rejected'
  add('unsupported-model')
  graph.nodes.find(node => node.id === 'unsupported-model').entailmentStatus = 'unsupported'
  for (let index = 0; index < 25; index++) add('chain-peer-' + index)
  return document
}

export const chainInput = (slotId, value = '', basis = '') => ({ slotId, source: 'known', value, basis, fromSlotId: '', meaning: '', unit: '', timeState: '', objectScope: '' })
export function modelChainDraft(peerId = 'budget-model') {
  return { version: 1, scenario: '合成情境：本次行驶 5 km，预算 20 元，假设无附加费用。', goal: '预测这次行程后剩余预算；不是现实账单。', steps: [
    { modelId: 'taxi', branchId: 'extra', inputs: [chainInput('distance-slot', '5', '本次里程记录，按行驶距离概念判别')],
      outputs: [{ slotId: 'fare-slot', value: '14' }], conditions: '本次行程超过 3 km，未发现附加费用；此为用户假设。', reasoning: '我预测 10 + (5 - 3) * 2 = 14。' },
    { modelId: peerId, branchId: 'subtract', inputs: [
      { ...chainInput('expense'), source: 'link', fromSlotId: 'fare-slot', meaning: '两端均按基础计价费用理解，未独立核验', unit: '同为元，无换算', timeState: '同为本次行程', objectScope: '同一乘客、同一行程，用户自述' },
      chainInput('available', '20', '本次行程预算，由用户提供')], outputs: [{ slotId: 'remaining', value: '6' }],
      conditions: '假定本次行程无其他支出，预算以元表示。', reasoning: '我尝试以 20 - 14 = 6 作为预算余额；往往还需检查额外费用。' },
  ] }
}
