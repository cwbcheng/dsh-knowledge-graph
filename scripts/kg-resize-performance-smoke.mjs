import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
function section(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, 'production implementation must be present')
  return source.slice(from, to)
}
const createDrag = new Function(section('function createGeometryDrag(', 'function useGeometryDrag(') + '; return createGeometryDrag')()

class Target extends EventTarget {
  listeners = new Map()
  attrs = new Set()
  capture = null
  addEventListener(type, fn) {
    super.addEventListener(type, fn)
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) { super.removeEventListener(type, fn); this.listeners.get(type)?.delete(fn) }
  setAttribute(key) { this.attrs.add(key) }
  removeAttribute(key) { this.attrs.delete(key) }
  setPointerCapture(id) { this.capture = id }
  hasPointerCapture(id) { return this.capture === id }
  releasePointerCapture() { this.capture = null }
  get listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0) }
}
function pointer(type, extras = {}) { return Object.assign(new Event(type), { pointerId: 1, clientX: 10, clientY: 20, ...extras }) }
function harness() {
  const doc = new Target(), target = new Target(), surface = new Target()
  doc.defaultView = new Target()
  target.ownerDocument = doc
  const frames = new Map(), previews = [], commits = []
  let id = 0, prepared = 0, released = 0, settled = 0
  const drag = createDrag(fn => { const key = id++; frames.set(key, fn); return key }, key => frames.delete(key))
  surface.addEventListener('kg-geometry-settled', () => settled++)
  const options = {
    surface, initial: 100, project: (dx, dy) => 100 + dx + dy,
    preview: value => previews.push(value), commit: value => commits.push(value),
    preparePreview: () => { prepared++; return () => released++ },
  }
  const start = (extra = {}, override = {}) => drag.start({ currentTarget: target, pointerId: 1, clientX: 10, clientY: 20,
    pointerType: 'mouse', button: 0, isPrimary: true, preventDefault() {}, stopPropagation() {}, ...extra }, { ...options, ...override })
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()) }
  const clean = () => {
    assert.equal(doc.listenerCount + doc.defaultView.listenerCount + target.listenerCount, 0)
    assert.equal(frames.size, 0)
    assert.equal(target.capture, null)
    assert.equal(surface.attrs.size, 0)
    assert.equal(prepared, released)
  }
  return { drag, doc, target, surface, frames, previews, commits, start, flush, clean, get settled() { return settled } }
}

// A high-rate drag performs no state/storage writes until pointerup, even when
// its final coordinate was never delivered by pointermove or animation frame.
{
  const t = harness()
  t.start()
  for (let i = 1; i <= 1000; i++) t.doc.dispatchEvent(pointer('pointermove', { clientX: 10 + i }))
  assert.equal(t.frames.size, 1, 'frame id 0 must also be treated as pending')
  assert.deepEqual(t.previews, [])
  assert.deepEqual(t.commits, [])
  t.flush()
  assert.deepEqual(t.previews, [1100])
  t.doc.dispatchEvent(pointer('pointermove', { pointerId: 2, clientX: 9000 }))
  t.doc.dispatchEvent(pointer('pointerup', { pointerId: 2 }))
  assert.deepEqual(t.commits, [])
  t.doc.dispatchEvent(pointer('pointerup', { clientX: 1012, clientY: 25 }))
  assert.deepEqual(t.commits, [1107])
  assert.equal(t.settled, 1)
  t.clean()
  t.start()
  t.doc.dispatchEvent(pointer('pointerup', { clientX: 60 }))
  assert.deepEqual(t.commits, [1107, 150], 'repeat drags must remain usable')
  t.clean()
}

