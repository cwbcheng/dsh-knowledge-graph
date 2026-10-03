import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { runInNewContext } from 'node:vm'
import { createGenerationStructureTools } from '../src/kg-generation-structure.mjs'

const tools = createGenerationStructureTools()
const edge = (fromNodeId, toNodeId, relation = 'supports') => ({ fromNodeId, toNodeId, relation })
const fact = (id, extra = {}) => ({ id, type: 'fact', text: id, ...extra })
const hasCheck = (result, code) => result.checks.some((check) => check.code === code)
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

for (const title of [
  '版本说明', '## 二、版本与整理说明', '# 1. **底本与校勘说明**',
  '### （三）转写说明 ###', '## 2.1 文本来源说明', '第三章：编者说明',
  '帛书版《道德经》知识图：版本与整理说明', '知识图的阅读层次',
  '建图主文本', '可追溯来源', '> ## 1. __建图说明__', 'Source notes',
]) assert.equal(tools.sectionLayer(title), 'source_context', title)
for (const title of [
  undefined, null, 42, '', '序言', '历史年代', '第三章：汉代哲学',
  '版本演变与哲学理论', '哲学理论来源', '知识的来源', '来源与目的',
  '关于文本来源的理论', '说明宇宙如何生成', '第12章 无为的来源',
  '# 德篇（网络现代整理文本；现代段落并非帛书原有章）',
  '# 道篇（网络现代整理文本；现代段落并非帛书原有章）',
  '# 德、道两篇：现代整理工作文本', 'Historical context', 'Introduction',
]) assert.equal(tools.sectionLayer(title), 'main', String(title))

const sections = [{ id: 'notes', title: '## 来源说明' }, { id: 'body', title: '哲学理论来源' }]
assert.equal(tools.layerOf({ contentLayer: 'main', sectionId: 'notes' }, sections), 'main')
assert.equal(tools.layerOf({ contentLayer: 'source_context', sectionId: 'body' }, sections), 'source_context')
assert.equal(tools.layerOf({ contentLayer: 'invalid', sectionId: 'notes' }, sections), 'source_context')
assert.equal(tools.layerOf({ contentLayer: 'SOURCE_CONTEXT', type: 'fact', sectionId: 'body' }, sections), 'main')
assert.equal(tools.layerOf({ sectionId: 'missing', type: 'fact' }, sections), 'main')
assert.equal(tools.layerOf({ type: 'fact', text: '前168年墓葬年代' }, sections), 'main')
assert.equal(tools.layerOf({ sectionTitle: '编者说明' }), 'source_context')
assert.equal(tools.layerOf(null, sections), 'main')
assert.equal(tools.layerOf({ sectionId: 'notes' }, new Map([['notes', '来源说明']])), 'source_context')
// Resolved manifest title is authoritative over a stale cached sectionTitle.
assert.equal(tools.layerOf({ sectionId: 'body', sectionTitle: '来源说明' }, sections), 'main')

const nodes = Array.from({ length: 8 }, (_, index) => fact('body-' + index))
const metadata = fact('meta', { contentLayer: 'source_context', type: 'concept' })
const bridged = deepFreeze({
  nodes: [...nodes, metadata], edges: nodes.map((node) => edge('meta', node.id)),
  source: { sections }, generation: { relationDiscovery: { totalTargets: 9, searchedTargets: 9, remainingTargets: 0 } },
})
const original = JSON.stringify(bridged)
const bridgeReport = tools.inspect(bridged)
assert.equal(bridgeReport.metrics.all.componentCount, 1)
assert.equal(bridgeReport.metrics.all.isolatedNodeCount, 0)
assert.equal(bridgeReport.metrics.main.nodeCount, 8)
assert.equal(bridgeReport.metrics.main.edgeCount, 0)
assert.equal(bridgeReport.metrics.main.isolatedNodeCount, 8)
assert.equal(bridgeReport.metrics.main.componentCount, 8)
assert.equal(bridgeReport.metrics.sourceContextNodeCount, 1)
assert.equal(bridgeReport.metrics.all.conceptCount, 1)
assert.equal(bridgeReport.metrics.main.conceptCount, 0)
assert.ok(hasCheck(bridgeReport, 'main_fragmented'))
assert.equal(bridgeReport.status, 'needs_attention')
assert.equal(JSON.stringify(bridged), original, 'inspect mutated the frozen graph')
for (const scope of ['all', 'main', 'source_context']) {
  const result = tools.partition(bridged, scope)
  assert.notEqual(result, bridged)
  assert.equal(result.source, bridged.source)
  assert.equal(result.generation, bridged.generation)
  assert.ok(result.nodes.every((node) => bridged.nodes.includes(node)))
  assert.ok(result.edges.every((item) => bridged.edges.includes(item)))
  const included = new Set(result.nodes.map((node) => node.id))
  assert.ok(result.edges.every((item) => included.has(item.fromNodeId) && included.has(item.toNodeId)))
}
assert.equal(tools.partition(bridged, 'main').nodes.length, 8)
assert.equal(tools.partition(bridged, 'source_context').nodes[0], metadata)
assert.equal(tools.partition(bridged, 'all').edges[0], bridged.edges[0])
assert.equal(JSON.stringify(bridged), original, 'partition mutated the canonical graph')
assert.throws(() => tools.partition(bridged, 'metadata'), RangeError)

