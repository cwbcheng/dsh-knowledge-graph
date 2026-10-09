import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { loadChannelEngine, channelFixture, channelRegressionFixtures, prepareChannelFixture, preparedChannelJSON } from './kg-layered-channel-fixture.mjs'

const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const engine = loadChannelEngine(viewer)
// Frozen BEFORE the optimization from main f710ff5: complete sizes, positions,
// bounds, lane allocation, path bytes and placed/hidden label geometry. No Git
// history or reference regenerated from the candidate is needed in CI.
const frozen = {
  empty: ['a2661344f5e95fe618bd905a38879f9e2962e829cb211c6e2c9ba1295439c17a', 'a2661344f5e95fe618bd905a38879f9e2962e829cb211c6e2c9ba1295439c17a'],
  single: ['5a5d3d2d6191a0bb59f69d6a0c455ffd295ff33364f65b664ed8ea88dd608394', '5a5d3d2d6191a0bb59f69d6a0c455ffd295ff33364f65b664ed8ea88dd608394'],
  'grid-4': ['dd5c68484cd56fc7e30c1a89c93dd751e3316ea1a68ddd95a47339d8d078b1d1', 'dc03b4abc078de56586a8c719a25930782b1fc0f4a3cb0e80b04bcc76b60f8ea'],
  'grid-65': ['7dc9705f9b29465e50b8ccceed869e7474a1746edbfc08c9981322bab6aa3d46', '5d705d737960bc693846cff25eaff970360daad80aaf3069137fa7e8628b54d9'],
  'grid-205': ['002f6b783495e4d8d5ceaf62c120856cafa8c056122f061b3cf9f5343bed4315', '45bc0c59015df1c3eca5711a967d6d574232bee98c46d21c9ebda5f1626190c0'],
  varied: ['edf5e3a87e28914a722057c304776984f7cf6a553d97c272dfb6eb4541992f44', '289ea3f39aec9e22891a8cbd791b4d8c8c66fc593c2c7737ac15fc36e568f27e'],
  components: ['1ea5444d9d287c745ae5b01b1cf9f5c85d04341ba0c56e630b3ba44febeab2a1', 'b745c34faf5088d573b0c25b59b603624ba69b9f5c54176d361c253ae810bd19'],
  fallback: ['91dcee2a940df9e740e37b071e2c3abc3095869ad58216d40ccb62c23af5f026', 'b745c34faf5088d573b0c25b59b603624ba69b9f5c54176d361c253ae810bd19'],
  shifted: ['c931859b74800f3fd819040e0705803c4636bc5dec14db5da7504047d1642170', 'e5cb0a8b2f024c2fc4f3103ed7826c77417330f05191c4100cbf1ab3e4e7bfa0'],
  'missing-size': ['170320afdceb1beca9f1d84b5ed457933650c99b08fe10f44c3dcadfb3109b58', '453d0fe10b827b681ad8b5e72060c645cbdaa3d8bb6b0b1ad86c96b0d81c7787'],
  'partial-components': ['613af385f7fcdff4d82c54df031d1ac0244df72c2662a19c7355f17e7aca4cef', 'b745c34faf5088d573b0c25b59b603624ba69b9f5c54176d361c253ae810bd19'],
}
const sha = prepared => createHash('sha256').update(preparedChannelJSON(prepared)).digest('hex')
let cases = 0, componentStats
const fixtureJSON = fixture => JSON.stringify({ nodes: fixture.nodes, edges: fixture.edges,
  sizes: [...fixture.sizes], pos: [...fixture.layout.pos],
  componentKeys: [...(fixture.layout.componentKeyById || [])],
  componentNodes: [...(fixture.layout.componentNodesById || [])] })
for (const [name, fixture] of channelRegressionFixtures()) {
  const original = fixtureJSON(fixture)
  for (const mode of ['layered', 'overview', 'force', 'circular', 'radial', 'neighborhood']) {
    const stats = {}, prepared = await prepareChannelFixture(engine, fixture, { mode, stats })
    assert.equal(sha(prepared), frozen[name][mode === 'layered' ? 0 : 1], name + '/' + mode + ': frozen complete geometry')
    assert.deepEqual([...new Set(prepared.progress.map(item => item.stage))], [0, 1, 2, 3])
    if (mode !== 'layered') {
      assert.equal(stats.bandCalls || 0, 0, 'Other layout modes must not calculate channel bands')
      assert.equal(stats.indexNodeVisits || 0, 0, 'Other layout modes must not build a channel index')
    }
    if (name === 'components' && mode === 'layered') componentStats = stats
    assert.equal(fixtureJSON(fixture), original, 'Preparation must not mutate graph data, dimensions or layout')
    cases++
  }
}
assert.equal(componentStats.caches.size, 3, 'Same rounded rows in three components need separate bands')
assert.equal(componentStats.bandNodeVisits || 0, 0, 'Component channels must use indexed row bounds')
const largeStats = {}
await prepareChannelFixture(engine, channelFixture(2000), { stats: largeStats })
assert.equal(largeStats.indexNodeVisits, 2000, 'Row bounds and highest row share one actual component scan')
assert.equal(largeStats.bandNodeVisits || 0, 0, 'Indexed channel lookup must not rescan nodes')
assert.equal(largeStats.maxRowNodeVisits || 0, 0, 'Same-row edges must not rescan the highest row')
assert.equal([...largeStats.caches][0].size, 499, 'Only requested rows may occupy channel entries')
assert.equal([...largeStats.indexes][0].rows.size, 500, 'Only actual rows may occupy the bounds index')
assert.equal(componentStats.indexNodeVisits, 51, 'Every exact component must be scanned once')

