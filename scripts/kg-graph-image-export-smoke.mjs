import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const helperBlock = file => {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  const start = source.indexOf('function graphImageBackground('), end = source.indexOf('function GraphExportActions(', start)
  assert(start >= 0 && end > start, 'Missing production PNG helpers in ' + file)
  return source.slice(start, end)
}
const helpers = helperBlock('src/index.client.js')
for (const file of ['lib/client.js', 'extension/viewer.js']) assert.equal(helperBlock(file), helpers, 'Generated export code drifted')

const toastBlock = file => {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  const start = source.indexOf('const toastListeners ='), end = source.indexOf('// Inbox for text selected', start)
  assert(start >= 0 && end > start)
  return source.slice(start, end)
}
const toastCode = toastBlock('src/index.client.js')
for (const file of ['lib/client.js', 'extension/viewer.js']) assert.equal(toastBlock(file), toastCode)
for (const mode of ['no-cordis-context', 'outer-context', 'explicit-context']) {
  const native = new Map(), owned = new Map(), messages = []
  let next = 0
  const owner = { timeout(callback, ms) {
    assert.equal(this, owner); assert.equal(ms, 3000)
    const id = ++next; owned.set(id, callback); return () => owned.delete(id)
  } }
  const environment = {
    setTimeout(callback, ms) { assert.equal(ms, 3000); const id = ++next; native.set(id, callback); return id },
    clearTimeout: id => native.delete(id),
    ...(mode === 'outer-context' ? { ctx: owner } : {}),
  }
  runInNewContext(toastCode + '\nthis.toast = toastStore', environment)
  const toast = environment.toast, stop = toast.subscribe(() => messages.push(toast.get()))
  toast.show('first', mode === 'explicit-context' ? owner : undefined)
  assert.equal(toast.get(), 'first', 'Extension export notifications must not require a free Cordis ctx')
  toast.show('replacement', mode === 'explicit-context' ? owner : undefined)
  const timers = mode === 'no-cordis-context' ? native : owned
  assert.equal(timers.size, 1, 'Replacing a toast must cancel the old scheduled dismissal')
  assert.equal(mode === 'no-cordis-context' ? owned.size : native.size, 0, 'Use the available timer owner, not an unrelated global')
  toast.clear()
  assert.equal(timers.size, 0, 'Clear must dispose the owned timer')
  toast.show('expires', mode === 'explicit-context' ? owner : undefined)
  const [id, expire] = [...timers][0]; timers.delete(id); expire()
  assert.equal(toast.get(), null)
  assert.deepEqual(messages, ['first', 'replacement', null, 'expires', null])
  stop(); toast.show('unsubscribed', mode === 'explicit-context' ? owner : undefined); toast.clear()
  assert.equal(messages.length, 5, 'Unsubscribed readers must not keep receiving notification updates')
}

class Element {
  constructor(tag, attrs = {}, children = [], paint = {}, styles = {}) {
    this.tag = tag; this.attrs = { ...attrs }; this.children = children; this.paint = paint
    this.style = { ...styles, removeProperty(name) { delete this[name] } }
    for (const child of children) child.parentElement = this
  }
  get firstChild() { return this.children[0] }
  getAttribute(name) { return this.attrs[name] ?? null }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  removeAttribute(name) { delete this.attrs[name]; if (name === 'style') this.style = { removeProperty() {} } }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
    return selector === '*' ? all : all.filter(child => child.tag === 'foreignObject' && child.attrs['data-image-node'])
  }
  querySelector(selector) { return this.querySelectorAll('*').find(child => child.tag === selector) }
  matches() {
    const classes = (this.attrs.class || '').split(' ')
    return classes.some(name => ['kg-node', 'kg-edge', 'kg-edge-label'].includes(name))
      || (this.tag === 'path' && this.parentElement?.attrs.class === 'kg-edge')
  }
  cloneNode() { return new Element(this.tag, this.attrs, this.children.map(child => child.cloneNode()), this.paint, this.style) }
  insertBefore(child, before) { this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child); child.parentElement = this }
  replaceWith(child) { const children = this.parentElement.children; children.splice(children.indexOf(this), 1, child); child.parentElement = this.parentElement }
}
const serialize = element => ({ tag: element.tag, attrs: element.attrs,
  style: Object.fromEntries(Object.entries(element.style).filter(([, value]) => typeof value !== 'function')),
  children: element.children.map(serialize) })
