import assert from 'node:assert/strict'
import { modelConceptQueryFixture } from './kg-model-concept-query-fixture.mjs'

export const modelPrivateNameFixture = modelConceptQueryFixture
export const privateNameRequests = [[], ['__PROTO__', '__proto__'], Array.from({ length: 40 }, (_, i) => 'search-concept-' + i)]
export const privateNameModes = [
  ...privateNameRequests.map(conceptNames => ({ conceptNames })),
  { conceptNames: ['constructor', 'spaced/id:opaque identity', 'rejected-concept', 'taxi', 'missing'] },
  { conceptNames: ['multi', 'distance', 'speed'] },
  { conceptNames: ['__PROTO__', '__proto__'], modelId: 'taxi' },
  { conceptNames: [], modelId: 'missing' }, { conceptNames: [], modelId: 'distance' },
  { conceptNames: [], modelId: undefined }, { conceptNames: ['__proto__'], expectedRevision: 0 },
  ...[null, true, 'speed', [0], [''], [' '], ['x'.repeat(161)], ['speed', 'speed'], Array(41).fill('speed')]
    .map(conceptNames => ({ conceptNames })),
  ...[{ concepts: true }, { diagnosis: true }, { structureSources: true }, { structureEdit: true },
    { compareModelId: 'taxi' }, { query: 'speed' }, { offset: 0 }, { compareModelId: 'taxi', chainDraft: {} }]
    .map(extra => ({ conceptNames: ['__proto__'], ...extra })),
]

// Instrument only input reads and actual graph-node Map writes, outside timings.
export function privateNameIndexWork(query, document, args, expected) {
  const { nodes, edges } = document.graph, units = document.sourceUnits
  const saved = [[nodes, 'map'], [edges, 'forEach'], [units, 'map']]
    .map(([object, key]) => ({ object, key, descriptor: Object.getOwnPropertyDescriptor(object, key), method: object[key] }))
  const nodeValues = new Set(nodes), set = Object.getOwnPropertyDescriptor(Map.prototype, 'set')
  let nodeVisits = 0, edgeVisits = 0, sourceUnitVisits = 0, graphIndexEntries = 0
  for (const [index, entry] of saved.entries()) Object.defineProperty(entry.object, entry.key, {
    configurable: true, value(callback, ...rest) {
      return entry.method.call(this, (...values) => {
        if (index === 0) nodeVisits++; else if (index === 1) edgeVisits++; else sourceUnitVisits++
        return callback(...values)
      }, ...rest)
    },
  })
  Map.prototype.set = function (key, value) {
    if (nodeValues.has(value)) graphIndexEntries++
    return set.value.call(this, key, value)
  }
  try { assert.deepEqual(query(document, args), expected) }
  finally {
    Object.defineProperty(Map.prototype, 'set', set)
    for (const { object, key, descriptor } of saved) {
      if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key]
    }
  }
  return { nodeVisits, edgeVisits, sourceUnitVisits, graphIndexEntries }
}
