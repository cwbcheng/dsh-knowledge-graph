import { documentBrowseIdentityFixture } from './kg-document-browse-identity-fixture-data.mjs'

export const neighborhoodReadCases = ['units', 'times', 'same-name', 'unknown-unit', 'unknown-state', 'wrong-model',
  'type-model', 'unknown-role', 'uncited', 'return-model', 'duplicate-concept', 'unsupported-model', 'multi']

export function neighborhoodReadFixture(documentId = 'neighborhood-snapshot', marker = 'ORIGINALNEIGHBORHOOD') {
  const fixture = documentBrowseIdentityFixture(documentId, marker, '关系与来源的一致性材料')
  for (const id of neighborhoodReadCases) fixture.graph.edges.push({ fromNodeId: 'taxi', toNodeId: 'search-' + id, relation: 'analogy' })
  fixture.graph.edges.push({ fromNodeId: 'search-conflict-a', toNodeId: 'taxi', relation: 'contradicts' },
    { fromNodeId: 'taxi', toNodeId: 'search-conflict-b', relation: 'supports' },
    { fromNodeId: 'search-conflict-b', toNodeId: 'taxi', relation: 'contradicts' })
  return fixture
}
