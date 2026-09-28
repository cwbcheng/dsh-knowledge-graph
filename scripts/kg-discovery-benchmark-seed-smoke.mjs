import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createGraphContract } from '../src/index.host.js'
import { fingerprintDiscoveryGold } from './kg-discovery-benchmark.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-source-zh-v2.json', import.meta.url), 'utf8'))
const second = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-source-zh-v3.json', import.meta.url), 'utf8'))
const table = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-source-zh-v4.json', import.meta.url), 'utf8'))
const dialogue = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-source-zh-v5.json', import.meta.url), 'utf8'))
const interview = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-source-zh-v6.json', import.meta.url), 'utf8'))
const openArticle = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-source-zh-v7.json', import.meta.url), 'utf8'))
const grandfathered = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-source-zh-v8.json', import.meta.url), 'utf8'))
const nonsignificance = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-source-zh-v9.json', import.meta.url), 'utf8'))
const clean = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-source-zh-v11.json', import.meta.url), 'utf8'))
const connectedClean = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-source-zh-v12.json', import.meta.url), 'utf8'))
const sunzi = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-source-zh-v13.json', import.meta.url), 'utf8'))
assert.deepEqual(createGraphContract().splitParagraphs(sunzi.sourceUnits.map(unit => unit.text).join('\n\n')),
  sunzi.sourceUnits.map(unit => unit.text), 'public-domain clauses must retain their frozen Host anchors')
assert.ok(fingerprintDiscoveryGold({ ...sunzi, revision: 1 }))
const sunziPlan = createGraphContract().buildFullVerifyPlan(
  sunzi.sourceUnits.map(unit => unit.text).join('\n\n'), sunzi.graph)
const sunziBatch = sunziPlan.batches.find(batch => batch.primaryNodeIds.includes('n1'))
assert(sunziBatch && sunziBatch.units.some(unit => unit.num === 0) &&
  sunziBatch.units.some(unit => unit.num === 1),
  'the only-know-self clause and contrasting know-both clause must reach the target audit batch')
const correctedSunzi = structuredClone(sunzi)
correctedSunzi.sourceUnits[1].text = correctedSunzi.sourceUnits[1].text.replace('一胜一负', '百战不殆')
assert.throws(() => fingerprintDiscoveryGold({ ...correctedSunzi, revision: 1 }),
  /finding evidence is not in source/, 'reversing the source contrast invalidates the frozen positive label')
assert.deepEqual(createGraphContract().splitParagraphs(connectedClean.sourceUnits.map(unit => unit.text).join('\n\n')),
  connectedClean.sourceUnits.map(unit => unit.text), 'connected control must use actual Host source units')
assert.ok(fingerprintDiscoveryGold({ ...connectedClean, revision: 1 }))
for (const item of [...connectedClean.graph.nodes, ...connectedClean.graph.edges]) {
  for (const evidence of item.evidence) {
    assert(connectedClean.sourceUnits[evidence.paragraph].text.includes(evidence.quote),
      'every connected-control citation must be grounded in the declared Host unit')
  }
}
const connectedPlan = createGraphContract().buildFullVerifyPlan(
  connectedClean.sourceUnits.map(unit => unit.text).join('\n\n'), connectedClean.graph)
assert.equal(connectedPlan.coverage.nodeCount, 2)
assert.equal(connectedPlan.coverage.edgeCount, 1)
assert.equal(connectedPlan.coverage.sourceUnitCount, 3)
const taxonomyBatch = connectedPlan.batches.find(batch => batch.primaryEdgeKeys?.some(key => key.includes('n1') && key.includes('n2')))
assert(taxonomyBatch, 'the explicit is-a relation must be assigned to full verification')
assert(taxonomyBatch.units.some(unit => unit.num === 2), 'the relation-defining source unit must reach its audit batch')
const brokenTaxonomy = structuredClone(connectedClean)
brokenTaxonomy.sourceUnits[2].text = brokenTaxonomy.sourceUnits[2].text.replace('是一种', '不是一种')
assert.notDeepEqual(createGraphContract().splitParagraphs(brokenTaxonomy.sourceUnits.map(unit => unit.text).join('\n\n')),
  connectedClean.sourceUnits.map(unit => unit.text), 'adversarial taxonomy mutation must change source meaning')
assert(!brokenTaxonomy.sourceUnits[2].text.includes(connectedClean.graph.edges[0].evidence[0].quote),
  'the original is-a evidence must not survive a source reversal')
assert.deepEqual(createGraphContract().splitParagraphs(clean.sourceUnits.map(unit => unit.text).join('\n\n')),
  clean.sourceUnits.map(unit => unit.text), 'clean-control source units must match actual Host anchors')
