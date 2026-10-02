import assert from 'node:assert/strict'
import { createModelChainTools } from '../src/kg-model-chain.mjs'
import { modelChainDraft } from './kg-model-chain-fixture-data.mjs'

const tools = createModelChainTools()
assert.equal(typeof tools.parseExchange, 'function', 'exported drafts need a bounded, identity-bound restore path')
const context = { documentId: 'document-one', modelId: 'taxi', revision: 2 }
const draft = modelChainDraft()
const envelope = { format: 'dsh.model-chain-draft', version: 1, documentId: context.documentId, revision: 1,
  modelIds: draft.steps.map(step => step.modelId), draft }
const parse = value => tools.parseExchange(JSON.stringify(value), context)
const restored = parse(envelope)
assert.deepEqual(restored, { documentId: context.documentId, revision: 1, peerId: 'budget-model', draft })
assert.equal(restored.revision, 1, 'source revision is retained, never silently rebased')
const legacy = { ...envelope, format: undefined, basis: 'recorded_fields_and_learner_reports_not_semantic_validity', persisted: false,
  status: 'worksheet_complete', firstStop: null, issues: [], warnings: [], steps: [{ model: { nodeId: 'forged' } }] }
assert.deepEqual(parse(legacy), restored, 'legacy exported receipts restore only text and identity, never checks or evidence snapshots')
for (const id of ['source:model-beta', '模型乙']) {
  const copy = structuredClone(envelope)
  copy.modelIds[1] = copy.draft.steps[1].modelId = id
  assert.equal(parse(copy).peerId, id)
}
const rejects = (mutate, pattern) => {
  const copy = structuredClone(envelope); mutate(copy)
  assert.throws(() => parse(copy), pattern)
}
rejects(value => { value.documentId = 'other-document' }, /文档/)
rejects(value => { value.modelIds[0] = value.draft.steps[0].modelId = 'other-model' }, /第一个模型/)
rejects(value => { value.modelIds[1] = 'different-model' }, /身份/)
rejects(value => { value.modelIds[1] = value.draft.steps[1].modelId = 'taxi' }, /不同模型/)
rejects(value => { value.modelIds = ['taxi'] }, /身份/)
rejects(value => { value.revision = 3 }, /高于当前/)
for (const revision of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, '1', null]) rejects(value => { value.revision = revision }, /版本/)
rejects(value => { value.version = 2 }, /格式或版本/)
rejects(value => { value.format = 'foreign-format' }, /格式或版本/)
rejects(value => { delete value.format }, /格式或版本/)
rejects(value => { value.draft.steps[0].inputs[0].source = 'automatic' }, /输入来源/)
rejects(value => { value.draft.steps[0].inputs.push(structuredClone(value.draft.steps[0].inputs[0])) }, /槽位重复/)
rejects(value => { value.draft.steps[0].outputs[0].value = 'x'.repeat(1001) }, /文字格式或长度/)
rejects(value => { value.draft.steps[0].inputs[0].verified = true }, /不支持的字段/)
assert.throws(() => tools.parseExchange('{broken', context), /JSON/)
assert.throws(() => tools.parseExchange(' '.repeat(2 * 1024 * 1024 + 1), context), /过大/)
assert.throws(() => tools.parseExchange('[]', context), /对象/)
const hostile = structuredClone(envelope)
hostile.draft.scenario = '<img src=x onerror=alert(1)>'
assert.equal(parse(hostile).draft.scenario, hostile.draft.scenario, 'text is retained as text, not converted into trusted markup')
console.log('model chain exchange: bounded JSON, legacy exports, document/model identity, source version, untrusted receipts and strict draft contract passed')
