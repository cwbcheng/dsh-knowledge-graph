import { modelDiagnosticChanges } from './kg-model-diagnostic-pair-fixture-data.mjs'

export const modelMissingChanges = [
  ...modelDiagnosticChanges,
  (d, s) => { s.slots.forEach(slot => { slot.label = '' }) },
  (d, s) => { s.slots.forEach(slot => { slot.label = '\u2003\u00a0' }) },
  (d, s) => { s.examples.at(-1).inputs = []; s.examples.at(-1).outputs = [] },
  (d, s) => { s.examples.at(-1).provenance = { kind: 'source', paragraph: 0, quote: d.sourceText, note: '完整引文' } },
  (d, s) => { const id = s.slots[0].id; s.slots[0].id = '__proto__'; s.examples.forEach(e => e.inputs.forEach(b => { if (b.slotId === id) b.slotId = '__proto__' })) },
  (d, s) => { const id = s.slots[1].id; s.slots[1].id = 'constructor'; s.examples.forEach(e => e.outputs.forEach(b => { if (b.slotId === id) b.slotId = 'constructor' })) },
  (d, s) => { s.examples[0].id = '__proto__'; s.examples[1].id = 'constructor' },
  (d, s) => { s.examples[1].inputs = []; s.examples[1].outputs = []; s.slots.reverse() },
]

// Test oracle only: the production Host reuses statuses it already computed.
export function diagnosticExampleStatuses(tools, document, structure) {
  tools.validate(structure, new Map(document.graph.nodes.map(node => [node.id, node])),
    new Map(document.sourceUnits.map(unit => [unit.paragraph, unit.text])))
  return new Map(structure.examples.map(example => [example.id, tools.exampleStatus(structure, example)]))
}