assert.ok(fingerprintDiscoveryGold({ ...clean, revision: 1 }))
for (const node of clean.graph.nodes) {
  assert(clean.sourceUnits[node.paragraph].text.includes(node.quote))
  for (const evidence of node.evidence) assert(clean.sourceUnits[evidence.paragraph].text.includes(evidence.quote))
}
const cleanPlan = createGraphContract().buildFullVerifyPlan(
  clean.sourceUnits.map(unit => unit.text).join('\n\n'), clean.graph)
assert.equal(cleanPlan.coverage.nodeCount, clean.graph.nodes.length)
assert.equal(cleanPlan.coverage.sourceUnitCount, clean.sourceUnits.length)
assert.throws(() => fingerprintDiscoveryGold({ ...clean, revision: 1, negativeReview: undefined }),
  /negative review/, 'a clean control cannot be frozen without an explicit source-and-graph review')
assert.deepEqual(createGraphContract().splitParagraphs(nonsignificance.sourceUnits.map(unit => unit.text).join('\n\n')),
  nonsignificance.sourceUnits.map(unit => unit.text), 'trial result and equivalence-design units must retain separate Host anchors')
assert.ok(fingerprintDiscoveryGold({ ...nonsignificance, revision: 1 }))
const trialPlan = createGraphContract().buildFullVerifyPlan(
  nonsignificance.sourceUnits.map(unit => unit.text).join('\n\n'), nonsignificance.graph)
const equivalenceBatch = trialPlan.batches.find(batch => batch.primaryNodeIds.includes('n1'))
assert(equivalenceBatch && equivalenceBatch.units.some(unit => unit.num === 2) &&
  equivalenceBatch.units.some(unit => unit.num === 3),
  'the no-equivalence-test qualifier and interpretation must reach the full-audit batch')
const provedEquivalence = structuredClone(nonsignificance)
provedEquivalence.sourceUnits[2].text = '研究预设了等效性界值，并实施了等效性检验。'
assert.throws(() => fingerprintDiscoveryGold({ ...provedEquivalence, revision: 1 }),
  /finding evidence is not in source/, 'reversing the study design must invalidate the frozen finding')
assert.deepEqual(createGraphContract().splitParagraphs(second.sourceUnits.map(unit => unit.text).join('\n\n')),
  second.sourceUnits.map(unit => unit.text))
assert.ok(fingerprintDiscoveryGold({ ...second, revision: 1 }))
assert.deepEqual(createGraphContract().splitParagraphs(table.sourceUnits.map(unit => unit.text).join('\n\n')),
  table.sourceUnits.map(unit => unit.text), 'table header and each data row must retain their own Host source anchors')
assert.ok(fingerprintDiscoveryGold({ ...table, revision: 1 }))
assert.deepEqual(createGraphContract().splitParagraphs(dialogue.sourceUnits.map(unit => unit.text).join('\n\n')),
  dialogue.sourceUnits.map(unit => unit.text), 'the hypothetical and actual-observation units must retain distinct Host anchors')
assert.ok(fingerprintDiscoveryGold({ ...dialogue, revision: 1 }))
assert.deepEqual(createGraphContract().splitParagraphs(interview.sourceUnits.map(unit => unit.text).join('\n\n')),
  interview.sourceUnits.map(unit => unit.text), 'speaker quote and editor rebuttal must retain distinct Host anchors')
assert.ok(fingerprintDiscoveryGold({ ...interview, revision: 1 }))
assert.deepEqual(createGraphContract().splitParagraphs(openArticle.sourceUnits.map(unit => unit.text).join('\n\n')),
  openArticle.sourceUnits.map(unit => unit.text), 'the real article abstract and subgroup rows must retain their source anchors')
assert.ok(fingerprintDiscoveryGold({ ...openArticle, revision: 1 }))
assert.deepEqual(createGraphContract().splitParagraphs(grandfathered.sourceUnits.map(unit => unit.text).join('\n\n')),
  grandfathered.sourceUnits.map(unit => unit.text), 'effective-date and transition units must match the real Host split')
assert.ok(fingerprintDiscoveryGold({ ...grandfathered, revision: 1 }))
for (const item of grandfathered.graph.nodes) {
  assert(grandfathered.sourceUnits[item.paragraph].text.includes(item.quote))
  for (const evidence of item.evidence) assert(grandfathered.sourceUnits[evidence.paragraph].text.includes(evidence.quote))
}
const grandfatheredPlan = createGraphContract().buildFullVerifyPlan(
  grandfathered.sourceUnits.map(unit => unit.text).join('\n\n'), grandfathered.graph)
const policyBatch = grandfatheredPlan.batches.find(batch => batch.primaryNodeIds.includes('n1'))
assert(policyBatch, 'the overgeneralized rule must be in a full-audit batch')
assert.deepEqual(policyBatch.units.map(unit => unit.num), [0, 1, 2, 3, 4, 5, 6, 7],
  'the exception and old-cohort counterexample must be available to the model')