const scene = () => new Element('svg', {}, [
  new Element('defs', {}, [new Element('marker', { id: 'arrow-identity' }, [new Element('path', { fill: 'var(--kg-edge)' }, [], { fill: 'rgb(100, 116, 139)' })])]),
  new Element('g', {}, [
    new Element('g', { class: 'kg-edge', 'aria-label': 'maps_between: input-slot -> model' }, [
      new Element('path', { d: 'M 0 0 L 80 80', stroke: 'var(--kg-edge)', 'marker-end': 'url(#arrow-identity)', opacity: '.15' }, [], { stroke: 'rgb(100, 116, 139)', opacity: '.15', 'stroke-width': '2px' }),
      new Element('g', { class: 'kg-edge-label sel', 'aria-label': 'conflicting-source: model -> output-slot' }, [
        new Element('rect', {}, [], { fill: 'rgba(99, 102, 241, 0.16)', stroke: 'rgb(99, 102, 241)' }),
        new Element('text', {}, [], { fill: 'rgb(99, 102, 241)', 'font-weight': '600', 'font-size': '10px' }),
      ], { opacity: '.15' }, { opacity: '.15' }),
    ]),
    new Element('g', { class: 'kg-node', 'data-node-id': 'input: same name / t0', 'aria-pressed': 'true' }, [
      new Element('rect', { stroke: '#3b82f6' }, [], { stroke: 'rgb(59, 130, 246)', fill: 'rgba(37, 99, 235, 0.15)' }, { filter: 'drop-shadow(0 0 6px blue)' }),
      new Element('text', { class: 'kg-node-name' }, [], { fill: 'rgb(31, 41, 55)', 'font-family': 'system-ui', 'font-size': '13px', 'text-anchor': 'middle' }),
    ], { opacity: '.22' }, { opacity: '.22' }),
  ], {}, { transform: 'translate(80px, 40px) scale(0.3)' }),
])
let exportedSvg, downloads, revoked, fills, failure, backgroundPixel
const context = {
  Blob, console,
  exportFilePart: value => value || 'knowledge-graph',
  getComputedStyle: element => ({ backgroundColor: element.paint.backgroundColor || 'rgba(0, 0, 0, 0)', getPropertyValue: name => element.paint[name] || '' }),
  XMLSerializer: class { serializeToString(value) { exportedSvg = serialize(value); return JSON.stringify(exportedSvg) } },
  URL: { createObjectURL: () => 'blob:owned-svg', revokeObjectURL: url => revoked.push(url) },
  Image: class { set src(value) { assert.equal(value, 'blob:owned-svg'); queueMicrotask(() => failure === 'image' ? this.onerror() : this.onload()) } },
  downloadBrowserBlob: (blob, filename) => { downloads.push({ blob, filename }); return true },
  document: { createElementNS: (_ns, tag) => new Element(tag), createElement: tag => {
    assert.equal(tag, 'canvas')
    const canvas = { width: 0, height: 0, getContext: () => failure === 'canvas' ? null : {
      fillStyle: '', fillRect() { fills.push(this.fillStyle) }, drawImage() { if (failure === 'draw') throw new Error('blocked pixels') },
      getImageData: () => ({ data: backgroundPixel }),
    }, toBlob: callback => callback(failure === 'blob' ? null : new Blob(['pixels'], { type: 'image/png' })), toDataURL: () => 'data:image/png;base64,AA==' }
    return canvas
  } },
}
runInNewContext(helpers + '\nthis.api = {graphImageBackground, freezeGraphImageStyles, exportRenderedGraphImage}', context)
const { api } = context
const reset = mode => { failure = mode; downloads = []; revoked = []; fills = []; exportedSvg = null; backgroundPixel = [248, 248, 248, 255] }
const makeContainer = svg => {
  const surface = new Element('div', {}, [], { backgroundColor: 'rgb(255, 255, 255)' })
  const panel = new Element('div', {}, [], { backgroundColor: 'rgba(127, 127, 127, 0.055)' })
  panel.parentElement = surface
  return { parentElement: panel, paint: {}, querySelector: () => svg, getBoundingClientRect: () => ({ width: 400, height: 300 }) }
}
reset()
const source = scene(), before = JSON.stringify(serialize(source)), copy = source.cloneNode()
api.freezeGraphImageStyles(source, copy)
assert.equal(JSON.stringify(serialize(source)), before, 'Export must not mutate live camera, selection, paint or identities')
const nodes = copy.querySelectorAll('*'), path = nodes.find(node => node.attrs['marker-end'])
assert.equal(path.attrs.stroke, 'rgb(100, 116, 139)', 'Inherited edge color must not fall back to an invisible stroke')
assert.equal(path.attrs.opacity, '1', 'Focus cannot erase an exported relation')
assert.equal(path.attrs.d, 'M 0 0 L 80 80')
assert.equal(path.attrs['marker-end'], 'url(#arrow-identity)', 'Storage direction must not be reversed or lose its marker')
const node = nodes.find(element => element.attrs['data-node-id'])
assert.equal(node.attrs['data-node-id'], 'input: same name / t0')
assert.equal(node.attrs['aria-pressed'], 'true', 'Do not clear live selection to make export tests pass')
assert.equal(node.attrs.opacity, '1')
assert.equal(node.children[0].attrs.stroke, 'rgb(59, 130, 246)')
assert.equal(node.children[0].attrs.filter, 'none', 'Transient glow must not wash out readable text')
assert.equal(node.children[1].attrs['font-size'], '13px')
assert.equal(nodes.find(element => element.attrs.class === 'kg-edge-label sel').children[1].attrs['font-weight'], '600')
assert(!JSON.stringify(serialize(copy)).includes('var(--kg-'), 'Standalone SVG cannot rely on page CSS variables')

