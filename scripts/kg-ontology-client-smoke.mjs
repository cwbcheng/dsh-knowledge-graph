#!/usr/bin/env node
/**
 * The ontology rendering handoff.
 *
 * The Host sends `graphOntology` with every graph payload and the client maps it
 * onto the tables ~20 render sites read. Those two halves are written in
 * different languages-of-place (a sandboxed host closure vs. a bundled React
 * client), so nothing else would catch them drifting apart.
 *
 * This test takes the payload the HOST actually produces — via the headless
 * contract, which calls the same `ontDescribe` the payload uses — and feeds it
 * to the CLIENT's real `applyGraphOntology`, extracted verbatim from
 * src/index.client.js. It asserts the two agree on the field names, that a
 * proposition payload restores the built-in tables exactly, and that a profile
 * with missing presentation still renders legibly.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { getOntology, ontologyIds } from '../src/kg-ontology.mjs'

// ---- the payload the host produces ----------------------------------------
const hostSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const previousHarness = globalThis.harness
globalThis.harness = { handle() { throw new Error('headless contracts must not register RPC handlers') } }
let contract
try {
  contract = (await import('data:text/javascript;base64,' + Buffer.from(hostSource).toString('base64'))).createGraphContract()
} finally {
  globalThis.harness = previousHarness
}
const records = new Map(contract.ontologies.map((record) => [record.id, record]))
for (const id of ontologyIds()) assert(records.has(id), 'the contract must describe ' + id)

// ---- the client's real mapping code ---------------------------------------
const clientSource = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')

// Slice out the fallback tables through the end of applyGraphOntology, so the
// test exercises the shipped source rather than a copy of it.
const blockStart = clientSource.indexOf('      const PROPOSITION_TYPE_META = {')
const fnStart = clientSource.indexOf('      function applyGraphOntology(record) {')
assert(blockStart >= 0, 'the client ontology tables must be found')
assert(fnStart > blockStart, 'applyGraphOntology must follow the fallback tables')
let depth = 0
let fnEnd = -1
for (let i = clientSource.indexOf('{', fnStart); i < clientSource.length; i += 1) {
  if (clientSource[i] === '{') depth += 1
  else if (clientSource[i] === '}') {
    depth -= 1
    if (depth === 0) { fnEnd = i + 1; break }
  }
}
assert(fnEnd > fnStart, 'applyGraphOntology must be balanced')
// The edge-label helpers sit immediately after applyGraphOntology and read the
// same profile-driven tables, so the slice has to reach through them too.
const relLabelStart = clientSource.indexOf('      function edgeRelationLabel(edge) {')
assert(relLabelStart > fnEnd, 'edgeRelationLabel must follow applyGraphOntology')
let relDepth = 0
let blockEnd = -1
for (let i = clientSource.indexOf('{', relLabelStart); i < clientSource.length; i += 1) {
  if (clientSource[i] === '{') relDepth += 1
  else if (clientSource[i] === '}') {
    relDepth -= 1
    if (relDepth === 0) { blockEnd = i + 1; break }
  }
}
assert(blockEnd > relLabelStart, 'edgeRelationLabel must be balanced')
const block = clientSource.slice(blockStart, blockEnd)

const harness = new Function(block + `
  return {
    applyGraphOntology,
    edgeRelationLabel,
    attributeDetailSuffix,
    snapshot: () => ({ TYPE_META, REL_LABEL, TYPE_ORDER, REL_SOURCE_RULES, CANDIDATE_ENTITY_TYPES, CANDIDATE_CLAIM_TYPES }),
    layout: () => ({
      weights: LAYERED_RELATION_WEIGHTS,
      backbone: [...REASONING_RELATIONS].sort(),
      satellite: [...SATELLITE_RELATIONS].sort(),
      directional: [...DIRECTIONAL_RELATIONS].sort(),
      strongLocal: [...STRONG_LOCAL_RELATIONS].sort(),
      branch: [...BRANCH_RELATIONS].sort(),
    }),
    fallback: { TYPE_META: PROPOSITION_TYPE_META, REL_LABEL: PROPOSITION_REL_LABEL, TYPE_ORDER: PROPOSITION_TYPE_ORDER },
  }
`)()
const { applyGraphOntology, edgeRelationLabel, attributeDetailSuffix, snapshot, fallback, layout } = harness

// ---- a payload with no ontology keeps the built-in tables ------------------
const before = snapshot()
assert.equal(applyGraphOntology(undefined), null, 'a missing record restores the fallback')
assert.deepEqual(snapshot(), before, 'a missing record must not change the tables')
assert.equal(snapshot().TYPE_META, fallback.TYPE_META, 'the fallback must be the original table object')
assert.deepEqual(snapshot().TYPE_ORDER, fallback.TYPE_ORDER, 'the fallback must be the original type order')

// ---- the proposition payload is a no-op -----------------------------------
assert.equal(applyGraphOntology(records.get('proposition-v1')), null, 'proposition must be recognised as the default')
assert.equal(snapshot().TYPE_META, fallback.TYPE_META, 'a proposition payload must not rebuild the tables')
assert.deepEqual(snapshot().TYPE_ORDER, fallback.TYPE_ORDER, 'a proposition payload must keep the built-in type order')

// ---- the layout tables follow the profile too ------------------------------
// These used to be hardcoded proposition id sets, which silently degraded a
// learning-view graph to an undifferentiated force layout.
const propLayout = layout()
assert.equal(applyGraphOntology(records.get('proposition-v1')), null)
assert.deepEqual(layout(), propLayout, 'a proposition payload must not change the layout tables')
assert.deepEqual(propLayout.backbone, ['causes', 'infers'], 'the proposition backbone is preserved')
assert.deepEqual(propLayout.satellite, ['analogy', 'contains', 'counter_example', 'defines', 'example', 'is_a'])
assert.deepEqual(propLayout.directional, ['aims_at', 'driven_by', 'supports'])
assert.equal(propLayout.weights.causes, 9, 'the proposition weights are preserved exactly')
assert.equal(propLayout.weights.analogy, 5)
assert.equal(propLayout.weights.supports, 4)
assert.deepEqual(propLayout.strongLocal, propLayout.satellite, 'strong-local is the satellite family')
assert.deepEqual(propLayout.branch, propLayout.satellite, 'branch is the satellite family')

// ---- edge attributes are labelled from the payload -------------------------
// Several relations carry half their meaning in an attribute, so the drawn label
// has to include it or two opposite edges look identical.
assert(!('edgeAttributeLabels' in records.get('proposition-v1')), 'the proposition payload must not carry attribute labels')
const lvAttr = records.get('learning-view-v1').edgeAttributeLabels
assert(lvAttr && lvAttr.role && lvAttr.role.input && lvAttr.role.output, 'the learning-view payload must label role values')
assert(lvAttr && lvAttr.mode && lvAttr.mode.contrast && lvAttr.mode.analogy, 'the learning-view payload must label mode values')
assert.equal(edgeRelationLabel({ relation: 'causes', role: 'input' }), '因果', 'the proposition ontology must ignore an attribute it never declared')

applyGraphOntology(records.get('learning-view-v1'))
const lvLayout = layout()
const familyOf = (want) => getOntology('learning-view-v1').relationTypes.filter((r) => r.family === want).map((r) => r.id).sort()
assert.deepEqual(lvLayout.backbone, familyOf('backbone'), 'the learning-view backbone must come from the profile')
assert.deepEqual(lvLayout.satellite, familyOf('satellite'))
assert.deepEqual(lvLayout.directional, familyOf('directional'))
assert(lvLayout.backbone.length > 0, 'a learning-view graph MUST have backbone relations, or it lays out as a hairball')
assert(!lvLayout.backbone.includes('causes'), 'proposition relations must not survive into a learning-view layout')
assert(!('causes' in lvLayout.weights), 'proposition weights must not leak into a learning-view layout')
for (const relation of getOntology('learning-view-v1').relationTypes) {
  if (relation.family === 'neutral') continue
  assert.equal(lvLayout.weights[relation.id], relation.weight, relation.id + ': the layout weight must come from the profile')
}
// A relation the profile does not describe still draws, it just cannot steer.
applyGraphOntology({ id: 'partial-v1', nodeTypes: [{ id: 'a' }], relationTypes: [{ id: 'x', family: 'backbone' }, { id: 'y' }] })
assert.deepEqual(layout().backbone, ['x'], 'only declared backbone relations steer the layout')
assert.equal(layout().weights.y, 2, 'a relation with no weight falls back to the neutral weight')
assert.deepEqual(layout().satellite, [], 'nothing is invented for an undeclared family')

applyGraphOntology(records.get('proposition-v1'))

// ---- a learning-view payload installs its own tables ----------------------
const lvProfile = getOntology('learning-view-v1')
const installed = applyGraphOntology(records.get('learning-view-v1'))
assert(installed, 'a learning-view payload must be installed')
assert.equal(edgeRelationLabel({ relation: 'maps_between', role: 'input' }), '联结映射·入', 'an attribute must appear in the edge label')
assert.equal(edgeRelationLabel({ relation: 'maps_between', role: 'output' }), '联结映射·出', 'the opposite attribute value must read differently')
assert.equal(edgeRelationLabel({ relation: 'compares_feature', mode: 'analogy' }), '特征对比/类比·类比', 'mode must disambiguate a label that names both')
assert.equal(edgeRelationLabel({ relation: 'maps_between' }), '联结映射', 'an edge without the attribute must not gain a suffix')
assert.equal(edgeRelationLabel({ relation: 'maps_between', role: 'unheard-of' }), '联结映射', 'an unknown attribute value must not be invented into the label')
assert.equal(attributeDetailSuffix({ relation: 'maps_between', role: 'input' }), '（role=input）', 'the detail card must spell the attribute out')

// A renderer that still reads REL_LABEL directly would draw a 输入 edge and an
// 输出 edge identically, which is the bug this replaces.
assert.equal(clientSource.split('const rel = REL_LABEL[edge.relation] || edge.relation').length - 1, 0, 'no edge renderer may bypass edgeRelationLabel')
assert.equal(clientSource.split('const rel = edgeRelationLabel(edge)').length - 1, 3, 'all three edge renderers must label through the helper')
assert.equal(clientSource.split('measureLabel(edgeRelationLabel(edge))').length - 1, 1, 'layout label sizing must reserve room for the attribute')
const after = snapshot()

assert.deepEqual(after.TYPE_ORDER, lvProfile.nodeTypes.map((type) => type.id), 'the type order must follow the profile order')
assert.equal(Object.keys(after.TYPE_META).length, lvProfile.nodeTypes.length, 'every node type needs a render entry')

for (const type of lvProfile.nodeTypes) {
  const meta = after.TYPE_META[type.id]
  assert(meta, 'missing render entry for ' + type.id)
  assert.equal(meta.label, type.zh, type.id + ': label must come from the profile 中文 name')
  assert.equal(meta.color, type.color, type.id + ': colour must come from the profile')
  assert.equal(meta.fill, type.fill, type.id + ': fill must come from the profile')
  assert.equal(meta.layer, type.layer, type.id + ': layer must survive for coordinate-aware rendering')
  assert.equal(meta.modelKind, type.modelKind, type.id + ': modelKind must survive for coordinate-aware rendering')
}
for (const relation of lvProfile.relationTypes) {
  assert.equal(after.REL_LABEL[relation.id], relation.zh, relation.id + ': relation label must come from the profile')
}

// The proposition tables must not survive underneath: a learning-view graph
// rendered with a proposition label would be worse than no label at all.
for (const type of lvProfile.nodeTypes) {
  assert(after.TYPE_META[type.id] !== fallback.TYPE_META[type.id], type.id + ': the fallback table must be replaced')
}
assert(!after.TYPE_ORDER.includes('fact'), 'a learning-view graph must not offer proposition types in its filter')

// Proposition-only affordances are withdrawn rather than misapplied: the
// source-rule repair hints and the entity/claim triage would otherwise name
// types this profile does not declare.
assert.deepEqual(after.REL_SOURCE_RULES, {}, 'source-rule hints are proposition-specific')
assert.equal(after.CANDIDATE_ENTITY_TYPES.size, 0, 'candidate triage is proposition-specific')
assert.equal(after.CANDIDATE_CLAIM_TYPES.size, 0, 'candidate triage is proposition-specific')

// ---- a profile with partial presentation still renders --------------------
applyGraphOntology({
  id: 'sparse-v1',
  nodeTypes: [{ id: 'thing' }, { id: 'other', color: '#123456' }],
  relationTypes: [{ id: 'links' }],
})
const sparse = snapshot()
assert.equal(sparse.TYPE_META.thing.label, 'thing', 'a missing label must fall back to the id')
assert.equal(sparse.TYPE_META.thing.color, '#64748b', 'a missing colour must fall back to a neutral one')
assert(sparse.TYPE_META.thing.fill, 'a missing fill must fall back to something paintable')
assert.equal(sparse.TYPE_META.other.color, '#123456', 'an explicit colour must be kept')
assert.equal(sparse.REL_LABEL.links, 'links', 'a missing relation label must fall back to the id')
assert.deepEqual(sparse.TYPE_ORDER, ['thing', 'other'], 'the order must follow the payload')

// ---- a payload can always return to the default ---------------------------
applyGraphOntology(records.get('proposition-v1'))
assert.deepEqual(snapshot().TYPE_ORDER, fallback.TYPE_ORDER, 'returning to proposition must restore the built-in order')

// ---- the diagnostics strip renders what the host concluded ---------------
// The host computes the findings and the client draws them; a strip that
// silently rendered nothing would look identical to a clean graph, which is the
// failure mode worth guarding.
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error(name + ' not found in the client source')
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(name + ' is not balanced')
}
// A minimal createElement, enough to inspect the tree the strip builds.
const h = (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) })
const strip = new Function('h', 'return (' + extractFunction(clientSource, 'ontologyDiagnosticStrip') + ')')(h)

assert.equal(strip({}, () => {}), null, 'a view with no findings must render nothing')
assert.equal(strip({ graphDiagnostics: [] }, () => {}), null, 'an empty finding list must render nothing')
assert.equal(strip(null, () => {}), null, 'a null view must render nothing')

// ---- the mode badge names the ontology the document was built with --------
// A document keeps the ontology it was extracted with, so without a name on
// screen the only way to tell an old proposition graph from a 《学习观》 one is
// to read the node types.
const modeBadge = new Function('h', 'return (' + extractFunction(clientSource, 'ontologyModeBadge') + ')')(h)
assert.equal(modeBadge({}), null, 'a view with no ontology must render no badge')
assert.equal(modeBadge(null), null, 'a null view must render no badge')
const lvBadge = modeBadge({ ontology: records.get('learning-view-v1') })
assert.equal(lvBadge.props.className, 'kg-ontology-badge')
assert.equal(lvBadge.children[0].children[0], '《学习观》知识图', 'the badge must name the ontology')
assert.equal(lvBadge.children[1].children[0], '18 类节点 · 21 类关系 · 11 项诊断', 'the badge must report the ontology shape')
const propBadge = modeBadge({ ontology: records.get('proposition-v1') })
assert.equal(propBadge.children[1].children[0], '8 类节点 · 12 类关系', 'an ontology with no diagnostics must not claim any')

// The extraction form has to be able to choose one, so the catalogue call and
// the payload field must both exist.
assert(clientSource.includes("host.call('ontology-list'"), 'the client must fetch the ontology catalogue')
assert(clientSource.includes("...(ontologyArg ? { ontology: ontologyArg } : {})"), 'a non-default mode must be sent with the extraction')

// A proposition graph declares no diagnostics, so it renders nothing either.
assert.equal(strip({ graphDiagnostics: applyGraphOntology(records.get('proposition-v1')) || [] }, () => {}), null, 'a proposition graph must render no strip')

const findings = [
  { id: 'lower_missing', zh: '下层丢失', count: 2059, targets: ['n1', 'n2'], detail: '只有上料' },
  { id: 'verification_missing', zh: '缺验证', count: 307, targets: ['n3'], detail: '无验证材料' },
]
const picked = []
const node = strip({ graphDiagnostics: findings }, (target) => picked.push(target))
assert(node && node.tag === 'div', 'findings must render a container')
assert.equal(node.props.className, 'kg-diagnostics')
assert.equal(node.children.length, 1 + findings.length, 'the strip must render a title plus one chip per finding')
assert(!('onClick' in node.props), 'the container itself must not be clickable')
assert(node.children[0].children.join('').includes(String(2059 + 307)), 'the title must total the counts: ' + JSON.stringify(node.children[0].children))
for (let i = 0; i < findings.length; i += 1) {
  const chip = node.children[i + 1]
  assert.equal(chip.tag, 'button', 'each finding must be a button so it is keyboard reachable')
  assert.equal(chip.props.type, 'button')
  assert(chip.children[0] === findings[i].zh, 'the chip must show the 中文 name')
  assert.equal(chip.children[1].children[0], String(findings[i].count), 'the chip must show its count')
  assert(chip.props.title.includes(findings[i].detail), 'the chip must explain itself on hover')
  assert(chip.props['aria-label'].includes(findings[i].zh), 'the chip needs an accessible name')
  chip.props.onClick()
}
assert.deepEqual(picked, ['n1', 'n3'], 'clicking a chip must select the first node to blame')
// A finding with no targets must not crash the click handler.
strip({ graphDiagnostics: [{ id: 'x', zh: '空', count: 1, targets: [] }] }, (target) => picked.push(target)).children[1].props.onClick()
assert.equal(picked.length, 2, 'a finding with no targets must not call back')

// ---- the material coordinate grid surfaces 图 34-2's two coordinates --------
// The ontology promises every material sits at 判别/联结 × 上料/下料. Nothing read
// those fields before, so a 判别下料 problem and a 联结上料 problem looked the
// same on screen.
function extractArrayLiteral(source, name) {
  const start = source.indexOf('const ' + name + ' = [')
  if (start < 0) throw new Error(name + ' not found in the client source')
  let depth = 0
  for (let i = source.indexOf('[', start); i < source.length; i += 1) {
    if (source[i] === '[') depth += 1
    else if (source[i] === ']') {
      depth -= 1
      if (depth === 0) return source.slice(source.indexOf('[', start), i + 1)
    }
  }
  throw new Error(name + ' is not balanced')
}
const COORDINATE_QUADRANTS = new Function('return (' + extractArrayLiteral(clientSource, 'COORDINATE_QUADRANTS') + ')')()
assert.equal(COORDINATE_QUADRANTS.length, 4, '图 34-2 cuts materials into four quadrants')
// `kind` is the 学习材料/知识 split, and it is omitted for a profile that does
// not have that reading. `evidenceRequiredTypes` is NOT a substitute: in the
// proposition profile it holds claim/rule and excludes example, so emitting
// `kind` there would label a claim a "material".
assert.equal(records.get('proposition-v1').nodeTypes.filter((type) => type.kind).length, 0,
  'the proposition payload must not carry the learning-view material split')
assert.equal(records.get('learning-view-v1').nodeTypes.filter((type) => type.kind === 'material').length, 13,
  'the learning-view payload must mark exactly its 13 materials')
assert.equal(records.get('learning-view-v1').nodeTypes.filter((type) => type.kind === 'knowledge').length, 5,
  'the learning-view payload must mark exactly its 5 knowledge types')
const gridMeta = {}
for (const type of records.get('learning-view-v1').nodeTypes) gridMeta[type.id] = { label: type.label, color: type.color }
const coordinateGrid = new Function('h', 'TYPE_META', 'COORDINATE_QUADRANTS',
  'return (' + extractFunction(clientSource, 'ontologyCoordinateGrid') + ')',
)(h, gridMeta, COORDINATE_QUADRANTS)

assert.equal(coordinateGrid(null, () => {}), null, 'a null view must render no grid')
assert.equal(coordinateGrid({}, () => {}), null, 'a view with no ontology must render no grid')
assert.equal(coordinateGrid({ ontology: records.get('learning-view-v1'), graph: { nodes: [] } }, () => {}), null, 'an empty graph must render no grid')
// A proposition profile declares no coordinates, so it must render nothing.
assert.equal(coordinateGrid({ ontology: records.get('proposition-v1'), graph: { nodes: [{ id: 'a', type: 'fact' }] } }, () => {}), null,
  'a proposition graph must render no coordinate grid')

// One node of every declared type: the grid must partition the ontology exactly.
const lvTypes = records.get('learning-view-v1').nodeTypes
const allNodes = lvTypes.map((type) => ({ id: 'n_' + type.id, type: type.id }))
const gridPicked = []
const grid = coordinateGrid({ ontology: records.get('learning-view-v1'), graph: { nodes: allNodes } }, (id) => gridPicked.push(id))
assert(grid && grid.tag === 'div', 'a learning-view graph must render the coordinate grid')
assert.equal(grid.props.className, 'kg-coordinates')
const cellOf = (label) => grid.children.find((child) => child && Array.isArray(child.children) && child.children.includes(label))
const countOf = (label) => Number(cellOf(label).children[cellOf(label).children.length - 1].children[0])
// The six cells 图 34-2 implies: four quadrants, the materials outside both
// coordinates (验证材料/数据或经验/记忆材料), and 知识.
assert.equal(grid.children.length, 1 + 6, 'the grid must render a title and six cells')
const expected = { '判别上料': 2, '判别下料': 4, '联结上料': 3, '联结下料': 1, '其他材料': 3, '知识': 5 }
for (const [label, count] of Object.entries(expected)) {
  assert(cellOf(label), 'the grid must show a ' + label + ' cell')
  assert.equal(countOf(label), count, label + ' must hold ' + count + ' types: ' + countOf(label))
}
assert.equal(Object.values(expected).slice(0, 4).reduce((a, b) => a + b, 0), 10, 'the four quadrants hold the ten coordinate materials')
assert(grid.children[0].children.join('').includes('13'), 'the title must total all 13 materials: ' + JSON.stringify(grid.children[0].children))

// A quadrant holds MULTIPLE types — 判别上料 is 内涵描述 + 特征描述 — so a cell whose
// membership silently collapsed to one type would be a bug.
const discUpper = cellOf('判别上料')
const discUpperTypes = records.get('learning-view-v1').nodeTypes
  .filter((t) => t.kind === 'material' && t.layer === 'upper' && t.modelKind === 'discrimination').map((t) => t.id)
assert(discUpperTypes.length > 1, 'the fixture must exercise a multi-type quadrant')
assert.equal(countOf('判别上料'), discUpperTypes.length, '判别上料 must count every type in the quadrant')
assert(discUpper.props.title.includes(gridMeta[discUpperTypes[0]].label), 'the tooltip must break the cell down by type')

// Clicking a quadrant selects its first member; an empty quadrant is inert.
const populated = cellOf('判别下料')
populated.props.onClick()
assert.equal(gridPicked.length, 1, 'clicking a quadrant must select exactly one node')
assert(populated.props.disabled !== true, 'a populated quadrant must be clickable')
const emptyGrid = coordinateGrid({ ontology: records.get('learning-view-v1'), graph: { nodes: [{ id: 'k', type: 'concept' }] } }, (id) => gridPicked.push(id))
const emptyCell = emptyGrid.children.find((child) => child && Array.isArray(child.children) && child.children.includes('判别下料'))
assert.equal(emptyCell.props.disabled, true, 'an empty quadrant must be disabled')
assert.equal(emptyCell.props.onClick(), undefined, 'an empty quadrant must not clear the selection')
assert.equal(gridPicked.length, 1, 'an empty quadrant must not add a selection')

console.log(JSON.stringify({
  ok: true,
  hostPayload: [...records.keys()],
  diagnosticsStrip: findings.length,
  learningViewRenderEntries: Object.keys(after.TYPE_META).length,
  learningViewRelations: Object.keys(after.REL_LABEL).length,
  layoutBackbone: lvLayout.backbone.length,
  coordinateCells: grid.children.length - 1,
  coordinateTotal: countOf('判别上料') + countOf('判别下料') + countOf('联结上料') + countOf('联结下料'),
  propositionLayoutPreserved: true,
  propositionRestoresFallback: true,
  partialPresentationTolerated: true,
}))
