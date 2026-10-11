import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

// Independent states of the same concept may legitimately share a display name.
export function modelBindingFocusFixture() {
  const document = modelStructureFixture()
  const model = document.graph.nodes.find(node => node.id === 'multi'), s = model.modelStructure
  const input = s.slots.find(slot => slot.id === 'initial-speed'), output = s.slots.find(slot => slot.id === 'final-speed')
  input.label = output.label = '速度'
  s.slots.splice(1, 0, { ...structuredClone(input), id: 'other-speed', state: '另一对象的初始时刻' })
  s.slots.push({ ...structuredClone(output), id: 'other-final-speed', unit: 'km/h', state: '另一对象的后续时刻' })
  s.examples = Array.from({ length: 21 }, (_, index) => ({ id: 'identity-example-' + index, title: '独立槽位实例 ' + index,
    scenario: '分别记录两个对象的速度；含义与适用性仍待核对。', branchId: 'motion',
    inputs: [{ slotId: 'initial-speed', value: '已填写的第一输入' }, { slotId: 'other-speed', value: index === 20 ? '' : '第二输入' }, { slotId: 'net-force', value: '合外力' }],
    outputs: [{ slotId: 'final-speed', value: '已填写的第一输出' }, ...(index === 20 ? [] : [{ slotId: 'other-final-speed', value: '第二输出' }])],
    reasoning: '个人配对记录，不代表条件满足、单位换算或映射成立。', provenance: { kind: 'user', paragraph: null, quote: '', note: '合成回归实例' } }))
  return document
}
