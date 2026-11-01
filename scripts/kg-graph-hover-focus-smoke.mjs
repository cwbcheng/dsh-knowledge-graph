// Hover focus, wheel zoom, and image-card label regressions.
//
// These three behaviors are the graph's cheapest feedback loop: hovering a node
// previews its neighborhood, the wheel zooms the canvas, and image cards must
// stay small enough that a 14-figure article still reads as a graph.
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
const clause = (name, args = '') => (0, eval)('(' + extractFunction(source, name) + ')')
const imageCardLabel = clause('imageCardLabel')
const cssAttributeValue = clause('cssAttributeValue')
const hoverFocusTargets = clause('hoverFocusTargets')
const wheelZoomFactorRaw = clause('wheelZoomFactor')
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const wheelZoomFactor = (event, height) => wheelZoomFactorRaw(event, height, clamp)

// ---------- image card labels ----------
assert.equal(imageCardLabel({ id: 'image:figure-4', text: '双层架构：Router 层统一负责路由与对外交互' }), '图 4 · 双层架构')
assert.equal(imageCardLabel({ id: 'image:figure-11', text: '存算分离与执行环境解耦：Agent Loop 与持久化状态在云端分离' }), '图 11 · 存算分离与执行环境解耦')
const longCaption = imageCardLabel({ id: 'image:figure-1', text: '同一个任务在 IM 群聊与 GitHub Pull Request 评审之间连续推进' })
assert(longCaption.startsWith('图 1 · '), 'image label keeps its figure number: ' + longCaption)
assert(longCaption.length <= 20, 'image label must stay short: ' + longCaption)
assert(longCaption.endsWith('…'), 'truncated image label ends with an ellipsis: ' + longCaption)
assert.equal(imageCardLabel({ id: 'image:figure-7', text: '' }), '图 7')
assert.equal(imageCardLabel({ id: 'image:custom-3', text: '插图说明' }), '插图 · 插图说明')
assert.equal(imageCardLabel(null), '插图')

// ---------- image card geometry ----------
const wrapText = (g, text, width) => {
  const chars = [...String(text || '')]
  const lines = []
  let current = ''
  for (const char of chars) {
    const next = current + char
    if (g.measureText(next).width > width && current) { lines.push(current); current = char }
    else current = next
  }
  if (current) lines.push(current)
  return lines
}
const computeNodeSizes = new Function('wrapText', 'clamp', 'TYPE_META', 'imageCardLabel',
  'return (' + extractFunction(source, 'computeNodeSizes') + ')')(wrapText, clamp, { fact: { label: '事实' } }, imageCardLabel)
const environment = { document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: String(text).length * 8 }) }) }) }, console }
globalThis.document = environment.document
const sizes = computeNodeSizes([
  { id: 'image:figure-4', type: 'image', text: '双层架构：Router 层统一负责路由与对外交互' },
  { id: 'f1', type: 'fact', text: '短句' },
], [{ fromNodeId: 'f1', toNodeId: 'image:figure-4' }])
const imageSize = sizes.get('image:figure-4')
assert.equal(imageSize.w, 176)
assert.equal(imageSize.h, 136)
assert.equal(imageSize.imageCard, true)
assert.deepEqual(imageSize.lines, ['图 4 · 双层架构'])
assert(imageSize.h < 194 && imageSize.w < 208, 'image card must stay smaller than the legacy 208x194 card')
assert(sizes.get('f1').h >= 60, 'text nodes keep their own sizing')

// ---------- attribute selector escaping ----------
assert.equal(cssAttributeValue('image:figure-1'), 'image:figure-1')
assert.equal(cssAttributeValue('a"b'), 'a\\"b')
assert.equal(cssAttributeValue('a\\b'), 'a\\\\b')
assert.equal(cssAttributeValue(null), '')

// ---------- wheel gesture ----------
assert(wheelZoomFactor({ deltaY: -100 }, 600) > 1.15, 'wheel up zooms in')
assert(wheelZoomFactor({ deltaY: 100 }, 600) < 0.87, 'wheel down zooms out')
assert.equal(wheelZoomFactor({ deltaY: -100, shiftKey: true }, 600), null, 'Shift+wheel scrolls the page')
assert(wheelZoomFactor({ deltaY: -100, ctrlKey: true }, 600) > 1, 'Ctrl+wheel still zooms')
assert.equal(wheelZoomFactor({ deltaY: 0 }, 600), null)
assert.equal(wheelZoomFactor(null, 600), null)
const lineMode = wheelZoomFactor({ deltaY: -3, deltaMode: 1 }, 600)
assert(lineMode !== null && Math.abs(lineMode - Math.exp(3 * 16 * 0.0018)) < 1e-9, 'line-mode deltas are scaled by 16px: ' + lineMode)
const pageMode = wheelZoomFactor({ deltaY: -1, deltaMode: 2 }, 900)
assert(pageMode !== null && Math.abs(pageMode - Math.exp(100 * 0.0018)) < 1e-9, 'page-mode deltas are scaled by viewport height and clamped: ' + pageMode)
assert(Math.abs(wheelZoomFactor({ deltaY: -100 }, 600) - Math.exp(0.18)) < 1e-9, 'plain wheel uses the 0.0018 step')

// ---------- hover targets ----------
const incident = [
  { edge: { fromNodeId: 'a', toNodeId: 'b', relation: 'supports' } },
  { edge: { fromNodeId: 'a', toNodeId: 'b', relation: 'contains' } },
  { edge: { fromNodeId: 'c', toNodeId: 'a', relation: 'causes' } },
]
const targets = hoverFocusTargets(incident, 'a')
assert.deepEqual([...targets.ids].sort(), ['a', 'b', 'c'])
assert.equal(targets.links.length, 2, 'parallel relations share one highlight link')
assert(!targets.ids.includes('d'))
assert.deepEqual(hoverFocusTargets(undefined, 'a'), { ids: ['a'], links: [] })

// ---------- generated artifacts stay in sync ----------
for (const path of ['src/index.client.js', 'lib/client.js']) {
  const built = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  for (const name of ['imageCardLabel', 'hoverFocusTargets', 'wheelZoomFactor', 'cssAttributeValue']) {
    assert(built.includes(extractFunction(source, name)), path + ' is missing ' + name)
  }
}

console.log(JSON.stringify({ ok: true, imageCardLabel: true, imageCardGeometry: true, wheelGesture: true,
  hoverFocus: true, attributeEscaping: true, generatedParity: true }))
