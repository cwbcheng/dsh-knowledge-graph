#!/usr/bin/env node
/**
 * 《学习观》 diagnostics.
 *
 * The learning-view ontology claims something the proposition ontology cannot:
 * that a graph built from its node types can be CHECKED for the specific
 * collapses the book names — 上层丢失, 下层丢失, 记言代学, 言存义空, 义存言空,
 * 验证复用旧例. If nothing computed those, the ontology would be a relabelling
 * exercise, which is exactly the "structure without meaning" the local re-cut
 * mode was rejected for.
 *
 * Every case below is a graph literal plus the diagnostics it must and must not
 * produce, so a rule that starts over-firing is caught as loudly as one that
 * stops firing. Each rule is also checked in the CLEAN direction: a well-built
 * knowledge cluster must come back empty, or the diagnostics are noise.
 */

import assert from 'node:assert/strict'

import { diagnoseLearningView, getOntology, ontologyIds } from '../src/kg-ontology.mjs'

const profile = getOntology('learning-view-v1')
const ids = (findings) => findings.map((finding) => finding.id).sort()
const has = (findings, id) => findings.some((finding) => finding.id === id)
const targetsOf = (findings, id) => (findings.find((finding) => finding.id === id) || { targets: [] }).targets

function judge(nodes, edges) {
  return diagnoseLearningView({ nodes, edges }, profile)
}

// ---- a well-built cluster produces nothing --------------------------------
// 概念 with a 特征 (upper), a 正例 (lower) and a 验证材料 drawn from fresh text.
const clean = judge(
  [
    { id: 'concept', type: 'concept', text: '掌握' },
    { id: 'feature', type: 'feature', text: '可分' },
    { id: 'desc', type: 'intension_description', text: '掌握的含义' },
    { id: 'pos', type: 'positive_example', text: '他会骑车', quote: '他会骑车' },
    { id: 'verify', type: 'verification_material', text: '陌生的新例', quote: '从未见过的例子' },
  ],
  [
    { fromNodeId: 'desc', toNodeId: 'concept', relation: 'builds' },
    { fromNodeId: 'feature', toNodeId: 'concept', relation: 'abstracts_to' },
    { fromNodeId: 'pos', toNodeId: 'concept', relation: 'exemplifies' },
    { fromNodeId: 'verify', toNodeId: 'concept', relation: 'verifies' },
  ]
)
assert.deepEqual(clean, [], 'a complete knowledge cluster must produce no diagnostics: ' + JSON.stringify(ids(clean)))

// ---- 上层丢失: examples with nothing abstracted from them -----------------
const upperMissing = judge(
  [
    { id: 'e1', type: 'positive_example', text: '例子一' },
    { id: 'e2', type: 'negative_example', text: '例子二' },
  ],
  []
)
assert(has(upperMissing, 'upper_missing'), 'orphan examples must report 上层丢失')
assert.equal(upperMissing.find((f) => f.id === 'upper_missing').count, 2, 'both orphans must be blamed')

// ---- 下层丢失: a rule with no example behind it ---------------------------
const lowerMissing = judge(
  [
    { id: 'r1', type: 'rule', text: '力等于质量乘加速度' },
    { id: 'd1', type: 'relation_material', text: '输入输出关系' },
  ],
  [{ fromNodeId: 'd1', toNodeId: 'r1', relation: 'describes' }]
)
assert(has(lowerMissing, 'lower_missing'), 'a rule with only upper material must report 下层丢失')
assert(targetsOf(lowerMissing, 'lower_missing').includes('r1'), 'the rule must be blamed')
assert(!has(lowerMissing, 'meaning_without_words'), '上层丢失 is not 义存言空: the words are there')

// ---- 义存言空 / 言存义空 --------------------------------------------------
const meaningOnly = judge(
  [{ id: 'c1', type: 'concept', text: '掌握' }, { id: 'p1', type: 'positive_example', text: '例子' }],
  [{ fromNodeId: 'p1', toNodeId: 'c1', relation: 'exemplifies' }]
)
assert(has(meaningOnly, 'meaning_without_words'), 'examples without any 言 must report 义存言空')
assert(!has(meaningOnly, 'words_without_meaning'), '义存言空 is the opposite of 言存义空')
assert(!has(meaningOnly, 'lower_missing'), 'there is no 上料, so 下层丢失 does not apply')

