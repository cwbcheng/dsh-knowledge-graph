import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelChainFixture, modelChainDraft } from './kg-model-chain-fixture-data.mjs'

const harness = await modelLearningHarness({ fixture: modelChainFixture() })
const { document, store, post } = harness
let owner = { slots: [], effects: [] }, cursor = 0, tree, props
const updates = [], storage = new Map(), requests = [], deferred = []
let paused = false, foreign = false, oldHost = false, malformed = false, transportFailure = false, storageFailure = false, confirm = true
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
const context = { window: { React, confirm: () => confirm }, console, AbortController, setTimeout, clearTimeout,
  sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => { if (storageFailure) throw new Error('Quota'); storage.set(key, value) } } }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), context)
let Component = context.window.KGViewer.ConnectionModelChain
const load = (args, signal) => {
  requests.push({ args, signal })
  const run = async () => {
    if (transportFailure && args.chainDraft) throw new Error('Chain transport failed')
    const value = await post(args, 'connection-models')
    if (foreign) return { ...value, documentId: 'foreign-document' }
    if (oldHost) return { ...value, modelChainVersion: undefined }
    if (malformed && args.chainDraft) return { ...value, chain: { ...value.chain, issues: undefined } }
    return value
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
const button = label => { const found = all(tree, el => el.type === 'button' && (el.props['aria-label'] === label || text(el) === label))[0]; assert(found, 'Missing button: ' + label); return found }
const click = label => { const found = button(label); assert(!found.props.disabled, label); found.props.onClick(); render() }
const input = label => { const found = all(tree, el => ['textarea', 'select', 'input'].includes(el.type) && el.props['aria-label'] === label)[0]; assert(found, 'Missing field: ' + label); return found }
const fill = (label, value) => { input(label).props.onChange({ target: { value } }); render() }
const choose = id => { const found = all(tree, el => el.type === 'button' && text(el).includes(id + ' · '))[0]; assert(found, 'Missing peer: ' + id); found.props.onClick(); render() }
const mount = next => {
  owner.slots.forEach(state => state.cleanup?.()); updates.length = 0; owner = { slots: [], effects: [] }; props = { ...next }; render()
}
const basicProps = { documentId: document.documentId, revision: 1, modelId: 'taxi', active: true, load }
const seed = modelChainDraft()
const storedKey = 'dsh-kg-model-chain:' + JSON.stringify([document.documentId, 'taxi'])
const exchange = (peerId = 'budget-model', revision = 1) => ({ format: 'dsh.model-chain-draft', version: 1,
  documentId: document.documentId, revision, modelIds: ['taxi', peerId], draft: modelChainDraft(peerId) })
const importFile = (value, overrides = {}) => {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  const target = { value: 'same-file.json', files: [{ size: Buffer.byteLength(raw), text: async () => raw, ...overrides }] }
  const pending = input('选择推测草稿文件').props.onChange({ target }); render()
  assert.equal(target.value, '', 'the same file can be retried after an error or cancellation')
  return pending
}
function fillDraft() {
  fill('具体情境', seed.scenario); fill('推测目标', seed.goal)
  fill('第 1 步分支', 'extra'); fill('第 2 步分支', 'subtract')
  fill('第 1 步 · 行驶距离已知值或状态', '5'); fill('第 1 步 · 行驶距离输入依据', '本次里程记录')
  fill('第 1 步 · 基础费用预测', '14')
  fill('第 2 步 · 行程基础费用输入来源', 'link'); fill('第 2 步 · 行程基础费用承接槽位', 'fare-slot')
  for (const label of ['含义核对', '单位口径核对', '时间状态核对', '对象范围核对']) fill('第 2 步 · 行程基础费用' + label, '同一次行程的自述核对，未独立验证')
  fill('第 2 步 · 行程预算已知值或状态', '20'); fill('第 2 步 · 行程预算输入依据', '这次行程的个人预算')
  fill('第 2 步 · 剩余预算预测', '6')
  for (const index of [1, 2]) {
    fill('第 ' + index + ' 步适用条件与边界依据', '假定同一次行程没有附加支出')
    fill('第 ' + index + ' 步应用过程', '依据所选文字规律，由我填写预测')
  }
}
try {
  const graphBefore = store.getDocument(document.documentId), unitsBefore = store.getDocumentSourceUnits(document.documentId)
  mount(basicProps); await settle()
  assert.equal(requests.filter(item => item.args.compareModelId).length, 0, 'no automatic second model selection')
  assert.equal(requests.filter(item => item.args.chainDraft).length, 0)
  assert(button('检查推测缺口').props.disabled)
  assert(button('导出推测草稿').props.disabled)
  assert(button('导入推测草稿'))
  choose('budget-model'); await settle()
  assert(!button('导出推测草稿').props.disabled, 'an unchecked, incomplete draft can be backed up')
  click('检查推测缺口'); await settle()
  assert(text(tree).includes('停在第 1 步'))
  fillDraft()
  const checkButton = button('检查推测缺口'); checkButton.props.onClick(); checkButton.props.onClick(); render(); await settle()
  assert.equal(requests.filter(item => item.args.chainDraft).length, 2, 'single-flight check despite double click')
  assert(text(tree).includes('草稿字段已齐备'))
  assert(text(tree).includes('fare-slot → expense：14'))
  assert(text(tree).includes('尚未独立核验'))
  assert(button('导出推测草稿'))
  const checksBeforeImport = requests.filter(item => item.args.chainDraft).length
  const cachedBeforeImport = storage.get(storedKey)
  const file = exchange(); file.draft.goal = '从文件恢复的目标'
  file.draft.scenario = '<img src=x onerror=alert(1)>'
  const legacy = { ...file, format: undefined, basis: 'recorded_fields_and_learner_reports_not_semantic_validity', persisted: false,
    status: 'worksheet_complete', firstStop: null, issues: [], steps: [{ model: { nodeId: 'forged' } }] }
  await importFile(legacy); await settle()
  assert(text(tree).includes('待导入草稿'))
  assert(!all(tree, el => el.type === 'img' || el.props?.dangerouslySetInnerHTML).length, 'file text is not mounted as HTML')
  assert.equal(storage.get(storedKey), cachedBeforeImport, 'preview leaves current text and cache intact')
  assert.equal(input('推测目标').props.value, seed.goal)
  click('取消导入'); assert.equal(storage.get(storedKey), cachedBeforeImport)
  await importFile(legacy); await settle()
  confirm = false; click('确认替换为导入草稿')
  assert.equal(storage.get(storedKey), cachedBeforeImport)
  confirm = true; click('确认替换为导入草稿'); await settle()
  assert.equal(input('推测目标').props.value, file.draft.goal)
  assert(!text(tree).includes('草稿字段已齐备'), 'imported successful receipts never become current check results')
  assert.equal(requests.filter(item => item.args.chainDraft).length, checksBeforeImport, 'import neither checks nor executes the draft automatically')
  click('检查推测缺口'); await settle(); assert(text(tree).includes('草稿字段已齐备'))
  const cacheAfterImport = storage.get(storedKey)
  for (const bad of ['{broken', { ...exchange(), documentId: 'foreign-document' }, exchange('missing-model'),
    { ...exchange(), modelIds: ['other', 'budget-model'] }, exchange('budget-model', 2)]) {
    await importFile(bad); await settle()
    assert(text(tree).includes('当前草稿未覆盖'))
    assert.equal(storage.get(storedKey), cacheAfterImport)
    assert.equal(input('推测目标').props.value, file.draft.goal)
    assert(!text(tree).includes('待导入草稿'))
  }
  await importFile(exchange(), { size: 2 * 1024 * 1024 + 1 }); await settle()
  assert(text(tree).includes('最多 2 MiB')); assert.equal(storage.get(storedKey), cacheAfterImport)
  await importFile(exchange(), { text: async () => { throw new Error('File read failed') } }); await settle()
  assert(text(tree).includes('File read failed')); assert.equal(storage.get(storedKey), cacheAfterImport)
  for (const kind of ['foreign', 'oldHost']) {
    if (kind === 'foreign') foreign = true; else oldHost = true
    await importFile(exchange()); await settle()
    assert(text(tree).includes('当前身份或服务版本不一致'))
    assert.equal(storage.get(storedKey), cacheAfterImport)
    foreign = oldHost = false
  }
  let releaseFile
  const lateFile = importFile(exchange(), { text: () => new Promise(resolve => { releaseFile = resolve }) })
  fill('推测目标', '读取文件期间继续编辑的目标')
  releaseFile(JSON.stringify(exchange())); await lateFile; await settle()
  assert.equal(input('推测目标').props.value, '读取文件期间继续编辑的目标')
  assert(!text(tree).includes('待导入草稿'), 'a delayed read cannot replace later edits')
  paused = true
  const lateModels = importFile(exchange('模型乙')); await settle()
  const pendingImport = deferred.splice(0); assert.equal(pendingImport.length, 1)
  fill('推测目标', '读取模型期间的新目标')
  assert(pendingImport[0].signal.aborted)
  pendingImport[0].resolve(); await lateModels; await settle()
  assert(!text(tree).includes('待导入草稿'))
  paused = false
  for (const peerId of ['source:model-beta', '模型乙', 'budget-model']) {
    await importFile(exchange(peerId)); await settle(); click('确认替换为导入草稿'); await settle()
    assert(text(tree).includes('第 2 步 · ' + peerId))
    assert(!text(tree).includes('草稿字段已齐备'))
    assert(text(tree).includes('草稿文字已导入'), 'pair loading must not erase the completed import status')
  }
  fill('第 1 步 · 行驶距离已知值或状态', '')
  assert(!text(tree).includes('草稿字段已齐备'), 'editing immediately invalidates the prior check receipt')
  assert(!button('导出推测草稿').props.disabled, 'missing inputs do not prevent backing up the remaining text')
  click('检查推测缺口'); await settle()
  assert(text(tree).includes('未承接上一步预测'), 'unresolved upstream input cannot silently feed a second step')
  fill('第 1 步 · 行驶距离已知值或状态', '5')
  fill('第 2 步 · 行程基础费用输入来源', 'known'); fill('第 2 步 · 行程基础费用已知值或状态', '旧手填金额')
  fill('第 2 步 · 行程基础费用输入来源', 'link'); fill('第 2 步 · 行程基础费用输入来源', 'known')
  assert.equal(input('第 2 步 · 行程基础费用已知值或状态').props.value, '旧手填金额', 'switching binding mode preserves inactive text')
  fill('第 2 步 · 行程基础费用输入来源', 'link')
  paused = true; click('检查推测缺口'); const oldCheck = deferred.splice(0)
  assert.equal(oldCheck.length, 1)
  fill('推测目标', '新的推测目标，旧回应不得替代')
  assert(oldCheck[0].signal.aborted)
  oldCheck[0].resolve(); await settle(); assert(!text(tree).includes('草稿字段已齐备'))
  paused = false
  mount(basicProps); await settle()
  assert.equal(input('推测目标').props.value, '新的推测目标，旧回应不得替代')
  assert.equal(input('第 2 步 · 行程基础费用承接槽位').props.value, 'fare-slot')
  assert(!text(tree).includes('草稿字段已齐备'), 'cached draft is not cached successful validation')
  click('下一页第 2 步模型'); await settle()
  assert.equal(input('第 2 步 · 行程基础费用承接槽位').props.value, 'fare-slot', 'pagination does not replace the active pair')
  click('上一页第 2 步模型'); await settle()
  fill('搜索第 2 步模型', 't'); await new Promise(resolve => setTimeout(resolve, 260)); await settle()
  confirm = false; choose('units'); await settle()
  assert.equal(input('第 2 步 · 行程基础费用承接槽位').props.value, 'fare-slot')
  confirm = true
  paused = true; choose('units'); const oldPair = deferred.splice(0)
  choose('times'); const nextPair = deferred.splice(0)
  assert(oldPair.every(item => item.signal.aborted))
  nextPair.forEach(item => item.resolve()); await settle(); oldPair.forEach(item => item.resolve()); await settle()
  assert(text(tree).includes('第 2 步 · times')); assert(!text(tree).includes('第 2 步 · units'))
  props.active = false; render(); assert.equal(tree, null)
  props.active = true; render(); const hiddenPair = deferred.splice(0)
  props.active = false; render(); hiddenPair.forEach(item => item.resolve()); await settle(); assert.equal(tree, null)
  assert(hiddenPair.every(item => item.signal.aborted))
  paused = false; props.active = true; render(); await settle()
  choose('budget-model'); await settle(); fillDraft()
  transportFailure = true; click('检查推测缺口'); await settle()
  assert(text(tree).includes('Chain transport failed')); assert.equal(input('第 1 步 · 基础费用预测').props.value, '14')
  transportFailure = false; malformed = true; click('检查推测缺口'); await settle()
  assert(text(tree).includes('检查回应与当前推测草稿不一致'))
  malformed = false; foreign = true; click('检查推测缺口'); await settle()
  assert(text(tree).includes('检查回应与当前推测草稿不一致'))
  foreign = false; oldHost = true; click('检查推测缺口'); await settle()
  assert(text(tree).includes('检查回应与当前推测草稿不一致'))
  oldHost = false; click('检查推测缺口'); await settle(); assert(text(tree).includes('草稿字段已齐备'))
  const current = store.getDocument(document.documentId)
  current.nodes.find(node => node.id === 'taxi').text = '来源更新后的合成计价模型'
  store.saveGraph(current, { sourceText: document.sourceText, sourceUnits: document.sourceUnits, expectedRevision: 1 })
  props.revision = 2; render(); await settle()
  assert(text(tree).includes('草稿来源版本 1，当前版本 2'))
  assert(button('检查推测缺口').props.disabled)
  assert.equal(input('第 1 步 · 基础费用预测').props.value, '14')
  confirm = false; click('对照后使用当前版本'); assert(button('检查推测缺口').props.disabled)
  confirm = true; click('对照后使用当前版本'); click('检查推测缺口'); await settle(); assert(text(tree).includes('草稿字段已齐备'))
  storageFailure = true; fill('推测目标', '缓存失败也保留页面文字')
  assert(text(tree).includes('标签页草稿未缓存'))
  assert.equal(input('推测目标').props.value, '缓存失败也保留页面文字')
  storageFailure = false
  await importFile(exchange()); await settle(); click('确认替换为导入草稿'); await settle()
  assert(text(tree).includes('草稿来源版本 1，当前版本 2'))
  assert(button('检查推测缺口').props.disabled, 'import does not silently change the source revision')
  confirm = false; click('对照后使用当前版本'); assert(button('检查推测缺口').props.disabled)
  confirm = true; click('对照后使用当前版本'); click('检查推测缺口'); await settle(); assert(text(tree).includes('草稿字段已齐备'))
  await importFile(exchange('模型乙')); await settle()
  fill('推测目标', '预览之后的编辑必须取消替换')
  assert(!text(tree).includes('待导入草稿'))
  let hiddenFileRelease
  const hiddenImport = importFile(exchange(), { text: () => new Promise(resolve => { hiddenFileRelease = resolve }) })
  props.active = false; render()
  hiddenFileRelease(JSON.stringify(exchange())); await hiddenImport; await settle(); assert.equal(tree, null)
  props.active = true; render(); await settle()
  assert(!text(tree).includes('待导入草稿'), 'inactive workbenches do not apply or show a late import')
  props.modelId = 'multi'; render(); await settle()
  assert.equal(input('具体情境').props.value, '', 'primary model drafts are isolated')
  assert.equal(store.listLearningAttempts(document.documentId).length, 0)
  storage.set(storedKey, '{broken')
  mount({ ...basicProps, revision: 2 }); await settle()
  assert(text(tree).includes('原缓存未覆盖')); assert.equal(storage.get(storedKey), '{broken')
  fill('具体情境', '暂时编辑的情境'); assert.equal(storage.get(storedKey), '{broken')
  confirm = false; click('重新建立标签页草稿'); assert.equal(storage.get(storedKey), '{broken')
  confirm = true; click('重新建立标签页草稿'); assert.notEqual(storage.get(storedKey), '{broken')
  assert.deepEqual(store.getDocumentSourceUnits(document.documentId), unitsBefore)
  assert.deepEqual(store.getDocument(document.documentId).edges, graphBefore.edges)
  Component = context.window.KGViewer.ConnectionModelPanel
  oldHost = true
  mount({ documentId: document.documentId, revision: 2, load,
    focusRequest: { documentId: document.documentId, revision: 2, type: 'connection_model', nodeId: 'taxi' } }); await settle()
  assert(button('两步推测').props.disabled, 'the workbench must gate the new entry, not merely reject after opening')
  assert(text(tree).includes('两步推测版本尚未就绪'))
  oldHost = false
  click('重新读取模型'); await settle()
  assert(!button('两步推测').props.disabled)
  click('两步推测')
  let chainChild = all(tree, el => el.type === context.window.KGViewer.ConnectionModelChain)[0]
  assert(chainChild.props.active)
  chainChild.props.onOpen('budget-model'); render(); await settle()
  assert.equal(all(tree, el => el.type === context.window.KGViewer.ConnectionModelChain)[0].props.modelId, 'budget-model')
  click('返回上一个模型'); await settle()
  chainChild = all(tree, el => el.type === context.window.KGViewer.ConnectionModelChain)[0]
  assert.equal(chainChild.props.modelId, 'taxi')
  assert(chainChild.props.active, 'return restores the chain tab, not just the previous model identity')
  console.log('model chain UI: actual production route, explicit selection, draft export/import preview and confirmation, untrusted receipts, import races, mode-preserving cache, stale guards, source CAS rebase, malformed cache and no learner writes passed')
} finally { owner.slots.forEach(state => state.cleanup?.()); harness.stop() }
