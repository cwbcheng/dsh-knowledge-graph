import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const window = { React: {} }
new Function('window', viewer.replace('window.KGViewer = {', 'window.KGViewer = { graphLayoutWorkerSource,'))(window)
const worker = window.KGViewer.graphLayoutWorkerSource()
const start = worker.indexOf('let left = Math.max(min - 1,')
const end = worker.indexOf('const y = row * LAYER_Y_GAP', start)
assert(start >= 0 && end > start, 'production worker contains lazy nearest-row traversal')
const iteration = worker.slice(start, end)
// Independent exhaustive oracle: the previous sort visits every admissible
// row, ordered by distance then row index. Production must visit the same prefix.
const sorted = `for (const row of Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i)
  .sort((a, b) => Math.abs(a * LAYER_Y_GAP - meanY) - Math.abs(b * LAYER_Y_GAP - meanY) || a - b)) {\n`
const compile = source => new Function('self', source + '\nreturn layoutGraph;')({})
const layout = compile(worker), reference = compile(worker.replace(iteration, sorted))
const visit = new Function('min', 'max', 'meanY', 'limit', 'LAYER_Y_GAP',
  'const visited = []; ' + iteration + 'visited.push(row); if (visited.length >= limit) break; } return visited;')
for (const [min, max] of [[0, 0], [5, 2], [0, 10], [3, 97], [0, 100000]]) {
  for (const mean of [-2000, 0, 120, 240, 360, 720.1, 12000, 25000000]) {
    const expected = Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i)
      .sort((a, b) => Math.abs(a * 240 - mean) - Math.abs(b * 240 - mean) || a - b).slice(0, 12)
    assert.deepEqual(visit(min, max, mean, 12, 240), expected, `nearest rows: ${min}/${max}/${mean}`)
  }
}
let seed = 8712
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
const relations = ['supports', 'analogy', 'contains', 'infers', 'causes', 'example', 'defines', 'aims_at']
for (let trial = 0; trial < 40; trial++) {
  const count = trial < 2 ? trial : trial === 39 ? 800 : 10 + Math.floor(random() * 70)
  const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, type: 'claim' }))
  const sizes = new Map(nodes.map(node => [node.id, { w: 60 + random() * 260, h: 20 + random() * 200 }]))
  const edges = []
  for (let i = 1; i < count; i++) {
    if (i % 9 !== 0) edges.push({ fromNodeId: 'n' + i, toNodeId: 'n' + Math.floor((i - 1) / 4), relation: relations[i % relations.length] })
    if (i % 5 === 0) edges.push({ fromNodeId: 'n' + Math.floor(random() * count), toNodeId: 'n' + i, relation: 'infers' })
  }
  const before = JSON.stringify({ nodes, edges, sizes: [...sizes] })
  const actual = layout(nodes, edges, sizes, 'layered')
  const expected = reference(nodes, edges, sizes, 'layered')
  assert.deepEqual([...actual.pos], [...expected.pos], 'exact full-layout parity for trial ' + trial)
  assert.equal(JSON.stringify({ nodes, edges, sizes: [...sizes] }), before, 'layout does not mutate graph inputs')
}
// Work is bounded by visited rows, not the number of rows in the graph.
let distanceChecks = 0
const measuredMath = { ...Math, max: Math.max, min: Math.min, floor: Math.floor, abs: value => { distanceChecks++; return Math.abs(value) } }
const bounded = new Function('Math', 'min', 'max', 'meanY', 'LAYER_Y_GAP', iteration + 'break; }')
bounded(measuredMath, 0, 1000000, 120000000.1, 240)
assert(distanceChecks <= 2)
console.log(JSON.stringify({ nearestRowCases: 40, fullLayoutParityCases: 40, millionRowDistanceChecks: distanceChecks }))
