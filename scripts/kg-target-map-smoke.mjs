import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createTargetMapTools } from '../src/kg-target-map.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'
import { targetMapFixture, motionTargetMap } from './kg-target-map-fixture-data.mjs'
const tools = createTargetMapTools(), fixture = targetMapFixture(), base = { documentId: fixture.documentId, expectedRevision: 1 }
const reorderKeys = value => Array.isArray(value) ? value.map(reorderKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorderKeys(item)])) : value
const map = motionTargetMap(), original = JSON.stringify(fixture)
const read = (args, records = []) => tools.handle(fixture, { ...base, ...args }, records, 100)
assert.equal(read({ action: 'catalog' }).items.length, 20)
assert.equal(read({ action: 'catalog' }).total, 28)
assert.equal(read({ action: 'catalog', offset: 20 }).items.length, 8)
assert.deepEqual(read({ action: 'catalog', query: '速度', mode: 'discrimination' }).items.map(item => item.id), ['speed-before', 'speed-after'])
const catalogueRecords = [
  { documentId: base.documentId, target: { id: 'speed-before' }, baseRevision: 1 },
  { documentId: base.documentId, target: { id: 'speed-before' }, baseRevision: 2 },
  { documentId: 'another-document', target: { id: 'speed-after' }, baseRevision: 1 },
  { documentId: base.documentId, target: { id: 'removed-target' }, baseRevision: 1 },
]
const personalCatalogue = read({ action: 'catalog', records: 'saved' }, catalogueRecords)
assert.equal(personalCatalogue.total, 1, 'Find previously saved targets without remembering their names, before pagination')
assert.equal(personalCatalogue.records, 'saved')
assert.deepEqual(personalCatalogue.items.map(item => [item.id, item.recordCount, item.currentRecordCount]), [['speed-before', 2, 1]])
assert.equal(read({ action: 'catalog', records: 'saved', mode: 'connection' }, catalogueRecords).total, 0)
assert.equal(read({ action: 'catalog', records: 'saved', query: 'speed-after' }, catalogueRecords).total, 0, 'Same names and other documents never transfer personal records')
assert.equal(read({ action: 'catalog', records: 'saved', offset: 20 }, catalogueRecords).items.length, 0)
assert.equal(read({ action: 'catalog', records: 'saved' }).total, 0, 'Unsaved drafts are not saved records')
for (const records of [null, true, 'mastered', {}, ['saved']]) assert.equal(read({ action: 'catalog', records }).error?.code, 'invalid_input')
assert.equal(read({ action: 'catalog', expectedRevision: 2, records: 'saved' }, catalogueRecords).error.code, 'revision_conflict')
assert(read({ action: 'read', targetId: 'unknown' }).template.slots.every(slot => slot.name === ''), 'Unknown roles must not become a guessed direction')
assert.equal(read({ action: 'read', targetId: 'externality' }).template.mode, 'discrimination')
assert.equal(read({ action: 'read', targetId: 'judge' }).template.outcomes.length, 2)
const opaqueIdentity = structuredClone(fixture)
opaqueIdentity.graph.nodes.push({ ...opaqueIdentity.graph.nodes[0], id: ' motion ', text: 'Same label, distinct identity' })
assert.equal(tools.handle(opaqueIdentity, { ...base, action: 'read', targetId: ' motion ' }).target.id, ' motion ')
assert.equal(tools.handle(opaqueIdentity, { ...base, action: 'read', targetId: 'motion' }).target.id, 'motion')
assert.equal(map.examples[0].outputs[0].outcomeId, map.examples[1].outputs[0].outcomeId)
assert.equal(map.outcomes.length, 3, 'Codomain retains outcomes without any example')
assert.deepEqual(tools.validate(map), map)
for (const mutate of [
  value => { value.slots[2].id = 'before' }, value => { value.examples[0].inputs.pop() },
  value => { value.examples[0].inputs[0].slotId = 'foreign' }, value => { value.examples[0].outputs[0].outcomeId = 'foreign' },
  value => { value.outcomes[0].slotId = 'before' }, value => { value.examples[0].stage = 'proved' },
  value => { value.mastered = true }, value => { value.examples[0].feedback.text = '答案提前出现' },
  value => { value.examples.push(structuredClone(value.examples[0])) }, value => { value.slots[0].meaning = 'x'.repeat(4001) },
  value => { value.mapping = 'x'.repeat(8001) }, value => { value.outcomes[0].label = '' },
]) { const invalid = structuredClone(map); mutate(invalid); assert.throws(() => tools.validate(invalid), mutate.toString()) }
const pending = structuredClone(map); pending.title = ''; pending.outcomes[0].label = ''; pending.examples.push(tools.example(pending, 'pending', 'prediction'))
assert.doesNotThrow(() => tools.validate(pending, { draft: true }), 'Incomplete editable drafts must survive navigation')
assert.throws(() => tools.validate(pending))
const gapMap = tools.blank({ type: 'connection_model', text: '仅定位填写缺口' })
gapMap.slots.push(tools.slot('same-name-2', 'input', '速度'))
gapMap.examples.push(tools.example(gapMap, ' __proto__" ', 'prediction'))
const gapBytes = JSON.stringify(gapMap)
const gapTargets = () => tools.gaps(gapMap, { targets: true })
assert.deepEqual(gapTargets().map(item => item.message), tools.gaps(gapMap), 'Structured destinations preserve the existing diagnostic messages')
assert.deepEqual(gapTargets()[0].path, ['slots', 'input-1', 'name'])
const lastGap = () => gapTargets().at(-1)
assert.deepEqual(lastGap().path, ['examples', ' __proto__" ', 'context'])
assert.equal(JSON.stringify(gapMap), gapBytes, 'Gap navigation does not complete the model')
gapMap.examples[0].context = '通常而非必然，条件仍未核对'
assert.deepEqual(lastGap().path, ['examples', ' __proto__" ', 'inputs', 'input-1'])
gapMap.examples[0].inputs[0].value = '0'
assert.deepEqual(lastGap().path, ['examples', ' __proto__" ', 'inputs', 'same-name-2'])
gapMap.examples[0].inputs[1].value = ' \n '
assert.deepEqual(lastGap().path, ['examples', ' __proto__" ', 'inputs', 'same-name-2'])
gapMap.examples[0].inputs[1].value = '未知单位与对象，不自动判断相容'
assert.deepEqual(lastGap().path, ['examples', ' __proto__" ', 'process'])
gapMap.examples[0].process = '循环不是证明；来源冲突保持未决'
assert.deepEqual(lastGap().path, ['examples', ' __proto__" ', 'outputs', 'output-1'])
gapMap.examples[0].outputs[0].detail = '无法确定'
assert(!gapTargets().some(item => item.path[0] === 'examples'), 'Presence is not correctness; unknown text remains literal')
gapMap.examples = []
assert.deepEqual(lastGap().path, ['examples'])
const conceptGaps = tools.gaps(tools.blank({ type: 'concept', text: '概念' }), { targets: true })
assert(!conceptGaps.some(item => item.path.at(-1) === 'meaning'), 'Do not invent hidden connection fields for discrimination maps')
const request = { action: 'save', id: 'one', targetId: 'motion', map, parentId: '', reason: '', confirm: true }
const first = read(request).saved; assert(first)
const historyRecords = Array.from({ length: 47 }, (_, index) => ({ ...structuredClone(first), id: 'history-' + String(index).padStart(2, '0'), createdAt: index + 1,
  reason: '保留条件与冲突来源 ' + index }))
