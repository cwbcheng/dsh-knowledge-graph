// Shared deterministic routing fixture. The production measurement and worker
// are supplied fixed dimensions/positions; lanes, routes, label collision
// placement, bounds and the preparation pipeline are the real viewer functions.
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { performance } from 'node:perf_hooks'

const names = ['prepareGraphScene', 'channelBand', 'layeredOrthoPath', 'clamp',
  'corridorFree', 'findCorridor', 'buildLayeredEdgeLanes', 'placeLayeredEdgeLabel',
  'computeBBox', 'edgeRelationLabel', 'LAYER_Y_GAP', 'REL_LABEL', 'EDGE_ATTRIBUTE_LABELS']

export function loadChannelEngine(viewer) {
  const environment = { window: { React: {} }, console }
  const marker = 'window.KGViewer = {'
  assert(viewer.includes(marker), 'Generated viewer export marker')
  runInNewContext(viewer.replace(marker, marker + names.join(',') + ','), environment)
  const engine = environment.window.KGViewer
  // Compile both comparison engines into this same realm. VM Math/global
  // lookup overhead must not masquerade as a channel optimization.
  for (const name of ['channelBand', 'corridorFree', 'findCorridor', 'buildLayeredEdgeLanes']) {
    engine[name] = new Function('LAYER_Y_GAP', 'return (' + engine[name].toString() + ')')(engine.LAYER_Y_GAP)
  }
  for (const name of ['clamp', 'placeLayeredEdgeLabel', 'computeBBox']) {
    engine[name] = new Function('return (' + engine[name].toString() + ')')()
  }
  engine.edgeRelationLabel = new Function('REL_LABEL', 'EDGE_ATTRIBUTE_LABELS',
    'return (' + engine.edgeRelationLabel.toString() + ')')(engine.REL_LABEL, engine.EDGE_ATTRIBUTE_LABELS)
  engine.routeWith = band => new Function('channelBand', 'clamp', 'corridorFree', 'findCorridor', 'LAYER_Y_GAP',
    'return (' + engine.layeredOrthoPath.toString() + ')')(
    band, engine.clamp, engine.corridorFree, engine.findCorridor, engine.LAYER_Y_GAP)
  engine.layeredOrthoPath = engine.routeWith(engine.channelBand)
  return engine
}

export function channelFixture(count, { components = 1, varied = false, fallback = false, shift = 0 } = {}) {
  const nodes = [], edges = [], sizes = new Map(), pos = new Map()
  const componentNodesById = new Map(), componentKeyById = new Map()
  for (let component = 0; component < components; component++) {
    const group = []
    for (let index = 0; index < count; index++) {
      const id = 'c' + component + ':n' + index + (varied && index % 7 === 0 ? ' 雪 ' : '')
      const node = { id, type: 'fact', text: 'Node ' + index }
      nodes.push(node); group.push(node)
      const row = varied ? [-2, -2, -1, 0, 0, 2, 3, 3][index % 8] : Math.floor(index / 4)
      pos.set(id, { x: component * 1600 + (index % 4) * 300 + shift,
        y: row * 240 + (varied ? component * 17 + (index % 3) * 0.25 : 0) + shift })
      sizes.set(id, { w: 140 + index % 5 * 10,
        h: varied && index % 8 === 3 ? 520 : 70 + index % 7 * 4 + component * 12 })
      componentKeyById.set(id, 'component:' + component)
    }
    for (const node of group) componentNodesById.set(node.id, group)
    for (let index = 0; index < count; index++) {
      for (const step of [1, 2, 3]) if (index + step < count) {
        edges.push({ id: 'e' + edges.length, fromNodeId: group[index].id, toNodeId: group[index + step].id,
          relation: 'supports', evidence: ['original:' + index] })
      }
      if (varied) {
        for (const target of [index, Math.max(0, index - 2), Math.max(0, index - 2)]) {
          edges.push({ id: 'e' + edges.length, fromNodeId: group[index].id, toNodeId: group[target].id,
            relation: index % 2 ? 'contradicts' : 'causes', polarity: index % 3 ? 'positive' : 'negative' })
        }
      }
    }
  }
  if (varied && nodes.length) edges.push({ id: 'missing-endpoint', fromNodeId: nodes[0].id, toNodeId: 'absent', relation: 'supports' })
  const layout = { pos, ...(fallback ? {} : { componentNodesById, componentKeyById }) }
  return { nodes, edges, sizes, layout }
}

