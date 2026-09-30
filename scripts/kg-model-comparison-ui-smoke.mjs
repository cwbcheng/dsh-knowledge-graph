import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness, learnerReview } from './kg-model-learning-fixture-data.mjs'
import { comparisonFixture, counterexampleResponse } from './kg-model-comparison-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: comparisonFixture() })
const { document, store, post } = harness
let owner = { slots: [], effects: [] }, cursor = 0, tree, Component, props
const updates = [], storage = new Map(), events = new Map(), requests = [], deferred = [], challenges = []
let paused = false, loseSave = false, invalidIdentity = false
const slot = init => { const index = cursor++; return owner.slots[index] ||= init() }
const React = {
  createElement: (type, properties, ...children) => ({ type, props: { ...properties, children } }),
  useState(initial) { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    return [state.value, next => updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect(fn, deps) { const state = slot(() => ({}));
    if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
      owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
    } },
}
const context = { window: { React, confirm: () => true, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) },
  console, AbortController, setTimeout, clearTimeout, crypto: { randomUUID },
  sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
const call = (args, signal, method = 'learning-mode') => {
  requests.push({ args, signal, method })
  const run = async () => {
    const result = await post(args, method)
    if (args.action === 'save' && loseSave) { loseSave = false; throw new Error('Lost challenge save response') }
    return invalidIdentity ? { ...result, documentId: 'foreign-document' } : result
  }
  return paused ? new Promise((resolve, reject) => deferred.push({ args, signal, resolve: () => run().then(resolve, reject) })) : run()
}
function render() {
  for (let count = 0; count < 30; count++) {
    updates.splice(0).forEach(fn => fn()); cursor = 0
    tree = Component(props); owner.effects.splice(0).forEach(fn => fn())
    if (!updates.length) return
  }
  throw new Error('Component update loop')
}
async function settle() { for (let count = 0; count < 8; count++) { await new Promise(resolve => setImmediate(resolve)); render() } }
const text = el => Array.isArray(el) ? el.map(text).join('') : el && typeof el === 'object' ? text(el.props?.children) : String(el ?? '')
const all = (el, predicate) => Array.isArray(el) ? el.flatMap(child => all(child, predicate)) : !el || typeof el !== 'object' ? [] :
  [...(predicate(el) ? [el] : []), ...all(el.props?.children, predicate)]
const button = label => { const found = all(tree, el => el.type === 'button' && (el.props['aria-label'] === label || text(el) === label))[0]; assert(found, label); return found }
const click = label => { const found = button(label); assert(!found.props.disabled, label); found.props.onClick(); render() }
const input = label => { const found = all(tree, el => ['textarea', 'select', 'input'].includes(el.type) && el.props['aria-label'] === label)[0]; assert(found, label); return found }
const fill = (label, value) => { const found = input(label); assert(!found.props.disabled, label); found.props.onChange({ target: { value } }); render() }
const choose = id => {
  const found = all(tree, el => el.type === 'button' && text(el).includes(id + ' · '))[0]
  assert(found, 'Missing peer ' + id); found.props.onClick(); render()
}
const mount = (name, next) => {
  owner.slots.forEach(state => state.cleanup?.()); updates.length = 0; owner = { slots: [], effects: [] }
  Component = context.window.KGViewer[name]; props = next; render()
}
try {
  const before = JSON.stringify(store.getDocument(document.documentId))
  mount('ConnectionModelComparison', { documentId: document.documentId, revision: 1, modelId: 'taxi', active: true,
    load: (args, signal) => call(args, signal, 'connection-models'), onChallenge: id => challenges.push(id), onLocate: () => { throw new Error('Locate failed visibly') } })
  await settle()
  assert.equal(requests.filter(item => item.args.compareModelId).length, 0, 'comparison requires explicit second model selection')
  choose('night'); await settle()
  assert(text(tree).includes('已记录的输入、输出端点相同'))
  assert(text(tree).includes('不代表条件、单位或结论等价'))
  assert(text(tree).includes('前 2 / 2 条关联材料'))
  click('挑战模型 B'); assert.deepEqual(challenges, ['night'], 'challenge targets selected secondary model, not primary by mistake')
  click('原文 P9'); await settle(); assert(text(tree).includes('Locate failed visibly'))
  click('后页比较模型'); await settle()
  assert(text(tree).includes('已记录的输入、输出端点相同'), 'candidate pagination does not replace the selected pair')
  assert(text(tree).includes('peer-9'))
  click('前页比较模型'); await settle()
  paused = true
  choose('multi'); const old = deferred.splice(0)
  choose('unknown'); const fresh = deferred.splice(0)
  assert(old.every(item => item.signal.aborted))
  fresh.forEach(item => item.resolve()); await settle()
  old.forEach(item => item.resolve()); await settle()
  assert(text(tree).includes('端点角色或关系身份尚不完整'))
  assert(!text(tree).includes('已记录的输入、输出端点有差异'), 'late response cannot swap in another model')
  choose('night'); const hidden = deferred.splice(0)
  props.active = false; render(); assert.equal(tree, null)
  assert(hidden.every(item => item.signal.aborted))
  hidden.forEach(item => item.resolve()); await settle(); assert.equal(tree, null)
  paused = false; invalidIdentity = true
  props.active = true; render(); await settle()
  assert(text(tree).includes('比较模型身份或版本不一致'))
  invalidIdentity = false; click('重新读取模型比较'); await settle()
  assert(text(tree).includes('已记录的输入、输出端点相同'))

  mount('ModelLearningPanel', { documentId: document.documentId, revision: 1, modelId: 'taxi', exercise: 'counterexample', active: true, call })
  await settle()
  const fields = { inputs: '输入', mapping: '联结与推理', outputs: '输出', boundary: '适用条件与失效边界',
    scenario: '改变后的情境', prediction: '改变后的预测', check: '可观察的验证依据', baseline: '基准情境',
    baselinePrediction: '基准预测', changedVariable: '只改变的一项与保持不变的条件', falsifier: '什么观察结果会反驳这个联结' }
  assert(text(tree).includes('反例挑战')); assert(!text(tree).includes('2 km 对应 10 元'))
  for (const [key, label] of Object.entries(fields)) {
    assert(button('保存预测').props.disabled, 'all challenge fields, including falsifier, are required')
    fill(label, counterexampleResponse[key])
  }
  assert(!button('保存预测').props.disabled)
  props.exercise = 'prediction'; render(); await settle()
  assert.equal(input('我的预测').props.value, '', 'exercise drafts cannot contaminate each other')
  fill('我的预测', '另外的未保存预测')
  props.exercise = 'counterexample'; render(); await settle()
  assert.equal(input('基准情境').props.value, counterexampleResponse.baseline)
  const preservedProps = props
  mount('ModelLearningPanel', preservedProps); await settle()
  assert.equal(input('什么观察结果会反驳这个联结').props.value, counterexampleResponse.falsifier, 'challenge draft survives remount')
  loseSave = true
  const saveButton = button('保存预测'); saveButton.props.onClick(); saveButton.props.onClick(); render(); await settle()
  assert.equal(requests.filter(item => item.args.action === 'save').length, 1)
  assert(text(tree).includes('Lost challenge save response'))
  assert.equal(input('改变后的预测').props.value, counterexampleResponse.prediction)
  click('保存预测'); await settle()
  const saves = requests.filter(item => item.args.action === 'save')
  assert.equal(saves[0].args.attemptId, saves[1].args.attemptId)
  assert(text(tree).includes('最初的预测')); assert(!text(tree).includes('2 km 对应 10 元'))
  assert(text(tree).includes('是否只改变一个条件尚未核验'), 'saved challenge is not presented as a controlled experiment already verified')
  click('展开原文对照'); await settle()
  assert(text(tree).includes('2 km 对应 10 元')); assert(text(tree).includes('不是标准答案'))
  fill('复盘判断', learnerReview.diagnosis); fill('保留或修改的理由', learnerReview.reflection); fill('下一步验证', learnerReview.nextCheck)
  click('保存复盘'); await settle()
  assert(input('保留或修改的理由').props.disabled)
  const record = store.listLearningAttempts(document.documentId, 'taxi', 'counterexample')[0]
  assert.equal(record.version, 3); assert.equal(record.response.changedVariable, counterexampleResponse.changedVariable)
  assert.equal(record.task.refutation, 'not_verified')
  props.exercise = 'prediction'; render(); await settle()
  assert.equal(input('我的预测').props.value, '另外的未保存预测')
  assert(text(tree).includes('最近 0 条'), 'prediction history excludes challenge attempts')
  props.exercise = 'counterexample'; render(); await settle()
  assert(text(tree).includes('最近 1 条'))
  assert.equal(JSON.stringify(store.getDocument(document.documentId)), before, 'actual UI plus SQLite routes preserve canonical graph')
  const savedHistory = all(tree, el => el.type === 'button' && text(el).includes(' · 已复盘'))[0]
  assert(savedHistory); savedHistory.props.onClick(); render()
  click('另开一次预测')
  fill('基准情境', '7 km'); fill('改变后的情境', '７ ｋｍ！')
  for (const [key, label] of Object.entries(fields)) if (!['baseline', 'scenario'].includes(key)) fill(label, counterexampleResponse[key])
  click('保存预测'); await settle()
  assert(text(tree).includes('仅修改标点或排版不构成条件变化'))
  assert.equal(input('基准情境').props.value, '7 km', 'invalid challenge retains all unsaved fields')
  assert.equal(store.listLearningAttempts(document.documentId, 'taxi', 'counterexample').length, 1)
  console.log(JSON.stringify({ ok: true, generatedProductionComponents: true, actualSqliteHttp: true, pairRaceFenced: true, explicitSelection: true,
    targetIdentity: true, challengeDraftScopes: true, idempotentLostResponse: true, visibleInvalidChange: true, graphUnchanged: true }))
} finally { owner.slots.forEach(state => state.cleanup?.()); harness.stop() }