const historyArgs = { action: 'history', targetId: 'motion', offset: 0 }
const historyFirst = read(historyArgs, historyRecords)
assert.equal(historyFirst.history?.length, 20, 'All personal revisions need bounded page access, not only the latest 20')
assert.equal(historyFirst.historyHead, 'history-46')
const historyNext = read({ ...historyArgs, offset: 20, historyHead: historyFirst.historyHead }, historyRecords)
const historyLast = read({ ...historyArgs, offset: 40, historyHead: historyFirst.historyHead }, historyRecords)
assert.deepEqual([...historyFirst.history, ...historyNext.history, ...historyLast.history].map(item => item.id), historyRecords.map(item => item.id).reverse())
for (const offset of [-1, 0.5, '20', Number.MAX_SAFE_INTEGER + 1]) assert(read({ ...historyArgs, offset }, historyRecords).error)
assert.equal(read({ ...historyArgs, offset: 20, historyHead: 'history-45' }, historyRecords).error.code, 'history_conflict')
assert.equal(read({ ...historyArgs, targetId: 'externality', historyHead: historyFirst.historyHead }, historyRecords).error.code, 'history_conflict')
assert.equal(read({ ...historyArgs, expectedRevision: 2 }, historyRecords).error.code, 'revision_conflict')
assert.equal(read({ ...historyArgs, offset: 60 }, historyRecords).history.length, 0)
assert(historyFirst.history.every(item => !Object.hasOwn(item, 'map') && !Object.hasOwn(item, 'bases')), 'Page payload is metadata, not 20 full answer snapshots')
assert.equal(read(request, [first]).unchanged, true)
assert.equal(read({ ...request, id: 'lost' }, [first]).error.code, 'attempt_conflict')
assert(read({ ...request, targetId: 'externality' }).error)
assert(read({ ...request, confirm: false }).error)
assert(read({ ...request, expectedRevision: 0 }).error)
const prediction = tools.example(map, '__proto__', 'prediction')
prediction.context = '密闭展示柜中静止的棋子'; prediction.process = '合外力为 0 N，初速度为 0 m/s；预测保持静止。'
prediction.inputs[0].value = '0 N'; prediction.inputs[1].value = '0 m/s'; prediction.outputs[0].outcomeId = 'rest'
const predicting = structuredClone(map); predicting.examples.push(prediction)
const second = read({ ...request, id: 'two', parentId: 'one', reason: '记录一次预测', map: predicting }, [first]).saved
assert.equal(second.bases.__proto__.recordId, 'two', 'Special string identities must not alias object prototypes')
const reviewed = structuredClone(second.map)
reviewed.examples.at(-1).stage = 'reviewed'; reviewed.examples.at(-1).feedback = { kind: 'observation', text: '这次观察保持静止，但未独立核验', source: '个人在当日记录的观察' }
reviewed.mapping += ' 条件并不总是能从眼前现象直接看出。'; reviewed.slots[0].meaning += ' 需要合并各外力。'
const third = read({ ...request, id: 'three', parentId: 'two', reason: '对照后修订上层', map: reviewed }, [second, first]).saved
assert(third); assert.equal(third.bases.__proto__.recordId, 'two'); assert.notEqual(third.map.mapping, second.map.mapping)
const immutableBytes = JSON.stringify([first, second, third])
for (const previous of [second, third]) {
  const reordered = reorderKeys(previous.map)
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(previous.map))
  assert.deepEqual(reordered, previous.map)
  assert.doesNotThrow(() => tools.transition(reordered, previous, [third, second, first]), 'JSON object key order is not a prediction edit')
  assert(read({ ...request, id: 'reordered-' + previous.id, parentId: previous.id, reason: '仅字段顺序不同', map: reordered }, [previous, first]).saved)
}
for (const previous of [first, second, third]) assert.equal(read({ ...request, id: previous.id, parentId: previous.parentId,
  reason: previous.reason, map: reorderKeys(previous.map) }, [third, second, first]).unchanged, true, 'Equivalent retries must not append or conflict')
