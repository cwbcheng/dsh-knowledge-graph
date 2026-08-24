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
  'buildLayeredEdgeLanes',
  'placeLayeredEdgeLabel',
  'corridorFree',
  'findCorridor',
  'channelBand',
  'layeredOrthoPath',
]
const mirroredSnippets = [
  'return layoutLayeredComponents(nodes, edges, sizes)',
  'return buildLayeredEdgeLanes(edges, layout.pos, layout.componentKeyById, layout.componentNodesById)',
  "placeLayeredEdgeLabel(route.lblX, route.lblY, labelW, labelH, occupied, nodeRects, index, route.labelAxis || 'x')",
  'const layeredEdgeGeometry = useMemo(() => {',
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
const buildLayeredEdgeLanes = new Function('LAYER_Y_GAP', 'return (' + extractFunction(source, 'buildLayeredEdgeLanes') + ')')(layerYGap)
const placeLayeredEdgeLabel = new Function('return (' + extractFunction(source, 'placeLayeredEdgeLabel') + ')')()
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
assert(source.includes('return buildLayeredEdgeLanes(edges, layout.pos, layout.componentKeyById, layout.componentNodesById)'), 'layered view does not use multi-track edge lanes')
assert(source.includes('sourcePort: 0, targetPort: 0, sourceChannel: 0, targetChannel: 0, corridor: 0'), 'layered lane dimensions are incomplete')
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
const disconnectedLanes = buildLayeredEdgeLanes(disconnectedEdges, disconnectedPos, disconnectedLayout.componentKeyById, disconnectedLayout.componentNodesById)
let routedSegments = 0
for (const edge of disconnectedEdges) {
  const from = disconnectedPos.get(edge.fromNodeId)
  const to = disconnectedPos.get(edge.toNodeId)
  const routeNodes = disconnectedLayout.componentNodesById.get(edge.fromNodeId)
  const points = pathPoints(layeredOrthoPath(edge, from, to, disconnectedSizes, disconnectedPos, routeNodes, disconnectedLanes.get(edge)).d)
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

// Relation chips on neighbouring horizontal tracks must stagger instead of
// rendering Chinese labels on top of each other. A nearby node also blocks the
// first preferred offset, exercising deterministic alternate placement.
const labelNodeRects = [{ x0: -52, x1: -24, y0: -5, y1: 23 }]
const placeLabelSeries = () => {
  const occupied = []
  const placements = [0, 9, 18, 27].map((y, index) => placeLayeredEdgeLabel(0, y, 30, 15, occupied, labelNodeRects, index, 'x'))
  return { occupied, placements }
}
const labelSeries = placeLabelSeries()
assert(JSON.stringify(labelSeries.placements) === JSON.stringify(placeLabelSeries().placements), 'layered label staggering is not deterministic')
for (let i = 0; i < labelSeries.occupied.length; i++) {
  const a = labelSeries.occupied[i]
  for (let j = i + 1; j < labelSeries.occupied.length; j++) {
    const b = labelSeries.occupied[j]
    const overlap = a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
    assert(!overlap, 'layered relation labels still overlap after staggering')
  }
  const blocker = labelNodeRects[0]
  const hitsBlocker = a.x0 < blocker.x1 && a.x1 > blocker.x0 && a.y0 < blocker.y1 && a.y1 > blocker.y0
  assert(!hitsBlocker, 'staggered relation label overlaps a node')
}
const staggeredLabelCount = labelSeries.placements.filter((point) => point.x !== 0 || ![0, 9, 18, 27].includes(point.y)).length
assert(staggeredLabelCount >= 2, 'crowded relation labels were not visibly staggered')
const verticalLabels = []
const verticalFirst = placeLayeredEdgeLabel(20, 40, 30, 15, verticalLabels, [], 0, 'y')
const verticalSecond = placeLayeredEdgeLabel(20, 40, 30, 15, verticalLabels, [], 1, 'y')
assert(verticalFirst.x === 20 && verticalSecond.x === 20 && verticalSecond.y !== 40, 'vertical corridor labels did not stagger along the route axis')

// Dense clusters must keep searching for the nearest bounded slot instead of
// giving up and stacking labels at their original point.
const denseLabels = []
const denseLabelPlacements = Array.from({ length: 24 }, (_, index) => placeLayeredEdgeLabel(0, 0, 30, 15, denseLabels, [], index, 'x'))
assert(denseLabelPlacements.every((point) => !point.hidden), 'dense label cluster exhausted bounded slots too early')
assert(denseLabels.length === denseLabelPlacements.length, 'visible dense labels were not registered as occupied')
for (let i = 0; i < denseLabels.length; i++) {
  for (let j = i + 1; j < denseLabels.length; j++) {
    const a = denseLabels[i]
    const b = denseLabels[j]
    assert(!(a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0), 'dense label cluster retained an overlap')
  }
}
const maxDenseLabelShift = Math.max(...denseLabelPlacements.map((point) => point.distance))
assert(maxDenseLabelShift <= 180, 'dense label displacement exceeded the ambiguity cap')
const overflowLabels = []
const hiddenOverflow = placeLayeredEdgeLabel(0, 0, 30, 15, overflowLabels, [{ x0: -220, x1: 220, y0: -220, y1: 220 }], 0, 'x')
assert(hiddenOverflow.hidden && overflowLabels.length === 0, 'unplaceable label fell back to an overlapping visible chip')

const labelPerfOccupied = []
const labelPerfStartedAt = Date.now()
for (let index = 0; index < 800; index++) {
  const x = (index % 40) * 48
  const y = Math.floor(index / 40) * 28
  const point = placeLayeredEdgeLabel(x, y, 30, 15, labelPerfOccupied, [], index, 'x')
  assert(!point.hidden, 'ordinary 800-label grid unexpectedly hid a chip')
}
const labelPerfElapsedMs = Date.now() - labelPerfStartedAt
assert(labelPerfElapsedMs < 1000, '800-label placement exceeded regression ceiling: ' + labelPerfElapsedMs + 'ms')

// A dense fan-in should no longer collapse onto one arrow entry or one channel
// line. Eight incoming edges are spread across the target border and the shared
// inter-row channel in deterministic source-x order.
const fanTarget = { id: 'fan-target', type: 'claim' }
const fanSources = Array.from({ length: 8 }, (_, index) => ({ id: 'fan-source-' + index, type: 'claim' }))
const fanNodes = [...fanSources, fanTarget]
const fanEdges = fanSources.map((node) => ({ fromNodeId: node.id, toNodeId: fanTarget.id, relation: 'supports' }))
const fanPos = new Map([[fanTarget.id, { x: 0, y: layerYGap }]])
fanSources.forEach((node, index) => fanPos.set(node.id, { x: (index - 3.5) * 180, y: 0 }))
const fanSizes = new Map(fanNodes.map((node) => [node.id, { w: 190, h: 100 }]))
const fanComponentKey = new Map(fanNodes.map((node) => [node.id, 0]))
const fanComponentNodes = new Map(fanNodes.map((node) => [node.id, fanNodes]))
const fanLanes = buildLayeredEdgeLanes(fanEdges, fanPos, fanComponentKey, fanComponentNodes)
const fanEntries = []
const fanChannels = []
for (const edge of fanEdges) {
  const lane = fanLanes.get(edge)
  const points = pathPoints(layeredOrthoPath(edge, fanPos.get(edge.fromNodeId), fanPos.get(edge.toNodeId), fanSizes, fanPos, fanNodes, lane).d)
  fanEntries.push(points[points.length - 1].x)
  fanChannels.push(points[1].y)
}
const minimumGap = (values) => {
  const ordered = values.slice().sort((a, b) => a - b)
  let gap = Infinity
  for (let index = 1; index < ordered.length; index++) gap = Math.min(gap, ordered[index] - ordered[index - 1])
  return gap
}
const minimumFanEntryGap = minimumGap(fanEntries)
const minimumFanChannelGap = minimumGap(fanChannels)
assert(minimumFanEntryGap >= 20, 'fan-in arrow entries still overlap: ' + JSON.stringify(fanEntries))
assert(minimumFanChannelGap >= 15, 'shared horizontal channel tracks are still too close: ' + JSON.stringify(fanChannels))
const targetPorts = fanEdges.map((edge) => fanLanes.get(edge).targetPort)
assert(targetPorts.every((slot, index) => index === 0 || slot > targetPorts[index - 1]), 'fan-in ports are not deterministically ordered')
assert(fanEdges.every((edge) => fanLanes.get(edge).corridor === 0), 'adjacent-row fan allocated useless vertical corridor tracks')

// A fork from one wide source to adjacent-row targets uses distinct source
// ports. The shared channel must connect each port straight to its target;
// detouring through the source centre creates a visible collinear stub and
// then doubles back (the regression shown in the UI screenshot).
const forkSource = { id: 'fork-source', type: 'claim' }
const forkTargets = [{ id: 'fork-left', type: 'rule' }, { id: 'fork-right', type: 'rule' }]
const forkNodes = [forkSource, ...forkTargets]
const forkEdges = forkTargets.map((node) => ({ fromNodeId: forkSource.id, toNodeId: node.id, relation: 'supports' }))
const forkPos = new Map([
  [forkSource.id, { x: 0, y: 0 }],
  [forkTargets[0].id, { x: -260, y: layerYGap }],
  [forkTargets[1].id, { x: 260, y: layerYGap }],
])
const forkSizes = new Map([
  [forkSource.id, { w: 300, h: 100 }],
  [forkTargets[0].id, { w: 210, h: 90 }],
  [forkTargets[1].id, { w: 210, h: 90 }],
])
const forkKeys = new Map(forkNodes.map((node) => [node.id, 0]))
const forkComponents = new Map(forkNodes.map((node) => [node.id, forkNodes]))
const forkLanes = buildLayeredEdgeLanes(forkEdges, forkPos, forkKeys, forkComponents)
for (const edge of forkEdges) {
  const route = layeredOrthoPath(edge, forkPos.get(edge.fromNodeId), forkPos.get(edge.toNodeId), forkSizes, forkPos, forkNodes, forkLanes.get(edge))
  const points = pathPoints(route.d)
  assert(points.length === 4, 'adjacent-row fork retained a zero-height corridor detour: ' + route.d)
  const channelStart = points[1]
  const channelEnd = points[2]
  const minX = Math.min(channelStart.x, channelEnd.x) - 1e-9
  const maxX = Math.max(channelStart.x, channelEnd.x) + 1e-9
  assert(route.lblX >= minX && route.lblX <= maxX, 'fork relation label sits on an overshooting stub')
  for (const point of points.filter((item) => Math.abs(item.y - channelStart.y) < 1e-9)) {
    assert(point.x >= minX && point.x <= maxX, 'adjacent-row fork channel overshoots its two ports: ' + route.d)
  }
}

// Incoming and outgoing edges that use the same physical side of a mixed hub
// must share one port allocator instead of independently choosing duplicates.
const mixedHub = { id: 'mixed-hub', type: 'claim' }
const mixedIncoming = Array.from({ length: 4 }, (_, index) => ({ id: 'mixed-in-' + index, type: 'claim' }))
const mixedOutgoing = Array.from({ length: 4 }, (_, index) => ({ id: 'mixed-out-' + index, type: 'claim' }))
const mixedNodes = [mixedHub, ...mixedIncoming, ...mixedOutgoing]
const mixedEdges = [
  ...mixedIncoming.map((node) => ({ fromNodeId: node.id, toNodeId: mixedHub.id, relation: 'supports' })),
  ...mixedOutgoing.map((node) => ({ fromNodeId: mixedHub.id, toNodeId: node.id, relation: 'supports' })),
]
const mixedPos = new Map([[mixedHub.id, { x: 0, y: layerYGap }]])
mixedIncoming.forEach((node, index) => mixedPos.set(node.id, { x: (index - 1.5) * 180 - 45, y: layerYGap * 2 }))
mixedOutgoing.forEach((node, index) => mixedPos.set(node.id, { x: (index - 1.5) * 180 + 45, y: layerYGap * 2 }))
const mixedKey = new Map(mixedNodes.map((node) => [node.id, 0]))
const mixedComponent = new Map(mixedNodes.map((node) => [node.id, mixedNodes]))
const mixedLanes = buildLayeredEdgeLanes(mixedEdges, mixedPos, mixedKey, mixedComponent)
const mixedBottomPorts = [
  ...mixedEdges.slice(0, 4).map((edge) => mixedLanes.get(edge).targetPort),
  ...mixedEdges.slice(4).map((edge) => mixedLanes.get(edge).sourcePort),
]
assert(new Set(mixedBottomPorts).size === mixedBottomPorts.length, 'mixed fan-in/out reused border ports')
const mixedBottomEntryX = mixedBottomPorts.map((slot) => slot * (170 / 2 - 8))
const minimumMixedPortGap = minimumGap(mixedBottomEntryX)
assert(minimumMixedPortGap >= 14, 'mixed fan-in/out ports remain visually merged: ' + JSON.stringify(mixedBottomEntryX))

// Overlapping multi-row intervals must receive distinct vertical corridor tracks.
const corridorPos = new Map()
const corridorNodes = []
const corridorEdges = []
for (let index = 0; index < 4; index++) {
  const from = { id: 'corridor-from-' + index, type: 'claim' }
  const to = { id: 'corridor-to-' + index, type: 'claim' }
  corridorNodes.push(from, to)
  corridorEdges.push({ fromNodeId: from.id, toNodeId: to.id, relation: 'causes' })
  corridorPos.set(from.id, { x: 0, y: 0 })
  corridorPos.set(to.id, { x: 0, y: layerYGap * 3 })
}
const corridorComponentKey = new Map(corridorNodes.map((node) => [node.id, 0]))
const corridorComponentNodes = new Map(corridorNodes.map((node) => [node.id, corridorNodes]))
const corridorLanes = buildLayeredEdgeLanes(corridorEdges, corridorPos, corridorComponentKey, corridorComponentNodes)
assert(new Set(corridorEdges.map((edge) => corridorLanes.get(edge).corridor)).size === corridorEdges.length, 'overlapping vertical spans reused one corridor track')
const corridorSizes = new Map(corridorNodes.map((node) => [node.id, { w: 150, h: 72 }]))
const renderedCorridorX = corridorEdges.map((edge) => {
  const points = pathPoints(layeredOrthoPath(edge, corridorPos.get(edge.fromNodeId), corridorPos.get(edge.toNodeId), corridorSizes, corridorPos, corridorNodes, corridorLanes.get(edge)).d)
  return points[2].x
})
const minimumCorridorGap = minimumGap(renderedCorridorX)
assert(minimumCorridorGap >= 13.9, 'distinct corridor tracks rendered onto one vertical line: ' + JSON.stringify(renderedCorridorX))

// Disjoint vertical intervals may safely reuse the same track.
const reuseNodes = ['reuse-a0','reuse-a2','reuse-b2','reuse-b4'].map((id) => ({ id, type: 'claim' }))
const reuseEdges = [
  { fromNodeId: 'reuse-a0', toNodeId: 'reuse-a2', relation: 'causes' },
  { fromNodeId: 'reuse-b2', toNodeId: 'reuse-b4', relation: 'causes' },
]
const reusePos = new Map([
  ['reuse-a0', { x: -100, y: 0 }],
  ['reuse-a2', { x: -100, y: layerYGap * 2 }],
  ['reuse-b2', { x: 100, y: layerYGap * 2 }],
  ['reuse-b4', { x: 100, y: layerYGap * 4 }],
])
const reuseKey = new Map(reuseNodes.map((node) => [node.id, 0]))
const reuseComponent = new Map(reuseNodes.map((node) => [node.id, reuseNodes]))
const reuseLanes = buildLayeredEdgeLanes(reuseEdges, reusePos, reuseKey, reuseComponent)
assert(reuseEdges.every((edge) => reuseLanes.get(edge).corridor === 0), 'disjoint vertical intervals did not reuse one corridor track')

const denseCorridorNodes = []
const denseCorridorEdges = []
const denseCorridorPos = new Map()
for (let index = 0; index < 40; index++) {
  const from = { id: 'dense-corridor-from-' + index, type: 'claim' }
  const to = { id: 'dense-corridor-to-' + index, type: 'claim' }
  denseCorridorNodes.push(from, to)
  denseCorridorEdges.push({ fromNodeId: from.id, toNodeId: to.id, relation: 'supports' })
  denseCorridorPos.set(from.id, { x: index * 12, y: 0 })
  denseCorridorPos.set(to.id, { x: index * 12, y: layerYGap * 3 })
}
const denseCorridorKey = new Map(denseCorridorNodes.map((node) => [node.id, 0]))
const denseCorridorComponent = new Map(denseCorridorNodes.map((node) => [node.id, denseCorridorNodes]))
const denseCorridorLanes = buildLayeredEdgeLanes(denseCorridorEdges, denseCorridorPos, denseCorridorKey, denseCorridorComponent)
const denseCorridorOffsets = denseCorridorEdges.map((edge) => denseCorridorLanes.get(edge).corridor)
assert(Math.max(...denseCorridorOffsets.map(Math.abs)) <= 8, 'dense corridor fan exceeded bounded horizontal spread')
assert(new Set(denseCorridorOffsets).size === denseCorridorEdges.length, 'bounded dense corridor tracks collapsed to identical lanes')

// Exercise every rendered routing branch: same-row above a negatively shifted
// component, upward flow, and a multi-row corridor that must dodge blockers.
const assertRouteCase = (name, caseNodes, edge, casePos) => {
  const caseSizes = new Map(caseNodes.map((node) => [node.id, { w: 150, h: 72 }]))
  const caseKey = new Map(caseNodes.map((node) => [node.id, 0]))
  const caseComponent = new Map(caseNodes.map((node) => [node.id, caseNodes]))
  const caseLanes = buildLayeredEdgeLanes([edge], casePos, caseKey, caseComponent)
  const points = pathPoints(layeredOrthoPath(edge, casePos.get(edge.fromNodeId), casePos.get(edge.toNodeId), caseSizes, casePos, caseNodes, caseLanes.get(edge)).d)
  for (let segmentIndex = 1; segmentIndex < points.length; segmentIndex++) {
    const start = points[segmentIndex - 1]
    const end = points[segmentIndex]
    const vertical = Math.abs(start.x - end.x) < 1e-9
    const horizontal = Math.abs(start.y - end.y) < 1e-9
    assert(vertical || horizontal, name + ' route contains a non-orthogonal segment')
    for (const node of caseNodes) {
      if (node.id === edge.fromNodeId || node.id === edge.toNodeId) continue
      const point = casePos.get(node.id)
      const size = caseSizes.get(node.id)
      const x0 = point.x - size.w / 2 + 1
      const x1 = point.x + size.w / 2 - 1
      const y0 = point.y - size.h / 2 + 1
      const y1 = point.y + size.h / 2 - 1
      const hits = vertical
        ? start.x > x0 && start.x < x1 && Math.max(Math.min(start.y, end.y), y0) < Math.min(Math.max(start.y, end.y), y1)
        : start.y > y0 && start.y < y1 && Math.max(Math.min(start.x, end.x), x0) < Math.min(Math.max(start.x, end.x), x1)
      assert(!hits, name + ' route crosses blocker ' + node.id)
    }
  }
  return points
}
const sameRowNodes = [{ id: 'same-left' }, { id: 'same-right' }]
const sameRowEdge = { fromNodeId: 'same-left', toNodeId: 'same-right', relation: 'supports' }
const sameRowPos = new Map([
  ['same-left', { x: -120, y: -layerYGap * 2 }],
  ['same-right', { x: 120, y: -layerYGap * 2 }],
])
const sameRowPoints = assertRouteCase('same-row', sameRowNodes, sameRowEdge, sameRowPos)
assert(sameRowPoints[1].y < sameRowPos.get('same-left').y, 'last negative row did not route through the upper channel')
const upwardNodes = [{ id: 'up-from' }, { id: 'up-to' }, { id: 'up-blocker' }]
const upwardEdge = { fromNodeId: 'up-from', toNodeId: 'up-to', relation: 'causes' }
const upwardPos = new Map([
  ['up-from', { x: 0, y: layerYGap * 2 }],
  ['up-to', { x: 220, y: 0 }],
  ['up-blocker', { x: 0, y: layerYGap }],
])
const upwardPoints = assertRouteCase('upward', upwardNodes, upwardEdge, upwardPos)
assert(upwardPoints[0].y < upwardPos.get('up-from').y, 'upward edge did not exit through the source top border')
const multiRowNodes = [{ id: 'multi-from' }, { id: 'multi-to' }, { id: 'multi-blocker-1' }, { id: 'multi-blocker-2' }]
const multiRowEdge = { fromNodeId: 'multi-from', toNodeId: 'multi-to', relation: 'causes' }
const multiRowPos = new Map([
  ['multi-from', { x: -220, y: 0 }],
  ['multi-to', { x: -220, y: layerYGap * 3 }],
  ['multi-blocker-1', { x: -220, y: layerYGap }],
  ['multi-blocker-2', { x: -220, y: layerYGap * 2 }],
])
const multiRowPoints = assertRouteCase('multi-row', multiRowNodes, multiRowEdge, multiRowPos)
assert(Math.abs(multiRowPoints[2].x + 220) > 75, 'multi-row corridor did not dodge aligned blockers')

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
  staggeredLabelCount,
  maxDenseLabelShift,
  labelPerfElapsedMs,
  minimumFanEntryGap,
  minimumFanChannelGap,
  minimumMixedPortGap,
  minimumCorridorGap,
  corridorTracks: corridorEdges.length,
  routeBranches: 3,
  largeNodes: largeLayout.pos.size,
  largeElapsedMs,
}))
