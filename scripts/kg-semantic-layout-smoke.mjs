import { readFileSync } from 'node:fs'
function assert(condition, message) { if (!condition) throw new Error(message) }
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error(name + ' not found')
  const brace = source.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error(name + ' is not balanced')
}
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const generatedSources = [
  ['lib/client.js', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')],
  ['extension/viewer.js', readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')],
]
const mirroredFunctions = [
  'layoutLayered',
  'resolveLayeredOverlaps',
  'packDisconnectedComponents',
  'layoutLayeredComponents',
  'corridorFree',
  'findCorridor',
  'channelBand',
  'layeredOrthoPath',
]
const mirroredSnippets = [
  'return layoutLayeredComponents(nodes, edges, sizes)',
  "const prefix = componentKey == null ? '' : 'component' + componentKey + ':'",
  'layout.componentNodesById.get(edge.fromNodeId) || nodes',
]
for (const [file, generated] of generatedSources) {
  for (const name of mirroredFunctions) {
    assert(extractFunction(generated, name) === extractFunction(source, name), file + ' has stale ' + name)
  }
  for (const snippet of mirroredSnippets) assert(generated.includes(snippet), file + ' has stale layered integration: ' + snippet)
}
const radialSource = extractFunction(source, 'layoutRadial')
assert(radialSource.includes('let hub = nodes[0]'), 'radial layout lost its highest-degree hub/BFS contract')
assert(!radialSource.includes('reasoningRelations'), 'relation-aware reasoning ranking leaked into radial layout')
const num = (name) => {
  const match = source.match(new RegExp('const ' + name + ' = ([0-9.]+)'))
  if (!match) throw new Error(name + ' not found')
  return Number(match[1])
}
const names = ['LAYER_COL_GAP', 'LAYER_MAX_ROW_WIDTH', 'LAYER_X_GAP', 'LAYER_Y_GAP']
const values = names.map(num)
const layoutLayered = new Function(...names, 'return (' + extractFunction(source, 'layoutLayered') + ')')(...values)
const resolveLayeredOverlaps = new Function('return (' + extractFunction(source, 'resolveLayeredOverlaps') + ')')()
const packDisconnectedComponents = new Function('return (' + extractFunction(source, 'packDisconnectedComponents') + ')')()
const layoutLayeredComponents = new Function(
  'layoutLayered',
  'resolveLayeredOverlaps',
  'packDisconnectedComponents',
  'return (' + extractFunction(source, 'layoutLayeredComponents') + ')',
)(layoutLayered, resolveLayeredOverlaps, packDisconnectedComponents)
const layerYGap = values[names.indexOf('LAYER_Y_GAP')]
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const corridorFree = new Function('LAYER_Y_GAP', 'return (' + extractFunction(source, 'corridorFree') + ')')(layerYGap)
const findCorridor = new Function('corridorFree', 'return (' + extractFunction(source, 'findCorridor') + ')')(corridorFree)
const channelBand = new Function('LAYER_Y_GAP', 'return (' + extractFunction(source, 'channelBand') + ')')(layerYGap)
const layeredOrthoPath = new Function(
  'LAYER_Y_GAP',
  'clamp',
  'corridorFree',
  'findCorridor',
  'channelBand',
  'return (' + extractFunction(source, 'layeredOrthoPath') + ')',
)(layerYGap, clamp, corridorFree, findCorridor, channelBand)
const nodes = [
  ...['a','b','c','d','e','x','p','q'].map((id) => ({ id, type: 'claim' })),
  { id: 'system', type: 'concept' },
  { id: 'flow', type: 'rule' },
  { id: 'far', type: 'claim' },
]
const edges = [
  { fromNodeId: 'a', toNodeId: 'b', relation: 'causes' },
  { fromNodeId: 'b', toNodeId: 'c', relation: 'causes' },
  { fromNodeId: 'c', toNodeId: 'd', relation: 'causes' },
  { fromNodeId: 'd', toNodeId: 'e', relation: 'causes' },
  { fromNodeId: 'x', toNodeId: 'c', relation: 'analogy' },
  { fromNodeId: 'p', toNodeId: 'q', relation: 'supports' },
  { fromNodeId: 'c', toNodeId: 'system', relation: 'supports' },
  { fromNodeId: 'e', toNodeId: 'flow', relation: 'supports' },
  { fromNodeId: 'system', toNodeId: 'flow', relation: 'contains' },
  { fromNodeId: 'far', toNodeId: 'system', relation: 'supports' },
]
const sizes = new Map(nodes.map((node) => [node.id, { w: node.id === 'q' ? 218 : 170, h: 72 }]))
const pinnedX = new Map()
const rawPos = layoutLayered(nodes, edges, sizes, pinnedX)
const pos = resolveLayeredOverlaps(nodes, sizes, rawPos, 18, pinnedX)
const localDistance = Math.abs(pos.get('flow').x - pos.get('system').x)
assert(localDistance <= 260, 'strong local contains relation was not attracted near its anchor: ' + localDistance)
const localRankDistance = pos.get('flow').y - pos.get('system').y
assert(localRankDistance > 0 && localRankDistance <= values[names.indexOf('LAYER_Y_GAP')] + 0.1, 'strong local contains relation was not made rank-adjacent: ' + localRankDistance)
assert(source.includes("const strongLocalRelations = new Set(['defines', 'contains', 'is_a', 'analogy', 'example', 'counter_example'])"), 'strong local relation set is missing or widened')
assert(source.includes('const localRadius = 260'), 'local attraction must stay bounded')
assert((source.match(/const strongLocalRelations = new Set/g) || []).length === 1, 'strong local relation set must have one view authority')
assert(source.includes('if (anchors.size !== 1 || reasoningRankIds.has(moverId)) continue'), 'ambiguous/local-reasoning rank guard is missing')
assert(source.includes('level.set(moverId, anchorRank + 1)'), 'local rank adjacency projection is missing')
assert(!source.includes("strongLocalRelations = new Set(['supports'"), 'supports must not become a strong local attraction relation')
for (const [from, to] of [['a','b'],['b','c'],['c','d'],['d','e']]) {
  assert(pos.get(from).y < pos.get(to).y, 'reasoning chain is not monotonic: ' + from + ' -> ' + to + ' / ' + JSON.stringify({ from: pos.get(from), to: pos.get(to) }))
}
const chainX = ['a','b','c','d','e'].map((id) => pos.get(id).x)
assert(Math.max(...chainX) - Math.min(...chainX) < 1, 'reasoning backbone did not stay pinned after overlap resolution: ' + JSON.stringify(chainX))
assert(pinnedX.size === 5, 'reasoning lane pins were not exported to the overlap resolver: ' + pinnedX.size)
const satelliteDistance = Math.abs(pos.get('x').x - pos.get('c').x)
assert(pos.get('x').y < pos.get('c').y, 'analogy satellite was not placed as a branch near its target')
assert(satelliteDistance >= 120 && satelliteDistance <= 280, 'analogy satellite is not a nearby side branch: ' + satelliteDistance)
if (pos.get('q').y === pos.get('b').y) {
  const required = (sizes.get('q').w + sizes.get('b').w) / 2 + 18
  assert(Math.abs(pos.get('q').x - pos.get('b').x) >= required - 0.1, 'unrelated row peer overlapped the pinned backbone slot')
}
const layeredSource = extractFunction(source, 'layoutLayered')
assert(!layeredSource.includes('if (backbonePaths.length === 0) return placed'), 'strong local attraction is incorrectly gated on a reasoning backbone')
assert(!layeredSource.includes('Shift an entire visual row rather than one node'), 'whole-row lane shifting is still present')
assert(layeredSource.includes('backbone nodes occupy fixed lane slots') || layeredSource.includes('Backbone nodes occupy fixed lane slots'), 'fixed lane-slot projection is missing')
assert(layeredSource.includes('const layeredRelationWeights = {'), 'relation-weighted layered ordering is missing')
assert(layeredSource.includes('weightedSum += p.x * link.weight'), 'weighted barycenter projection is missing')
assert(layeredSource.includes('supports: 4'), 'supports must remain a bounded soft layout preference')
assert(layeredSource.includes('not_is: 7'), 'not_is must retain explicit-classification proximity weight')
assert(source.includes("const reasoningRelations = new Set(['causes', 'infers'])"), 'relation-aware layered backbone is missing')
assert(source.includes("return 'layered'"), 'new sessions do not default to the semantic layered projection')
assert(source.includes('return layoutLayeredComponents(nodes, edges, sizes)'), 'layered view does not use component-aware layout')
assert(source.includes("const prefix = componentKey == null ? '' : 'component' + componentKey + ':'"), 'layered edge lanes are not component-local')
assert(source.includes('layout.componentNodesById.get(edge.fromNodeId) || nodes'), 'orthogonal routing is not scoped to the edge component')

// Many disconnected two-node components used to share global rank rows. Wide
// rows then wrapped, so a direct edge could span several visual rows even
// though its own component had only two nodes. Every component must now retain
// a one-row local edge and component boxes must be packed without overlap.
const disconnectedNodes = []
const disconnectedEdges = []
const disconnectedSizes = new Map()
for (let index = 0; index < 12; index++) {
  const rootId = 'component-root-' + index
  const leafId = 'component-leaf-' + index
  disconnectedNodes.push({ id: rootId, type: 'claim' }, { id: leafId, type: 'claim' })
  disconnectedEdges.push({
    fromNodeId: rootId,
    toNodeId: leafId,
    relation: index % 3 === 0 ? 'causes' : index % 3 === 1 ? 'defines' : 'supports',
  })
  disconnectedSizes.set(rootId, { w: 146 + (index % 4) * 16, h: 66 + (index % 3) * 8 })
  disconnectedSizes.set(leafId, { w: 154 + (index % 3) * 18, h: 70 + (index % 2) * 10 })
}
disconnectedNodes.push({ id: 'isolated-component', type: 'concept' })
disconnectedSizes.set('isolated-component', { w: 170, h: 80 })
const disconnectedLayout = layoutLayeredComponents(disconnectedNodes, disconnectedEdges, disconnectedSizes)
const disconnectedPos = disconnectedLayout.pos
assert(disconnectedPos.size === disconnectedNodes.length, 'component-aware layout omitted nodes')
assert(disconnectedLayout.componentKeyById.size === disconnectedNodes.length, 'component key metadata omitted nodes')
assert(disconnectedLayout.componentNodesById.get('component-root-0').length === 2, 'edge routing component contains unrelated nodes')
assert(disconnectedLayout.componentNodesById.get('isolated-component').length === 1, 'isolated routing component is not local')
const componentEdgeDistances = disconnectedEdges.map((edge) => {
  const from = disconnectedPos.get(edge.fromNodeId)
  const to = disconnectedPos.get(edge.toNodeId)
  return Math.hypot(to.x - from.x, to.y - from.y)
})
const maxComponentEdgeDistance = Math.max(...componentEdgeDistances)
assert(maxComponentEdgeDistance <= values[names.indexOf('LAYER_Y_GAP')] + 0.1, 'direct component edge spans wrapped global rows: ' + maxComponentEdgeDistance)
const componentBoxes = []
for (let index = 0; index < 12; index++) {
  const ids = ['component-root-' + index, 'component-leaf-' + index]
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const id of ids) {
    const point = disconnectedPos.get(id)
    const size = disconnectedSizes.get(id)
    x0 = Math.min(x0, point.x - size.w / 2)
    y0 = Math.min(y0, point.y - size.h / 2)
    x1 = Math.max(x1, point.x + size.w / 2)
    y1 = Math.max(y1, point.y + size.h / 2)
  }
  componentBoxes.push({ x0, y0, x1, y1 })
}
for (let i = 0; i < componentBoxes.length; i++) {
  for (let j = i + 1; j < componentBoxes.length; j++) {
    const a = componentBoxes[i]
    const b = componentBoxes[j]
    const separated = a.x1 + 37 <= b.x0 || b.x1 + 37 <= a.x0 || a.y1 + 37 <= b.y0 || b.y1 + 37 <= a.y0
    assert(separated, 'packed layered components overlap: ' + i + ' / ' + j)
  }
}

// Component discovery, local layout, and rectangle packing must remain fully
// deterministic for a stable source node/edge order.
const disconnectedAgain = layoutLayeredComponents(disconnectedNodes, disconnectedEdges, disconnectedSizes)
const snapshotPositions = (layout) => disconnectedNodes.map((node) => {
  const point = layout.pos.get(node.id)
  return [node.id, point.x, point.y, layout.componentKeyById.get(node.id)]
})
assert(JSON.stringify(snapshotPositions(disconnectedLayout)) === JSON.stringify(snapshotPositions(disconnectedAgain)), 'component-aware layout is not deterministic')

// A causes/infers cycle must take the existing hub-BFS fallback rather than
// hanging or emitting non-finite ranks.
const cycleNodes = ['cycle-a', 'cycle-b', 'cycle-c'].map((id) => ({ id, type: 'claim' }))
const cycleEdges = [
  { fromNodeId: 'cycle-a', toNodeId: 'cycle-b', relation: 'causes' },
  { fromNodeId: 'cycle-b', toNodeId: 'cycle-c', relation: 'causes' },
  { fromNodeId: 'cycle-c', toNodeId: 'cycle-a', relation: 'causes' },
]
const cycleSizes = new Map(cycleNodes.map((node) => [node.id, { w: 160, h: 72 }]))
const cycleLayout = layoutLayeredComponents(cycleNodes, cycleEdges, cycleSizes)
assert(cycleLayout.pos.size === cycleNodes.length, 'reasoning cycle fallback omitted nodes')
for (const point of cycleLayout.pos.values()) assert(Number.isFinite(point.x) && Number.isFinite(point.y), 'reasoning cycle produced non-finite coordinates')

// Packed components can be translated off the original global row grid. Route
// every edge against its component metadata and verify every orthogonal segment
// still avoids every non-endpoint node rectangle, including neighbouring boxes.
const pathPoints = (path) => Array.from(path.matchAll(/[ML]\s+(-?[0-9.]+)\s+(-?[0-9.]+)/g), (match) => ({ x: Number(match[1]), y: Number(match[2]) }))
let routedSegments = 0
for (const edge of disconnectedEdges) {
  const from = disconnectedPos.get(edge.fromNodeId)
  const to = disconnectedPos.get(edge.toNodeId)
  const routeNodes = disconnectedLayout.componentNodesById.get(edge.fromNodeId)
  const points = pathPoints(layeredOrthoPath(edge, from, to, disconnectedSizes, disconnectedPos, routeNodes, 0).d)
  assert(points.length >= 4, 'layered orthogonal route omitted bends')
  for (let segmentIndex = 1; segmentIndex < points.length; segmentIndex++) {
    const start = points[segmentIndex - 1]
    const end = points[segmentIndex]
    const vertical = Math.abs(start.x - end.x) < 1e-9
    const horizontal = Math.abs(start.y - end.y) < 1e-9
    assert(vertical || horizontal, 'layered route contains a non-orthogonal segment')
    routedSegments += 1
    for (const node of disconnectedNodes) {
      if (node.id === edge.fromNodeId || node.id === edge.toNodeId) continue
      const point = disconnectedPos.get(node.id)
      const size = disconnectedSizes.get(node.id)
      const x0 = point.x - size.w / 2 + 1
      const x1 = point.x + size.w / 2 - 1
      const y0 = point.y - size.h / 2 + 1
      const y1 = point.y + size.h / 2 - 1
      const hits = vertical
        ? start.x > x0 && start.x < x1 && Math.max(Math.min(start.y, end.y), y0) < Math.min(Math.max(start.y, end.y), y1)
        : start.y > y0 && start.y < y1 && Math.max(Math.min(start.x, end.x), x0) < Math.min(Math.max(start.x, end.x), x1)
      assert(!hits, 'packed component route crosses node ' + node.id + ' for ' + edge.fromNodeId + '>' + edge.toNodeId)
    }
  }
}

// Keep an inexpensive upper-bound guard around the supported ~800-node view.
// The generous ceiling avoids machine-speed flakiness while catching accidental
// cubic regressions in component discovery, ranking, or overlap resolution.
const largeNodes = Array.from({ length: 800 }, (_, index) => ({ id: 'large-' + index, type: 'claim' }))
const largeEdges = Array.from({ length: 799 }, (_, index) => ({ fromNodeId: 'large-' + index, toNodeId: 'large-' + (index + 1), relation: 'causes' }))
const largeSizes = new Map(largeNodes.map((node) => [node.id, { w: 120, h: 64 }]))
const largeStartedAt = Date.now()
const largeLayout = layoutLayeredComponents(largeNodes, largeEdges, largeSizes)
const largeElapsedMs = Date.now() - largeStartedAt
assert(largeLayout.pos.size === largeNodes.length, 'large component-aware layout omitted nodes')
assert(largeElapsedMs < 5000, '800-node layered layout exceeded regression ceiling: ' + largeElapsedMs + 'ms')

console.log(JSON.stringify({
  ok: true,
  chain: ['a','b','c','d','e'].map((id) => ({ id, ...pos.get(id) })),
  satellite: pos.get('x'),
  peer: pos.get('q'),
  componentAware: true,
  componentCount: 13,
  maxComponentEdgeDistance,
  deterministic: true,
  cycleSafe: true,
  routedSegments,
  largeNodes: largeLayout.pos.size,
  largeElapsedMs,
}))
