import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelStructureFixture } from './kg-model-structure-fixture-data.mjs'
import { createModelReviewController } from './kg-model-review-controller-fixture.mjs'

const harness = await modelLearningHarness({ fixture: modelStructureFixture() })
let current, cursor = 0, timerId = 0, uuid = 0
const updates = [], timers = new Map(), cache = new Map()
const slot = init => { const index = cursor++; return current.slots[index] ||= init() }
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } } },
  useState(initial) { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, next => updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
  useRef(initial) { return slot(() => ({ current: initial })) },
  useEffect(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) { current.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps } },
}
const context = { window: { React, confirm: () => true }, console, AbortController,
  crypto: { randomUUID: () => 'fixture-' + (++uuid) }, sessionStorage: { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
  setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id) }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const { ModelStructureEditor, ModelPairedExamples } = context.window.KGViewer
const original = harness.store.getDocument(harness.document.documentId)
const state = { resultView: { graph: original, sourceText: original.sourceText }, graphCommitQueueRef: { current: Promise.resolve() }, currentResultRef: { current: null }, graphRevisionRef: { current: 1 }, verifyBusyRef: { current: false } }
state.currentResultRef.current = state.resultView
const writes = [], requests = [], busy = []
let delayed = false, failWrite = false, delayWriteDelivery = false, malformedPreview = false, unsupportedHost = false, dropSavedStructure = false
const pending = [], deliveries = []
const props = { documentId: harness.document.documentId, revision: 1, modelId: 'multi', active: true, busy: false,
  load(args, signal) {
    const request = { args, signal }; requests.push(request)
    if (delayed) return new Promise((resolve, reject) => pending.push({ ...request, resolve, reject }))
    return harness.post(args, 'connection-models').then(result => {
      if (unsupportedHost) delete result.modelStructureVersion
      return result
    })
  }, onBusy: value => busy.push(value),
  async onCommit(args) {
    writes.push(args); if (failWrite) throw new Error('fixture save response lost')
    if (malformedPreview) return { signature: 'incomplete-preview', diff: [] }
    const result = await createModelReviewController(state, { call: async (method, body) => {
      const response = await harness.post(body, method)
      if (dropSavedStructure && method === 'graph-commit') delete response.graph.nodes.find(node => node.id === body.graph.nodes[0].id).modelStructure
      return response
    } })(args)
    return delayWriteDelivery ? new Promise(resolve => deliveries.push(() => resolve(result))) : result
  },
}
state.onSaved = view => { state.resultView = view; props.revision = state.graphRevisionRef.current }
let owner = { slots: [], effects: [] }, tree
function render() {
  for (let i = 0; i < 30; i++) {
    updates.splice(0).forEach(fn => fn()); current = owner; cursor = 0
    tree = ModelStructureEditor(props); owner.effects.splice(0).forEach(fn => fn())
    if (!updates.length) return
  }
  throw new Error('model structure update loop')
}
async function settle() { for (let i = 0; i < 8; i++) { await new Promise(setImmediate); render() } }
const text = element => Array.isArray(element) ? element.map(text).join('') : element && typeof element === 'object' ? text(element.props?.children) : String(element ?? '')
const all = (element, predicate) => Array.isArray(element) ? element.flatMap(child => all(child, predicate)) : !element || typeof element !== 'object' ? [] : [...(predicate(element) ? [element] : []), ...all(element.props?.children, predicate)]
const button = label => {
  const item = all(tree, element => element.type === 'button' && (element.props['aria-label'] === label || text(element) === label))[0]
  assert(item, 'missing button ' + label); return item
}
const click = label => { const item = button(label); assert(!item.props.disabled, 'disabled button ' + label); item.props.onClick(); render() }
const change = (label, value) => {
  const input = all(tree, element => element.props?.['aria-label'] === label && ['input', 'select', 'textarea'].includes(element.type))[0]
  assert(input, 'missing field ' + label); input.props.onChange({ target: { value } }); render()
}
const unmount = () => { owner.slots.forEach(state => state.cleanup?.()); owner = { slots: [], effects: [] } }
try {
  render(); await settle()
  assert(text(tree).includes('初速度') && text(tree).includes('后续速度'))
  assert.equal(writes.length, 0, 'reading must not write')
  change('时间或对象状态 final-speed', '10 秒后')
  assert([...cache.values()].some(value => value.includes('10 秒后')))
  click('预览结构修改'); await settle()
  assert(text(tree).includes('待确认的结构修改'))
  assert.equal(harness.store.getDocumentRevision(props.documentId), 1)
  change('单位 final-speed', 'km/h')
  assert(!text(tree).includes('确认保存结构'), 'editing invalidates an approval')
  change('单位 final-speed', 'm/s')
  click('预览结构修改'); await settle()
  const confirm = button('确认保存结构'); confirm.props.onClick(); confirm.props.onClick(); render()
  await settle()
  assert.equal(writes.filter(write => write.preview).length, 1, 'synchronous double-click submits only once')
  assert.equal(harness.store.getDocumentRevision(props.documentId), 2)
  const saved = harness.store.getDocument(props.documentId).nodes.find(node => node.id === 'multi').modelStructure
  assert.equal(saved.slots.find(slot => slot.id === 'final-speed').state, '10 秒后')
  assert.equal(saved.slots.find(slot => slot.id === 'initial-speed').state, '初始时刻')
  assert.equal(JSON.stringify(harness.store.getDocument(props.documentId).edges), JSON.stringify(original.edges))
  assert.equal(cache.size, 0, 'successful save clears the structure draft')

  change('槽位名称 final-speed', '后续速度草稿')
  props.active = false; render(); props.active = true; render(); await settle()
  const labelField = all(tree, element => element.type === 'input' && element.props['aria-label'] === '槽位名称 final-speed')[0]
  assert.equal(labelField.props.value, '后续速度草稿', 'tab switching preserves the draft')
  unmount(); render(); await settle()
  assert.equal(all(tree, element => element.type === 'input' && element.props['aria-label'] === '槽位名称 final-speed')[0].props.value, '后续速度草稿', 'remount restores the draft')
  failWrite = true; click('预览结构修改'); await settle()
  assert(text(tree).includes('fixture save response lost'))
  assert.equal(all(tree, element => element.type === 'input' && element.props['aria-label'] === '槽位名称 final-speed')[0].props.value, '后续速度草稿')
  failWrite = false
  malformedPreview = true; click('预览结构修改'); await settle()
  assert(text(tree).includes('结构修改结果不完整'))
  assert(!text(tree).includes('确认保存结构'), 'missing change details must block approval instead of crashing or concealing changes')
  malformedPreview = false

  props.modelId = 'taxi'; render(); await settle()
  click('条件分支 (3)')
  change('完整映射规律 base', '基础费用 = 11 元（用户整理）')
  change('完整映射规律来源身份 base', 'user')
  change('完整映射规律逐字引用 base', 'fabricated quotation')
  click('预览结构修改'); await settle()
  assert(text(tree).includes('quote does not match the stored source unit'), 'invalid field evidence must identify the failing field')
  assert.equal(harness.store.getDocumentRevision(props.documentId), 2)
  change('完整映射规律逐字引用 base', '')
  change('完整映射规律原文段落 base', '')
  click('成对实例 (3)')
  change('选择编辑实例', 'five-km')
  change('推测过程', '先核对分支，再记录推测；仍未独立验证。')
  click('预览结构修改'); await settle()
  assert(text(tree).includes('待确认的结构修改'))
  const draftBefore = [...cache.values()].find(value => value.includes('先核对分支'))
  assert(draftBefore)
  const externallyChanged = harness.store.getDocument(props.documentId)
  externallyChanged.summary += ' external revision'
  harness.store.saveGraph(externallyChanged, { sourceText: original.sourceText, expectedRevision: 2 })
  props.revision = 3; state.graphRevisionRef.current = 3; render(); await settle()
  assert(text(tree).includes('草稿基于第 2 版'))
  assert(button('预览结构修改').props.disabled, 'stale drafts cannot overwrite a new revision')
  assert([...cache.values()].some(value => value.includes('先核对分支')), 'revision changes preserve drafts')

  delayed = true; props.modelId = 'legacy'; render()
  const stale = pending.find(request => request.args.modelId === 'legacy')
  props.modelId = 'multi'; render()
  assert(stale.signal.aborted)
  for (const request of pending.splice(0)) request.resolve(await harness.post(request.args, 'connection-models'))
  await settle()
  assert(text(tree).includes('后续速度草稿'), 'late responses cannot replace a different model draft')
  delayed = false

  click('丢弃草稿并重读'); await settle()
  change('槽位名称 final-speed', '提交中的后续速度')
  click('预览结构修改'); await settle()
  delayWriteDelivery = true; click('确认保存结构'); await settle()
  assert.equal(harness.store.getDocumentRevision(props.documentId), 4, 'the production commit has completed before its response is delivered')
  unmount(); render(); await settle()
  assert.equal(busy.at(-1), false, 'unmount releases the old editor busy state')
  click('丢弃草稿并重读'); await settle()
  change('槽位名称 final-speed', '第四版新草稿')
  const newerDraft = [...cache.values()].find(value => value.includes('第四版新草稿'))
  assert(newerDraft)
  deliveries.splice(0).forEach(deliver => deliver()); await settle()
  assert([...cache.values()].includes(newerDraft), 'late success must not clear a newer draft in the same model')
  assert.equal(all(tree, element => element.type === 'input' && element.props['aria-label'] === '槽位名称 final-speed')[0].props.value, '第四版新草稿')
  assert(!text(tree).includes('结构已保存'), 'late success must not update the remounted editor')
  delayWriteDelivery = false

  const slotEvents = [], paired = await harness.post({ documentId: props.documentId, expectedRevision: 4, modelId: 'taxi', branchId: 'extra' }, 'connection-models')
  const pairs = ModelPairedExamples({ structure: paired.structure, selectedSlot: '', onSlot: (...args) => slotEvents.push(args), onLocate() {}, onPage() {} })
  assert(text(pairs).includes('配对或映射尚不完整'))
  all(pairs, element => element.type === 'button' && element.props.className?.includes('kg-model-binding'))[0].props.onClick()
  assert.equal(slotEvents[0][0], 'distance-slot')
  assert.equal(slotEvents[0][1], 'five-km')
  const writeCount = writes.length
  unsupportedHost = true; props.active = false; render(); props.active = true; render(); await settle()
  assert(text(tree).includes('当前 Host 尚未部署结构核对版本'))
  assert(button('预览结构修改').props.disabled)
  button('预览结构修改').props.onClick(); await settle()
  assert.equal(writes.length, writeCount, 'an unsupported Host blocks writes even when the disabled button callback is invoked')
  assert([...cache.values()].includes(newerDraft), 'version mismatch must preserve existing draft data')
  unsupportedHost = false; props.active = false; render(); props.active = true; render(); await settle()
  click('预览结构修改'); await settle()
  dropSavedStructure = true; click('确认保存结构'); await settle()
  assert.equal(harness.store.getDocumentRevision(props.documentId), 5, 'the store committed the approved structure')
  assert(text(tree).includes('保存结果未包含预览中的模型结构'), 'the controller must check the returned canonical structure, not just a successful revision')
  assert([...cache.values()].includes(newerDraft), 'an unconfirmed save must not clear the draft')
  assert.equal(props.revision, 4, 'an incomplete receipt must not be presented as an acknowledged save')
  assert.equal(JSON.stringify(harness.store.getDocument(props.documentId).edges), JSON.stringify(original.edges))
  assert.equal(busy.at(-1), false)
  unmount()
  assert(requests.filter(request => request.args.modelId).some(request => request.signal.aborted))
} finally { harness.stop() }
console.log(JSON.stringify({ ok: true, generatedEditorAndProductionRoutes: true, independentSlotEdit: true, predictPreviewThenCommit: true,
  approvalInvalidation: true, duplicateWriteBlocked: true, sourceErrorPreservesDraft: true, scopedDraftAndRevision: true,
  staleReadsAborted: true, lateSaveProtectsNewDraft: true, mixedHostVersionBlocksWrites: true, unconfirmedSavePreservesDraft: true, pairHighlightsSlot: true, formalEdgesUnchanged: true }))
