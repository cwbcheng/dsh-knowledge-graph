import { readFileSync } from 'node:fs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error(name + ' not found')
  const brace = source.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(name + ' is not balanced')
}

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const functionText = extractFunction(source, 'packDisconnectedComponents')
const packDisconnectedComponents = (0, eval)('(' + functionText + ')')
const intersectDist = (0, eval)('(' + extractFunction(source, 'intersectDist') + ')')
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const bezierGeometry = new Function('intersectDist', 'clamp', 'return (' + extractFunction(source, 'bezierGeometry') + ')')(intersectDist, clamp)

const nodes = Array.from({ length: 12 }, (_, index) => ({ id: 'n' + index }))
const edges = [{ fromNodeId: 'n0', toNodeId: 'n1', relation: 'supports' }]
const sizes = new Map(nodes.map((node, index) => [node.id, { w: index % 3 === 0 ? 190 : 150, h: index % 2 === 0 ? 82 : 70 }]))
const pos = new Map()
pos.set('n0', { x: 0, y: 0 })
pos.set('n1', { x: 210, y: 0 })
for (let index = 2; index < nodes.length; index++) pos.set('n' + index, { x: 900 + index * 430, y: (index % 2) * 600 })

function bounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const node of nodes) {
    const p = pos.get(node.id)
    const s = sizes.get(node.id)
    x0 = Math.min(x0, p.x - s.w / 2)
    y0 = Math.min(y0, p.y - s.h / 2)
    x1 = Math.max(x1, p.x + s.w / 2)
    y1 = Math.max(y1, p.y + s.h / 2)
  }
  return { w: x1 - x0, h: y1 - y0 }
}

const before = bounds()
packDisconnectedComponents(nodes, edges, sizes, pos, 38)
const after = bounds()
assert(after.w < before.w * 0.45, 'component packing did not substantially reduce graph width: ' + JSON.stringify({ before, after }))
assert(after.h < before.h * 1.5, 'component packing created excessive height: ' + JSON.stringify({ before, after }))

// Boxes belonging to different connected components must remain separated.
const componentOf = new Map(nodes.map((node, index) => [node.id, index < 2 ? 0 : index - 1]))
for (let i = 0; i < nodes.length; i++) {
  for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i]
    const b = nodes[j]
    if (componentOf.get(a.id) === componentOf.get(b.id)) continue
    const pa = pos.get(a.id), pb = pos.get(b.id)
    const sa = sizes.get(a.id), sb = sizes.get(b.id)
    const overlapX = Math.abs(pa.x - pb.x) < (sa.w + sb.w) / 2
    const overlapY = Math.abs(pa.y - pb.y) < (sa.h + sb.h) / 2
    assert(!(overlapX && overlapY), 'packed components overlap: ' + a.id + ' / ' + b.id)
  }
}

// Curved and straight arrows must start/end exactly on their rectangle borders.
const a = { x: 0, y: 0 }
const b = { x: 400, y: 120 }
const sa = { w: 180, h: 80 }
const sb = { w: 150, h: 100 }
const curved = bezierGeometry(a, b, sa, sb, 2)
const boundaryRatio = (point, center, size) => Math.max(Math.abs(point.x - center.x) / (size.w / 2), Math.abs(point.y - center.y) / (size.h / 2))
assert(Math.abs(boundaryRatio({ x: curved.x1, y: curved.y1 }, a, sa) - 1) < 1e-9, 'curved edge source does not touch the node border: ' + JSON.stringify(curved))
assert(Math.abs(boundaryRatio({ x: curved.x2, y: curved.y2 }, b, sb) - 1) < 1e-9, 'curved edge target does not touch the node border: ' + JSON.stringify(curved))
const sourceCross = (curved.x1 - a.x) * (curved.cy - curved.y1) - (curved.y1 - a.y) * (curved.cx - curved.x1)
const targetCross = (curved.x2 - b.x) * (curved.y2 - curved.cy) - (curved.y2 - b.y) * (curved.x2 - curved.cx)
assert(Math.abs(sourceCross) < 1e-7 && Math.abs(targetCross) < 1e-7, 'bezier endpoint tangents are not aligned with border clipping')
const straight = bezierGeometry({ x: 0, y: 0 }, { x: 400, y: 0 }, { w: 180, h: 80 }, { w: 180, h: 80 }, 0)
assert(Math.abs(straight.x1 - 90) < 1e-9 && Math.abs(straight.x2 - 310) < 1e-9, 'straight edge retained a border gap: ' + JSON.stringify(straight))

assert(source.includes("(simDegree.get(d.id) || 0) === 0 ? -70 : -280"), 'isolated-node charge reduction is missing')
assert(source.includes('Math.sqrt(s.w * s.h) * 0.5 + 10'), 'area-based collision radius is missing')

console.log(JSON.stringify({ ok: true, before, after, components: 11 }))
