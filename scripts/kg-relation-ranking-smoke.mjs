import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const previousHarness = globalThis.harness
let source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const marker = '      async function weaveRelationsHost('
assert.equal(source.split(marker).length, 2)
source = source.replace(marker, `      harness.ranking = { selectRelationCandidatesHost, buildRelationWeaveGroupsHost, graphConnectivityHost, normalizeGraphLookupTextHost, phraseTokensHost }
${marker}`)
source = source.replace('function selectRelationCandidatesHost(', `function selectRelationCandidatesHost(...args) {
  return harness.reference ? harness.reference(...args) : measuredSelectRelationCandidatesHost(...args)
}
function measuredSelectRelationCandidatesHost(`)
source = source.replace('function relationCandidateScoreHost(', `function relationCandidateScoreHost(...args) {
  harness.scored++
  return measuredRelationCandidateScoreHost(...args)
}
function measuredRelationCandidateScoreHost(`)
const compare = 'const compare = (a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id))'
assert.equal(source.split(compare).length, 2)
source = source.replace(compare, 'const compare = (a, b) => { harness.comparisons++; return b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)) }')
const { default: plugin } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const harness = { handle() {}, scored: 0, comparisons: 0 }
globalThis.harness = harness
plugin().apply({ get() { return null }, interval() {} })
const api = harness.ranking