const malformed = deepFreeze({
  nodes: [
    fact('a', { type: 'concept' }), fact('b'), fact('c', { type: 'concept' }),
    { id: 'image', type: 'image' }, fact('a'), fact(''), null,
  ],
  edges: [edge('a', 'b'), edge('a', 'b'), edge('b', 'a'), edge('a', 'b', 'infers'),
    edge('a', 'a'), edge('a', 'missing'), edge('missing', 'b'), edge('a', 'image'),
    { fromNodeId: 'a', toNodeId: 'b' }, edge('a', 'b', ''), null],
})
const malformedReport = tools.inspect(malformed)
assert.deepEqual(malformedReport.metrics.all, {
  nodeCount: 3, edgeCount: 3, undirectedPairCount: 1, componentCount: 2,
  isolatedNodeCount: 1, isolatedRatio: 1 / 3, largestComponentSize: 2,
  largestComponentRatio: 2 / 3, conceptCount: 2, isolatedConceptCount: 1,
})
assert.equal(malformedReport.metrics.main.edgeCount, 3)
assert.ok(hasCheck(malformedReport, 'isolated_concept_anchors'))
assert.deepEqual(malformedReport.checks.find((check) => check.code === 'isolated_concept_anchors').nodeIds, ['c'])
assert.ok(tools.partition(malformed, 'all').nodes.some((node) => node.type === 'image'))
assert.ok(tools.partition(malformed, 'main').edges.includes(malformed.edges[7]), 'view projection lost a body image relationship')
// JSON tuple keys avoid delimiter/prototype collisions.
const unusualIds = { nodes: ['a>b', 'c', 'a', 'b>c', '__proto__'].map((id) => fact(id)),
  edges: [edge('a>b', 'c'), edge('a', 'b>c'), edge('__proto__', 'c')] }
assert.equal(tools.inspect(unusualIds).metrics.all.edgeCount, 3)

const partial = tools.inspect({ nodes: [fact('a')], edges: [], generation: {
  relationDiscovery: { totalTargets: 683, searchedTargets: 48, remainingTargets: 635, contextTargetIds: Array(683).fill('seen') },
} })
assert.deepEqual(partial.relationSearch, { status: 'partial', totalTargets: 683, searchedTargets: 48, remainingTargets: 635 })
assert.match(partial.checks.find((check) => check.code === 'relation_search_partial').message, /不表示它们从未进入上下文/)
assert.equal(partial.status, 'needs_attention')
const fallback = tools.inspect({ nodes: [fact('a')], edges: [], generation: {
  relationDiscovery: {}, connectivity: { attempted: true, coverage: { totalTargets: 3, completedTargetIds: ['a', 'b', 'b'] } },
} })
assert.deepEqual(fallback.relationSearch, { status: 'partial', totalTargets: 3, searchedTargets: 2, remainingTargets: 1 })
assert.equal(tools.inspect({ nodes: [fact('a')], edges: [], connectivity: { coverage: { totalTargets: 1, remainingTargets: 0 } } }).relationSearch.status, 'complete')
const complete = tools.inspect({ nodes: [fact('a')], edges: [], generation: {
  relationDiscovery: { totalTargets: 1, searchedTargets: 1, remainingTargets: 0 },
} })
assert.equal(complete.relationSearch.status, 'complete')
assert.equal(complete.status, 'no_structural_alert', 'valid independent fact should remain savable')
assert.match(complete.checks.find((check) => check.code === 'relation_search_complete').message, /不等于所有关系已找到/)
assert.ok(complete.checks.every((check) => check.severity !== 'error'))
const unknown = tools.inspect({ nodes: [fact('a')], edges: [], generation: {
  status: 'succeeded', connectivity: { attempted: true }, relationDiscovery: { contextTargetIds: ['a'] },
} })
assert.deepEqual(unknown.relationSearch, { status: 'not_assessed', totalTargets: null, searchedTargets: null, remainingTargets: null })
assert.equal(tools.inspect({ generation: { relationDiscovery: { totalTargets: 4, searchedTargets: 5, remainingTargets: 0 } } }).relationSearch.status, 'not_assessed')
assert.equal(tools.inspect({ generation: { relationDiscovery: { totalTargets: '4', searchedTargets: '4' } } }).relationSearch.status, 'not_assessed')

