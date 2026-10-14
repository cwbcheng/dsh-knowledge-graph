import assert from 'node:assert/strict'
import { createGraphContract } from '../src/index.host.js'
import { materialLinksFixture, materialLinksQuery, materialLinksWork } from './kg-model-material-links-fixture.mjs'
import { materialValuesWork } from './kg-model-related-values-fixture.mjs'

const contract = createGraphContract(), query = (document, options) => materialLinksQuery(contract, document, options)
let pages = 0, accessorCases = 0
for (const structured of [false, true]) for (const materials of [25, 4096]) {
  const document = materialLinksFixture({ structured, materials, chunks: 512 }), before = JSON.stringify(document)
  for (const offset of [0, 19, 20, materials - 1, materials, materials + 5, -1, '20', Number.MAX_SAFE_INTEGER]) {
    const expected = query(document, { offset }), values = materialValuesWork(query, document, { offset }, expected)
    assert.equal(expected.relatedTotal, materials + 5)
    assert.equal(values.valuesYielded, 0, 'Ordinary pages must not copy the entire related-material Map into an array')
    assert.equal(values.collections, 0)
    const links = materialLinksWork(query, document, { offset }, expected)
    assert.equal(links.relatedEntries, materials + 5, 'All identities still contribute to total and encounter order')
    assert.equal(links.linkArrays, expected.related.length)
    assert.equal(links.constructedLinks, expected.related.reduce((sum, item) => sum + item.links.length, 0))
    pages++
  }
  const sourceOptions = { structureSources: true, offset: materials + 5 }
  assert.equal(materialValuesWork(query, document, sourceOptions, query(document, sourceOptions)).valuesYielded, materials + 5)
  for (const field of ['diagnosis', 'structureSources']) for (const inherited of [false, true]) {
    const args = { modelId: 'left', expectedRevision: 1 }, target = inherited ? {} : args
    Object.defineProperty(target, field, { get() { return false } })
    if (inherited) Object.setPrototypeOf(args, target)
    const direct = (doc, options) => contract.connectionModels(doc, options)
    const expected = direct(document, args)
    assert.equal(materialValuesWork(direct, document, args, expected).valuesYielded, materials + 5, 'Accessor modes retain original collection and getter order')
    accessorCases++
  }
  assert.equal(JSON.stringify(document), before)
}
const document = materialLinksFixture(), before = JSON.stringify(document), last = query(document, { offset: 64 })
assert.deepEqual(last.related.map(item => item.nodeId), ['rule-a', 'mapping-material', 'verification-material', 'example-material', 'rule-b'])
assert.deepEqual(last.related.find(item => item.nodeId === 'mapping-material').links.map(({ relation, via }) => [relation, via]),
  [['states_mapping', 'rule-a'], ['states_mapping', 'rule-b'], ['states_mapping', 'left']])
assert.deepEqual(query(document, { compareModelId: 'right', offset: 1000 }).left, query(document))
const mutable = query(document, { offset: 64 }); mutable.related[1].links[0].via = 'caller-only'
assert.deepEqual(query(document, { offset: 64 }), last)
assert.equal(JSON.stringify(document), before)
assert.equal(query(document, { expectedRevision: 0 }).error.code, 'revision_conflict')
console.log(JSON.stringify({ ok: true, pages, accessorCases, noOffPageValuesArray: true, fullSourceContext: true, identityOrderAndMultipleLinks: true, canonicalReadOnly: true }))
