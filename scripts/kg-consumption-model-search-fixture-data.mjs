import { modelChainFixture } from './kg-model-chain-fixture-data.mjs'

export function modelSearchFixture() {
  const fixture = modelChainFixture()
  const field = (text, kind = 'user') => ({ text, provenance: { kind, paragraph: null, quote: '', note: '' } })
  const clone = (id, original = 'taxi') => {
    const model = structuredClone(fixture.graph.nodes.find(node => node.id === original))
    model.id = id; model.text = 'Recorded branch model'
    fixture.graph.nodes.push(model)
    return model
  }
  clone('search-condition').modelStructure.branches[0].condition = field('ONLYAFTERMIDNIGHT applies only to this recorded trip.')
  clone('search-mapping', 'multi').modelStructure.branches[0].mapping = field('FAREBRANCHONLY is a hypothetical recorded mapping, not a numerical proof.', 'ai')
  const boundary = clone('search-boundary', 'wrong-model')
  const paragraph = fixture.sourceUnits.length
  const quote = 'NOTOBSERVATION is a recorded wrong-example boundary, not an independent observation.'
  fixture.sourceUnits.push({ paragraph, text: quote })
  boundary.modelStructure.branches[0].boundary = { text: quote,
    provenance: { kind: 'source', paragraph, quote, note: '' } }
  for (const id of ['units', 'times', 'same-name', 'unknown-unit', 'unknown-state', 'wrong-model', 'type-model',
    'unknown-role', 'uncited', 'return-model', 'duplicate-concept', 'unsupported-model', 'multi']) {
    const model = clone('search-' + id, id)
    model.modelStructure.branches[0].condition = field('ROLEBRANCHCASE: ' + model.modelStructure.branches[0].condition.text)
  }
  for (const [id, price] of [['search-conflict-a', 10], ['search-conflict-b', 12]]) {
    const model = clone(id)
    model.modelStructure.branches[0].condition = field('CONFLICTBRANCHCASE: same object, time and conditions.')
    model.modelStructure.branches[0].mapping = field('Recorded fare = ' + price + '; conflicting unverified reports.')
  }
  const notes = clone('search-notes')
  notes.modelStructure.branches[0].condition.provenance.note = 'NOTEONLYSENTINEL'
  const examples = clone('search-examples')
  examples.modelStructure.examples[0].scenario = 'EXAMPLEONLYSENTINEL: an example is not branch-condition text.'
  const escaped = clone('search-normalized')
  escaped.modelStructure.branches[0].condition = field('ＦＵＬＬＷＩＤＴＨＣＯＮＤＩＴＩＯＮ')
  escaped.modelStructure.branches[0].mapping = field('UNICODEPHRASE\n\tNORMALIZEDWORD')
  fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
  fixture.graph.source.paragraphCount = fixture.sourceUnits.length
  return fixture
}