for (const input of [null, {}, { nodes: [], edges: [] }, { nodes: [{ id: 'img', type: 'image' }], edges: [edge('img', 'img')] }]) {
  const empty = tools.inspect(input)
  assert.equal(empty.status, 'not_assessed')
  assert.equal(empty.metrics.all.nodeCount, 0)
  assert.equal(empty.metrics.main.largestComponentRatio, 0)
  assert.equal(empty.metrics.all.isolatedRatio, 0)
  assert.ok(Number.isFinite(empty.metrics.all.largestComponentRatio))
}
assert.equal(tools.inspect({ nodes: [fact('source', { contentLayer: 'source_context' })], edges: [] }).status, 'not_assessed')
assert.equal(hasCheck(tools.inspect({ nodes: Array.from({ length: 7 }, (_, i) => fact('solo-' + i)), edges: [] }), 'main_fragmented'), false)
const pairs = { nodes: Array.from({ length: 10 }, (_, i) => fact('pair-' + i)), edges: Array.from({ length: 5 }, (_, i) => edge('pair-' + (i * 2), 'pair-' + (i * 2 + 1))) }
assert.equal(hasCheck(tools.inspect(pairs), 'main_fragmented'), false, 'largest cluster threshold is strictly below .2')
const smallClusters = { nodes: Array.from({ length: 15 }, (_, i) => fact('small-' + i)), edges: Array.from({ length: 5 }, (_, i) => [edge('small-' + (i * 3), 'small-' + (i * 3 + 1)), edge('small-' + (i * 3 + 1), 'small-' + (i * 3 + 2))]).flat() }
assert.equal(tools.inspect(smallClusters).metrics.main.isolatedRatio, 0)
assert.equal(hasCheck(tools.inspect(smallClusters), 'main_fragmented'), false)
const tinyClusters = { nodes: Array.from({ length: 12 }, (_, i) => fact('tiny-' + i)), edges: Array.from({ length: 6 }, (_, i) => edge('tiny-' + (i * 2), 'tiny-' + (i * 2 + 1))) }
assert.equal(tools.inspect(tinyClusters).metrics.main.isolatedRatio, 0)
assert.ok(hasCheck(tools.inspect(tinyClusters), 'main_fragmented'), 'small maximum cluster should alert even without isolated nodes')

const conditions = deepFreeze({ nodes: [
  { id: 'if-a', type: 'rule', text: '若知足，则不辱。' },
  { id: 'if-b', type: 'rule', text: '若知止，则不殆。' },
], edges: [] })
const conditionsBefore = JSON.stringify(conditions)
tools.inspect(conditions)
assert.equal(tools.partition(conditions, 'main').edges.length, 0)
assert.equal(JSON.stringify(conditions), conditionsBefore, 'shared topic/conditional rules acquired invented edges')

// The factory source, alone, must execute without ESM imports, host or DOM references.
const inlined = runInNewContext('(' + createGenerationStructureTools.toString() + ')()', {})
assert.deepEqual(JSON.parse(JSON.stringify(inlined.inspect(bridged))), tools.inspect(bridged))
assert.equal(inlined.layerOf({ sectionTitle: '## 编者说明' }), 'source_context')
assert.equal(inlined.partition(conditions, 'main').nodes[0], conditions.nodes[0])

// The inline copies must be byte-equivalent, without executing a build generator.
const inlineOpen = '      // >>> GENERATED GENERATION STRUCTURE TOOLS >>>'
const inlineClose = '      // <<< END GENERATION STRUCTURE TOOLS <<<'
const inlineBody = createGenerationStructureTools.toString().split('\n')
  .map((line, index) => index === 0 || !line ? line : '      ' + line).join('\n')
