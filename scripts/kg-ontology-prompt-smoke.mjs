#!/usr/bin/env node
/**
 * Ontology prompt conformance.
 *
 * The first-pass extraction prompt IS the ontology contract: it is the only
 * place that tells the model which node and relation types it may emit. If the
 * prompt and the profile tables disagree, extraction silently produces types
 * the validator then deletes — a failure mode that looks like "the model is
 * bad" rather than "the prompt is wrong".
 *
 * This test loads the DYNAMIC host half (through a data: URL, exactly as the
 * other host smokes do) and checks the generated prompts against the profile
 * tables:
 *   - learning-view-v1's prompt names every declared node and relation type
 *   - it does not name proposition-only types
 *   - proposition-v1's prompt still names its own 8/12 and nothing else
 *   - the headless contract keeps its historical nodeTypes/relations keys
 *
 * A data: URL is not incidental: the DSH dynamic-package sandbox exposes no
 * `import`/`require`, which is why the profile data is inlined into the host
 * rather than loaded from ./kg-ontology.mjs. Loading the host this way proves
 * the self-containment the sandbox requires.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { getOntology, ontologyIds } from '../src/kg-ontology.mjs'

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')

// The dynamic half must be importable as a lone module: strip nothing, add
// nothing, and resolve it through a base that cannot reach any sibling file.
assert(
  !/^\s*import\s/m.test(source),
  'src/index.host.js must not contain a static import: the dynamic sandbox provides no module resolver'
)
const { default: plugin, createGraphContract } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))

const previousHarness = globalThis.harness
globalThis.harness = { handle() { throw new Error('headless contracts must not register RPC handlers') } }
let contract
try {
  contract = createGraphContract()
} finally {
  globalThis.harness = previousHarness
}

assert(Object.isFrozen(contract), 'the headless contract must stay frozen')
assert.equal(typeof plugin, 'function', 'the dynamic host must default-export its plugin factory')

// ---- the catalogue ---------------------------------------------------------
assert.deepEqual(contract.ontologies.map((item) => item.id), ontologyIds(), 'the contract must expose every profile')
assert.equal(contract.defaultOntology, 'proposition-v1', 'the default profile must not change')

// Historical keys stay readable so existing consumers keep working.
const proposition = getOntology('proposition-v1')
assert.deepEqual(contract.nodeTypes, proposition.nodeTypes.map((type) => type.id), 'contract.nodeTypes must stay the proposition type list')
assert.deepEqual(contract.relations, proposition.relationTypes.map((relation) => relation.id), 'contract.relations must stay the proposition relation list')

const prompts = contract.ontologySystemPrompts
assert(prompts && typeof prompts === 'object', 'the contract must publish per-ontology prompts')
assert.deepEqual(Object.keys(prompts).sort(), ontologyIds().sort(), 'every profile needs a prompt')

// The generated catalogue lists each type as `id 中文`. Matching that exact
// pair is precise: a bare `\b` scan would flag ordinary English prose (several
// ids are words like `example` / `rule`), and a looser "id followed by Chinese"
// scan would flag phrases such as "worked example 不得整体省略".
function declaresType(prompt, typeId, zh) {
  return prompt.includes(typeId + ' ' + zh)
}

// ---- per-profile prompt conformance ---------------------------------------
const REPORT = {}
for (const id of ontologyIds()) {
  const profile = getOntology(id)
  const prompt = prompts[id]
  assert.equal(typeof prompt, 'string', id + ': prompt must be a string')
  assert(prompt.length > 400, id + ': prompt looks truncated')

  const missingNodes = profile.nodeTypes.filter((type) => !declaresType(prompt, type.id, type.zh)).map((type) => type.id)
  const missingRelations = profile.relationTypes.filter((relation) => !declaresType(prompt, relation.id, relation.zh)).map((relation) => relation.id)
  assert.deepEqual(missingNodes, [], id + ': prompt omits declared node types')
  assert.deepEqual(missingRelations, [], id + ': prompt omits declared relation types')

  // The declared counts must be stated, not just implied by the list.
  assert(prompt.includes(String(profile.nodeTypes.length) + ' 类'), id + ': prompt must state the node-type count')
  assert(prompt.includes(String(profile.relationTypes.length) + ' 类'), id + ': prompt must state the relation-type count')

  // No prompt may catalogue a type from a different profile: that is how a
  // model ends up emitting a type the validator will then delete.
  const own = new Set([...profile.nodeTypes.map((type) => type.id), ...profile.relationTypes.map((relation) => relation.id)])
  const leaked = ontologyIds()
    .filter((other) => other !== id)
    .flatMap((other) => [...getOntology(other).nodeTypes, ...getOntology(other).relationTypes])
    .filter((entry) => !own.has(entry.id) && declaresType(prompt, entry.id, entry.zh))
    .map((entry) => entry.id)
  assert.deepEqual([...new Set(leaked)], [], id + ': prompt catalogues types from another profile')

  REPORT[id] = { chars: prompt.length, nodes: profile.nodeTypes.length, relations: profile.relationTypes.length }
}

// ---- EVERY model pass must follow the document's ontology -------------------
// Checking only the first-pass prompt left a real hole: the coverage pass ran a
// proposition-only prompt, the model copied `"type":"claim"` straight out of its
// JSON example, and a 40-minute real extraction died at the invariant gate. The
// weave pass had the same problem in its relation list. Every pass is checked
// here, and the checks target the two forms a model actually imitates: the
// `id 中文` catalogue line, and a JSON example.
const pipeline = contract.ontologyPipelinePrompts
assert(pipeline && typeof pipeline === 'object', 'the contract must publish every model pass prompt')
assert.deepEqual(Object.keys(pipeline).sort(), ontologyIds().sort(), 'every profile needs a pass catalogue')
const pipelineReport = {}
for (const id of ontologyIds()) {
  const passes = pipeline[id]
  assert.deepEqual(Object.keys(passes).sort(), ['coverage', 'extract', 'verify', 'weave'], id + ': every pass must be published')
  const own = new Set([...getOntology(id).nodeTypes.map((type) => type.id), ...getOntology(id).relationTypes.map((relation) => relation.id)])
  const foreign = ontologyIds()
    .filter((other) => other !== id)
    .flatMap((other) => [...getOntology(other).nodeTypes, ...getOntology(other).relationTypes])
    .filter((entry) => !own.has(entry.id))
  for (const [pass, text] of Object.entries(passes)) {
    assert.equal(typeof text, 'string', id + '/' + pass + ': prompt must be a string')
    assert(text.length > 300, id + '/' + pass + ': prompt looks truncated')
    const where = id + '/' + pass + ': '
    const catalogued = foreign.filter((entry) => text.includes(entry.id + ' ' + entry.zh)).map((entry) => entry.id)
    assert.deepEqual([...new Set(catalogued)], [], where + 'catalogues a type from another profile')
    const typed = foreign.filter((entry) => text.includes('"type":"' + entry.id + '"') || text.includes('"type": "' + entry.id + '"')).map((entry) => entry.id)
    assert.deepEqual([...new Set(typed)], [], where + "shows another profile's node type in a JSON example")
    const related = foreign.filter((entry) => text.includes('"relation":"' + entry.id + '"') || text.includes('"relation": "' + entry.id + '"')).map((entry) => entry.id)
    assert.deepEqual([...new Set(related)], [], where + "shows another profile's relation in a JSON example")
  }
  // The learning-view passes must both declare their own grammar, since neither
  // may inherit it from the proposition prompt.
  const lvOwn = getOntology(id).nodeTypes.every((type) => passes.coverage.includes(type.id + ' ' + type.zh))
  const lvRel = getOntology(id).relationTypes.every((relation) => passes.weave.includes(relation.id + ' ' + relation.zh))
  if (id === 'learning-view-v1') {
    assert(lvOwn, 'the learning-view coverage pass must catalogue every node type')
    assert(lvRel, 'the learning-view weave pass must catalogue every relation')
  }
  pipelineReport[id] = Object.fromEntries(Object.entries(passes).map(([pass, text]) => [pass, text.length]))
}

// ---- the learning-view prompt must carry its own contract ------------------
const lv = prompts['learning-view-v1']
for (const required of ['判别', '联结', '上料', '下料', '不得编造材料', 'memory_material']) {
  assert(lv.includes(required), 'learning-view prompt must state: ' + required)
}
assert(!lv.includes('fact 事实'), 'learning-view prompt must not describe proposition node types')
assert(prompts['proposition-v1'].includes('fact 事实'), 'proposition prompt must keep its original node descriptions')

// ---- the prompt selector falls back safely --------------------------------
// A carrier with no ontology resolves to the default, so pre-ontology documents
// are unaffected by this refactor.
assert.equal(contract.normalizeGraph({ summary: '', nodes: [], edges: [] }, 0, new Set(), null).ontology, 'proposition-v1',
  'a graph without an ontology must normalize as the default profile')

console.log(JSON.stringify({ ok: true, profiles: REPORT, pipelinePrompts: pipelineReport, defaultOntology: contract.defaultOntology }))
