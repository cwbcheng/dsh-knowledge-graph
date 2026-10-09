// Optional, isolated comparison; no wall-clock threshold is used in CI.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { loadChannelEngine, channelFixture, channelRegressionFixtures, prepareChannelFixture, preparedChannelJSON } from './kg-layered-channel-fixture.mjs'

export async function benchmarkLayeredChannels(ref = 'f710ff5', { validateOnly = false } = {}) {
  const baseline = execFileSync('git', ['rev-parse', ref], { encoding: 'utf8' }).trim()
  const beforeSource = execFileSync('git', ['show', baseline + ':extension/viewer.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const currentSource = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
  const before = loadChannelEngine(beforeSource), current = loadChannelEngine(currentSource)
  const samples = []
  const cases = [...channelRegressionFixtures(),
    ['grid-800', channelFixture(800)], ['grid-2000', channelFixture(2000)],
    ['disconnected-2000', channelFixture(40, { components: 50 })],
    ['force-control', channelFixture(2000), 'force'], ['overview-control', channelFixture(2000), 'overview']]
  for (const [name, fixture, mode = 'layered'] of cases) {
    const stats = [{}, {}], labelStats = [{}, {}]
    const expected = await prepareChannelFixture(before, fixture, { mode, stats: stats[0], labelStats: labelStats[0] })
    const actual = await prepareChannelFixture(current, fixture, { mode, stats: stats[1], labelStats: labelStats[1] })
    assert.equal(preparedChannelJSON(actual), preparedChannelJSON(expected), name + ': complete prepared geometry')
    const lanes = before.buildLayeredEdgeLanes(fixture.edges, fixture.layout.pos, fixture.layout.componentKeyById, fixture.layout.componentNodesById)
    const routes = engine => {
      if (mode !== 'layered') return []
      const byNodes = engine.layeredOrthoPath.length >= 8 ? new Map() : null
      return fixture.edges.filter(edge => fixture.layout.pos.has(edge.fromNodeId) && fixture.layout.pos.has(edge.toNodeId)
        && fixture.sizes.has(edge.fromNodeId) && fixture.sizes.has(edge.toNodeId)).map(edge => {
        const group = fixture.layout.componentNodesById?.get(edge.fromNodeId) || fixture.nodes
        let bands = byNodes?.get(group)
        if (byNodes && !bands) {
          bands = engine.buildLayeredChannelIndex ? engine.buildLayeredChannelIndex(group, fixture.sizes, fixture.layout.pos) : new Map()
          byNodes.set(group, bands)
        }
        return engine.layeredOrthoPath(edge, fixture.layout.pos.get(edge.fromNodeId), fixture.layout.pos.get(edge.toNodeId),
          fixture.sizes, fixture.layout.pos, group, lanes.get(edge) || 0, bands)
      })
    }
    assert.equal(JSON.stringify(routes(current)), JSON.stringify(routes(before)), name + ': path and original label anchor bytes')
    const routeTimes = [[], []], routingStageTimes = [[], []]
    if (!validateOnly) {
      // Counters pass Proxy arrays to the old collision function. Use fresh
      // functions for timing so instrumentation cannot affect their JIT type
      // feedback even after warmup. Both engines get the same fresh lifecycle.
      const engines = [loadChannelEngine(beforeSource), loadChannelEngine(currentSource)]
      for (let warm = 0; warm < 3; warm++) for (const engine of engines) {
        routes(engine)
        const prepared = await prepareChannelFixture(engine, fixture, { mode })
        if (warm === 0) assert.equal(preparedChannelJSON(prepared), preparedChannelJSON(expected), name + ': uninstrumented timing engine geometry')
      }
      for (let trial = 0; trial < 9; trial++) for (const index of trial % 2 ? [1, 0] : [0, 1]) {
        if (mode === 'layered') {
          const start = performance.now(); routes(engines[index]); routeTimes[index].push(performance.now() - start)
        }
        routingStageTimes[index].push((await prepareChannelFixture(engines[index], fixture, { mode })).routingMs)
      }
    }
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null
    samples.push({ name, mode, nodes: fixture.nodes.length, edges: fixture.edges.length,
      beforeBandNodeVisits: stats[0].bandNodeVisits || 0, currentBandNodeVisits: stats[1].bandNodeVisits || 0,
      beforeMaxRowNodeVisits: stats[0].maxRowNodeVisits || 0, currentMaxRowNodeVisits: stats[1].maxRowNodeVisits || 0,
      beforeIndexNodeVisits: stats[0].indexNodeVisits || 0, currentIndexNodeVisits: stats[1].indexNodeVisits || 0,
      currentBandEntries: [...(stats[1].caches || [])].reduce((sum, cache) => sum + cache.size, 0),
      beforeLabelChecks: (labelStats[0].nodeChecks || 0) + (labelStats[0].occupiedChecks || 0) + (labelStats[0].indexChecks || 0),
      currentLabelChecks: (labelStats[1].nodeChecks || 0) + (labelStats[1].occupiedChecks || 0) + (labelStats[1].indexChecks || 0),
      currentLabelIndexes: labelStats[1].indexes?.size || 0,
      currentLabelRectangles: labelStats[1].rectangles || 0,
      currentLabelBucketReferences: labelStats[1].references || 0,
      currentLabelOverflow: labelStats[1].overflow || 0,
      beforeRouteMs: median(routeTimes[0]), currentRouteMs: median(routeTimes[1]),
      beforeRoutingStageMs: median(routingStageTimes[0]), currentRoutingStageMs: median(routingStageTimes[1]),
      routeTimes, routingStageTimes, exactPreparedGeometry: true, exactRouteAnchors: true })
  }
  return { ok: true, baseline, validateOnly, warmups: validateOnly ? 0 : 3, trials: validateOnly ? 0 : 9, samples,
    scope: 'Both real generated engines compiled in one realm. Separate fresh engine instances for timing never receive counter proxies or instrumentation. Route-only time includes channel index allocation and excludes lanes and label collision placement; actual prepare stage 2 includes lanes, channels, routes, label index allocation, fixed-width label measurement and actual collision placement. Supplied dimensions and fixed layout exclude real text measurement, layout worker, HTTP, source, React and rendering. Fresh indexes per run; actual node iterations, label intersection calls and bucket references counted outside timing. Scopes are not added. No CI timing threshold.' }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await benchmarkLayeredChannels(process.argv[2] || 'f710ff5', { validateOnly: process.argv.includes('--validate-only') })))
}
