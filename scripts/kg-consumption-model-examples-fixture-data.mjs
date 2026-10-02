import { modelChainFixture } from './kg-model-chain-fixture-data.mjs'

export function modelExamplesFixture() {
  const fixture = modelChainFixture(), nodes = fixture.graph.nodes
  const taxi = nodes.find(node => node.id === 'taxi')
  const user = { kind: 'user', paragraph: null, quote: '', note: 'Synthetic saved material, not a new exercise or observation.' }
  const clone = (id, original = taxi) => {
    const node = { ...structuredClone(original), id, text: 'PAIREDCONTEXT ' + id }
    nodes.push(node)
    return node
  }
  const exampleFor = structure => ({ id: 'saved-pair', title: 'Recorded synthetic situation',
    scenario: 'The same object in the recorded time state; all values are unverified saved text.',
    branchId: structure.branches[0].id,
    inputs: structure.slots.filter(slot => slot.role === 'input').map(slot => ({ slotId: slot.id, value: 'known-' + slot.id })),
    outputs: structure.slots.filter(slot => slot.role === 'output').map(slot => ({ slotId: slot.id, value: 'predicted-' + slot.id })),
    reasoning: 'Often more conditions are needed; this is not formula execution.', provenance: { ...user } })
  for (const id of ['multi', 'units', 'times', 'same-name', 'unknown-unit', 'unknown-state', 'wrong-model',
    'type-model', 'unknown-role', 'uncited', 'return-model', 'duplicate-concept', 'unsupported-model']) {
    const node = clone('pair-' + id, nodes.find(node => node.id === id))
    node.modelStructure.examples = [exampleFor(node.modelStructure)]
  }
  const incomplete = clone('pair-incomplete', nodes.find(node => node.id === 'multi'))
  incomplete.modelStructure.examples = [exampleFor(incomplete.modelStructure)]
  incomplete.modelStructure.examples[0].inputs.pop()
  const noBranch = clone('pair-no-branch')
  noBranch.modelStructure.examples = [structuredClone(taxi.modelStructure.examples[0])]
  noBranch.modelStructure.examples[0].branchId = ''
  const noReason = clone('pair-no-reasoning')
  noReason.modelStructure.examples = [structuredClone(taxi.modelStructure.examples[0])]
  noReason.modelStructure.examples[0].reasoning = ''

  const quote = 'PAIRSOURCEONLY: recorded 2 km / 10 units for this synthetic trip; not an observation, proof or mastery.'
  const paragraph = fixture.sourceUnits.length
  fixture.sourceUnits.push({ paragraph, text: quote })
  for (const kind of ['source', 'user', 'ai', 'unknown']) {
    const node = clone('pair-' + kind)
    node.modelStructure.examples = [{ ...structuredClone(taxi.modelStructure.examples[0]), scenario: quote,
      provenance: { kind, paragraph, quote, note: 'Declared origin is not semantic validation.' } }]
  }
  const longQuote = 'PAIRLONGSOURCE: ' + 'recorded context; '.repeat(60) + 'not evidence of truth or mastery.'
  const longParagraph = fixture.sourceUnits.length
  fixture.sourceUnits.push({ paragraph: longParagraph, text: longQuote })
  const long = clone('pair-long-source')
  long.modelStructure.examples = [{ ...structuredClone(taxi.modelStructure.examples[0]), scenario: longQuote,
    provenance: { kind: 'source', paragraph: longParagraph, quote: longQuote, note: '' } }]
  for (const [id, value] of [['pair-conflict-a', '10'], ['pair-conflict-b', '12']]) {
    const node = clone(id), paragraph = fixture.sourceUnits.length
    const quote = 'Conflicting synthetic source ' + id + ': the same trip and conditions, 2 km predicts ' + value + ' units; unverified.'
    fixture.sourceUnits.push({ paragraph, text: quote })
    node.modelStructure.examples = [{ ...structuredClone(taxi.modelStructure.examples[0]), scenario: 'The same recorded trip and conditions.',
      outputs: [{ slotId: 'fare-slot', value }], provenance: { kind: 'source', paragraph, quote, note: '' } }]
  }
  const huge = clone('pair-huge', nodes.find(node => node.id === 'multi'))
  for (let index = 0; index < 30; index++) huge.modelStructure.slots.push({ ...structuredClone(huge.modelStructure.slots[0]),
    id: 'required-' + index, label: 'Required input ' + index, state: 'Separate object/time state ' + index })
  huge.modelStructure.examples = [exampleFor(huge.modelStructure)]
  for (const binding of huge.modelStructure.examples[0].inputs) binding.value = 'value-'.repeat(120)
  for (let index = 0; index < 8; index++) {
    const node = clone('pair-many-' + index)
    node.modelStructure.examples = structuredClone(taxi.modelStructure.examples.slice(0, 2))
  }
  for (let index = 0; index < 4; index++) {
    const node = clone('pair-pressure-' + index)
    const field = text => ({ text, provenance: { ...user } })
    node.modelStructure.branches = [{ id: 'base', label: 'Recorded complex conditions',
      condition: field('condition '.repeat(200)), mapping: field('often '.repeat(333)), boundary: field('not verified '.repeat(153)) }]
    for (const slot of node.modelStructure.slots) slot.state = 'Recorded object/time state; '.repeat(7)
    node.modelStructure.examples = structuredClone(taxi.modelStructure.examples.slice(0, 1))
    for (const example of node.modelStructure.examples) {
      example.branchId = 'base'
      example.scenario = 'recorded '.repeat(170)
      example.reasoning = 'Not verified. '.repeat(120)
    }
  }
  fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
  fixture.graph.source.paragraphCount = fixture.sourceUnits.length
  return fixture
}
