import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(label + ': pattern not found')
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(label + ': pattern is not unique')
  return source.slice(0, first) + after + source.slice(first + before.length)
}

const clientPath = 'src/index.client.js'
let client = readFileSync(clientPath, 'utf8')

client = replaceOnce(
  client,
  'function layoutLayered(nodes, edges, sizes) {',
  'function layoutLayered(nodes, edges, sizes, pinnedXOut) {',
  'layoutLayered output pin map',
)

const oldLaneBlock = `        // Keep every substantial reasoning backbone in a stable vertical lane.
        // Shift an entire visual row rather than one node, preserving the row
        // geometry and the existing orthogonal edge-router assumptions.
        const backboneLane = new Map()
        const laneGap = Math.max(LAYER_X_GAP * 2, 360)
        const laneMid = (backbonePaths.length - 1) / 2
        backbonePaths.forEach((path, laneIndex) => {
          const laneX = (laneIndex - laneMid) * laneGap
          for (const id of path) backboneLane.set(id, laneX)
        })
        const rowIds = new Map()
        for (const node of nodes) {
          const p = placed.get(node.id)
          if (!p) continue
          const list = rowIds.get(p.y) || []
          list.push(node.id)
          rowIds.set(p.y, list)
        }
        for (const ids of rowIds.values()) {
          const anchors = ids.filter((id) => backboneLane.has(id))
          if (anchors.length === 0) continue
          const shift = anchors.reduce((sum, id) => {
            const p = placed.get(id)
            return sum + backboneLane.get(id) - p.x
          }, 0) / anchors.length
          for (const id of ids) placed.get(id).x += shift
        }

        // Examples/analogies/definitions/concept branches stay next to the
        // backbone node they explain. They remain ordinary graph nodes; this is
        // only a view projection and resolveLayeredOverlaps handles collisions.
        const branchRelations = new Set(['example', 'counter_example', 'analogy', 'defines', 'is_a', 'contains'])
        const branchCount = new Map()
        for (const edge of edges) {
          if (!edge || !branchRelations.has(edge.relation)) continue
          const fromIsBackbone = backboneLane.has(edge.fromNodeId)
          const toIsBackbone = backboneLane.has(edge.toNodeId)
          if (fromIsBackbone === toIsBackbone) continue
          const targetId = fromIsBackbone ? edge.fromNodeId : edge.toNodeId
          const branchId = fromIsBackbone ? edge.toNodeId : edge.fromNodeId
          const target = placed.get(targetId)
          const branch = placed.get(branchId)
          if (!target || !branch) continue
          const count = branchCount.get(targetId) || 0
          const side = count % 2 === 0 ? -1 : 1
          const ring = Math.floor(count / 2) + 1
          const targetSize = sizes.get(targetId)
          const branchSize = sizes.get(branchId)
          const distance = Math.max(
            LAYER_X_GAP * 0.72,
            ((targetSize ? targetSize.w : 170) + (branchSize ? branchSize.w : 170)) / 2 + 24,
          )
          branch.x = target.x + side * distance * ring
          branchCount.set(targetId, count + 1)
        }
        return placed`

const newLaneBlock = `        // Keep every substantial reasoning backbone in a stable vertical lane.
        // Backbone nodes occupy fixed lane slots; unrelated nodes on the same
        // row are repacked around those slots instead of being dragged with the
        // whole row. This stays view-only and preserves every node's y/rank.
        const backboneLane = new Map()
        const laneGap = Math.max(LAYER_X_GAP * 2, 360)
        const laneMid = (backbonePaths.length - 1) / 2
        backbonePaths.forEach((path, laneIndex) => {
          const laneX = (laneIndex - laneMid) * laneGap
          for (const id of path) backboneLane.set(id, laneX)
        })
        for (const [id, laneX] of backboneLane) {
          const p = placed.get(id)
          if (p) p.x = laneX
        }

        // Examples/analogies/definitions/concept branches stay next to the
        // backbone node they explain. They remain ordinary graph nodes; this is
        // only a view projection and the row pack below handles collisions.
        const branchRelations = new Set(['example', 'counter_example', 'analogy', 'defines', 'is_a', 'contains'])
        const branchCount = new Map()
        for (const edge of edges) {
          if (!edge || !branchRelations.has(edge.relation)) continue
          const fromIsBackbone = backboneLane.has(edge.fromNodeId)
          const toIsBackbone = backboneLane.has(edge.toNodeId)
          if (fromIsBackbone === toIsBackbone) continue
          const targetId = fromIsBackbone ? edge.fromNodeId : edge.toNodeId
          const branchId = fromIsBackbone ? edge.toNodeId : edge.fromNodeId
          const target = placed.get(targetId)
          const branch = placed.get(branchId)
          if (!target || !branch) continue
          const count = branchCount.get(targetId) || 0
          const side = count % 2 === 0 ? -1 : 1
          const ring = Math.floor(count / 2) + 1
          const targetSize = sizes.get(targetId)
          const branchSize = sizes.get(branchId)
          const distance = Math.max(
            LAYER_X_GAP * 0.72,
            ((targetSize ? targetSize.w : 170) + (branchSize ? branchSize.w : 170)) / 2 + 24,
          )
          branch.x = target.x + side * distance * ring
          branchCount.set(targetId, count + 1)
        }

        // Repack only rows that contain a backbone anchor. Pinned lane slots
        // never move; every other node keeps the nearest collision-free x to
        // its existing placement. Rows with no backbone keep the old layout.
        const rowIds = new Map()
        for (const node of nodes) {
          const p = placed.get(node.id)
          if (!p) continue
          const list = rowIds.get(p.y) || []
          list.push(node.id)
          rowIds.set(p.y, list)
        }
        const rowGap = 18
        for (const ids of rowIds.values()) {
          const anchors = ids.filter((id) => backboneLane.has(id))
          if (anchors.length === 0) continue
          const occupied = []
          anchors.sort((a, b) => backboneLane.get(a) - backboneLane.get(b) || String(a).localeCompare(String(b)))
          for (const id of anchors) {
            const p = placed.get(id)
            const s = sizes.get(id)
            const half = (s ? s.w : 170) / 2
            p.x = backboneLane.get(id)
            occupied.push({ left: p.x - half, right: p.x + half })
          }
          occupied.sort((a, b) => a.left - b.left)
          const others = ids
            .filter((id) => !backboneLane.has(id))
            .sort((a, b) => placed.get(a).x - placed.get(b).x || String(a).localeCompare(String(b)))
          for (const id of others) {
            const p = placed.get(id)
            const s = sizes.get(id)
            const half = (s ? s.w : 170) / 2
            const preferred = p.x
            const candidates = [preferred]
            for (const slot of occupied) {
              candidates.push(slot.left - rowGap - half)
              candidates.push(slot.right + rowGap + half)
            }
            candidates.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b)
            const fits = (x) => occupied.every((slot) => x + half + rowGap <= slot.left || x - half - rowGap >= slot.right)
            let chosen = candidates.find((x) => fits(x))
            if (chosen == null) {
              const right = occupied.reduce((max, slot) => Math.max(max, slot.right), preferred)
              chosen = right + rowGap + half
            }
            p.x = chosen
            occupied.push({ left: chosen - half, right: chosen + half })
            occupied.sort((a, b) => a.left - b.left)
          }
        }
        if (pinnedXOut && typeof pinnedXOut.set === 'function') {
          if (typeof pinnedXOut.clear === 'function') pinnedXOut.clear()
          for (const [id, laneX] of backboneLane) if (placed.has(id)) pinnedXOut.set(id, laneX)
        }
        return placed`