for (const reason of ['pointercancel', 'lostpointercapture', 'blur', 'unmount']) {
  const t = harness()
  t.start()
  t.doc.dispatchEvent(pointer('pointermove', { clientX: 500 }))
  const staleFrame = [...t.frames.values()][0]
  if (reason === 'blur') t.doc.defaultView.dispatchEvent(new Event('blur'))
  else if (reason === 'unmount') t.drag.cancel()
  else (reason === 'lostpointercapture' ? t.target : t.doc).dispatchEvent(pointer(reason))
  assert.deepEqual(t.previews, [100], reason + ' restores original geometry')
  assert.deepEqual(t.commits, [], reason + ' does not persist partial geometry')
  t.clean()
  t.start()
  t.doc.dispatchEvent(pointer('pointermove', { clientX: 80 }))
  staleFrame()
  assert.deepEqual(t.previews, [100], 'cancelled callbacks cannot touch a later gesture')
  t.flush()
  assert.equal(t.previews.at(-1), 170)
  t.drag.cancel()
  t.clean()
}
{
  const t = harness()
  t.start({ button: 2 })
  t.start({ isPrimary: false })
  assert.equal(t.doc.listenerCount, 0)
  t.start({}, { resize: false })
  t.doc.dispatchEvent(pointer('pointerup'))
  assert.equal(t.settled, 0, 'moving the window must not reset the camera')
  t.clean()
}

// Exercise the shared column/height hook with both existing storage namespaces.
for (const prefix of ['dsh-kg', 'dsh-kg-trajectory']) {
  const t = harness(), values = new Map(), saved = new Map(), state = []
  const style = { gridTemplateColumns: '', setProperty: (k, v) => values.set(k, v), removeProperty: k => values.delete(k) }
  const svg = { style: { width: '', height: '' }, getBoundingClientRect: () => ({ width: 588, height: 560 }) }
  const original = { style: { width: '', clipPath: '', maxHeight: '560px' },
    getBoundingClientRect: () => ({ width: 400 }), matches: () => true }
  const graph = { style: { height: '560px' }, matches: () => false }
  Object.assign(t.surface, { clientWidth: 1000, style,
    querySelector: selector => selector === '.kg-original, .kg-traj-original' ? original : svg,
    querySelectorAll: () => [original, graph] })
  const useResultGeometry = new Function('useGeometryDrag', 'clamp', 'localStorage',
    section('function useResultGeometry(', 'function WindowInner(') + '; return useResultGeometry')(
    () => t.drag, (n, lo, hi) => Math.max(lo, Math.min(hi, n)), { setItem: (k, v) => saved.set(k, v) })
  const props = { colsRef: { current: t.surface }, splitRatio: 46, resultHeight: 560,
    setSplitRatio: n => state.push(n), setResultHeight: n => state.push(n),
    splitKey: prefix + '-split-v1', heightKey: prefix + '-height-v1' }
  const handlers = useResultGeometry(props)
  const event = { currentTarget: t.target, pointerId: 1, clientX: 10, clientY: 20,
    pointerType: 'mouse', button: 0, preventDefault() {}, stopPropagation() {} }
  handlers.startSplitDrag(event)
  t.doc.dispatchEvent(pointer('pointermove', { clientX: 110 }))
  t.flush()
  assert.equal(style.gridTemplateColumns, 'minmax(240px, 56%) 12px minmax(0, 1fr)')
  assert.equal(original.style.width, '400px')
  assert.equal(values.size, 0, 'preview must not invalidate inherited custom properties')
  assert.deepEqual(svg.style, { width: '588px', height: '560px' })
  assert.equal(saved.size, 0)
  t.doc.dispatchEvent(pointer('pointerup', { clientX: 150 }))
  assert.equal(saved.get(props.splitKey), '60')
  assert.equal(style.gridTemplateColumns, '')
  assert.equal(original.style.width, '')
  assert.equal(original.style.clipPath, '')
  assert.deepEqual(svg.style, { width: '', height: '' })
  handlers.startHDrag(event)
  t.doc.dispatchEvent(pointer('pointermove', { clientY: 120 }))
  t.flush()
  assert.equal(graph.style.height, '660px')
  assert.equal(original.style.maxHeight, '660px')
  t.doc.dispatchEvent(pointer('pointerup', { clientY: 220 }))
  assert.equal(saved.get(props.heightKey), '760')
  assert.equal(graph.style.height, '560px')
  assert.equal(original.style.maxHeight, '560px')
  handlers.startSplitDrag(event)
  t.doc.dispatchEvent(pointer('pointerup', { clientX: 9000 }))
  assert.equal(saved.get(props.splitKey), '70')
  handlers.startHDrag(event)
  t.doc.dispatchEvent(pointer('pointerup', { clientY: -9000 }))
  assert.equal(saved.get(props.heightKey), '320')
  assert.deepEqual(state, [60, 760, 70, 320])
  t.clean()
}