const wordsOnly = judge([{ id: 'c1', type: 'concept', text: '掌握' }], [])
assert(has(wordsOnly, 'words_without_meaning'), 'a naked knowledge node must report 言存义空')
assert(!has(wordsOnly, 'meaning_without_words'), 'a naked node has no 义 either')
assert(!has(wordsOnly, 'lower_missing'), 'a naked node has no 上料 to lose')
assert(!has(wordsOnly, 'verification_missing'), 'a naked node has no materials to verify')

// ---- 记言代学: a description that never became a feature or model ---------
const memorize = judge(
  [
    { id: 'd1', type: 'intension_description', text: '掌握就是……' },
    { id: 'c1', type: 'concept', text: '掌握' },
    { id: 'p1', type: 'positive_example', text: '例子' },
    { id: 'v1', type: 'verification_material', text: '验证', quote: '独有原文' },
  ],
  [
    { fromNodeId: 'p1', toNodeId: 'c1', relation: 'exemplifies' },
    { fromNodeId: 'v1', toNodeId: 'c1', relation: 'verifies' },
  ]
)
assert(has(memorize, 'memorize_words'), 'a description attached to nothing must report 记言代学')
assert.equal(memorize.find((f) => f.id === 'memorize_words').count, 1)

// ---- 缺验证 --------------------------------------------------------------
assert(has(memorize, 'verification_missing') === false, 'a verified cluster must not report 缺验证')
const unverified = judge(
  [{ id: 'c1', type: 'concept', text: '掌握' }, { id: 'p1', type: 'positive_example', text: '例子' }],
  [{ fromNodeId: 'p1', toNodeId: 'c1', relation: 'exemplifies' }]
)
assert(has(unverified, 'verification_missing'), 'materials without verification must report 缺验证')
assert(targetsOf(unverified, 'verification_missing').includes('c1'), 'the untested knowledge must be blamed')

// ---- 验证复用旧例 --------------------------------------------------------
const recycled = judge(
  [
    { id: 'c1', type: 'concept', text: '掌握' },
    { id: 'p1', type: 'positive_example', text: '他会骑车', quote: '他会骑车' },
    { id: 'v1', type: 'verification_material', text: '他会骑车', quote: '他会骑车' },
  ],
  [
    { fromNodeId: 'p1', toNodeId: 'c1', relation: 'exemplifies' },
    { fromNodeId: 'v1', toNodeId: 'c1', relation: 'verifies' },
  ]
)
assert(has(recycled, 'verification_recycled'), 'a verification reusing an example must report 验证复用旧例')
assert.deepEqual(targetsOf(recycled, 'verification_recycled'), ['v1'], 'the recycled verification must be blamed')

// ---- 下上错配: 上料 wired straight to 下料 of the other model -------------
const mismatch = judge(
  [
    { id: 'rm', type: 'relation_material', text: '输入输出关系' }, // connection, upper
    { id: 'pe', type: 'positive_example', text: '例子' },          // discrimination, lower
  ],
  [{ fromNodeId: 'rm', toNodeId: 'pe', relation: 'exemplifies' }]
)
assert(has(mismatch, 'layer_mismatch'), 'cross-kind 上料/下料 links must report 下上错配')
assert(targetsOf(mismatch, 'layer_mismatch').includes('rm'), 'both ends must be blamed')
assert(targetsOf(mismatch, 'layer_mismatch').includes('pe'), 'both ends must be blamed')

