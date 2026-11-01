// Minimap geometry: world ↔ thumbnail mapping, viewport rectangle clipping.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
const clause = name => (0, eval)('(' + extractFunction(source, name) + ')')
const minimapTransform = clause('minimapTransform')
const worldToMinimap = clause('worldToMinimap')
const minimapToWorld = clause('minimapToWorld')
const minimapViewportRect = new Function('worldToMinimap',
  'return (' + extractFunction(source, 'minimapViewportRect') + ')')(worldToMinimap)

// A wide graph fits by width and is centred vertically.
const wide = minimapTransform({ w: 1000, h: 500, cx: 0, cy: 0 }, 168, 118, 8)
assert(Math.abs(wide.scale - 152 / 1000) < 1e-12, 'wide graphs fit by width: ' + wide.scale)
assert(Math.abs(wide.offsetX - 84) < 1e-9)
assert(Math.abs(wide.offsetY - 59) < 1e-9)
assert(Math.abs(wide.offsetY - (59 - 0 * wide.scale)) < 1e-9)

// A tall graph fits by height.
const tall = minimapTransform({ w: 400, h: 2000, cx: 0, cy: 0 }, 168, 118, 8)
assert(Math.abs(tall.scale - 102 / 2000) < 1e-12, 'tall graphs fit by height: ' + tall.scale)

// Round trip is exact.
for (const [x, y] of [[0, 0], [321, -44], [-500, 250]]) {
  const [mx, my] = worldToMinimap(tall, x, y)
  const back = minimapToWorld(tall, mx, my)
  assert(Math.abs(back.x - x) < 1e-9 && Math.abs(back.y - y) < 1e-9, 'round trip ' + x + ',' + y)
}

// Centre of the bbox lands at the centre of the canvas.
const [cx, cy] = worldToMinimap(wide, 0, 0)
assert(Math.abs(cx - 84) < 1e-9 && Math.abs(cy - 59) < 1e-9, 'graph centre maps to canvas centre')

// Viewport rectangle for a 600x400 window at scale 1 anchored at the origin.
// The world origin maps to the thumbnail centre, so the right/bottom edges clip.
const rect = minimapViewportRect({ k: 1, tx: 0, ty: 0 }, 600, 400, wide, 168, 118)
assert(Math.abs(rect.x - 84) < 1e-6, 'viewport starts at world origin: ' + rect.x)
assert(Math.abs(rect.y - 59) < 1e-6)
assert(Math.abs(rect.w - (168 - 84)) < 1e-6, 'clipped to the thumbnail width: ' + rect.w)
assert(Math.abs(rect.h - (118 - 59)) < 1e-6, 'clipped to the thumbnail height: ' + rect.h)
assert(rect.y + rect.h <= 118 + 1e-6, 'viewport rect is clipped to the canvas')

// An unclipped viewport keeps the exact scale ratio.
const small = minimapViewportRect({ k: 1, tx: 0, ty: 0 }, 200, 100, wide, 168, 118)
assert(Math.abs(small.w - 200 * wide.scale) < 1e-6, 'unclipped width follows the scale: ' + small.w)
assert(Math.abs(small.h - 100 * wide.scale) < 1e-6)

// A zoomed-in camera is clipped to the thumbnail instead of overflowing.
const zoomed = minimapViewportRect({ k: 4, tx: -2000, ty: -1200 }, 600, 400, wide, 168, 118)
assert(zoomed.x >= 0 && zoomed.y >= 0 && zoomed.x + zoomed.w <= 168 + 1e-6 && zoomed.y + zoomed.h <= 118 + 1e-6,
  'zoomed viewport stays inside the thumbnail: ' + JSON.stringify(zoomed))
assert(zoomed.w > 0 && zoomed.h > 0)

// Degenerate camera sizes never produce NaN or negative rectangles.
for (const view of [{ k: 0, tx: 0, ty: 0 }, { k: 1, tx: 10, ty: 10 }]) {
  const degenerate = minimapViewportRect(view, 0, 0, wide, 168, 118)
  assert(Number.isFinite(degenerate.x) && Number.isFinite(degenerate.w) && degenerate.w >= 1 && degenerate.h >= 1)
}

// Generated artifacts stay in sync.
for (const path of ['src/index.client.js', 'lib/client.js', 'extension/viewer.js']) {
  const built = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  for (const name of ['minimapTransform', 'worldToMinimap', 'minimapToWorld', 'minimapViewportRect']) {
    assert(built.includes(extractFunction(source, name)), path + ' is missing ' + name)
  }
}

console.log(JSON.stringify({ ok: true, fitByWidth: true, fitByHeight: true, roundTrip: true,
  viewportClipping: true, degenerateCamera: true, generatedParity: true }))
