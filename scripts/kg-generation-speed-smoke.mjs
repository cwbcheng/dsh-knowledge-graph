import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const previousHarness = globalThis.harness
let source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      async function weaveRelationsHost('
assert.equal(source.split(marker).length, 2)
source = source.replace(marker, `      harness.speed = { serializeExistingGraph, normalizeGraphLookupTextHost, phraseTokensHost, buildRelationWeaveGroupsHost, graphConnectivityHost }
${marker}`)
source = source.replace('function relationCandidateScoreHost(', `function relationCandidateScoreHost(...args) {
  harness.scored.push([args[0].id, args[1].id].join('>'))
  return measuredRelationCandidateScoreHost(...args)
}
function measuredRelationCandidateScoreHost(`)
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const harness = { handle() {}, scored: [] }
globalThis.harness = harness
plugin().apply({ get() { return null }, interval() {} })
const api = harness.speed

// Frozen exhaustive ranking is the equivalence oracle, not a faster heuristic.
function referenceDigest(nodes, cap, queryText) {
  const query = api.normalizeGraphLookupTextHost(queryText)
  const queryTokens = api.phraseTokensHost(query)
  const candidates = []
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (!node || typeof node.id !== 'string' || !node.id.trim() || typeof node.text !== 'string' || !node.text.trim()) continue
    const normalized = api.normalizeGraphLookupTextHost(node.text.trim())
    const tokens = api.phraseTokensHost(normalized)
    let overlap = 0
    for (const token of queryTokens) if (tokens.has(token)) overlap++
    candidates.push({ node, index, score: queryTokens.size ? (normalized === query ? 2 : overlap / Math.max(queryTokens.size, tokens.size, 1)) : 0 })
  }
  if (queryTokens.size) candidates.sort((a, b) => b.score - a.score || b.index - a.index)
  return candidates.slice(0, cap).map(({ node }) => node.id + '|' + (node.type || '') + '|' + node.text.slice(0, 120)).join('\n')
}

try {
  const nodes = Array.from({ length: 400 }, (_, i) => ({ id: 'n' + i, type: 'fact', paragraph: i,
    text: 'Material ' + i + ' records measurement ' + (i * 7919) + ' with identifier experiment' + i + ' and independent observation ' + (i * 37) + '.' }))
  const cache = new Map()
  const longQuery = nodes.slice(70, 120).map(node => node.text).join(' ')
  for (const query of [longQuery, 'material', nodes[11].text, '', '---', '\u674e\u5b66\u4e60 \uff21\uff22\uff23 1.25', 'absentidentifier']) {
    assert.equal(api.serializeExistingGraph({ nodes }, 24, query, cache), referenceDigest(nodes, 24, query))
  }
  nodes[3].text = longQuery
  assert.equal(api.serializeExistingGraph({ nodes }, 24, longQuery, cache), referenceDigest(nodes, 24, longQuery), 'text edits must invalidate cached tokens')
  nodes.push({ ...nodes[3], id: 'most-recent' })
  assert.equal(api.serializeExistingGraph({ nodes }, 24, longQuery, cache), referenceDigest(nodes, 24, longQuery), 'equal scores retain recency ordering')
  nodes.push({ id: 'unicode', type: 'concept', text: '\u5b66\u4e60\u6750\u6599 \uff21\uff22\uff23 1.25' }, null, {}, { id: '', text: 'invalid' })
  for (const query of ['\u5b66\u4e60\u6750\u6599 ABC', '1.25', '']) {
    assert.equal(api.serializeExistingGraph({ nodes }, 24, query, cache), referenceDigest(nodes, 24, query))
  }

  let probes = 0
  class CountedTokens extends Set {
    has(value) { probes++; return super.has(value) }
    *[Symbol.iterator]() { for (const value of super[Symbol.iterator]()) { probes++; yield value } }
  }
  const queryTokens = api.phraseTokensHost(api.normalizeGraphLookupTextHost(longQuery))
  for (const [id, entry] of cache) cache.set(id, { ...entry, tokens: new CountedTokens(entry.tokens) })
  api.serializeExistingGraph({ nodes }, 24, longQuery, cache)
  const bound = Array.from(cache.values()).reduce((sum, entry) => sum + Math.min(queryTokens.size, entry.tokens.size), 0)
  assert.ok(probes <= bound, 'digest token work must follow the smaller set, not nodes times the whole source chunk: ' + probes + ' > ' + bound)

  const planningNodes = nodes.slice(0, 400).map((node, i) => ({ ...node, text: 'Record ' + i + ' evidence' + (i % 19), quote: 'Source ' + i, evidence: [{ paragraph: i, quote: 'Source ' + i }] }))
  const paragraphs = planningNodes.map(node => node.quote)
  const plan = api.buildRelationWeaveGroupsHost(planningNodes, api.graphConnectivityHost(planningNodes, []), paragraphs, null, paragraphs.join('\n\n'))
  assert.equal(plan.groups.length, 4)
  assert.equal(plan.groups.flatMap(group => group.targetIds).length, 48)
  const scoredPairs = harness.scored.length
  const repeatedPairs = scoredPairs - new Set(harness.scored).size
  assert.equal(repeatedPairs, 0, 'a frozen target/candidate pair must not be ranked twice during the same plan')
  const hash = createHash('sha256').update(JSON.stringify(plan.groups.map(group => [group.nodes.map(node => node.id), group.targetIds]))).digest('hex')
  const next = api.buildRelationWeaveGroupsHost(planningNodes, api.graphConnectivityHost(planningNodes, [{ fromNodeId: 'n0', toNodeId: 'n1' }]), paragraphs, null, paragraphs.join('\n\n'))
  assert.ok(!next.groups.flatMap(group => group.targetIds).includes('n0'), 'a later plan must use changed connectivity rather than stale rankings')
  console.log(JSON.stringify({ ok: true, exactDigestRanking: true, probes, bound, scoredPairs, repeatedPairs, planHash: hash }))
} finally {
  if (previousHarness === undefined) delete globalThis.harness
  else globalThis.harness = previousHarness
}