export async function prepareChannelFixture(engine, fixture, { mode = 'layered', stats, cancelAtRoute = null } = {}) {
  const { nodes, edges, sizes, layout } = fixture
  const controller = new AbortController(), progress = []
  let routes = 0, routingStarted, routingMs
  const band = stats ? (row, group, dimensions, points, cache) => {
    stats.bandCalls = (stats.bandCalls || 0) + 1
    if (cache) {
      stats.caches ||= new Set(); stats.caches.add(cache)
      stats.cacheGroups ||= new Map()
      if (stats.cacheGroups.has(cache)) assert.equal(stats.cacheGroups.get(cache), group, 'Channel cache must belong to one component')
      stats.cacheGroups.set(cache, group)
    }
    const countedNodes = new Proxy(group, {
      get(target, key, receiver) {
        if (key === Symbol.iterator) return function* () {
          for (const node of target) {
            stats.bandNodeVisits = (stats.bandNodeVisits || 0) + 1
            yield node
          }
        }
        return Reflect.get(target, key, receiver)
      },
    })
    return engine.channelBand(row, countedNodes, dimensions, points, cache)
  } : engine.channelBand
  const route = engine.routeWith(band)
  const deps = {
    performance: cancelAtRoute === null ? performance : { now: () => routes * 9 },
    async graphPaint(signal) { signal.throwIfAborted() },
    async graphYield(signal) {
      if (cancelAtRoute !== null && routes >= cancelAtRoute) controller.abort()
      signal.throwIfAborted()
    },
    computeNodeSizes: batch => new Map(batch.filter(node => sizes.has(node.id)).map(node => [node.id, sizes.get(node.id)])),
    async computeGraphLayoutAsync(input, inputEdges, measured, inputMode, signal) {
      signal.throwIfAborted(); assert.equal(input, nodes); assert.equal(inputEdges, edges)
      return layout
    },
    buildLayeredEdgeLanes: engine.buildLayeredEdgeLanes,
    layeredOrthoPath(...args) { routes++; return route(...args) },
    measureLabel: text => String(text).length * 8,
    edgeRelationLabel: engine.edgeRelationLabel,
    placeLayeredEdgeLabel: engine.placeLayeredEdgeLabel,
    computeBBox: engine.computeBBox,
  }
  const run = new Function(...Object.keys(deps), 'return (' + engine.prepareGraphScene.toString() + ')')(...Object.values(deps))
  const result = await run(nodes, edges, mode, controller.signal, item => {
    progress.push(item)
    if (item.stage === 2 && routingStarted === undefined) routingStarted = performance.now()
    if (item.stage === 3) routingMs = performance.now() - routingStarted
  })
  return { result, progress, routingMs, routes }
}

export function preparedChannelJSON(prepared) {
  const { sizes, layout, bbox, edgeLanes, layeredEdgeGeometry } = prepared.result
  return JSON.stringify({ sizes: [...sizes], pos: [...layout.pos], bbox,
    lanes: [...edgeLanes].map(([edge, lane]) => [edge.id, lane]),
    geometry: [...layeredEdgeGeometry].map(([edge, geometry]) => [edge.id, geometry]) })
}

export function channelRegressionFixtures() {
  const cases = [
    ['empty', channelFixture(0)], ['single', channelFixture(1)],
    ['grid-4', channelFixture(4)], ['grid-65', channelFixture(65)],
    ['grid-205', channelFixture(205)],
    ['varied', channelFixture(17, { varied: true })],
    ['components', channelFixture(17, { components: 3, varied: true })],
    ['fallback', channelFixture(17, { components: 3, varied: true, fallback: true })],
    ['shifted', channelFixture(17, { components: 3, varied: true, shift: 83.25 })],
  ]
  const missingSize = channelFixture(17, { varied: true })
  missingSize.sizes.delete(missingSize.nodes[3].id)
  cases.push(['missing-size', missingSize])
  const partial = channelFixture(17, { components: 3, varied: true })
  for (const node of partial.nodes.slice(0, 17)) partial.layout.componentNodesById.delete(node.id)
  cases.push(['partial-components', partial])
  return cases
}
