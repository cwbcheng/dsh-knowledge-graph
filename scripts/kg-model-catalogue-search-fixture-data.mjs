import { modelSearchFixture } from './kg-consumption-model-search-fixture-data.mjs'

export function modelCatalogueSearchFixture({ scale = false } = {}) {
  const fixture = modelSearchFixture()
  const field = (text, kind = 'user') => ({ text, provenance: { kind, paragraph: null, quote: '', note: '' } })
  const clone = id => {
    const node = structuredClone(fixture.graph.nodes.find(item => item.id === 'search-condition'))
    node.id = id
    fixture.graph.nodes.push(node)
    return node
  }
  const unknown = clone('catalogue-unknown-origin')
  unknown.modelStructure.branches[0].condition = field('UNRESOLVEDCATALOGUE: object and time still unknown.', 'unknown')
  const split = clone('catalogue-split')
  split.modelStructure.branches[0].condition = field('FIRSTRARECATALOGUE')
  split.modelStructure.branches[0].mapping = field('SECONDRARECATALOGUE')
  split.modelStructure.branches[0].boundary = field('OPERATORCATALOGUE x > 3; ARROWCATALOGUE input -> output.')
  const between = clone('catalogue-between-branches')
  between.modelStructure.branches[0].condition = field('BETWEENFIRSTCATALOGUE')
  between.modelStructure.branches[1].condition = field('BETWEENSECONDCATALOGUE')
  between.modelStructure.branches[0].boundary = field('OPERATORCATALOGUE x < 3; ARROWCATALOGUE output -> input.')
  const dense = clone('catalogue-dense')
  dense.modelStructure.examples = []
  dense.modelStructure.branches = Array.from({ length: 12 }, (_, index) => ({ id: 'dense-' + index, label: 'Recorded branch ' + index,
    condition: field('DENSECATALOGUERECORD only in this recorded scenario.'), mapping: field('DENSECATALOGUERECORD may not be executable.'),
    boundary: field('DENSECATALOGUERECORD is not verified.') }))
  const tail = clone('catalogue-tail-branch')
  tail.modelStructure.examples = []
  tail.modelStructure.branches = Array.from({ length: 40 }, (_, index) => ({ id: 'tail-' + index, label: 'Recorded branch ' + index,
    condition: field(index === 39 ? 'BRANCHTAILCATALOGUE: only the final recorded condition.' : 'An unrelated condition.'),
    mapping: field('Unverified mapping.'), boundary: field('Object, time and units need review.') }))
  if (scale) {
    for (let index = 0; index < 845; index++) {
      const node = clone('catalogue-scale-' + String(index).padStart(4, '0'))
      node.paragraph = 7
      node.modelStructure.branches[0].condition = field('CATALOGUEPAGETOKEN: recorded branch ' + index)
    }
    const late = clone('catalogue-scale-zzzz')
    late.paragraph = 7
    late.modelStructure.branches[0].condition = field('CATALOGUEPAGETOKEN PRECISIONTAILCATALOGUE: only after the final page.')
  }
  return fixture
}