// ---- 判联错配: a model standing on the other model's materials -----------
// Note what is NOT a mismatch: a cluster that only ever built a 判别模型. Most
// single concepts legitimately are discrimination-only, so firing there would
// make the diagnostic noise.
const wrongModel = judge(
  [
    { id: 'cm', type: 'connection_model', text: '联结模型' },   // connection
    { id: 'p1', type: 'positive_example', text: '例子' },        // discrimination
    { id: 'v1', type: 'verification_material', text: '验证', quote: '独有' },
  ],
  [
    { fromNodeId: 'p1', toNodeId: 'cm', relation: 'exemplifies' },
    { fromNodeId: 'v1', toNodeId: 'cm', relation: 'verifies' },
  ]
)
assert(has(wrongModel, 'model_mismatch'), 'a 联结模型 built from 判别 下料 must report 判联错配')
assert(targetsOf(wrongModel, 'model_mismatch').includes('cm'), 'the model must be blamed')
assert(targetsOf(wrongModel, 'model_mismatch').includes('p1'), 'the offending material must be blamed')

const coherentModel = judge(
  [
    { id: 'cm', type: 'connection_model', text: '联结模型' },
    { id: 's1', type: 'segment_example_group', text: '分段例组' }, // connection
    { id: 'v1', type: 'verification_material', text: '验证', quote: '独有' },
  ],
  [
    { fromNodeId: 's1', toNodeId: 'cm', relation: 'exemplifies' },
    { fromNodeId: 'v1', toNodeId: 'cm', relation: 'verifies' },
  ]
)
assert(!has(coherentModel, 'model_mismatch'), 'a 联结模型 built from 联结 下料 must not report 判联错配')

// A discrimination-only cluster is legitimate, not a collapse.
const discriminationOnly = judge(
  [
    { id: 'dm', type: 'discrimination_model', text: '判别模型' },
    { id: 'p1', type: 'positive_example', text: '例子' },
    { id: 'v1', type: 'verification_material', text: '验证', quote: '独有' },
  ],
  [
    { fromNodeId: 'p1', toNodeId: 'dm', relation: 'exemplifies' },
    { fromNodeId: 'v1', toNodeId: 'dm', relation: 'verifies' },
  ]
)
assert(!has(discriminationOnly, 'model_mismatch'), 'a 判别-only cluster is legitimate and must stay silent')

// ---- 联结空载: a 联结模型 that never says what it maps between --------------
// Measured on the source book: this is what the extractor actually produces —
// the mapping ends up inside the model's own text and no material ever states
// the input or the output.
const bareModel = judge(
  [
    { id: 'cm', type: 'connection_model', text: '讲者表达结构到听者理解难度的映射' },
    { id: 'r1', type: 'rule', text: '规律' },
  ],
  [{ fromNodeId: 'r1', toNodeId: 'cm', relation: 'has_rule' }]
)
assert(has(bareModel, 'mapping_missing'), 'a 联结模型 carrying only its rules must report 联结空载')
assert(targetsOf(bareModel, 'mapping_missing').includes('cm'), 'the bare model must be blamed')

// Stating the mapping either way must silence it: explicit edges, or 因素材料.
const mappedModel = judge(
  [
    { id: 'cm', type: 'connection_model', text: '映射' },
    { id: 'in', type: 'concept', text: '输入概念' },
    { id: 'out', type: 'concept', text: '输出概念' },
    { id: 'r1', type: 'rule', text: '规律' },
  ],
  [
    { fromNodeId: 'r1', toNodeId: 'cm', relation: 'has_rule' },
    { fromNodeId: 'cm', toNodeId: 'in', relation: 'maps_between' },
    { fromNodeId: 'cm', toNodeId: 'out', relation: 'maps_between' },
  ]
)
assert(!has(mappedModel, 'mapping_missing'), 'a 联结模型 with maps_between edges must stay silent')

const factoredModel = judge(
  [
    { id: 'cm', type: 'connection_model', text: '映射' },
    { id: 'f1', type: 'factor_material', text: '输入变量' },
    { id: 'r1', type: 'rule', text: '规律' },
  ],
  [
    { fromNodeId: 'r1', toNodeId: 'cm', relation: 'has_rule' },
    { fromNodeId: 'f1', toNodeId: 'cm', relation: 'states_variable' },
  ]
)
assert(!has(factoredModel, 'mapping_missing'), 'a 联结模型 with 因素材料 must stay silent')