const container = makeContainer(source)
assert.equal(api.graphImageBackground(container), 'rgb(248,248,248)')
assert.deepEqual(fills, ['#ffffff', 'rgb(255, 255, 255)', 'rgba(127, 127, 127, 0.055)', 'rgba(0, 0, 0, 0)'], 'Ancestor backgrounds must composite bottom-up, once, on an opaque base')
reset()
backgroundPixel = [27, 34, 49, 255]
assert.equal(api.graphImageBackground(container), 'rgb(27,34,49)', 'Do not force white paint on a dark surface')
reset()
assert.equal(await api.exportRenderedGraphImage(container, 'selected-model', null, { w: 200, h: 120, cx: 50, cy: -40 }), 'selected-model.png')
assert.equal(exportedSvg.attrs.width, '560')
assert.equal(exportedSvg.attrs.height, '480')
const camera = exportedSvg.children.find(element => element.tag === 'g')
assert.equal(camera.attrs.transform, 'translate(230 280)', 'Fit export must not crop to the zoomed viewport')
assert.equal(exportedSvg.children[0].attrs.fill, 'rgb(248,248,248)')
assert.equal(downloads.length, 1)
assert.deepEqual(revoked, ['blob:owned-svg'])
assert.equal(JSON.stringify(serialize(source)), before, 'Asynchronous PNG generation must not rewrite the source DOM')
for (const [mode, message] of [['canvas', /Canvas/], ['image', /图像渲染失败/], ['draw', /blocked pixels/], ['blob', /PNG 生成失败/]]) {
  reset(mode)
  await assert.rejects(api.exportRenderedGraphImage(container, 'failure', null, {}), message)
  assert.equal(downloads.length, 0, 'Never report an unsuccessful PNG as downloaded')
  assert.deepEqual(revoked, mode === 'canvas' ? [] : ['blob:owned-svg'], 'Release the rasterization URL on errors')
  assert.equal(JSON.stringify(serialize(source)), before, 'Errors must leave browsing and selection unchanged')
}
reset()
const withImage = scene(), figure = new Element('foreignObject', { 'data-image-node': 'original-image', x: '2', y: '3', width: '90', height: '70' })
figure.querySelector = () => ({ complete: false, naturalWidth: 0 })
withImage.children[1].children.push(figure)
await assert.rejects(api.exportRenderedGraphImage(makeContainer(withImage), 'not-ready', null, {}), /原图尚未读取完成/)
assert.equal(downloads.length, 0)
figure.querySelector = () => ({ complete: true, naturalWidth: 1200, naturalHeight: 800 })
await api.exportRenderedGraphImage(makeContainer(withImage), 'original-image', null, {})
const embedded = exportedSvg.children.find(element => element.tag === 'g').children.at(-1)
assert.equal(embedded.tag, 'image')
assert.equal(embedded.attrs.href, 'data:image/png;base64,AA==')
assert.equal(embedded.attrs.width, '90')
assert.equal(figure.tag, 'foreignObject', 'Embedding must not replace the live original image')
console.log(JSON.stringify({ ok: true, generatedParity: 3, standalonePaint: true, opaqueAncestorBackground: true,
  selectedIdentityRetained: true, noFocusDimmingOrGlow: true, decodedImages: true, errorCleanupCases: 5, toastTimerContexts: 3,
  pixelFidelity: 'separate actual browser acceptance required' }))
