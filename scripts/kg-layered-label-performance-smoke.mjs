import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadChannelEngine, countedLabelFunctions, channelFixture, prepareChannelFixture, preparedChannelJSON } from './kg-layered-channel-fixture.mjs'

const engine = loadChannelEngine(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'))
const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
const box = (x0, y0, x1, y1) => ({ x0, x1, y0, y1 })
let seed = 20261009
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
const randomBox = () => {
  const x = Math.floor(random() * 80 - 40) * 128 + (random() - 0.5) / 10
  const y = Math.floor(random() * 80 - 40) * 128 + (random() - 0.5) / 10
  return box(x, y, x + random() * 300, y + random() * 300)
}
const unusual = [
  box(-128, -128, 0, 0), box(0, 0, 128, 128), box(128, 128, 128, 128),
  box(-128.0001, -0.0001, -128, 0), box(-0, -0, 0, 0),
  box(40, 40, -40, -40), box(0, 0, 127, 8191), box(0, 0, 127, 8192),
  box(-1e8, -1e8, 1e8, 1e8), box(-Infinity, -Infinity, Infinity, Infinity),
  box(NaN, 0, 128, 128), box(0, NaN, 128, 128), box(0, 0, NaN, Infinity),
  box(Number.MAX_VALUE, 0, Number.MAX_VALUE, 1),
  box(-Number.MAX_VALUE, -1, Number.MAX_VALUE, 1),
  box(2 ** 60, 0, 2 ** 60 + 1024, 128), box(-(2 ** 60), -128, -(2 ** 60) + 1024, 0),
  box('0', '0', '128', '128'), box(undefined, 0, 128, 128),
]
let differentialQueries = 0
const check = (index, flat, queries) => {
  for (const query of queries) {
    assert.equal(index.intersects(query), flat.some(rect => overlaps(query, rect)), 'Exact strict intersection / overflow fallback')
    differentialQueries++
  }
}
for (const rect of unusual) {
  check(engine.buildLayeredLabelIndex([rect]), [rect], [...unusual,
    box(-256, -256, 256, 256), box(128, 0, 256, 128), box(-256, -128, -128, 0)])
}
const flat = Array.from({ length: 400 }, randomBox), queries = Array.from({ length: 500 }, randomBox)
const index = engine.buildLayeredLabelIndex(flat.slice(0, 200)), incremental = flat.slice(0, 200)
check(index, incremental, [...queries, ...unusual])
for (const rect of [...flat.slice(200), ...unusual]) { index.add(rect); incremental.push(rect) }
check(index, incremental, [...queries, ...unusual])
assert.equal(engine.buildLayeredLabelIndex([]).intersects(box(-1, -1, 1, 1)), false)

// Compare the indexed path with the preserved ordinary-array caller, including
// origins, axes, even/odd ties, dense hiding, negative cells and large widths.
let placements = 0, hidden = 0
for (const blockers of [[], [box(-220, -220, 220, 220)],
  [box(-128, -35, 0, 35), box(128, -35, 256, 35)], unusual]) {
  const expectedOccupied = [], actualOccupied = [], collisions = engine.buildLayeredLabelIndex(blockers)
  for (let edge = 0; edge < 180; edge++) {
    const x = edge % 3 === 0 ? 0 : (edge % 17 - 8) * 128 + (edge % 2 ? 0.001 : 0)
    const y = edge % 3 === 0 ? 0 : (edge % 11 - 5) * 21
    const width = [0, 26, 30, 128, 270, 2000][edge % 6], height = [0, 15, 27][edge % 3]
    const axis = edge % 2 ? 'x' : 'y'
    const expected = engine.placeLayeredEdgeLabel(x, y, width, height, expectedOccupied, blockers, edge, axis)
    const actual = engine.placeLayeredEdgeLabel(x, y, width, height, actualOccupied, blockers, edge, axis, collisions)
    assert.deepEqual(actual, expected, 'Complete placed/hidden label and exact distance/tie ranking')
    assert.deepEqual(actualOccupied, expectedOccupied, 'Only visible labels append their original rectangles')
    placements++; if (actual.hidden) hidden++
  }
}
assert(hidden > 0, 'Density cases must exercise hiding')

// Count real predicate calls and actual bucket storage, with no CI clock limit.
const largeStats = {}, fixture = channelFixture(2000)
const large = await prepareChannelFixture(engine, fixture, { labelStats: largeStats })
assert.equal(largeStats.indexes.size, 1, 'One label index spans the entire scene')
assert.equal(largeStats.calls, 5994)
const visible = [...large.result.layeredEdgeGeometry.values()].filter(label => !label.labelHidden).length
assert.equal(largeStats.rectangles, 2000 + visible, 'Node rectangles and successful visible labels only')
assert.equal(largeStats.overflow || 0, 0)
assert.equal((largeStats.nodeChecks || 0) + (largeStats.occupiedChecks || 0), 0, 'Prepared labels use the actual index')
assert(largeStats.indexChecks < 200000, 'Local checks must avoid the old 84,382,598 full-array comparisons')
assert(largeStats.references <= largeStats.rectangles * 64, 'At most 64 bucket references per rectangle')
assert.equal(largeStats.candidateBuilds, 2, 'Repeated conflicts reuse the two actual spacing/axis/direction templates')
assert.equal(largeStats.candidateObjects, 286, 'Candidate object allocation stays independent of 5994 edges')
assert(largeStats.candidateComparisons > 0 && largeStats.candidateComparisons < 2000, 'Sort only new candidate lists')
const largeIndex = [...largeStats.indexes][0]
assert.equal(largeIndex.candidates.size, 2)
assert.equal([...largeIndex.candidates.values()].reduce((sum, list) => sum + list.length, 0), 286)
const boundedStats = {}, bounded = countedLabelFunctions(engine, boundedStats).buildLayeredLabelIndex([])
for (const rect of unusual) bounded.add(rect)
assert.equal(boundedStats.rectangles, unusual.length)
assert(boundedStats.overflow > 0, 'Large, non-finite, inverted and unsafe-coordinate rectangles use bounded overflow')
assert(boundedStats.references <= (boundedStats.rectangles - boundedStats.overflow) * 64)
check(bounded, unusual, [...queries, ...unusual])

// Offsets are translation-independent; actual rectangles and occupancy still
// decide placement. Exercise keys, normalized spacing, saturation and no-cache
// fallbacks against the preserved direct ordinary-array caller.
let templatePlacements = 0
const blockers = [box(-5000, -5000, 5000, 5000)], rawOccupied = [], indexedOccupied = []
const templates = engine.buildLayeredLabelIndex(blockers)
const compareTemplate = (x, y, width, height, edge, axis) => {
  const old = engine.placeLayeredEdgeLabel(x, y, width, height, rawOccupied, blockers, edge, axis)
  const actual = engine.placeLayeredEdgeLabel(x, y, width, height, indexedOccupied, blockers, edge, axis, templates)
  assert.deepEqual(actual, old, 'Spacing, axis, parity, translation and cache saturation preserve exact placement')
  assert.deepEqual(indexedOccupied, rawOccupied)
  templatePlacements++
}
for (let entry = 0; entry < 24; entry++) compareTemplate(entry * 3.25, -entry * 2.5, 26 + entry, 15, entry, entry % 3 ? 'x' : 'y')
assert.equal(templates.candidates.size, 16, 'Unique configurations cannot grow the per-layout cache beyond 16 lists')
for (const list of templates.candidates.values()) assert(list.length <= 256)
assert([...templates.candidates.values()].reduce((sum, list) => sum + list.length, 0) <= 4096)
const savedTemplates = [...templates.candidates], savedTemplateJSON = JSON.stringify(savedTemplates)
for (let repeat = 0; repeat < 3; repeat++) {
  for (let entry = 0; entry < 24; entry++) compareTemplate(-entry * 7.5, entry * 1.25, 26 + entry, 15, entry, entry % 3 ? 'x' : 'y')
}
assert.equal(JSON.stringify([...templates.candidates]), savedTemplateJSON, 'Hits and full-cache misses must not mutate or evict stored offsets')
for (const [key, list] of savedTemplates) assert.equal(templates.candidates.get(key), list, 'Reuse actual stored list identity')
for (const width of [0, 10, 22, 128.0001, Infinity]) {
  for (const height of [0, 15, '15', Infinity]) for (const axis of ['x', 'y', undefined, 'other']) {
    compareTemplate(-128.25, 0, width, height, templatePlacements % 2, axis)
  }
}
const oversizedTemplates = engine.buildLayeredLabelIndex(blockers)
engine.placeLayeredEdgeLabel(0, 0, 26, 0, [], blockers, 0, 'x', oversizedTemplates)
assert.equal(oversizedTemplates.candidates.size, 0, 'A candidate list over 256 records must not be retained')
const clearTemplates = engine.buildLayeredLabelIndex([])
engine.placeLayeredEdgeLabel(128, 128, 26, 15, [], [], 0, 'x', clearTemplates)
assert.equal(clearTemplates.candidates.size, 0, 'Available origins must not construct or retain candidate templates')

const components = channelFixture(17, { components: 3, varied: true }), firstStats = {}, nextStats = {}
await prepareChannelFixture(engine, components, { labelStats: firstStats })
assert.equal(firstStats.indexes.size, 1, 'Labels avoid rectangles across packed components')
for (const point of components.layout.pos.values()) { point.x += 83.25; point.y += 83.25 }
for (const size of components.sizes.values()) size.h += 27
const changed = await prepareChannelFixture(engine, components, { labelStats: nextStats })
for (const next of nextStats.indexes) assert(!firstStats.indexes.has(next), 'Changed dimensions/positions rebuild the label index')
for (const next of nextStats.indexes) for (const old of firstStats.indexes) assert.notEqual(next.candidates, old.candidates, 'Template maps must belong to one preparation')
for (const cancelAtRoute of [1, 45]) {
  const cancelledStats = {}, retryStats = {}
  await assert.rejects(prepareChannelFixture(engine, components, { labelStats: cancelledStats, cancelAtRoute }), { name: 'AbortError' })
  const retry = await prepareChannelFixture(engine, components, { labelStats: retryStats })
  assert.equal(preparedChannelJSON(retry), preparedChannelJSON(changed), 'Cancellation cannot contaminate a retry')
  for (const next of retryStats.indexes) assert(!cancelledStats.indexes.has(next))
}
for (const mode of ['force', 'overview', 'circular', 'radial', 'neighborhood']) {
  const stats = {}; await prepareChannelFixture(engine, components, { mode, labelStats: stats })
  assert.equal(stats.indexes?.size || 0, 0, 'Other modes must not build a label index')
}
for (const count of [0, 1]) {
  const stats = {}; await prepareChannelFixture(engine, channelFixture(count), { labelStats: stats })
  assert.equal(stats.indexes?.size || 0, 0, 'No valid relations need no label index')
}
for (const path of ['src/index.client.js', 'lib/client.js']) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  for (const name of ['buildLayeredLabelIndex', 'placeLayeredEdgeLabel', 'prepareGraphScene']) assert(source.includes(engine[name].toString()), path + ': generated parity')
}
console.log(JSON.stringify({ ok: true, differentialQueries, placements, hidden, templatePlacements,
  largeNodes: 2000, largeEdges: 5994, actualLabelChecks: largeStats.indexChecks,
  actualRectangles: largeStats.rectangles, actualBucketReferences: largeStats.references,
  actualCandidateBuilds: largeStats.candidateBuilds, actualCandidateObjects: largeStats.candidateObjects,
  actualCandidateComparisons: largeStats.candidateComparisons, boundedTemplateStorage: true,
  boundedOverflow: true, strictBoundaryParity: true, fullSceneIndex: true,
  freshLayoutIndex: true, cancelledRetry: true, otherModeControls: true, generatedParity: true }))