const inlineBlock = inlineOpen + '\n      const GENERATION_STRUCTURE_TOOLS = (' + inlineBody + ')()\n' + inlineClose
for (const file of ['index.host.js', 'index.client.js']) {
  const source = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
  const start = source.indexOf(inlineOpen), end = source.indexOf(inlineClose)
  assert.ok(start >= 0 && end > start, 'inline structure markers missing: ' + file)
  assert.equal(source.slice(start, end + inlineClose.length), inlineBlock, 'inline structure factory stale: ' + file)
}
assert.equal(tools.sectionLayer('# 第三部分：编者说明'), 'source_context')
const boundaryNodes = Array.from({ length: 10 }, (_, index) => fact('boundary-' + index))
const boundaryEdges = Array.from({ length: 5 }, (_, index) => edge('boundary-' + index, 'boundary-' + (index + 1)))
const boundaryReport = tools.inspect({ nodes: boundaryNodes, edges: boundaryEdges })
assert.equal(boundaryReport.metrics.main.isolatedRatio, 0.4)
assert.ok(hasCheck(boundaryReport, 'main_fragmented'), 'isolation threshold includes exactly 40%')
assert.equal(hasCheck(tools.inspect({ nodes: boundaryNodes, edges: [...boundaryEdges, edge('boundary-5', 'boundary-6')] }), 'main_fragmented'), false)

// Accessor instrumentation catches per-node scans across section arrays (O(n²)).
const largeSize = 24000
let sectionIdReads = 0
let nodeSectionReads = 0
const largeSections = Array.from({ length: largeSize }, (_, i) => ({
  get id() { sectionIdReads += 1; return 's-' + i }, title: '正文理论来源',
}))
const largeNodes = Array.from({ length: largeSize }, (_, i) => ({
  id: 'large-' + i, type: 'fact', get sectionId() { nodeSectionReads += 1; return 's-' + i },
}))
const largeEdges = Array.from({ length: largeSize - 1 }, (_, i) => [edge('large-' + i, 'large-' + (i + 1)), edge('large-' + (i + 1), 'large-' + i, 'infers')]).flat()
const started = performance.now()
const largeReport = tools.inspect({ nodes: largeNodes, edges: largeEdges, source: { sections: largeSections } })
const elapsedMs = performance.now() - started
assert.equal(largeReport.metrics.main.nodeCount, largeSize)
assert.equal(largeReport.metrics.main.edgeCount, 2 * (largeSize - 1))
assert.equal(largeReport.metrics.main.undirectedPairCount, largeSize - 1)
assert.equal(largeReport.metrics.main.componentCount, 1)
assert.equal(largeReport.metrics.main.isolatedNodeCount, 0)
assert.equal(largeReport.metrics.main.largestComponentSize, largeSize)
assert.ok(sectionIdReads <= largeSize * 4, 'section lookup was not indexed: ' + sectionIdReads)
assert.ok(nodeSectionReads <= largeSize * 4, 'per-node section processing was not bounded: ' + nodeSectionReads)

// An optional existing export is read only: no DB/API/model calls, no persistence.
const graphArgumentIndex = process.argv.indexOf('--graph')
const existingPath = graphArgumentIndex >= 0 ? process.argv[graphArgumentIndex + 1]
  : new URL('../../knowledge-graphs/boshu-daodejing/知识图.json', import.meta.url)
let readOnlyExistingGraph = { status: 'not_present' }
if (process.argv.includes('--expect-boshu')) assert.ok(existingPath && existsSync(existingPath), 'Expected known read-only graph fixture')
if (existingPath && existsSync(existingPath)) {
  const before = readFileSync(existingPath)
  const existing = JSON.parse(before.toString('utf8'))
  const report = tools.inspect(existing)
  const after = readFileSync(existingPath)
  assert.equal(createHash('sha256').update(before).digest('hex'), createHash('sha256').update(after).digest('hex'), 'existing graph export changed')
  if (process.argv.includes('--expect-boshu')) {
    assert.equal(report.metrics.all.nodeCount, 683)
    assert.equal(report.metrics.all.edgeCount, 200)
    assert.equal(report.metrics.all.undirectedPairCount, 196)
    assert.equal(report.relationSearch.remainingTargets, 635)
    assert.equal(report.relationSearch.status, 'partial')
    assert.ok(report.metrics.main.isolatedNodeCount > 0)
    assert.ok(hasCheck(report, 'main_fragmented'))
  }
  readOnlyExistingGraph = { status: report.status, metrics: report.metrics, relationSearch: report.relationSearch, unchanged: true }
}
console.log(JSON.stringify({
  ok: true, enumAndConservativeTitles: true, metadataSeparatedWithoutInventedEdges: true,
  validUndirectedNeighborsAndDirectedTypedRelations: true, pureFactoryInlining: true, hostClientInlineParity: true,
  coverageIsNotContextOrSemanticCompleteness: true, emptyAndUnknownLegacy: true,
  largeGraph: { nodeCount: largeSize, edgeCount: largeEdges.length, elapsedMs: Math.round(elapsedMs), sectionIdReads, nodeSectionReads },
  readOnlyExistingGraph,
}))
