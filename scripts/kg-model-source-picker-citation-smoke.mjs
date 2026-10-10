import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { modelLearningHarness } from './kg-model-learning-fixture-data.mjs'
import { modelCitationFixture, modelCitationLocator, modelCitationPanelLocationSource } from './kg-model-citation-locator-fixture.mjs'

// Real Host source candidates and the production editor wrapper / Workbench
// receiver. The caller boundary can pause without inventing a node for a unit.
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const component = value => value.slice(value.indexOf('function ModelSourceFieldPicker('), value.indexOf('// >>> GENERATED TARGET MAP TOOLS >>>')).replaceAll('host.call(', 'rpc(')
for (const path of ['../lib/client.js', '../extension/viewer.js']) assert.equal(component(source), component(readFileSync(new URL(path, import.meta.url), 'utf8')))
let owner, cursor = 0
const slot = initial => { const index = cursor++; return owner.slots[index] ||= initial() }
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState(initial) { const opening = owner, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    return [state.value, next => opening.updates.push(() => { state.value = typeof next === 'function' ? next(state.value) : next })] },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect(fn, deps) { const state = slot(() => ({})); if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
    owner.effects.push(() => { state.cleanup?.(); state.cleanup = fn() }); state.deps = deps
  } },
}
const env = { window: { React, confirm: () => true }, console, AbortController, crypto: { randomUUID: () => 'source-picker-fixture' },
  sessionStorage: { getItem: key => owner.storage.get(key), setItem: (key, value) => owner.storage.set(key, value), removeItem: key => owner.storage.delete(key) },
  documentIdOfGraph: graph => graph?.source?.documentId, setTimeout: () => 1, clearTimeout() {} }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), env)
runInNewContext(source.slice(source.indexOf('function exactSourceQuoteTarget('), source.indexOf('function KnowledgeConsumePanel(')) + '\nthis.target=exactSourceQuoteTarget', env)
const panelStart = source.indexOf('const locateInDetail =', source.indexOf('function ConnectionModelPanel('))
const panelRelay = source.slice(panelStart + 'const locateInDetail ='.length, source.indexOf('\n        const sequence', panelStart)).trim()
const locationEnv = { ...env, useRef: React.useRef, useEffect: React.useEffect }
runInNewContext(source.slice(source.indexOf('function useConnectionModelLocation('), source.indexOf('function ConnectionModelPanel('))
  + '\nthis.locationHook=useConnectionModelLocation', locationEnv)