for (const mutate of [
  value => { value.examples.at(-1).context += ' ' }, value => { value.examples.at(-1).process += '必然' },
  value => { value.examples.at(-1).inputs.reverse() }, value => { value.examples.at(-1).inputs[0].slotId = value.examples.at(-1).inputs[1].slotId },
  value => { value.examples.at(-1).inputs[0].value = '0' }, value => { value.examples.at(-1).outputs[0].outcomeId = 'uniform' },
  value => { value.examples.at(-1).feedback.kind = 'ai' }, value => { value.examples.at(-1).feedback.source += '冲突来源' },
  value => { value.slots[1].scope = '同一名称，不同对象与时刻' }, value => { value.slots[0].unit = 'kN' },
  value => { value.outcomes[1].detail = '未知方向；循环不构成证明' },
]) {
  const invalid = reorderKeys(third.map); mutate(invalid)
  assert.throws(() => tools.transition(invalid, third, [third, second, first]), mutate.toString())
  assert(read({ ...request, id: 'three', parentId: 'two', reason: third.reason, map: invalid }, [third, second, first]).error)
}
for (const mutate of [value => { value.examples.reverse() }, value => { value.slots.reverse() }, value => { value.outcomes.reverse() },
  value => { value.conditions += ' ' }, value => { value.boundary = '无条件' }, value => { value.title += 'x' }]) {
  const invalid = reorderKeys(third.map); mutate(invalid)
  assert.equal(read({ ...request, id: 'three', parentId: 'two', reason: third.reason, map: invalid }, [third, second, first]).error.code, 'attempt_conflict', 'Retry equality retains arrays and literal text')
}
assert.equal(JSON.stringify([first, second, third]), immutableBytes, 'Comparisons never rewrite saved snapshots')
for (const mutate of [
  value => { value.examples.at(-1).process = '事后改写预测' }, value => { value.examples.pop() },
  value => { value.slots[0].unit = 'kN' }, value => { value.slots[1].scope = '另一个物体' },
  value => { value.slots[2].scope = '原状态' }, value => { value.outcomes[1].label = '匀速运动' },
  value => { value.examples[0].stage = 'prediction' }, value => { value.examples.at(-1).feedback.text = '改变已保存结果' },
]) { const invalid = structuredClone(third.map); mutate(invalid); assert(read({ ...request, id: 'bad', parentId: 'three', reason: 'attempt', map: invalid }, [third, second, first]).error, mutate.toString()) }
assert(read({ ...request, id: 'forged-review', map: reviewed }).error, 'Feedback cannot arrive before a committed prediction')
const roundMap = { ...structuredClone(third.map), examples: [] }
const roundRequest = { ...request, id: 'round-start', parentId: 'three', reason: '重新判断必要输入，保留旧预测', map: roundMap, startRound: true }
const round = read(roundRequest, [third, second, first]).saved
assert(round, 'Frozen predictions need an explicit new round, not deletion or perpetual structural lock')
assert.equal(round.startsRound, true); assert.deepEqual(round.bases, {}); assert.equal(round.parentId, 'three')
assert.deepEqual(round.map, roundMap); assert.equal(read(roundRequest, [round, third, second, first]).unchanged, true)
assert(read({ ...roundRequest, map: reorderKeys(roundMap) }, [third, second, first]).saved, 'An explicit new round accepts equal upper fields in another key order')
assert.equal(read({ ...roundRequest, map: reorderKeys(roundMap) }, [round, third, second, first]).unchanged, true)
assert.equal(read({ ...roundRequest, startRound: false }, [round, third]).error.code, 'attempt_conflict')
for (const mutate of [
  value => { value.startRound = 'true' }, value => { value.confirm = false }, value => { value.reason = ' ' },
  value => { value.parentId = 'two' }, value => { value.expectedRevision = 2 }, value => { value.targetId = 'unknown' },
  value => { value.map.examples = structuredClone(third.map.examples) },
  value => { value.map.slots[0].unit = 'kN' }, value => { value.map.conditions = '无条件' },
]) { const bad = structuredClone(roundRequest); mutate(bad); assert(read(bad, [third, second, first]).error, mutate.toString()) }
assert(read({ ...roundRequest, parentId: '' }).error, 'New rounds require an existing personal snapshot')
const restructured = structuredClone(round.map)
restructured.slots[0].unit = 'kN'; restructured.slots[0].scope = '另一个对象，另一时刻'
restructured.slots.push(tools.slot('same-label-new-input', 'input', restructured.slots[0].name))
const revisedRound = read({ ...request, id: 'round-revised', parentId: round.id, reason: '新轮次修正结构', map: restructured }, [round, third, second, first]).saved
assert(revisedRound); assert.equal(revisedRound.map.slots.length, 4)
assert.deepEqual(read({ action: 'record', targetId: 'motion', recordId: 'three' }, [revisedRound, round, third]).record, third, 'New structure never rewrites prior predictions or feedback')
const roundRepeat = { ...structuredClone(prediction), id: 'round-repeated', exposure: 'self_reported_new' }
const repeatMap = { ...structuredClone(round.map), examples: [roundRepeat] }
assert(read({ ...request, id: 'round-repeat', parentId: round.id, reason: '曾见情境不能重新变成未见', map: repeatMap }, [round, third, second, first]).error)
const duplicate = structuredClone(third.map), repeated = structuredClone(prediction)
repeated.id = 'repeat'; repeated.context = ' \n密闭展示柜中静止的棋子\t'; repeated.exposure = 'self_reported_new'; duplicate.examples.push(repeated)
assert(read({ ...request, id: 'seen', parentId: 'three', reason: 'repeat', map: duplicate }, [third, second, first]).error)
const distinctContexts = [['x > 3', 'x < 3'], ['f(x,y)', 'f(xy)'], ['a-b', 'ab'], ['x = 3', 'x != 3'], ['x²', 'x2'], ['x y', 'xy']]
for (const [known, candidate] of distinctContexts) {
  const distinct = structuredClone(map), nextCase = structuredClone(prediction)
  distinct.examples[0].context = known; nextCase.context = candidate; nextCase.exposure = 'self_reported_new'; distinct.examples.push(nextCase)
  assert(read({ ...request, id: 'distinct', map: distinct }).saved, 'Do not erase mathematical or token distinctions: ' + known + ' / ' + candidate)
}
const sameBatch = structuredClone(map), sameContext = structuredClone(prediction)
sameContext.context = sameBatch.examples[0].context; sameContext.exposure = 'self_reported_new'; sameBatch.examples.push(sameContext)
assert(read({ ...request, id: 'same-batch', map: sameBatch }).error, 'Same-save material cannot be relabeled as unseen')
const opaque = structuredClone(map)
opaque.mapping = 'input = output; output = input; 未知方向与循环，不执行。<script>throw new Error("never execute")</script>'
opaque.conditions = '可能成立，仅在特定对象与时间中'; opaque.boundary = '来源甲与来源乙相冲突，保持未决'
assert.equal(read({ ...request, id: 'opaque', map: opaque }).saved.map.mapping, opaque.mapping)
assert.equal(JSON.stringify(fixture), original)
for (const file of ['src/index.host.js', 'src/index.client.js', 'lib/index.js', 'lib/client.js', 'extension/viewer.js']) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  const start = source.indexOf('// >>> GENERATED TARGET MAP TOOLS >>>'), end = source.indexOf('// <<< END TARGET MAP TOOLS <<<', start)
  assert(start >= 0 && end > start, file)
  const generated = new Function(source.slice(start, end) + '; return TARGET_MAP_TOOLS')()
  assert.deepEqual(generated.handle(fixture, { ...base, ...request }, [], 100), tools.handle(fixture, { ...base, ...request }, [], 100), file)
  assert.doesNotThrow(() => generated.transition(reorderKeys(third.map), third, [third, second, first]), file)
  assert.equal(generated.handle(fixture, { ...base, ...request, map: reorderKeys(map) }, [first], 100).unchanged, true, file)
}
const directory = mkdtempSync(join(tmpdir(), 'kg-target-map-')), path = join(directory, 'isolated.sqlite'), previous = process.env.DSH_KG_DB
process.env.DSH_KG_DB = path
let store = await openSqliteStore(path), server
const cleanups = []
try {
  store.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
  const before = store.getCanonicalDocument(fixture.documentId), beforeUnits = store.getDocumentSourceUnits(fixture.documentId), routes = []
  const host = await import('../lib/index.js?target-map=' + Date.now())
  host.apply({ get: name => name === 'webServer' ? { register: route => { routes.push(route); return () => {} } } : null,
    effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup }, interval: () => () => {} })
  const handler = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  server = createServer((request, response) => Promise.resolve(handler(request, response)).catch(error => { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const call = async args => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/dsh-knowledge-graph/target-map', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ ...base, ...args }) })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result)); return result
  }
  assert.equal((await call({ action: 'read', targetId: 'motion' })).current, null)
  const saved = await call(request); assert(saved.saved && !saved.appendRecord); assert.equal(saved.saved.origin, 'personal_target_map_not_mastery')
  assert.equal((await call(request)).unchanged, true)
  const firstRows = store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()
  assert.equal((await call({ ...request, map: reorderKeys(map) })).unchanged, true, 'HTTP retry compares objects, not serialized key order')
  assert.deepEqual(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all(), firstRows)
  const concurrent = await call({ ...request, id: 'competing' }); assert.equal(concurrent.error.code, 'attempt_conflict')
  assert.equal((await call({ ...request, id: 'foreign-record', documentId: 'other' })).error.code, 'not_found')
  assert.equal((await call({ ...request, targetId: 'speed-before' })).error.code, 'invalid_input')
  const savedPrediction = await call({ ...request, id: 'two', parentId: 'one', reason: '记录预测', map: reorderKeys(predicting) }); assert(savedPrediction.saved)
  assert.equal((await call({ ...request, id: 'two', parentId: 'one', reason: '记录预测', map: predicting })).unchanged, true)
  assert((await call({ ...request, id: 'three', parentId: 'two', reason: '修订', map: reviewed })).saved)
  const reviewedRows = store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()
  assert.equal((await call({ ...request, id: 'three', parentId: 'two', reason: '修订', map: reorderKeys(reviewed) })).unchanged, true)
  for (const mutate of [value => { value.examples.at(-1).process += '必然' }, value => { value.examples.at(-1).inputs.reverse() }, value => { value.slots[1].unit = 'km/h' }]) {
    const invalid = reorderKeys(reviewed); mutate(invalid)
    assert((await call({ ...request, id: 'three', parentId: 'two', reason: '修订', map: invalid })).error)
    assert((await call({ ...request, id: 'rejected-order-edit', parentId: 'three', reason: '不能伪装成字段调序', map: invalid })).error)
  }
  assert.deepEqual(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all(), reviewedRows)
  assert.deepEqual(store.getCanonicalDocument(fixture.documentId), before)
  assert.equal(store.listLearningAttempts(fixture.documentId, 'motion').length, 0, 'Target maps are not prediction or mastery statistics')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM learning_attempts').get().n, 3)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM image_reviews').get().n, 0)
  store.close(); store = await openSqliteStore(path)
  assert.equal(store.targetMap({ ...base, action: 'read', targetId: 'motion' }).current.id, 'three')
  assert.equal((await call({ action: 'record', targetId: 'motion', recordId: 'two' })).record.map.mapping, second.map.mapping)
  const changed = structuredClone(fixture.graph); changed.nodes[0].text += ' 新版本'
  store.saveGraph(changed, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits, expectedRevision: 1 })
  assert.equal((await call({ ...request, id: 'stale', parentId: 'three' })).error.code, 'revision_conflict')
  const fresh = await call({ action: 'read', targetId: 'motion', expectedRevision: 2 })
  assert.equal(fresh.current, null); assert.equal(fresh.historyTotal, 3)
  const old = await call({ action: 'record', targetId: 'motion', recordId: 'three', expectedRevision: 2 }); assert.equal(old.stale, true)
  let head = ''
  const revising = structuredClone(map)
  for (let index = 0; index < 22; index++) {
    const response = await call({ ...request, expectedRevision: 2, id: 'revision-' + index, parentId: head, reason: '独立修订 ' + index, map: revising })
    assert(response.saved); head = response.saved.id
    revising.examples = []; revising.mapping += ' 修订'
  }
  const repeatedOldMaterial = tools.example(revising, 'old-again', 'prediction')
  repeatedOldMaterial.context = map.examples[0].context; repeatedOldMaterial.process = '这个情境见过，不能当成自报未见'
  repeatedOldMaterial.exposure = 'self_reported_new'; repeatedOldMaterial.inputs.forEach(input => { input.value = '已知' }); repeatedOldMaterial.outputs[0].outcomeId = 'uniform'
  revising.examples.push(repeatedOldMaterial)
  const beyondPage = await call({ ...request, expectedRevision: 2, id: 'outside-page', parentId: head, reason: '不能遗忘 20 版以前材料', map: revising })
  assert.equal(beyondPage.error.code, 'invalid_input')
  assert((await call({ action: 'record', targetId: 'motion', recordId: 'one', expectedRevision: 2 })).record, 'Old basis remains reachable beyond history page')
  const wrongTarget = await call({ action: 'record', targetId: 'externality', recordId: 'one', expectedRevision: 2 })
  assert.equal(wrongTarget.error.code, 'not_found', 'Record lookup cannot cross target identity')
  const historyBefore = await call({ action: 'history', targetId: 'motion', expectedRevision: 2, offset: 0 })
  assert.equal(historyBefore.historyTotal, 25); assert.equal(historyBefore.history.length, 20)
  const historyOlder = await call({ action: 'history', targetId: 'motion', expectedRevision: 2, offset: 20, historyHead: historyBefore.historyHead })
  assert.deepEqual(historyOlder.history.map(item => item.id), ['revision-1', 'revision-0', 'three', 'two', 'one'])
  assert(historyOlder.history.every(item => !Object.hasOwn(item, 'map') && typeof item.title === 'string'))
  const rowsBeforeHistory = store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()
  assert.equal((await call({ action: 'history', targetId: 'motion', expectedRevision: 1, offset: 20, historyHead: historyBefore.historyHead })).error.code, 'revision_conflict')
  assert.equal((await call({ action: 'history', targetId: 'externality', expectedRevision: 2, offset: 20, historyHead: historyBefore.historyHead })).error.code, 'history_conflict')
  assert.equal((await call({ action: 'history', targetId: 'motion', expectedRevision: 2, offset: -1 })).error.code, 'invalid_input')
  assert.deepEqual(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all(), rowsBeforeHistory, 'History requests never create or rewrite records')
  assert((await call({ ...request, expectedRevision: 2, id: 'history-concurrent', parentId: head, reason: '另一个窗口的新修订', map })).saved)
  assert.equal((await call({ action: 'history', targetId: 'motion', expectedRevision: 2, offset: 20, historyHead: historyBefore.historyHead })).error.code, 'history_conflict', 'Concurrent append must not silently shift a page')
  const refreshedHistory = await call({ action: 'history', targetId: 'motion', expectedRevision: 2, offset: 0 })
  assert.equal(refreshedHistory.historyTotal, 26); assert.equal(refreshedHistory.historyHead, 'history-concurrent')
  store.db.exec('PRAGMA journal_mode = WAL')
  const writer = await openSqliteStore(path), originalPrepare = DatabaseSync.prototype.prepare
  let interleaved = false
  try {
    DatabaseSync.prototype.prepare = function(sql, ...args) {
      const statement = originalPrepare.call(this, sql, ...args)
      if (sql.startsWith('SELECT attempt_id FROM learning_attempts WHERE')) {
        const originalGet = statement.get
        statement.get = function(...keys) {
          const value = originalGet.apply(this, keys)
          if (!interleaved) {
            interleaved = true
            assert(writer.targetMap({ ...base, ...request, expectedRevision: 2, id: 'history-independent-writer', parentId: 'history-concurrent', reason: '在历史读取期间提交', map }).saved)
          }
          return value
        }
      }
      return statement
    }
    const snapshot = await call({ action: 'history', targetId: 'motion', expectedRevision: 2, offset: 0 })
    assert(interleaved); assert.equal(snapshot.historyHead, 'history-concurrent'); assert.equal(snapshot.historyTotal, 26)
    assert(!snapshot.history.some(item => item.id === 'history-independent-writer'), 'Head, count and page share one read snapshot')
  } finally { DatabaseSync.prototype.prepare = originalPrepare; writer.close() }
  assert.equal((await call({ action: 'history', targetId: 'motion', expectedRevision: 2, offset: 20, historyHead: refreshedHistory.historyHead })).error.code, 'history_conflict')
  assert.equal((await call({ action: 'history', targetId: 'motion', expectedRevision: 2, offset: 0 })).historyTotal, 27)
  assert.deepEqual(store.getDocumentSourceUnits(fixture.documentId), beforeUnits)
  const concept = await call({ action: 'read', targetId: 'externality', expectedRevision: 2 })
  concept.template.mapping = '个人判别依据，尚未独立核验'
  assert((await call({ ...request, id: 'classification', targetId: 'externality', expectedRevision: 2, map: concept.template })).saved)
  let symbolParent = ''
  const symbolMap = structuredClone(map)
  symbolMap.examples = distinctContexts.map(([known], index) => ({ ...structuredClone(map.examples[0]), id: 'known-' + index, context: known }))
  const knownSymbols = await call({ ...request, expectedRevision: 2, targetId: 'unknown', id: 'known-symbols', map: symbolMap })
  assert(knownSymbols.saved); symbolParent = knownSymbols.saved.id
  for (const [index, [, candidate]] of distinctContexts.entries()) {
    const nextCase = structuredClone(prediction)
    nextCase.id = 'symbol-' + index; nextCase.context = candidate; nextCase.exposure = 'self_reported_new'; symbolMap.examples.push(nextCase)
    const result = await call({ ...request, expectedRevision: 2, targetId: 'unknown', id: 'symbols-' + index, parentId: symbolParent, reason: '保留运算符、指数及词元差异', map: symbolMap })
    assert(result.saved, 'Stored context comparison must preserve symbols: ' + candidate); symbolParent = result.saved.id
  }
  const symbolicRepeat = structuredClone(prediction)
  symbolicRepeat.id = 'symbol-repeat'; symbolicRepeat.context = '  x > 3\n'; symbolicRepeat.exposure = 'self_reported_new'; symbolMap.examples.push(symbolicRepeat)
  assert.equal((await call({ ...request, expectedRevision: 2, targetId: 'unknown', id: 'repeat-symbols', parentId: symbolParent, reason: '相同文字仍不能自报未见', map: symbolMap })).error.code, 'invalid_input')
  const protectedRows = store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()
  const beforeRoundGraph = store.getCanonicalDocument(fixture.documentId)
  const latest = (await call({ action: 'read', targetId: 'unknown', expectedRevision: 2 })).current
  const beginRound = { ...request, expectedRevision: 2, targetId: 'unknown', id: 'stored-round', parentId: latest.id, startRound: true,
    reason: '保留旧预测，重新检查必要输入和单位', map: { ...latest.map, examples: [] } }
  const start = await call(beginRound); assert(start.saved?.startsRound); assert.deepEqual(start.saved.bases, {})
  assert.equal((await call(beginRound)).unchanged, true, 'A lost response cannot create two rounds')
  assert.equal((await call({ ...beginRound, id: 'competing-round' })).error.code, 'attempt_conflict')
  assert.equal((await call({ ...beginRound, expectedRevision: 1 })).error.code, 'revision_conflict')
  assert.equal((await call({ ...beginRound, targetId: 'motion' })).error.code, 'attempt_conflict')
  const amended = structuredClone(start.saved.map)
  amended.slots[0].unit = 'kN'; amended.slots[1].scope = '另一个对象，测量前'
  amended.slots.push(tools.slot('extra-input', 'input', amended.slots[0].name))
  assert((await call({ ...beginRound, startRound: false, id: 'stored-round-structure', parentId: start.saved.id, map: amended, reason: '修订新轮结构' })).saved)
  const nextPrediction = tools.example(amended, 'next-round-prediction', 'prediction')
  nextPrediction.context = 'x > 3'; nextPrediction.process = '旧情境不能通过换轮次声称未见'; nextPrediction.exposure = 'self_reported_new'
  nextPrediction.inputs.forEach(item => { item.value = '各自独立的必要输入' }); nextPrediction.outputs[0].detail = '仍未独立验证'
  amended.examples.push(nextPrediction)
  assert.equal((await call({ ...beginRound, startRound: false, id: 'round-seen', parentId: 'stored-round-structure', map: amended })).error.code, 'invalid_input')
  nextPrediction.exposure = 'known'; nextPrediction.inputs.pop()
  assert.equal((await call({ ...beginRound, startRound: false, id: 'round-missing', parentId: 'stored-round-structure', map: amended })).error.code, 'invalid_input', 'A new round does not waive required inputs')
  const afterRoundRows = store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()
  for (const row of protectedRows) assert.deepEqual(afterRoundRows.find(item => item.attempt_id === row.attempt_id), row)
  assert.deepEqual((await call({ action: 'record', targetId: 'unknown', recordId: latest.id, expectedRevision: 2 })).record, latest)
  assert.equal(afterRoundRows.length, protectedRows.length + 2)
  assert.deepEqual(store.getCanonicalDocument(fixture.documentId), beforeRoundGraph)
  assert.deepEqual(store.getDocumentSourceUnits(fixture.documentId), beforeUnits)
  assert.equal(store.listLearningAttempts(fixture.documentId, 'unknown').length, 0)
  const catalogDocumentId = 'saved-catalogue-isolated'
  const catalogGraph = { ...structuredClone(fixture.graph), source: { documentId: catalogDocumentId, id: 'catalogue-source' }, edges: [],
    nodes: Array.from({ length: 845 }, (_, index) => ({ ...structuredClone(fixture.graph.nodes[1]), id: index === 0 ? 'motion' : 'target-' + index,
      documentId: catalogDocumentId, sourceId: 'catalogue-source', text: index === 800 || index === 801 ? '同名但不同身份' : '目录目标 ' + index })) }
  store.saveGraph(catalogGraph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
  const catalogArgs = { action: 'catalog', documentId: catalogDocumentId, expectedRevision: 1, records: 'saved' }
  assert.equal((await call(catalogArgs)).total, 0, 'Another document with the same motion ID has no personal target records')
  const saveCatalog = (targetId, expectedRevision = 1) => call({ ...request, documentId: catalogDocumentId, targetId, expectedRevision,
    id: 'catalogue-' + targetId, map: tools.blank(catalogGraph.nodes.find(node => node.id === targetId)) })
  assert((await saveCatalog('target-800')).saved)
  assert((await saveCatalog('target-844')).saved)
  catalogGraph.nodes.pop()
  store.saveGraph(catalogGraph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits, expectedRevision: 1 })
  catalogArgs.expectedRevision = 2
  for (let index = 802; index < 844; index++) assert((await saveCatalog('target-' + index, 2)).saved)
  const catalogBefore = store.getCanonicalDocument(catalogDocumentId), catalogRows = store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all()
  const pages = []
  for (const offset of [0, 20, 40]) {
    const page = await call({ ...catalogArgs, offset }); assert.equal(page.total, 43); assert.equal(page.offset, offset); pages.push(...page.items)
  }
  assert.equal(new Set(pages.map(item => item.id)).size, 43)
  assert.deepEqual(pages.map(item => item.id), ['target-800', ...Array.from({ length: 42 }, (_, index) => 'target-' + (802 + index))])
  assert.deepEqual([pages[0].recordCount, pages[0].currentRecordCount], [1, 0])
  assert(pages.slice(1).every(item => item.recordCount === 1 && item.currentRecordCount === 1))
  assert(pages.every(item => !Object.hasOwn(item, 'map') && !Object.hasOwn(item, 'reason') && !Object.hasOwn(item, 'examples')))
  assert.equal((await call({ ...catalogArgs, query: '同名' })).total, 1)
  assert.equal((await call({ ...catalogArgs, mode: 'connection' })).total, 0)
  assert.equal((await call({ ...catalogArgs, records: 'all', query: '同名' })).total, 2)
  assert.equal((await call({ ...catalogArgs, expectedRevision: 1 })).error.code, 'revision_conflict')
  assert.deepEqual(store.getCanonicalDocument(catalogDocumentId), catalogBefore)
  assert.deepEqual(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all(), catalogRows, 'Catalogues never write records or promote mastery')
  const catalogWriter = await openSqliteStore(path)
  let catalogInterleaved = false
  try {
    DatabaseSync.prototype.prepare = function(sql, ...args) {
      assert(!sql.includes('SELECT task_json, response_json FROM learning_attempts'), 'Catalogue reads aggregate metadata, not full private snapshots')
      const statement = originalPrepare.call(this, sql, ...args)
      if (sql.startsWith('SELECT model_id AS targetId')) {
        const originalAll = statement.all
        statement.all = function(...keys) {
          const value = originalAll.apply(this, keys)
          if (!catalogInterleaved) {
            catalogInterleaved = true
            catalogWriter.saveGraph(catalogGraph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits, expectedRevision: 2 })
          }
          return value
        }
      }
      return statement
    }
    const snapshot = await call(catalogArgs)
    assert(catalogInterleaved); assert.equal(snapshot.revision, 2); assert.equal(snapshot.items[1].currentRecordCount, 1)
  } finally { DatabaseSync.prototype.prepare = originalPrepare; catalogWriter.close() }
  assert.equal((await call(catalogArgs)).error.code, 'revision_conflict')
  const revisedCatalog = await call({ ...catalogArgs, expectedRevision: 3 })
  assert.equal(revisedCatalog.total, 43); assert(revisedCatalog.items.every(item => item.currentRecordCount === 0))
  assert.deepEqual(store.db.prepare('SELECT * FROM learning_attempts ORDER BY attempt_id').all(), catalogRows)
  assert.deepEqual(store.getCanonicalDocument(fixture.documentId), beforeRoundGraph)
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  for (const cleanup of cleanups.reverse()) cleanup()
  store.close(); if (previous === undefined) delete process.env.DSH_KG_DB; else process.env.DSH_KG_DB = previous
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ ok: true, twoLevelsThreeExpressions: true, codomainNotRange: true, multipleInputsAndManyToOne: true,
  identityAndScope: true, predictionBeforeFeedback: true, frozenPredictionBasis: true, appendOnlyCas: true, actualHttpSqlite: true,
  sourceAndGenerated: true, historyPages: 3, historyNoWrites: true, historyAppendFence: true, historyIndependentWriterSnapshot: true,
  explicitNewRound: true, roundRetryAndCas: true, previousRoundsUnchanged: true, seenAcrossRounds: true,
  graphUnchanged: true, noMasteryPromotion: true, objectKeyOrderIndependent: true, orderedArraysAndLiteralFields: true,
  reorderedHttpRetryNoWrites: true, reorderedPredictionProtected: true, savedCatalogueBeyondCanvas: true,
  savedCataloguePages: 3, savedCatalogueSnapshot: true, savedCatalogueReadOnly: true }))
