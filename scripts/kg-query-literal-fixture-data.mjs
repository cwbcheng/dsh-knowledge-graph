import { modelCatalogueSearchFixture } from './kg-model-catalogue-search-fixture-data.mjs'

export function queryLiteralFixture() {
  const fixture = modelCatalogueSearchFixture()
  fixture.graph.source.title = 'LITERAL QUERY ACCEPTANCE DOCUMENT'
  const add = (id, text) => {
    const model = structuredClone(fixture.graph.nodes.find(node => node.id === 'search-condition'))
    model.id = id
    model.entailmentStatus = 'unsupported'
    model.modelStructure.identity = 'wrong_example'
    model.modelStructure.examples = []
    model.modelStructure.branches = [model.modelStructure.branches[0]]
    model.modelStructure.branches[0].condition = { text, provenance: { kind: 'unknown', paragraph: null, quote: '', note: '' } }
    fixture.graph.nodes.push(model)
  }
  add('literal-regex', 'LITERALREGEX [a-z].* (x > 3); [a-z].* only for object-A at t0, in cents.')
  add('literal-wide', '\uff2c\uff29\uff34\uff25\uff32\uff21\uff2c\uff37\uff29\uff24\uff25 only in the stated context.')
  add('literal-spaces', 'SPACELITERAL\tone\n two; retain whitespace and qualifiers.')
  add('literal-case', 'CASEQUERY lower; not a verified assertion.')
  add('literal-grapheme', 'GRAPHEMELITERAL e\u0301 \ud83d\udc69\ud83c\udffd\u200d\ud83d\ude80 \u4e59; only at t0.')
  add('literal-html', 'HTMLLITERAL <img src=x onerror=attack()>; only object-A at t0, no verification.')
  add('literal-many', ('TOKENLITERAL ').repeat(60).trim())
  for (const [id, operator] of [['literal-operator-a', '>'], ['literal-operator-b', '<']]) {
    add(id, 'OPERATORLITERAL x ' + operator + ' 3; OPERATORLITERAL x ' + operator + ' 3; only object-A at t0, in cents.')
  }
  return fixture
}

export const literalCatalogueCases = [
  { query: 'ONLYAFTERMIDNIGHT', modelId: 'search-condition', marks: 1 },
  { query: 'FAREBRANCHONLY', modelId: 'search-mapping', marks: 1 },
  { query: 'NOTOBSERVATION', modelId: 'search-boundary', marks: 1 },
  { query: 'OPERATORLITERAL x > 3', modelId: 'literal-operator-a', marks: 2 },
  { query: '[a-z].*', modelId: 'literal-regex', marks: 2 },
  { query: 'LITERALWIDE', modelId: 'literal-wide', marks: 0 },
  { query: 'SPACELITERAL one two', modelId: 'literal-spaces', marks: 0 },
  { query: 'casequery lower', modelId: 'literal-case', marks: 0 },
  { query: '\ud83d\udc69', modelId: 'literal-grapheme', marks: 0 },
  { query: 'GRAPHEMELITERAL e\u0301', modelId: 'literal-grapheme', marks: 1 },
  { query: '\ud83d\udc69\ud83c\udffd\u200d\ud83d\ude80', modelId: 'literal-grapheme', marks: 1 },
  { query: '<img src=x onerror=attack()>', modelId: 'literal-html', marks: 1 },
  { query: 'TOKENLITERAL', modelId: 'literal-many', marks: 32 },
]
