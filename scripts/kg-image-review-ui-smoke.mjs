import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

for (const file of ['../src/index.client.js', '../lib/client.js']) {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8')
  const start = text.indexOf('      function ImageReviewForm(')
  const end = text.indexOf('      function VisualInterpretationPanel(', start)
  assert(start >= 0 && end > start, 'Image review must expose actual controls in both clients')
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) })
  const states = []
  let cursor = 0
  const useState = initial => {
    const index = cursor++
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
  }
  const useRef = value => { const index = cursor++; return states[index] ||= { current: value } }
  const calls = [], saved = [], drafts = { current: new Map() }
  let resolve, reject
  const rpc = (name, args) => { calls.push({ name, args }); return new Promise((yes, no) => { resolve = yes; reject = no }) }
  const Form = new Function('h', 'useState', 'useRef', 'useEffect', 'host', 'rpc',
    text.slice(start, end) + '; return ImageReviewForm')(h, useState, useRef, () => {}, { call: rpc }, rpc)
  const review = { imageId: 'img-a', version: 3, fingerprint: 'a'.repeat(64), status: 'pending', note: '', reviewable: true }
  const render = overrides => {
    cursor = 0
    return Form({ documentId: 'doc', revision: 8, review, originalReady: true, busy: false, drafts,
      onSaved: result => saved.push(result), onRefresh() {}, ...overrides })
  }
  const find = (node, predicate) => node && typeof node === 'object'
    ? predicate(node) ? node : node.children.map(child => find(child, predicate)).find(Boolean) : null
  const button = (tree, label) => find(tree, node => node.type === 'button' && node.children.includes(label))
  const checkbox = tree => find(tree, node => node.type === 'input' && node.props.type === 'checkbox')
  const note = tree => find(tree, node => node.type === 'textarea')
  const initial = render()
  assert.equal(button(initial, '保存核对').props.disabled, true)
  await button(initial, '保存核对').props.onClick()
  assert.equal(calls.length, 0, 'No write before explicit confirmation')
  checkbox(render()).props.onChange({ currentTarget: { checked: true } })
  await button(render({ busy: true }), '保存核对').props.onClick()
  await button(render({ originalReady: false }), '保存核对').props.onClick()
  assert.equal(calls.length, 0, 'Busy tasks and missing original pixels block confirmation')
  note(render()).props.onChange({ currentTarget: { value: 'checked notes' } })
  const ready = render()
  const first = button(ready, '保存核对').props.onClick()
  await button(ready, '保存核对').props.onClick()
  assert.equal(calls.length, 1, 'Immediate repeated clicks must not create duplicate requests')
  assert.deepEqual(calls[0], { name: 'image-review', args: { action: 'save', documentId: 'doc', imageId: 'img-a',
    expectedRevision: 8, expectedVersion: 3, fingerprint: review.fingerprint, status: 'matched', note: 'checked notes', confirmed: true } })
  const newerDraft = { status: 'needs_correction', note: 'newer unsaved note from a reopened image' }
  drafts.current.set('doc:img-a', newerDraft)
  resolve({ documentId: 'doc', revision: 8, review: { ...review, status: 'matched', version: 4 } })
  await first
  assert.equal(saved.length, 1)
  assert.equal(drafts.current.get('doc:img-a'), newerDraft, 'A late save must not discard a newer local draft')
  note(render()).props.onChange({ currentTarget: { value: 'keep on server conflict' } })
  const conflict = button(render(), '保存核对').props.onClick()
  reject(new Error('conflict: newer record'))
  await conflict
  assert.equal(saved.length, 1)
  assert.equal(note(render()).props.value, 'keep on server conflict')
  assert.equal(checkbox(render()).props.checked, false)
  assert(find(render(), node => node.props.role === 'alert').children.includes('conflict: newer record'))
  checkbox(render()).props.onChange({ currentTarget: { checked: true } })
  const wrong = button(render(), '保存核对').props.onClick()
  resolve({ documentId: 'foreign', revision: 8, review: { ...review, version: 4 } })
  await wrong
  assert.equal(saved.length, 1, 'A mismatched response cannot claim success')
}
console.log(JSON.stringify({ ok: true, sourceAndGenerated: true, explicitConfirmation: true, busyAndMissingPixels: true,
  duplicateSaveGuard: true, newerDraftPreserved: true, failedSaveVisible: true, responseIdentity: true }))