client = replaceOnce(client, oldLaneBlock, newLaneBlock, 'fixed lane slots')

client = replaceOnce(
  client,
  'function resolveLayeredOverlaps(nodes, sizes, pos, gap) {',
  'function resolveLayeredOverlaps(nodes, sizes, pos, gap, pinnedX) {',
  'pinned layered overlap signature',
)

const oldMove = `              const push = (need - Math.abs(dx)) / 2
              a.x -= s * push
              b.x += s * push
              moved += 1`
const newMove = `              const overlap = need - Math.abs(dx)
              const aPinned = pinnedX && typeof pinnedX.has === 'function' && pinnedX.has(ids[i])
              const bPinned = pinnedX && typeof pinnedX.has === 'function' && pinnedX.has(ids[j])
              if (aPinned && bPinned) continue
              if (aPinned) b.x += s * overlap
              else if (bPinned) a.x -= s * overlap
              else {
                const push = overlap / 2
                a.x -= s * push
                b.x += s * push
              }
              moved += 1`
client = replaceOnce(client, oldMove, newMove, 'pinned layered overlap movement')

client = replaceOnce(
  client,
  `          return { pos: resolveLayeredOverlaps(nodes, sizes, layoutLayered(nodes, edges, sizes), 18) }`,
  `          const pinnedX = new Map()
          const pos = layoutLayered(nodes, edges, sizes, pinnedX)
          return { pos: resolveLayeredOverlaps(nodes, sizes, pos, 18, pinnedX) }`,
  'layered dispatcher pins',
)

writeFileSync(clientPath, client)

const test = `import { readFileSync } from 'node:fs'
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
const nodes = ['a','b','c','d','e','x','p','q'].map((id) => ({ id }))
const edges = [
  { fromNodeId: 'a', toNodeId: 'b', relation: 'causes' },
  { fromNodeId: 'b', toNodeId: 'c', relation: 'causes' },
  { fromNodeId: 'c', toNodeId: 'd', relation: 'causes' },
  { fromNodeId: 'd', toNodeId: 'e', relation: 'causes' },
  { fromNodeId: 'x', toNodeId: 'c', relation: 'analogy' },
  { fromNodeId: 'p', toNodeId: 'q', relation: 'supports' },
]
const sizes = new Map(nodes.map((node) => [node.id, { w: node.id === 'q' ? 218 : 170, h: 72 }]))
const pinnedX = new Map()
const rawPos = layoutLayered(nodes, edges, sizes, pinnedX)
const pos = resolveLayeredOverlaps(nodes, sizes, rawPos, 18, pinnedX)
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
assert(!layeredSource.includes('Shift an entire visual row rather than one node'), 'whole-row lane shifting is still present')
assert(layeredSource.includes('backbone nodes occupy fixed lane slots') || layeredSource.includes('Backbone nodes occupy fixed lane slots'), 'fixed lane-slot projection is missing')
assert(source.includes("const reasoningRelations = new Set(['causes', 'infers'])"), 'relation-aware layered backbone is missing')
assert(source.includes("return 'layered'"), 'new sessions do not default to the semantic layered projection')
console.log(JSON.stringify({ ok: true, chain: ['a','b','c','d','e'].map((id) => ({ id, ...pos.get(id) })), satellite: pos.get('x'), peer: pos.get('q') }))
`
writeFileSync('scripts/kg-semantic-layout-smoke.mjs', test)
console.log(JSON.stringify({ ok: true, changed: [clientPath, 'scripts/kg-semantic-layout-smoke.mjs'] }))