// Keep an exhaustive, independently calculated oracle. The optimized path may
// change neither retrieval order nor the bridge/distant quotas and tie breaks.
function exhaustive(candidates, target, byId, stats) {
  const paragraphs = node => stats.lookupParagraphs?.get(node.id) || (Number.isInteger(node.paragraph) ? [node.paragraph] : [])
  const tokens = node => stats.lookupTokens?.get(node.id) || api.phraseTokensHost(api.normalizeGraphLookupTextHost(node.text))
  const ranked = Array.from(candidates, id => {
    const node = byId.get(id)
    let distance = Infinity
    for (const a of paragraphs(target)) for (const b of paragraphs(node)) distance = Math.min(distance, Math.abs(a - b))
    let score = distance === 0 ? 4 : distance <= 8 ? 3 / distance : 0
    if (target.sectionId && target.sectionId === node.sectionId) score += 2.5
    const a = tokens(target), b = tokens(node)
    let shared = 0
    for (const token of a) if (b.has(token)) shared++
    score += (a.size && b.size ? shared / (a.size + b.size - shared) : 0) * 8
    score += Math.min(stats.degree.get(id) || 0, 6) * 0.2
    if (stats.componentById.get(target.id) !== stats.componentById.get(id)) score += 0.25
    return { node, distance, score }
  }).sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)))
  const bridges = ranked.filter(item => stats.componentById.get(item.node.id) !== stats.componentById.get(target.id))
  const distant = bridges.filter(item => Number.isFinite(item.distance) && item.distance > 8)
  return Array.from(new Map([...distant.slice(0, 2), ...bridges.slice(0, 3), ...ranked.slice(0, 6)].map(item => [item.node.id, item.node])).values())
}
let seed = 1234567
const random = max => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max }
const nodesFor = size => Array.from({ length: size }, (_, i) => ({
  id: i === 0 ? '\u00e9' : i === 1 ? 'e\u0301' : 'n' + i,
  type: 'fact', text: ['common token', '---', '\u5b66\u4e60\u77e5\u8bc6\u7ed3\u6784', 'records sample' + random(13)][random(4)],
  paragraph: i % 7 ? random(size) : undefined, sectionId: 's' + random(3),
  evidence: [{ paragraph: random(size), quote: 'secondary source' }],
}))
try {
  let selectionCases = 0
  for (const size of [0, 1, 2, 3, 6, 7, 11, 12, 40, 256, 4096]) {
    for (let repeat = 0; repeat < 4; repeat++) {
      const target = { id: 'target', text: 'common token', paragraph: 3, sectionId: 's1' }
      const nodes = nodesFor(size), byId = new Map(nodes.map(node => [node.id, node]))
      const stats = { degree: new Map(), componentById: new Map([[target.id, 0]]), lookupParagraphs: new Map([[target.id, [3, 19]]]) }
      for (const node of nodes) {
        stats.degree.set(node.id, random(10))
        stats.componentById.set(node.id, random(4))
        stats.lookupParagraphs.set(node.id, repeat % 2 ? [node.paragraph, ...node.evidence.map(item => item.paragraph)].filter(Number.isInteger) : [])
      }
      const candidates = new Set((repeat % 2 ? nodes.toReversed() : nodes).map(node => node.id))
      harness.scored = 0; harness.comparisons = 0
      const actual = api.selectRelationCandidatesHost(candidates, target, byId, stats)
      assert.deepEqual(actual, exhaustive(candidates, target, byId, stats))
      assert.equal(harness.scored, size, 'bounded selection must still score every retrieved candidate')
      assert.ok(harness.comparisons <= size * 14, 'selection comparisons must stay linear in candidate count')
      assert.ok(actual.length <= 11)
      selectionCases++
    }
  }
  // Canonically equivalent IDs tie exactly at each retained prefix boundary.
  // A later equal candidate must not replace the earlier candidate's last slot.
  assert.equal('\u00e9'.localeCompare('e\u0301'), 0)
  const target = { id: 'target', text: 'same', paragraph: 0 }
  for (const prefix of [1, 2, 5]) {
    for (const equivalentIds of [['\u00e9', 'e\u0301'], ['e\u0301', '\u00e9']]) {
      const list = [...'abcde'.slice(0, prefix), ...equivalentIds, 'z'].map(id => ({ id, text: 'same', paragraph: 50 }))
      const stats = api.graphConnectivityHost([target, ...list], [])
      const candidates = new Set(list.map(node => node.id)), byId = new Map(list.map(node => [node.id, node]))
      const actual = api.selectRelationCandidatesHost(candidates, target, byId, stats)
      assert.deepEqual(actual, exhaustive(candidates, target, byId, stats))
      if (prefix === 5) assert.equal(actual.at(-1).id, equivalentIds[0], 'stable ties must keep the first candidate at the six-node cutoff')
      selectionCases++
    }
  }

  const nodes = nodesFor(300), paragraphs = nodes.map((_, i) => 'Source paragraph ' + i + ' ' + 'x'.repeat(i % 17 === 0 ? 9000 : 20))
  const text = paragraphs.join('\n\n')
  let previous = null
  for (let pass = 0; pass < 12; pass++) {
    const edges = pass % 3 ? nodes.slice(1, 100).map(node => ({ fromNodeId: nodes[0].id, toNodeId: node.id })) : []
    const stats = () => api.graphConnectivityHost(nodes, edges)
    harness.reference = null
    const actual = api.buildRelationWeaveGroupsHost(nodes, stats(), paragraphs, previous, text)
    harness.reference = exhaustive
    const reference = api.buildRelationWeaveGroupsHost(nodes, stats(), paragraphs, previous, text)
    harness.reference = null
    assert.deepEqual(actual, reference, 'complete groups, targets, coverage and ordering must match exhaustive ranking')
    previous = { ...actual.coverage, completedTargetIds: [...actual.coverage.completedTargetIds, ...actual.groups.flatMap(group => group.targetIds)] }
    if (pass === 3) previous.completedTargetIds = nodes.map(node => node.id)
    if (pass === 5) { nodes[2].text = 'changed source tokens'; nodes[3].evidence.push({ paragraph: 270, quote: 'later anchor' }) }
    if (pass === 8) nodes.reverse()
  }
  console.log(JSON.stringify({ ok: true, exhaustiveSelectionCases: selectionCases, exactPlanCases: 12, allCandidatesScored: true, boundedComparisons: true }))
} finally {
  if (previousHarness === undefined) delete globalThis.harness
  else globalThis.harness = previousHarness
}