const erasedTransition = structuredClone(grandfathered)
erasedTransition.sourceUnits[4].text = erasedTransition.sourceUnits[4].text.replace('旧班继续采用2023版流程', '旧班改用2024版流程')
assert.throws(() => fingerprintDiscoveryGold({ ...erasedTransition, revision: 1 }),
  /finding evidence is not in source/, 'removing the grandfathering clause must invalidate the frozen finding')
for (const item of openArticle.graph.nodes) {
  assert(openArticle.sourceUnits[item.paragraph].text.includes(item.quote), 'the graph quote must match its article unit')
  for (const evidence of item.evidence) {
    assert(openArticle.sourceUnits[evidence.paragraph].text.includes(evidence.quote), 'each graph citation must match its article unit')
  }
}
assert.match(openArticle.sourceUnits[2].text, /I²=58\.988%.*g=0\.333/)
assert.match(openArticle.sourceUnits[3].text, /I²=25\.528%.*g=0\.530/)
const articlePlan = createGraphContract().buildFullVerifyPlan(
  openArticle.sourceUnits.map(unit => unit.text).join('\n\n'), openArticle.graph)
const comparisonBatch = articlePlan.batches.find(batch => batch.primaryNodeIds.includes('n1'))
assert(comparisonBatch, 'the published-data comparison must be assigned to a full-audit batch')
assert.deepEqual(comparisonBatch.units.map(unit => unit.num), [0, 1, 2, 3],
  'the frozen missed finding must not be attributed to omitted distant subgroup evidence')
assert.deepEqual(comparisonBatch.primaryNodeIds, ['n1', 'n2', 'n3', 'n4'])
const alteredArticle = structuredClone(openArticle)
alteredArticle.sourceUnits[3].text = alteredArticle.sourceUnits[3].text.replace('g=0.530', 'g=0.230')
assert.throws(() => fingerprintDiscoveryGold({ ...alteredArticle, revision: 1 }),
  /finding evidence is not in source/, 'reversing the published subgroup comparison must invalidate the frozen finding')
const endorsedInterview = structuredClone(interview)
endorsedInterview.sourceUnits[2].text = endorsedInterview.sourceUnits[2].text.replace('不能把林的经验判断当成已证实结论', '赞同林的经验判断')
assert.throws(() => fingerprintDiscoveryGold({ ...endorsedInterview, revision: 1 }),
  /finding evidence is not in source/, 'changing editor disagreement into endorsement must invalidate frozen evidence')
const assertedDialogue = structuredClone(dialogue)
assertedDialogue.sourceUnits[0].text = assertedDialogue.sourceUnits[0].text.replace('乙方案只在讨论中提出，没有实施', '乙方案已经实施')
assert.throws(() => fingerprintDiscoveryGold({ ...assertedDialogue, revision: 1 }),
  /finding evidence is not in source/, 'changing an untested proposal into an asserted observation must invalidate frozen gold')
const reversedHeader = structuredClone(table)
reversedHeader.sourceUnits[1].text = '| 学生组别 | 策略乙达标人数 | 策略甲达标人数 |'
assert.throws(() => fingerprintDiscoveryGold({ ...reversedHeader, revision: 1 }),
  /finding evidence is not in source/, 'swapped column meaning must invalidate the frozen evidence')
const sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
assert.deepEqual(createGraphContract().splitParagraphs(sourceText), fixture.sourceUnits.map(unit => unit.text))
assert.ok(fingerprintDiscoveryGold({ ...fixture, revision: 1 }))

const malformed = structuredClone(fixture)
malformed.sourceUnits[0].text = malformed.sourceUnits[0].text.replace('提高，研究', '提高；研究')
assert.equal(createGraphContract().splitParagraphs(malformed.sourceUnits.map(unit => unit.text).join('\n\n')).length, 5,
  'the adversarial source must actually move later evidence anchors')
const dir = mkdtempSync(join(tmpdir(), 'kg-discovery-seed-'))
const db = join(dir, 'isolated.sqlite')
const input = join(dir, 'misanchored.json')
const output = join(dir, 'gold.json')
writeFileSync(db, '')
writeFileSync(input, JSON.stringify(correctedSunzi))
const changedSunzi = spawnSync(process.execPath, [new URL('./kg-discovery-benchmark-seed.mjs', import.meta.url).pathname,
  '--db', db, '--fixture', input, '--gold-output', output], { encoding: 'utf8' })
