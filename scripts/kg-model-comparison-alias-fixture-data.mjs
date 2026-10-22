import { modelChainFixture } from './kg-model-chain-fixture-data.mjs'

// Slot labels are contextual names; a shared concept keeps its canonical ID.
// These extra ports are synthetic count cases, not established mappings.
export function comparisonAliasFixture({ collisions = false } = {}) {
  const document = modelChainFixture()
  if (!collisions) return document
  const left = document.graph.nodes.find(node => node.id === 'taxi')
  const right = document.graph.nodes.find(node => node.id === 'budget-model')
  const provenance = { kind: 'source', paragraph: 0, quote: document.sourceUnits[0].text,
    note: '合成的槽位名称比较样本，不证明概念相同或映射成立' }
  const add = (model, id, role) => {
    document.graph.nodes.push({ id, type: 'concept', text: '身份独立的金额概念 ' + id, paragraph: 0 })
    model.modelStructure.slots.push({ id: 'slot-' + id, conceptId: id, label: '基础费用', role,
      unit: '元', state: '本次行程', provenance: { ...provenance } })
  }
  add(left, 'alias-left', 'unknown')
  // Two left identities x 37 right identities = 74 same-name identity pairs. The
  // shared fare identity is called 行程基础费用 on the right and is not a match.
  for (let index = 0; index < 37; index++) add(right, 'alias-right-' + index, 'input')
  return document
}
