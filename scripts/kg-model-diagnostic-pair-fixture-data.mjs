export const modelDiagnosticChanges = [
  () => {},
  (d, s) => { s.examples = [] },
  (d, s) => { s.branches = []; s.examples.forEach(e => { e.branchId = '' }) },
  (d, s) => { s.examples[1].branchId = '' },
  (d, s) => { s.examples[1].inputs = [] },
  (d, s) => { s.examples[1].outputs[0].value = '  ' },
  (d, s) => { s.examples[1].outputs[0].value = '\u2003\u00a0' },
  (d, s) => { s.examples.forEach(e => { for (const b of [...e.inputs, ...e.outputs]) b.value = '0' }) },
  (d, s) => { s.branches[1].mapping.text = '' },
  (d, s) => { s.branches[1].mapping.text = '\u2003\u00a0' },
  (d, s) => { s.branches[1].condition.text = ''; s.branches[1].boundary.text = '' },
  (d, s) => { s.branches.reverse(); s.examples.reverse(); s.slots.reverse() },
  (d, s) => { s.examples.forEach(e => { e.inputs.reverse(); e.outputs.reverse() }) },
  (d, s) => { const id = s.branches[0].id; s.branches[0].id = '__proto__'; s.examples.forEach(e => { if (e.branchId === id) e.branchId = '__proto__' }) },
  (d, s) => { const id = s.branches[0].id; s.branches[0].id = 'constructor'; s.examples.forEach(e => { if (e.branchId === id) e.branchId = 'constructor' }) },
  (d, s) => { s.identity = 'wrong_example' },
  (d, s) => { s.identity = 'type_definition' },
  (d, s) => { s.identity = 'assertion' },
  (d, s) => { s.slots[0].role = 'unknown'; s.examples.forEach(e => { e.inputs = e.inputs.filter(b => b.slotId !== s.slots[0].id) }) },
  (d, s) => { s.slots.forEach(slot => { slot.role = 'output' }); s.examples.forEach(e => { e.inputs = [] }) },
  (d, s) => { s.slots = []; s.examples.forEach(e => { e.inputs = []; e.outputs = [] }) },
  (d, s) => { s.slots.forEach(slot => { slot.role = slot.role === 'input' ? 'output' : 'input' }); s.examples.forEach(e => { [e.inputs, e.outputs] = [e.outputs, e.inputs] }) },
  (d, s) => { s.examples[1].scenario = '' },
  (d, s) => { s.examples[1].scenario = {} },
  (d, s) => { s.examples[1].branchId = 'missing' },
  (d, s) => { s.examples[1].id = s.examples[0].id },
  (d, s) => { s.branches[1].id = s.branches[0].id },
  (d, s) => { s.slots[1].id = s.slots[0].id },
  (d, s) => { s.examples[1].inputs.push(structuredClone(s.examples[1].inputs[0])) },
  (d, s) => { s.examples[1].outputs[0].slotId = 'missing' },
  (d, s) => { s.examples[1].inputs = null },
  (d, s) => { s.examples[1].outputs[0].value = null },
  (d, s) => { s.examples[0] = null },
  (d, s) => { delete s.branches[0].mapping },
  (d, s) => { s.version = 2 },
  (d, s) => { s.examples[1].provenance = { kind: 'source', paragraph: 0, quote: 'not the source', note: '' } },
  d => { d.sourceUnits[0].text = 7 },
  d => { d.sourceUnits.push(null) },
  d => { d.graph.staging = { chunks: {} } },
  d => { d.sourceUnits = [] },
  d => { d.graph.nodes.find(n => n.id === 'distance').state = 'rejected' },
]

// Test oracle only: independent single-example checks, after canonical validation.
export function diagnosticBranchCounts(tools, document, structure) {
  tools.validate(structure, new Map(document.graph.nodes.map(node => [node.id, node])),
    new Map(document.sourceUnits.map(unit => [unit.paragraph, unit.text])))
  const counts = new Map(structure.branches.map(branch => [branch.id, { pairedExamples: 0, incompleteExamples: 0 }]))
  for (const example of structure.examples) {
    const count = counts.get(example.branchId), status = tools.exampleStatus(structure, example)
    if (count) count[status.complete ? 'pairedExamples' : 'incompleteExamples']++
  }
  return counts
}

// An unconditional filter-to-some rewrite changes which late raw error is thrown.
export function diagnosticGetterFixture(makeFixture) {
  const s = makeFixture({ branches: 2, examples: 3 }).graph.nodes.find(node => node.id === 'taxi').modelStructure
  s.examples[0].inputs = [{ slotId: 'slot-0', value: '0' }]; s.examples[0].outputs[0].value = '0'
  s.examples[1].branchId = 'branch-0'; s.examples[2].branchId = 'branch-1'
  Object.defineProperty(s.examples[1].outputs[0], 'value', { enumerable: true, get() { throw new Error('late first-branch output') } })
  Object.defineProperty(s.examples[2].inputs[0], 'value', { enumerable: true, get() { throw new Error('second-branch input') } })
  return s
}