const viewer = env.window.KGViewer
const all = (node, predicate) => Array.isArray(node) ? Array.from(node).flatMap(child => all(child, predicate)) : !node || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function mount(Component, props) {
  const state = { slots: [], updates: [], effects: [], storage: new Map(), tree: null }; let mounted = true
  const render = () => {
    for (let count = 0; count < 30; count++) {
      owner = state; state.updates.splice(0).forEach(fn => fn()); cursor = 0
      state.tree = Component(props); state.effects.splice(0).forEach(fn => fn()); if (!state.updates.length) return
    }
    throw new Error('Component update loop')
  }
  const settle = async () => { for (let count = 0; count < 12; count++) { await new Promise(setImmediate); if (mounted) render() } }
  const buttons = label => all(state.tree, node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label))
  const click = async label => { const button = buttons(label)[0]; assert(button && !button.props.disabled, label); owner = state;
    button.props.onClick(); await settle() }
  const input = label => all(state.tree, node => ['input', 'textarea'].includes(node.type) && node.props['aria-label'] === label)[0]
  const fill = async (label, value) => { const field = input(label); assert(field && !field.props.disabled, label); owner = state;
    field.props.onChange({ target: { value } }); await settle() }
  const unmount = () => { mounted = false; state.slots.forEach(item => item.cleanup?.()) }
  render(); return { state, props, settle, buttons, click, input, fill, unmount }
}
function navigation(harness, fixture) {
  const references = [], paragraphs = [], changes = [], pending = [], completed = []
  const view = viewer.makeView(harness.store.getDocument(fixture.documentId), fixture.sourceText)
  const context = { resultView: view, fullText: fixture.sourceText, currentResultRef: { current: view }, graphRevisionRef: { current: 1 },
    paragraphLocateSeqRef: { current: 0 }, graphCommitQueueRef: { current: Promise.resolve() }, documentIdOfGraph: env.documentIdOfGraph,
    exactSourceQuoteTarget: env.target, makeView: viewer.makeView, loadGraphDocument: () => assert.fail('Source browsing must not invent a node window'),
    setResultView: value => changes.push(value), setContentScope: value => changes.push(value), navigateWorkspace: value => changes.push(value),
    setChapterFilter: value => changes.push(value), chapterSectionsOf: graph => graph.source.sections || [], graphViewMetadata: () => null,
    setGraphQueryDraft() {}, setGraphPageDraft() {}, setSelectedNodeId: () => assert.fail('Source context is not model-node evidence'), setSelectedEdgeId() {}, setFocusReq() {},
    setActivePara: value => paragraphs.push(value), setFlashPara() {}, ctx: { timeout: fn => fn() }, document: { getElementById: id => ({ id }) },
    scrollElIntoCenter: element => changes.push(element.id), changeReadMode: value => changes.push(value) }
  context.locateConsumptionReference = modelCitationLocator(context)
  const receiver = new Function(...Object.keys(context), 'return ' + modelCitationPanelLocationSource())(...Object.values(context))
  let paused = false
  return { references, paragraphs, changes, pending, completed, pause: () => { paused = true },
    locate(reference, stillCurrent = () => true) {
      references.push(reference)
      const result = (async () => { if (paused) { const hold = deferred(); pending.push(hold); await hold.promise; if (hold.failure) throw new Error(hold.failure) }
        return receiver(reference, stillCurrent) })()
      completed.push(result.then(() => true, () => false)); return result
    } }
}
let citationActions = 0, cancelledCases = 0, explicitDraftApplications = 0
for (const variant of ['sparse', 'dense', 'long-source']) {
  const dense = variant === 'dense', fixture = modelCitationFixture({ dense, anchor: dense ? 2 : 1, long: variant === 'long-source', sourcePages: !dense })
  const harness = await modelLearningHarness({ fixture }), uis = []
  try {
    const before = JSON.stringify(harness.store.getDocument(fixture.documentId)), unitsBefore = JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId))
    const rows = () => JSON.stringify(harness.store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()), recordsBefore = rows(), writes = []
    const load = args => harness.post(args, 'connection-models')
    async function open(nav, extras = {}) {
      const boundary = mount(() => {
        const location = locationEnv.locationHook('source-picker-parent', true)
        return new Function('location', 'api', 'setDetailError', 'return ' + panelRelay)(location, { current: { onLocate: nav.locate } },
          () => assert.fail('A nested picker must own its current navigation error'))
      }, {})
      uis.push(boundary)
      const editor = mount(viewer.ModelStructureEditor, { documentId: fixture.documentId, revision: 1, modelId: 'taxi', active: true, load,
        onCommit: args => { writes.push(args); return harness.post(args, 'connection-model-structure') }, onLocate: boundary.state.tree, busy: false })
      uis.push(editor); await editor.settle(); await editor.click('条件分支 (1)'); await editor.click('从原文选取 base condition')
      const node = all(editor.state.tree, item => item.type === viewer.ModelSourceFieldPicker)[0]; assert(node)
      const picker = mount(viewer.ModelSourceFieldPicker, { ...node.props, ...extras }); uis.push(picker); await picker.settle()
      return { editor, picker, node }
    }
    const nav = navigation(harness, fixture), { editor, picker } = await open(nav)
    const candidate = fixture.sourceUnits[dense ? 2 : 1], label = '打开原文 P' + (candidate.paragraph + 1)
    await picker.click(label); await nav.completed[0]; await picker.settle()
    const reference = nav.references[0]
    assert.equal(reference.documentId, fixture.documentId, 'Opening source context must carry document identity')
    assert.equal(reference.revision, 1); assert.equal(reference.sourceId, fixture.graph.source.id)
    assert.equal(reference.paragraph, candidate.paragraph); assert.equal(reference.quote, candidate.text)
    assert.equal(reference.sourceQuoteOnly, true); assert.equal(reference.sourceCitation, true); assert.equal(reference.nodeId, undefined)
    assert.deepEqual(nav.paragraphs, [dense ? 3 : 1]); assert.equal(editor.input('适用条件 base').props.value, '')
    assert.equal(writes.length, 0); assert(text(picker.state.tree).includes('不是已认定的字段依据')); citationActions++
    await picker.click('选取 P' + (candidate.paragraph + 1))
    if (variant === 'long-source') {
      assert(candidate.text.length > 2000); assert.equal(picker.input('待选原文片段').props.value, '')
      assert(picker.buttons('填入字段草稿')[0].props.disabled)
      await picker.fill('待选原文片段', candidate.text.slice(0, 2001)); assert(picker.buttons('填入字段草稿')[0].props.disabled)
      await picker.fill('待选原文片段', candidate.text.slice(-1900))
    }
    const selected = picker.input('待选原文片段').props.value
    await picker.click(label); await nav.completed[1]; assert.equal(nav.references[1].quote, candidate.text, 'Browsing keeps full context, distinct from the personal draft excerpt')
    await picker.click('填入字段草稿'); await editor.settle()
    assert.equal(editor.input('适用条件 base').props.value, selected); assert.equal(writes.length, 0); explicitDraftApplications++
    assert.equal(harness.store.getDocumentRevision(fixture.documentId), 1)
    if (variant === 'sparse') {
      for (const transition of ['target', 'target-back', 'selection', 'excerpt', 'page', 'page-back', 'reload', 'reload-complete', 'busy', 'busy-back', 'document', 'revision', 'model', 'close', 'section', 'active', 'unmount']) {
        for (const failure of [false, true]) {
          const old = navigation(harness, fixture), reads = []; let pauseReads = false
          const opened = await open(old, { load: async args => { if (pauseReads) { const hold = deferred(); reads.push(hold); await hold.promise } return load(args) } }), current = opened.picker
          await current.click('选取 P8'); old.pause(); await current.click(label); assert.equal(old.pending.length, 1)
          if (transition.startsWith('target')) { current.props.target = { ...current.props.target, field: 'boundary', selectionId: 99 }; await current.settle()
            if (transition.endsWith('back')) { current.props.target = opened.node.props.target; await current.settle() } }
          else if (transition === 'selection') await current.click('选取 P1')
          else if (transition === 'excerpt') await current.fill('待选原文片段', '仅限白天、无附加收费')
          else if (transition.startsWith('page')) { await current.click('下一页原文'); if (transition.endsWith('back')) await current.click('上一页原文') }
          else if (transition.startsWith('reload')) { pauseReads = true; await current.click('重新加载原文候选')
            assert.equal(current.buttons(label).length, 0)
            if (transition === 'reload-complete') { pauseReads = false; reads.forEach(hold => hold.resolve()); await current.settle() } }
          else if (transition.startsWith('busy')) { current.props.busy = true; await current.settle(); if (transition.endsWith('back')) { current.props.busy = false; await current.settle() } }
          else if (['document', 'revision', 'model'].includes(transition)) { current.props[transition === 'document' ? 'documentId' : transition === 'model' ? 'modelId' : 'revision'] = transition === 'revision' ? 2 : 'other'; await current.settle() }
          else { if (transition === 'close') await current.click('关闭原文选取')
            if (transition === 'section') await opened.editor.click('变量槽位 (2)')
            if (transition === 'active') { opened.editor.props.active = false; await opened.editor.settle() }
            current.unmount() }
          if (failure) old.pending[0].failure = '旧原文候选定位失败'
          old.pending[0].resolve(); await old.completed[0]; await current.settle()
          assert.deepEqual(old.paragraphs, [], transition); assert.deepEqual(old.changes, [], transition)
          assert(!text(current.state.tree).includes('旧原文候选定位失败'), transition); assert.equal(writes.length, 0); cancelledCases++
          pauseReads = false; reads.forEach(hold => hold.resolve()); await current.settle()
        }
      }
      const newest = navigation(harness, fixture), twice = await open(newest); newest.pause()
      await twice.picker.click(label); await twice.picker.click('打开原文 P1')
      newest.pending[1].resolve(); await newest.completed[1]; newest.pending[0].failure = '更早点击失败'; newest.pending[0].resolve(); await newest.completed[0]; await twice.picker.settle()
      assert.deepEqual(newest.paragraphs, [0]); assert(!text(twice.picker.state.tree).includes('更早点击失败'))
      const failed = navigation(harness, fixture), broken = await open(failed); failed.pause()
      await broken.picker.click(label); failed.pending[0].failure = '当前原文定位失败，请重试'; failed.pending[0].resolve(); await failed.completed[0]; await broken.picker.settle()
      assert(text(broken.picker.state.tree).includes('当前原文定位失败，请重试'))
      assert(text(broken.picker.state.tree).includes(candidate.text)); await broken.picker.click('选取 P1')
      assert(!text(broken.picker.state.tree).includes('当前原文定位失败，请重试'))
      const blocked = navigation(harness, fixture), captured = await open(blocked), callback = captured.picker.buttons(label)[0].props.onClick
      captured.picker.props.busy = true; await captured.picker.settle(); assert(captured.picker.buttons(label)[0].props.disabled)
      owner = captured.picker.state; callback(); await captured.picker.settle(); assert.equal(blocked.references.length, 0)
      const malformed = await open(navigation(harness, fixture), { load: async args => { const result = await load(args);
        if (result.sourceUnits?.items) result.sourceUnits.items[1].documentId = 'wrong-document'; return result } })
      assert(text(malformed.picker.state.tree).includes('原文候选版本或身份不一致')); assert.equal(malformed.picker.buttons(label).length, 0)
    }
    assert.equal(JSON.stringify(harness.store.getDocument(fixture.documentId)), before)
    assert.equal(JSON.stringify(harness.store.getDocumentSourceUnits(fixture.documentId)), unitsBefore); assert.equal(rows(), recordsBefore)
  } finally { uis.forEach(ui => ui.unmount()); harness.stop() }
}
console.log(JSON.stringify({ ok: true, citationActions, cancelledCases, explicitDraftApplications, actualSourceCandidatesAndHttp: true,
  fullContextAnd2000DraftLimit: true, sparseDenseAndLongTargets: true, editorCallerFence: true, currentFailuresVisible: true,
  newerClickWins: true, candidateNotFieldProof: true, canonicalSourceAndLearningUnchanged: true }))