assert.notEqual(changedSunzi.status, 0)
assert.match(changedSunzi.stderr, /finding evidence is not in source/)
assert.equal(statSync(db).size, 0, 'altered public-domain contrast must not seed a graph with stale positive evidence')
writeFileSync(input, JSON.stringify(brokenTaxonomy))
const changedTaxonomy = spawnSync(process.execPath, [new URL('./kg-discovery-benchmark-seed.mjs', import.meta.url).pathname,
  '--db', db, '--fixture', input, '--gold-output', output], { encoding: 'utf8' })
assert.notEqual(changedTaxonomy.status, 0)
assert.match(changedTaxonomy.stderr, /graph quote is not in source|graph evidence is not in source/)
assert.equal(statSync(db).size, 0, 'reversed taxonomy evidence must be rejected before database write')
writeFileSync(input, JSON.stringify(malformed))
const child = spawnSync(process.execPath, [new URL('./kg-discovery-benchmark-seed.mjs', import.meta.url).pathname,
  '--db', db, '--fixture', input, '--gold-output', output], { encoding: 'utf8' })
assert.notEqual(child.status, 0)
assert.match(child.stderr, /source units differ from the Host content splitter/)
assert.equal(statSync(db).size, 0, 'a misanchored fixture must be rejected before a database write')
const wrongGraphQuote = structuredClone(second)
wrongGraphQuote.graph.nodes[0].evidence[0].quote = second.sourceUnits[0].text
writeFileSync(input, JSON.stringify(wrongGraphQuote))
const wrongAnchor = spawnSync(process.execPath, [new URL('./kg-discovery-benchmark-seed.mjs', import.meta.url).pathname,
  '--db', db, '--fixture', input, '--gold-output', output], { encoding: 'utf8' })
assert.notEqual(wrongAnchor.status, 0)
assert.match(wrongAnchor.stderr, /graph evidence is not in source/)
assert.equal(statSync(db).size, 0, 'wrong graph evidence must be rejected before a database write')
const wrongTableRow = structuredClone(table)
wrongTableRow.graph.nodes[0].evidence[1].quote = table.sourceUnits[4].text
writeFileSync(input, JSON.stringify(wrongTableRow))
const wrongRowAnchor = spawnSync(process.execPath, [new URL('./kg-discovery-benchmark-seed.mjs', import.meta.url).pathname,
  '--db', db, '--fixture', input, '--gold-output', output], { encoding: 'utf8' })
assert.notEqual(wrongRowAnchor.status, 0)
assert.match(wrongRowAnchor.stderr, /graph evidence is not in source/)
assert.equal(statSync(db).size, 0, 'a different table row must not be accepted as this node\'s citation')
writeFileSync(input, JSON.stringify(assertedDialogue))
const changedModality = spawnSync(process.execPath, [new URL('./kg-discovery-benchmark-seed.mjs', import.meta.url).pathname,
  '--db', db, '--fixture', input, '--gold-output', output], { encoding: 'utf8' })
assert.notEqual(changedModality.status, 0)
assert.match(changedModality.stderr, /finding evidence is not in source/)
assert.equal(statSync(db).size, 0, 'a changed hypothesis status must be rejected before a database write')
writeFileSync(input, JSON.stringify(endorsedInterview))
const changedAttribution = spawnSync(process.execPath, [new URL('./kg-discovery-benchmark-seed.mjs', import.meta.url).pathname,
  '--db', db, '--fixture', input, '--gold-output', output], { encoding: 'utf8' })
assert.notEqual(changedAttribution.status, 0)
assert.match(changedAttribution.stderr, /finding evidence is not in source/)
assert.equal(statSync(db).size, 0, 'replacing editorial disagreement with endorsement must be rejected before write')
writeFileSync(input, JSON.stringify(erasedTransition))
const changedTransition = spawnSync(process.execPath, [new URL('./kg-discovery-benchmark-seed.mjs', import.meta.url).pathname,
  '--db', db, '--fixture', input, '--gold-output', output], { encoding: 'utf8' })
assert.notEqual(changedTransition.status, 0)
assert.match(changedTransition.stderr, /finding evidence is not in source/)
assert.equal(statSync(db).size, 0, 'erasing the old-cohort exception must be rejected before write')
console.log(JSON.stringify({ canonicalChineseUnits: [4, 5, 6, 4, 5, 4, 8, 4], misanchoredUnitsRejectedBeforeWrite: true,
  connectedNegativeUnits: connectedClean.sourceUnits.length, reversedTaxonomyRejectedBeforeWrite: true,
  publicDomainUnits: sunzi.sourceUnits.length, alteredSourceContrastRejectedBeforeWrite: true,
  wrongGraphEvidenceRejectedBeforeWrite: true, wrongTableRowRejectedBeforeWrite: true,
  changedHypothesisStatusRejectedBeforeWrite: true, changedAttributionRejectedBeforeWrite: true,
  changedPublishedSubgroupRejected: true, grandfatheredUnits: grandfathered.sourceUnits.length,
  changedTransitionRejected: true }))