// Run the actual observer effect. A deliberate slow drag must not repeatedly
// move the camera, and the trailing ResizeObserver delivery must not move twice.
{
  const doc = new Target(), surface = new Target(), timers = new Set()
  let resizing = true, fitCount = 0, observer, cleanup, camera = { k: 0.8, tx: 100, ty: 120 }
  const el = { clientWidth: 600, clientHeight: 560, ownerDocument: doc, closest: () => resizing ? surface : null }
  const viewportSizeRef = { current: { width: 600, height: 560 } }, pendingFocusRef = { current: null }
  surface.contains = candidate => candidate === el
  class Observer {
    constructor(fn) { this.callback = fn; observer = this }
    observe(target) { assert.equal(target, el) }
    disconnect() { this.disconnected = true }
  }
  const effect = section('// Resize previews change CSS only.', '// Focus a node (paragraph click -> graph).')
  new Function('useEffect', 'containerRef', 'ResizeObserver', 'ctx', 'fitView', 'setView', 'viewportSizeRef', 'pendingFocusRef', effect)(fn => { cleanup = fn() }, { current: el }, Observer,
    { timeout: fn => { timers.add(fn); return () => timers.delete(fn) } }, () => assert.fail('resize must not reset zoom or location'),
    update => { camera = update(camera); fitCount++ }, viewportSizeRef, pendingFocusRef)
  const tick = () => { for (const fn of [...timers]) { timers.delete(fn); fn() } }
  for (let i = 0; i < 20; i++) { el.clientWidth++; observer.callback(); tick() }
  assert.equal(fitCount, 0)
  const settled = new Event('kg-geometry-settled')
  Object.defineProperty(settled, 'target', { value: surface })
  resizing = false
  doc.dispatchEvent(settled)
  assert.equal(fitCount, 1)
  assert.deepEqual(camera, { k: 0.8, tx: 110, ty: 120 })
  observer.callback(); tick()
  assert.equal(fitCount, 1)
  const unrelated = new Event('kg-geometry-settled')
  Object.defineProperty(unrelated, 'target', { value: { contains: () => false } })
  el.clientHeight++
  doc.dispatchEvent(unrelated)
  assert.equal(fitCount, 1)
  observer.callback(); tick()
  assert.equal(fitCount, 2, 'ordinary responsive resizing still fits')
  el.clientWidth = 0; el.clientHeight = 0
  observer.callback(); tick()
  assert.equal(fitCount, 2, 'a hidden workspace must not translate the camera toward zero dimensions')
  el.clientWidth = 360; el.clientHeight = 560
  observer.callback(); tick()
  assert.deepEqual(camera, { k: 0.8, tx: -20, ty: 120 }, 'revealing in a narrower viewport preserves the original graph center')
  assert.equal(fitCount, 3)
  pendingFocusRef.current = () => {
    viewportSizeRef.current = { width: el.clientWidth, height: el.clientHeight }
    camera = { k: 0.8, tx: 42, ty: 43 }
    pendingFocusRef.current = null
  }
  el.clientWidth = 800
  observer.callback(); tick()
  assert.deepEqual(camera, { k: 0.8, tx: 42, ty: 43 }, 'deferred node focus takes precedence over resize translation')
  observer.callback(); tick()
  assert.equal(fitCount, 3, 'observer after focus does not add a second camera offset')
  observer.callback(); cleanup(); tick()
  assert.equal(fitCount, 3)
  assert.equal(observer.disconnected, true)
  assert.equal(doc.listenerCount, 0)
}
// A persisted wide window must remain wholly reachable at medium widths, not
// merely have scrollWidth === clientWidth inside an off-screen frame.
{
  const viewport = new Target()
  viewport.innerWidth = 2560; viewport.innerHeight = 1221
  const preferred = { x: 9, y: 10, w: 2541, h: 1200 }
  const saved = new Map([['window', JSON.stringify(preferred)]])
  let writes = 0, cancelled = 0, cursor = 0, nextFrame = 0, cleanup
  const states = [], frames = new Map()
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => { saved.set(key, value); writes++ } }
  const helpers = new Function('window', 'localStorage', 'LS_WIN', 'clamp',
    section('function fitWinRect(', '// --------------------------- slot registration') + '; return { fitWinRect, loadWinRect }')(
    viewport, storage, 'window', clamp)
  const hook = new Function('useState', 'useEffect', 'window', 'localStorage', 'LS_WIN', 'requestAnimationFrame', 'cancelAnimationFrame', 'fitWinRect', 'loadWinRect',
    section('function useWindowGeometry(', 'function WindowInner(') + '; return useWindowGeometry')(
    init => { const i = cursor++; if (!(i in states)) states[i] = init(); return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] },
    fn => { if (!cleanup) cleanup = fn() }, viewport, storage, 'window',
    fn => { const id = nextFrame++; frames.set(id, fn); return id }, id => frames.delete(id), helpers.fitWinRect, helpers.loadWinRect)
  const drag = { cancel: () => cancelled++ }
  const render = () => { cursor = 0; return hook(drag) }
  const flush = () => { const work = [...frames.values()]; frames.clear(); work.forEach(fn => fn()) }
  let geometry = render(); flush()
  assert.deepEqual(geometry.rect, preferred)
  for (const [w, h] of [[900, 1000], [768, 600], [620, 1000], [320, 240], [2560, 1221]]) {
    viewport.innerWidth = w; viewport.innerHeight = h
    for (let i = 0; i < 100; i++) viewport.dispatchEvent(new Event('resize'))
    assert.equal(frames.size, 1, 'Resize bursts coalesce, including frame ID zero')
    flush(); geometry = render()
    const rect = geometry.rect
    assert(rect.x >= 6 && rect.y >= 6 && rect.x + rect.w <= w - 6 && rect.y + rect.h <= h - 6,
      'All four borders, including the close control, must fit the viewport')
    assert.equal(saved.get('window'), JSON.stringify(preferred), 'Ambient resizing cannot overwrite the saved layout')
  }
  assert.deepEqual(geometry.rect, preferred, 'Expanding restores preferred geometry')
  assert.equal(writes, 0)
  assert(cancelled >= 500, 'A viewport change cancels stale pointer previews before fitting')
  const moved = { x: 50, y: 40, w: 800, h: 500 }
  geometry.commit(moved); geometry = render()
  assert.deepEqual(geometry.rect, moved); assert.equal(writes, 1)
  viewport.dispatchEvent(new Event('resize')); cleanup()
  assert.equal(frames.size, 0); assert.equal(viewport.listenerCount, 0)
  saved.set('window', '{"x":1e400,"y":-1e400,"w":1e400,"h":null}')
  assert(Object.values(helpers.loadWinRect()).every(Number.isFinite), 'Malformed stored dimensions must fall back safely')
  assert.deepEqual(helpers.fitWinRect({ x: -500, y: 9999, w: 800, h: 500 }, { w: 900, h: 600 }),
    { x: 6, y: 94, w: 800, h: 500 })
}
console.log('PASS resize: frame coalescing, final-coordinate persistence, cancellation, repeat gestures, shared controls, stable camera and viewport-fit restoration')
