import { readFileSync, writeFileSync } from 'node:fs'

const clientPath = 'src/index.client.js'
const testPath = 'scripts/kg-semantic-layout-smoke.mjs'
let client = readFileSync(clientPath, 'utf8')
let test = readFileSync(testPath, 'utf8')

const relationMarker = `        const reasoningRelations = new Set(['causes', 'infers'])\n        const satelliteRelations = new Set(['example', 'counter_example', 'analogy', 'defines', 'is_a', 'contains'])\n        const directionalRelations = new Set(['supports', 'driven_by', 'aims_at'])\n`
const relationReplacement = `        const reasoningRelations = new Set(['causes', 'infers'])\n        const satelliteRelations = new Set(['example', 'counter_example', 'analogy', 'defines', 'is_a', 'contains'])\n        const directionalRelations = new Set(['supports', 'driven_by', 'aims_at'])\n        // One shared view-only set drives both local rank adjacency and the\n        // later bounded x-attraction pass. It is not graph-schema authority.\n        const strongLocalRelations = new Set(['defines', 'contains', 'is_a', 'analogy', 'example', 'counter_example'])\n        const reasoningRankIds = new Set()\n        for (const edge of edges) {\n          if (!edge || !reasoningRelations.has(edge.relation)) continue\n          reasoningRankIds.add(edge.fromNodeId)\n          reasoningRankIds.add(edge.toNodeId)\n        }\n`
if (client.split(relationMarker).length !== 2) throw new Error('relation set marker mismatch')
client = client.replace(relationMarker, relationReplacement)

const rankMarker = `          for (const [id, rank] of local) level.set(id, rank)\n        }\n        const groups = new Map()\n`
const rankReplacement = `          for (const [id, rank] of local) level.set(id, rank)\n        }\n\n        // Strong local relations are also a soft rank constraint. Reasoning\n        // nodes never move. A subordinate endpoint with exactly one local\n        // anchor may move only when the pair is more than one rank apart; the\n        // new rank is anchor+1. Ambiguous multi-anchor nodes stay untouched.\n        const localAnchors = new Map()\n        for (const edge of edges) {\n          if (!edge || !strongLocalRelations.has(edge.relation)) continue\n          let anchorId = edge.toNodeId\n          let moverId = edge.fromNodeId\n          if (edge.relation === 'contains') { anchorId = edge.fromNodeId; moverId = edge.toNodeId }\n          if (!level.has(anchorId) || !level.has(moverId)) continue\n          if (!localAnchors.has(moverId)) localAnchors.set(moverId, new Set())\n          localAnchors.get(moverId).add(anchorId)\n        }\n        const baseLevel = new Map(level)\n        for (const [moverId, anchors] of localAnchors) {\n          if (anchors.size !== 1 || reasoningRankIds.has(moverId)) continue\n          const anchorId = anchors.values().next().value\n          const anchorRank = baseLevel.get(anchorId)\n          const moverRank = baseLevel.get(moverId)\n          if (!Number.isInteger(anchorRank) || !Number.isInteger(moverRank)) continue\n          if (Math.abs(moverRank - anchorRank) <= 1) continue\n          level.set(moverId, anchorRank + 1)\n        }\n\n        const groups = new Map()\n`
if (client.split(rankMarker).length !== 2) throw new Error('rank insertion marker mismatch')
client = client.replace(rankMarker, rankReplacement)

const lateSet = `        const strongLocalRelations = new Set(['defines', 'contains', 'is_a', 'analogy', 'example', 'counter_example'])\n`
if (client.split(lateSet).length !== 3) throw new Error('expected two strong-local declarations after insertion')
client = client.replace(lateSet, '')
// The first declaration was removed by replace(); restore it once next to the
// relation authority sets, leaving the later x-pass to reuse that same set.
if (!client.includes("const reasoningRankIds = new Set()")) throw new Error('reasoning rank ids missing')
client = client.replace(
  `        const directionalRelations = new Set(['supports', 'driven_by', 'aims_at'])\n        // One shared view-only set drives both local rank adjacency and the\n`,
  `        const directionalRelations = new Set(['supports', 'driven_by', 'aims_at'])\n        const strongLocalRelations = new Set(['defines', 'contains', 'is_a', 'analogy', 'example', 'counter_example'])\n        // One shared view-only set drives both local rank adjacency and the\n`,
)

const edgeMarker = `  { fromNodeId: 'p', toNodeId: 'q', relation: 'supports' },\n  { fromNodeId: 'system', toNodeId: 'flow', relation: 'contains' },\n  { fromNodeId: 'far', toNodeId: 'system', relation: 'supports' },\n]`
const edgeReplacement = `  { fromNodeId: 'p', toNodeId: 'q', relation: 'supports' },\n  { fromNodeId: 'c', toNodeId: 'system', relation: 'supports' },\n  { fromNodeId: 'e', toNodeId: 'flow', relation: 'supports' },\n  { fromNodeId: 'system', toNodeId: 'flow', relation: 'contains' },\n  { fromNodeId: 'far', toNodeId: 'system', relation: 'supports' },\n]`
if (!test.includes(edgeMarker)) throw new Error('semantic-layout edge fixture marker mismatch')
test = test.replace(edgeMarker, edgeReplacement)

const localAssertMarker = `const localDistance = Math.abs(pos.get('flow').x - pos.get('system').x)\nassert(localDistance <= 260, 'strong local contains relation was not attracted near its anchor: ' + localDistance)\n`
const localAssertReplacement = `const localDistance = Math.abs(pos.get('flow').x - pos.get('system').x)\nassert(localDistance <= 260, 'strong local contains relation was not attracted near its anchor: ' + localDistance)\nconst localRankDistance = pos.get('flow').y - pos.get('system').y\nassert(localRankDistance > 0 && localRankDistance <= values[names.indexOf('LAYER_Y_GAP')] + 0.1, 'strong local contains relation was not made rank-adjacent: ' + localRankDistance)\n`
if (!test.includes(localAssertMarker)) throw new Error('local rank assertion marker mismatch')
test = test.replace(localAssertMarker, localAssertReplacement)

const staticMarker = `assert(source.includes('const localRadius = 260'), 'local attraction must stay bounded')\n`
const staticReplacement = `assert(source.includes('const localRadius = 260'), 'local attraction must stay bounded')\nassert((source.match(/const strongLocalRelations = new Set/g) || []).length === 1, 'strong local relation set must have one view authority')\nassert(source.includes('if (anchors.size !== 1 || reasoningRankIds.has(moverId)) continue'), 'ambiguous/local-reasoning rank guard is missing')\nassert(source.includes('level.set(moverId, anchorRank + 1)'), 'local rank adjacency projection is missing')\n`
if (!test.includes(staticMarker)) throw new Error('static assertion marker mismatch')
test = test.replace(staticMarker, staticReplacement)

writeFileSync(clientPath, client)
writeFileSync(testPath, test)
console.log(JSON.stringify({ ok: true, changed: [clientPath, testPath] }))