// Reuse the very same graph, positions and component arrays for a subsequent
// prepare: there must be no channel maps surviving the prior preparation.
const fixture = channelFixture(17, { components: 3, varied: true }), firstStats = {}, nextStats = {}
await prepareChannelFixture(engine, fixture, { stats: firstStats })
for (const point of fixture.layout.pos.values()) { point.x += 83.25; point.y += 83.25 }
assert.equal(sha(await prepareChannelFixture(engine, fixture, { stats: nextStats })), frozen.shifted[0])
for (const cache of nextStats.caches) assert(!firstStats.caches.has(cache), 'Channel maps must be scoped to one prepare')
for (const size of fixture.sizes.values()) size.h += 27
const changed = await prepareChannelFixture(engine, fixture)
assert.notEqual(sha(changed), frozen.shifted[0], 'Updated dimensions must affect routes')
assert.equal(preparedChannelJSON(changed), preparedChannelJSON(await prepareChannelFixture(engine, fixture)), 'Repeated updated scene is deterministic')
for (const cancelAtRoute of [1, 45]) {
  await assert.rejects(prepareChannelFixture(engine, fixture, { cancelAtRoute }), { name: 'AbortError' })
  assert.equal(preparedChannelJSON(await prepareChannelFixture(engine, fixture)), preparedChannelJSON(changed), 'Cancelled routing must not contaminate retry')
}

// Explicit band bounds keep empty rows, missing dimensions and inverted bands
// readable beside the full-scene golden hashes.
const nodes = [{ id: 'a' }, { id: 'b' }], pos = new Map([['a', { x: 0, y: 0 }], ['b', { x: 0, y: 240 }]])
const indexedBand = (row, group, dimensions, points) => engine.channelBand(row, group, dimensions, points,
  engine.buildLayeredChannelIndex(group, dimensions, points))
assert.deepEqual(indexedBand(0, [], new Map(), new Map()), [124, 356])
assert.deepEqual(indexedBand(0, nodes, new Map(), pos), [44, 196])
assert.deepEqual(indexedBand(0, nodes, new Map([['a', { h: 520 }], ['b', { h: 70 }]]), pos), [232.5, 232.5])
const broken = new Map(pos); broken.delete('b')
assert.throws(() => engine.buildLayeredChannelIndex(nodes, new Map(), broken), TypeError)
assert.deepEqual(indexedBand(0, nodes, new Map(), pos), [44, 196], 'A failed index must not affect a subsequent calculation')
// Preserve strict-row and non-finite fallback behavior, including NaN row
// keys (Map uses a different equality rule than the original comparisons).
for (const y of [NaN, Infinity, -Infinity, -0, -240.25, 119.9, 120.1]) {
  const unusual = new Map(pos); unusual.set('b', { x: 0, y })
  for (const h of [NaN, Infinity, -Infinity, undefined, 0, 520]) {
    const dimensions = new Map([['b', { h }]])
    for (const row of [NaN, Infinity, -Infinity, -2, -1, 0, 1, 4]) {
      assert.deepEqual(indexedBand(row, nodes, dimensions, unusual), engine.channelBand(row, nodes, dimensions, unusual), 'Exact non-finite and missing-row band fallback')
    }
    const edge = { fromNodeId: 'a', toNodeId: 'a' }
    assert.deepEqual(engine.layeredOrthoPath(edge, pos.get('a'), pos.get('a'), dimensions, unusual, nodes, 0,
      engine.buildLayeredChannelIndex(nodes, dimensions, unusual)), engine.layeredOrthoPath(edge, pos.get('a'), pos.get('a'), dimensions, unusual, nodes, 0), 'Exact highest-row fallback')
  }
}
for (const path of ['src/index.client.js', 'lib/client.js']) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  for (const name of ['prepareGraphScene', 'buildLayeredChannelIndex', 'channelBand', 'layeredOrthoPath']) assert(source.includes(engine[name].toString()), path + ': generated ' + name + ' parity')
}
console.log(JSON.stringify({ ok: true, frozenScenes: cases, sameRowComponentIsolation: true,
  bandCalls: componentStats.bandCalls, bandNodeVisits: componentStats.bandNodeVisits || 0,
  largeNodes: 2000, largeIndexNodeVisits: largeStats.indexNodeVisits, largeBandNodeVisits: largeStats.bandNodeVisits || 0,
  largeMaxRowNodeVisits: largeStats.maxRowNodeVisits || 0, nonFiniteFallback: true,
  freshPreparationMaps: true, changedDimensions: true, cancelledRetry: true, generatedParity: true }))
