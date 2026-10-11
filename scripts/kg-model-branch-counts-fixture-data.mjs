import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'

export function modelBranchCountsFixture({ slots = 2, branches = 40, examples = 100, structured = true } = {}) {
  const document = modelStructureFixture(), model = document.graph.nodes.find(node => node.id === 'taxi')
  const structure = model.modelStructure, templates = structuredClone(structure.slots), branch = structuredClone(structure.branches[0])
  structure.identity = 'hypothesis'
  structure.slots = Array.from({ length: slots }, (_, index) => ({ ...structuredClone(templates[index % 2]),
    id: 'slot-' + index, label: '独立槽位 ' + index, state: '对象时间 ' + index }))
  structure.branches = Array.from({ length: branches }, (_, index) => ({ ...structuredClone(branch), id: 'branch-' + index,
    label: '同名条件分支', ...(index % 7 === 6 ? { mapping: { text: '', provenance: { kind: 'unknown', paragraph: null, quote: '', note: '' } } } : {}) }))
  structure.examples = Array.from({ length: examples }, (_, index) => ({ id: 'example-' + index,
    title: '同名个人例子', scenario: '例子 ' + index + '：仅核对记录，不证明映射为真。', branchId: branches ? 'branch-' + index % branches : '',
    inputs: index % 3 ? structure.slots.filter(slot => slot.role === 'input').map(slot => ({ slotId: slot.id, value: '2' })) : [],
    outputs: structure.slots.filter(slot => slot.role === 'output').map(slot => ({ slotId: slot.id, value: index % 5 ? '10' : '  ' })),
    reasoning: '仍需核对适用条件与原文证据', provenance: { kind: 'user', paragraph: null, quote: '', note: '' } }))
  if (!structured) for (const node of document.graph.nodes) delete node.modelStructure
  return document
}

export const modelBranchCountsModes = [
  { modelId: 'taxi' }, { modelId: 'taxi', diagnosis: true }, { modelId: 'taxi', structureSources: true },
  { modelId: 'taxi', compareModelId: 'multi' }, { modelId: 'taxi', branchId: 'branch-1', exampleOffset: 20 },
  { modelId: 'taxi', exampleOffset: 20 }, { modelId: 'taxi', exampleOffset: 999 },
  { modelId: 'taxi', branchId: 'missing' }, { modelId: 'taxi', branchId: 'branch-0' },
  { modelId: 'taxi', exampleOffset: -1 }, { modelId: 'taxi', exampleOffset: '20' }, { modelId: 'missing' },
]

// Count actual full-example filtering across the whole query, including diagnostic defensive arrays.
export function countFullExampleFilters(query) {
  const filter = Array.prototype.filter
  let calls = 0, visits = 0
  Array.prototype.filter = function(callback, thisArg) {
    if (!this.length || this[0]?.id !== 'example-0') return filter.call(this, callback, thisArg)
    calls++
    return filter.call(this, (value, index, array) => { visits++; return callback.call(thisArg, value, index, array) })
  }
  try { return { response: query(), calls, visits } } finally { Array.prototype.filter = filter }
}
