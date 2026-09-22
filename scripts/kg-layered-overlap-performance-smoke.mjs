import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const context = { window: { React: {} }, console }
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { resolveLayeredOverlaps,'), context)
const solve = context.window.KGViewer.resolveLayeredOverlaps

// Frozen all-pairs oracle: retain update order, tie breaks, pinned lanes and
// all 120 relaxation passes while optimizing access to immutable geometry.
function reference(nodes, sizes, pos, gap, pinnedX) {
  for (let iter = 0; iter < 120; iter++) {
    let moved = 0
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id), b = pos.get(nodes[j].id)
        const sa = sizes.get(nodes[i].id), sb = sizes.get(nodes[j].id)
        if (!sa || !sb) continue
        const dx = b.x - a.x, dy = b.y - a.y
        if (Math.abs(dy) > (sa.h + sb.h) / 2 + gap) continue
        const need = (sa.w + sb.w) / 2 + gap
        if (Math.abs(dx) >= need) continue
        const sign = dx === 0 ? ((i + j) % 2 === 0 ? -1 : 1) : dx >= 0 ? 1 : -1
        const overlap = need - Math.abs(dx)
        const aPinned = pinnedX?.has(nodes[i].id), bPinned = pinnedX?.has(nodes[j].id)
        if (aPinned && bPinned) continue
        if (aPinned) b.x += sign * overlap
        else if (bPinned) a.x -= sign * overlap
        else { a.x -= sign * overlap / 2; b.x += sign * overlap / 2 }
        moved++
      }
    }
    if (!moved) break
  }
  return pos
}
const clone = map => new Map(Array.from(map, ([id, p]) => [id, { ...p }]))
let seed = 2048
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
for (let trial = 0; trial < 100; trial++) {
  const nodes = Array.from({ length: trial < 3 ? trial : 3 + Math.floor(random() * 40) }, (_, i) => ({ id: 'n' + i }))
  const sizes = new Map(nodes.map(node => [node.id, { w: 40 + Math.floor(random() * 260), h: 20 + Math.floor(random() * 700) }]))
  const positions = new Map(nodes.map(node => [node.id, { x: trial % 3 === 0 ? 0 : Math.floor(random() * 1000) - 500, y: (Math.floor(random() * 7) - 3) * 240 }]))
  const pinned = new Map(nodes.filter(() => random() < 0.2).map(node => [node.id, positions.get(node.id).x]))
  if (trial % 4 === 0) sizes.delete('n1')
  if (trial >= 60) {
    // Shuffled rows, fractional boundaries and unusually tall rectangles.
    for (const [i, node] of nodes.entries()) {
      sizes.set(node.id, { w: 19.2 + i, h: trial % 2 ? 124.1 : (i === 0 ? 2400 : 0.1) })
      positions.get(node.id).y = (i % 3 - 1) * (trial % 2 ? 142.1 : 18.1) + (i % 5 === 0 ? Number.EPSILON * 256 : 0)
    }
  }
  const before = JSON.stringify({ nodes, sizes: [...sizes], pinned: [...pinned] })
  const expected = reference(nodes, sizes, clone(positions), 18, pinned)
  const actual = clone(positions)
  assert.equal(solve(nodes, sizes, actual, 18, pinned), actual)
  assert.deepEqual([...actual], [...expected], 'exact layout parity for trial ' + trial)
  assert.equal(JSON.stringify({ nodes, sizes: [...sizes], pinned: [...pinned] }), before)
  for (const [id, x] of pinned) assert.equal(actual.get(id).x, x)
  for (const [id, point] of positions) assert.equal(actual.get(id).y, point.y, 'row identity never changes')
}

let geometryReads = 0, yReads = 0
class GeometryMap extends Map { get(id) { geometryReads++; return super.get(id) } }
const nodes = Array.from({ length: 800 }, (_, i) => ({ id: 'dense-' + i }))
const sizes = new GeometryMap(nodes.map(node => [node.id, { w: 194, h: 124 }]))
const positions = new GeometryMap(nodes.map((node, i) => [node.id, { x: 0, get y() { yReads++; return Math.floor(i / 20) * 240 } }]))
const started = performance.now()
solve(nodes, sizes, positions, 18, new Map())
const elapsedMs = Math.round(performance.now() - started)
assert(geometryReads <= nodes.length * 2, 'immutable geometry must be read once per node, not once per pair/pass: ' + geometryReads)
assert(yReads < nodes.length * 20 * 125, 'sparse rows must not scan vertically disjoint pairs on every pass: ' + yReads)

// All nodes on one row must not allocate an unbounded quadratic pair cache.
const denseNodes = Array.from({ length: 180 }, (_, i) => ({ id: 'one-row-' + i }))
const denseSizes = new Map(denseNodes.map(node => [node.id, { w: 100, h: 124 }]))
const densePos = new Map(denseNodes.map(node => [node.id, { x: 0, y: 0 }]))
const expectedDense = reference(denseNodes, denseSizes, clone(densePos), 18, new Map())
runInNewContext('globalThis.pairPushes = 0; const originalPush = Array.prototype.push; Array.prototype.push = function(...items) { pairPushes += items.length; return originalPush.apply(this, items) }', context)
solve(denseNodes, denseSizes, densePos, 18, new Map())
assert.deepEqual([...densePos], [...expectedDense], 'dense fallback retains exact pair update order')
assert(context.pairPushes <= 32 * denseNodes.length, 'pair cache has a linear memory bound: ' + context.pairPushes)
console.log(JSON.stringify({ exactParityCases: 101, variableHeightAndMissingSizes: true, pinnedLanes: true, nodes: nodes.length, geometryReads, yReads, densePairCache: context.pairPushes, elapsedMs }))
