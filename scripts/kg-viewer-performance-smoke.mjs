import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
// Exercise the real pointer-down handler with both enclosing and graph-local dialogs.
const downSource = source.slice(source.indexOf('const onBgPointerDown = (e) => {'), source.indexOf('const onBgPointerMove = (e) => {'))
for (const location of ['ancestor-dialog', 'background', 'local-dialog', 'node', 'edge', 'control']) {
  let captured = false
  const local = !['ancestor-dialog', 'background'].includes(location)
  const match = location === 'background' ? null : {}
  const el = { contains: candidate => candidate === match && local, setPointerCapture: () => { captured = true } }
  const pan = { current: null }
  const noop = () => {}
  const down = new Function('containerRef', 'panRef', 'cancelPress', 'setTooltip', 'setDetail', 'viewScheduler', 'setDragging', downSource + '; return onBgPointerDown')(
    { current: el }, pan, noop, noop, noop, { current: { get: () => ({ tx: 0, ty: 0 }) } }, noop,
  )
  down({ button: 0, pointerId: 1, clientX: 10, clientY: 20, target: { closest: () => match } })
  assert.equal(captured, !local, location + ' must respect the graph interaction boundary')
  assert.equal(Boolean(pan.current), !local)
}
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert(start >= 0, name + ' not found')
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error('Unbalanced function: ' + name)
}
const compile = name => new Function('return (' + extractFunction(source, name) + ')')()
{
  let state = null, effect, cleanup
  let id = 0
  const pending = new Map()
  const scene = () => {}
  const render = new Function('useState', 'useEffect', 'requestAnimationFrame', 'cancelAnimationFrame', 'h', 'GraphScene', 'return (' + extractFunction(source, 'GraphViewer') + ')')(
    () => [state, next => { state = next }], fn => { effect = fn },
    fn => { pending.set(++id, fn); return id }, key => pending.delete(key),
    (type, props, ...children) => ({ type, props, children }), scene,
  )
  const tick = () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn()) }
  const props = { nodes: [], edges: [], layoutMode: 'layered', height: 760 }
  assert.equal(render(props).props.role, 'status', 'Loading must render before expensive scene work')
  cleanup = effect()
  tick()
  assert.equal(state, null, 'First frame must leave a paint opportunity for the indicator')
  tick()
  assert.equal(render(props).type, scene)
  assert.equal(render({ ...props, selectedNodeId: 'a' }).type, scene, 'Selection must not restart loading')
  const changed = { ...props, layoutMode: 'force' }
  assert.equal(render(changed).props['aria-busy'], true)
  cleanup()
  cleanup = effect()
  tick()
  cleanup()
  tick()
  assert.equal(state.layoutMode, 'layered', 'Cancelled layout/unmount must not commit a stale scene')
  assert.equal(pending.size, 0)
}
const schedulerFactory = compile('createGraphViewScheduler')
const zoomAround = new Function('clamp', 'return (' + extractFunction(source, 'zoomAround') + ')')((v, lo, hi) => Math.max(lo, Math.min(hi, v)))
const frames = new Map()
let nextId = 0
const commits = []
const camera = schedulerFactory({ k: 1, tx: 0, ty: 0 }, v => commits.push(v), fn => { const id = nextId++; frames.set(id, fn); return id }, id => frames.delete(id))
for (let i = 0; i < 1000; i++) camera.set(v => ({ ...v, tx: v.tx + 1, ty: v.ty - 2 }))
assert.equal(frames.size, 1, 'High-rate input must schedule exactly one frame, including frame ID zero')
assert.equal(commits.length, 0)
assert.deepEqual(camera.get(), { k: 1, tx: 1000, ty: -2000 }, 'Pending input must accumulate without stale React state')
const [frameId, callback] = frames.entries().next().value
frames.delete(frameId)
callback()
assert.equal(commits.length, 1)
assert.deepEqual(commits[0], camera.get())
camera.set(v => ({ ...v }))
assert.equal(frames.size, 0, 'An identical resize/fit must not repaint the graph')
const anchor = { x: (120 - camera.get().tx) / camera.get().k, y: (80 - camera.get().ty) / camera.get().k }
for (let i = 0; i < 4; i++) camera.set(v => zoomAround(v, 1.1, 120, 80))
assert.equal(frames.size, 1)
assert(Math.abs(camera.get().k - 1.1 ** 4) < 1e-10)
assert(Math.abs((120 - camera.get().tx) / camera.get().k - anchor.x) < 1e-9)
assert(Math.abs((80 - camera.get().ty) / camera.get().k - anchor.y) < 1e-9)
camera.flush()
assert.equal(frames.size, 0)
assert.equal(commits.length, 2, 'Pointer-up must immediately commit the last pending position')
camera.flush()
assert.equal(commits.length, 2)
camera.set(v => ({ ...v, tx: 99 }))
const staleCallback = frames.values().next().value
camera.dispose()
assert.equal(frames.size, 0, 'Unmount must cancel the queued frame')
staleCallback()
camera.set({ k: 1, tx: 5, ty: 5 })
assert.equal(commits.length, 2, 'A disposed callback must never update an unmounted viewer')