// 联结空载 is about 联结模型: a 判别模型 maps nothing between.
const discriminatingOnly = judge(
  [
    { id: 'dm', type: 'discrimination_model', text: '判别模型' },
    { id: 'p1', type: 'positive_example', text: '例子' },
  ],
  [{ fromNodeId: 'p1', toNodeId: 'dm', relation: 'exemplifies' }]
)
assert(!has(discriminatingOnly, 'mapping_missing'), '联结空载 must not fire on a 判别模型')


// ---- 学习材料当记忆材料 --------------------------------------------------
const asMemory = judge(
  [
    { id: 'c1', type: 'concept', text: '掌握' },
    { id: 'm1', type: 'memory_material', text: '定义原文' },
  ],
  [{ fromNodeId: 'm1', toNodeId: 'c1', relation: 'supports' }]
)
assert(has(asMemory, 'material_as_memory'), '记忆材料 attached as material must report 学习材料当记忆材料')

const memoryOnly = judge([{ id: 'm1', type: 'memory_material', text: '定义原文' }], [])
assert(!has(memoryOnly, 'material_as_memory'), 'an unattached 记忆材料 is not being used as material')

// ---- every declared diagnostic is reachable ------------------------------
// A diagnostic nobody can trigger is a promise the ontology does not keep.
const reached = new Set()
const allCases = [upperMissing, lowerMissing, meaningOnly, wordsOnly, memorize, unverified, recycled, mismatch, wrongModel, asMemory]
for (const findings of allCases) for (const finding of findings) reached.add(finding.id)
for (const declared of profile.diagnostics) {
  assert(reached.has(declared.id), 'no case triggers diagnostic ' + declared.id + ' (' + declared.zh + ')')
}
// ...and the clean case reaches none of them.
const cleanIds = new Set(ids(clean))
assert.equal(cleanIds.size, 0, 'the clean case must not trigger anything')

// ---- other profiles have no diagnostics to run ---------------------------
for (const id of ontologyIds()) {
  if (id === 'learning-view-v1') continue
  const other = getOntology(id)
  assert.deepEqual(other.diagnostics, [], id + ' must not declare diagnostics it cannot compute')
}

// ---- determinism and shape ------------------------------------------------
const repeat = judge(
  [{ id: 'e1', type: 'positive_example', text: '例子' }],
  []
)
assert.deepEqual(repeat, judge([{ id: 'e1', type: 'positive_example', text: '例子' }], []), 'diagnostics must be deterministic')
for (const finding of repeat) {
  assert(typeof finding.id === 'string' && typeof finding.zh === 'string', 'a finding needs an id and a 中文 name')
  assert(Number.isInteger(finding.count) && finding.count > 0, 'a finding needs a positive count')
  assert(Array.isArray(finding.targets) && finding.targets.length > 0, 'a finding must name what to blame')
  assert.equal(finding.targets.length, finding.count, 'count must match the blamed ids')
}
// Malformed input degrades instead of throwing: it arrives from stored graphs.
assert.deepEqual(diagnoseLearningView(null, profile), [], 'a null graph must not throw')
assert.deepEqual(diagnoseLearningView({ nodes: [] }, profile), [], 'an empty graph must not throw')
const dangling = diagnoseLearningView({ nodes: [{ id: 'x', type: 'concept' }, { id: 'z', type: 'positive_example', text: '例子' }], edges: [{ fromNodeId: 'x', toNodeId: 'missing', relation: 'builds' }, { fromNodeId: 'x', toNodeId: 'x', relation: 'builds' }] }, profile)
assert(has(dangling, 'upper_missing'), 'a dangling edge must not attach anything')
assert(has(dangling, 'words_without_meaning'), 'a self-loop must not count as an attachment')

console.log(JSON.stringify({
  ok: true,
  declared: profile.diagnostics.length,
  reachable: reached.size,
  cases: allCases.length,
  cleanGraphIsSilent: true,
  deterministic: true,
  danglingEdgesTolerated: true,
}))
