import { modelChainFixture } from './kg-model-chain-fixture-data.mjs'

export function modelSourceEvidenceFixture() {
  const fixture = modelChainFixture(), original = fixture.graph.nodes.find(node => node.id === 'taxi')
  const cite = quote => {
    const paragraph = fixture.sourceUnits.length
    fixture.sourceUnits.push({ paragraph, text: quote })
    return { kind: 'source', paragraph, quote, note: 'Synthetic recorded citation, not semantic validation.' }
  }
  const quotes = {
    condition: 'FIELD CONDITION: this recorded trip only.\n\nObject Alpha at t0, daytime and no surcharge; x > 3, not x < 3.',
    mapping: 'FIELD MAPPING: base fee 10 units, often not always.\n\nOnly the recorded conditions; no formula execution or independent verification.',
    boundary: 'FIELD BOUNDARY: <img src=x onerror=attack()> is literal text.\n\nObject Beta at t1 and cents are not interchangeable with Alpha at t0 and units.',
    input: 'FIELD INPUT: the full trip distance in km for Object Alpha at t0; direction and object identity remain recorded claims.',
    output: 'FIELD OUTPUT: the predicted fee in units for Object Alpha at t0; not an observed bill or mastery evidence.',
    example: 'FIELD EXAMPLE: recorded 2 km and 10 units.\n\nThis is not a new situation, observation or proof of the mapping.',
  }
  const provenance = Object.fromEntries(Object.entries(quotes).map(([key, quote]) => [key, cite(quote)]))
  const clone = (id, kind = 'source') => {
    const node = { ...structuredClone(original), id, text: 'SOURCETRACE ' + id }
    const structure = node.modelStructure
    const origin = key => ({ ...provenance[key], kind })
    structure.branches = [{ id: 'base', label: 'Recorded qualified branch',
      condition: { text: 'Only Alpha at t0; x > 3, not x < 3.', provenance: origin('condition') },
      mapping: { text: 'Often 10 units under the recorded conditions; not always.', provenance: origin('mapping') },
      boundary: { text: 'Beta at t1 and cents cannot be silently substituted.', provenance: origin('boundary') } }]
    structure.slots[0].provenance = origin('input'); structure.slots[1].provenance = origin('output')
    structure.examples = [{ ...structure.examples[0], provenance: origin('example'), scenario: quotes.example }]
    fixture.graph.nodes.push(node)
    return node
  }
  clone('source-fields')
  for (const kind of ['user', 'ai', 'unknown']) clone('source-' + kind, kind)
  const duplicate = cite('FIELD DUPLICATE: the same recorded text appears in two distinct stored units; do not guess the occurrence.')
  cite(duplicate.quote)
  clone('source-duplicate').modelStructure.branches[0].condition.provenance = duplicate
  const conflict = cite('FIELD CONFLICT: for the same recorded trip and conditions, 12 units rather than 10; both sources remain unverified.')
  const other = clone('source-conflict')
  other.modelStructure.branches[0].mapping = { text: '12 units; conflicts with the other recorded source, not an adjudication.', provenance: conflict }
  fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
  fixture.graph.source.title = 'FIELD SOURCE ACCEPTANCE DOCUMENT'
  fixture.graph.source.paragraphCount = fixture.sourceUnits.length
  return fixture
}