const tokenize = text => text.split(/[ \n\t\u3000]+/).filter(Boolean)
const wrap = new Function('tokenize', 'return (' + extractFunction(source, 'wrapText') + ')')(tokenize)
// Exhaustive legacy oracle measures every line before truncating the preview.
function fullWrap(g, text, width) {
  const words = tokenize(text.trim())
  const lines = []
  let line = ''
  for (const word of words) {
    if (g.measureText(word).width > width) {
      if (line) { lines.push(line); line = '' }
      let cur = ''
      for (const ch of word) {
        const test = cur + ch
        if (cur && g.measureText(test).width > width) { lines.push(cur); cur = ch } else cur = test
      }
      if (cur) line = cur
      continue
    }
    const test = line ? line + ' ' + word : word
    if (g.measureText(test).width <= width || !line) line = test
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)
  if (lines.length > 4) { lines.length = 4; lines[3] = lines[3].slice(0, 36) + '\u2026' }
  return lines.length ? lines : ['']
}
let measured = 0
const measurer = { measureText(text) { measured++; return { width: Array.from(text).reduce((n, ch) => n + (ch.codePointAt(0) > 127 ? 13 : 7), 0) } } }
for (const text of ['', '   ', 'one two three', '\u4e2d'.repeat(8000), 'abcdefghij'.repeat(2000), '\ud83d\ude80'.repeat(90), ('Alpha \u4e2d\u6587\tBeta\n').repeat(60)]) {
  for (const width of [1, 42, 162, 900]) assert.deepEqual(wrap(measurer, text, width), fullWrap(measurer, text, width))
}
measured = 0
wrap(measurer, '\u4e2d'.repeat(8000), 162)
assert(measured < 60, 'Preview text measurement must stop after four lines, not scale with hidden text: ' + measured)

const place = compile('placeLayeredEdgeLabel')
function exhaustiveLabel(x, y, w, h, occupied, blocked, index, axis) {
  const candidates = []
  const dxStep = Math.max(w + 8, 30), dyStep = h + 6, direction = index % 2 ? -1 : 1
  for (let i = -Math.floor(180 / dxStep); i <= Math.floor(180 / dxStep); i++) {
    for (let j = -Math.floor(180 / dyStep); j <= Math.floor(180 / dyStep); j++) {
      const dx = i * dxStep, dy = j * dyStep, distance = Math.hypot(dx, dy)
      if (distance > 180.001) continue
      const primary = axis === 'y' ? dy : dx
      candidates.push({ dx, dy, distance, score: distance + (axis === 'y' ? Math.abs(dx) : Math.abs(dy)) * .45 + (primary === 0 || Math.sign(primary) === direction ? 0 : .01) })
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.distance - b.distance || a.dy - b.dy || a.dx - b.dx)
  for (const c of candidates) {
    const cx = x + c.dx, cy = y + c.dy
    const r = { x0: cx - w / 2 - 2, x1: cx + w / 2 + 2, y0: cy - h / 2 - 2, y1: cy + h / 2 + 2 }
    if ([...occupied, ...blocked].some(b => r.x0 < b.x1 && r.x1 > b.x0 && r.y0 < b.y1 && r.y1 > b.y0)) continue
    occupied.push(r)
    return { x: cx, y: cy, hidden: false, distance: c.distance }
  }
  return { x, y, hidden: true, distance: 0 }
}
const blocked = [{ x0: -80, x1: 80, y0: -60, y1: 60 }]
const actualOccupied = [], referenceOccupied = []
for (let i = 0; i < 240; i++) {
  const args = [(i % 4) * 50, (i % 7) * 40, 25 + i % 4 * 13, 15]
  const axis = i % 3 ? 'x' : 'y'
  assert.deepEqual(place(...args, actualOccupied, blocked, i, axis), exhaustiveLabel(...args, referenceOccupied, blocked, i, axis))
}
assert.deepEqual(actualOccupied, referenceOccupied, 'The fast path must not move labels or change collision decisions')
assert(actualOccupied.length < 240, 'The fixture must also exercise exhausted/hidden label placement')
const originalSort = Array.prototype.sort
let sorts = 0
try {
  Array.prototype.sort = function (...args) { sorts++; return originalSort.apply(this, args) }
  const occupied = []
  for (let i = 0; i < 800; i++) place(i * 100, 0, 25, 15, occupied, [], i, 'x')
} finally { Array.prototype.sort = originalSort }
assert.equal(sorts, 0, 'Unobstructed labels must not build/sort a candidate grid')

for (const file of ['lib/client.js', 'extension/viewer.js']) {
  const generated = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  for (const name of ['createGraphViewScheduler', 'wrapText', 'placeLayeredEdgeLabel']) {
    assert.equal(extractFunction(generated, name), extractFunction(source, name), file + ' must contain the optimized implementation')
  }
}
console.log(JSON.stringify({ ok: true, frameCoalescing: true, latestInputPreserved: true, unmountSafe: true, previewMeasurements: measured, labelParity: true, unobstructedLabelSorts: sorts, generatedParity: true }))
