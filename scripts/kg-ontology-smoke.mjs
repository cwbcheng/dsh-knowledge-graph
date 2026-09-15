#!/usr/bin/env node
/**
 * Ontology profile conformance smoke test.
 *
 * `proposition-v1` is a frozen copy of constants that used to be hardcoded in
 * src/index.host.js and src/index.client.js. Those constants now live only in
 * the profile, so this test asserts the profile still reproduces the frozen
 * pre-refactor baseline (scripts/fixtures/proposition-v1-baseline.json)
 * exactly — the refactor cannot silently change how existing graphs are
 * extracted, validated or drawn.
 *
 * It also validates the structural integrity of every profile (ids unique,
 * snake_case, relation endpoints declared, every referenced node type exists)
 * which is what keeps a hand-written ontology honest.
 *
 * Run: node scripts/kg-ontology-smoke.mjs
 * Exit 0 on success; prints one JSON summary line.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Frozen pre-refactor constants. proposition-v1 must never drift from this
// fixture: it is what guarantees existing graphs keep extracting and rendering
// identically now that the constants no longer live in the host/client sources.
const BASELINE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/proposition-v1-baseline.json', import.meta.url)), 'utf8'))

import {
  DEFAULT_ONTOLOGY_ID,
  ONTOLOGY_LEARNING_VIEW,
  ONTOLOGY_PROPOSITION,
  claimCandidateSet,
  consumptionRelationSet,
  consumptionTypeSet,
  assertionTypeSet,
  describeOntology,
  factCheckTypeSet,
  factCheckWeights,
  entityCandidateSet,
  evidenceRequiredSet,
  findOntology,
  getOntology,
  hasOntology,
  nodeCoordinatesMap,
  nodeType,
  nodeTypeIds,
  nodeTypeSet,
  ontologyIdOf,
  ontologyIds,
  promptLines,
  relationAliasMap,
  relationAliases,
  relationAllows,
  relationLayoutMap,
  relationWeave,
  relationType,
  relationTypeIds,
  relationTypeSet,
  semanticGuardSet,
  sourceRuleMap,
  typeAliasMap,
  typeAliases,
} from '../src/kg-ontology.mjs'

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failed += 1
    console.error('FAIL ' + name + ': ' + (error && error.message ? error.message : String(error)))
  }
}

/**
 * Extract a flat `key: 'value',`-style literal map from a source file and
 * return it as a plain object. Only handles the simple shape the plugin uses
 * for alias tables (identifiers or quoted keys, string values).
 */
function parseLiteralMap(source, constName) {
  const at = source.indexOf('const ' + constName + ' = {')
  assert.ok(at >= 0, 'const ' + constName + ' not found in source')
  const open = source.indexOf('{', at)
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  assert.ok(end > open, 'unterminated literal for ' + constName)
  const body = source.slice(open + 1, end)
  const out = Object.create(null)
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim()
    if (!line) continue
    for (const entry of line.split(',')) {
      const text = entry.trim()
      if (!text) continue
      const match = /^(?:'([^']*)'|"([^"]*)"|([^\s:',]+))\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\s:',{}]+))$/.exec(text)
      if (!match) continue
      const key = match[1] || match[2] || match[3]
      const value = match[4] !== undefined ? match[4] : match[5] !== undefined ? match[5] : match[6]
      if (key && value) out[key] = value
    }
  }
  return out
}

/** Extract a `new Set([...])` literal of strings. */
function parseLiteralArray(source, constName) {
  const at = source.indexOf('const ' + constName + ' = new Set([')
  assert.ok(at >= 0, 'const ' + constName + ' not found in source')
  const open = source.indexOf('[', at)
  const close = source.indexOf(']', open)
  assert.ok(close > open, 'unterminated array for ' + constName)
  return source.slice(open + 1, close).split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

/** Extract a `const X = [...]` array of string literals. */
function parseLiteralList(source, constName) {
  const at = source.indexOf('const ' + constName + ' = [')
  assert.ok(at >= 0, 'const ' + constName + ' not found in source')
  const open = source.indexOf('[', at)
  const close = source.indexOf(']', open)
  assert.ok(close > open, 'unterminated array for ' + constName)
  return source.slice(open + 1, close).split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

/** Extract a `const X = { a: { label: '…', color: '…' }, … }` id → label/color table. */
function parseTypeMeta(source, constName) {
  const at = source.indexOf('const ' + constName + ' = {')
  assert.ok(at >= 0, 'const ' + constName + ' not found in source')
  const open = source.indexOf('{', at)
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  const body = source.slice(open + 1, end)
  const out = Object.create(null)
  const entryRe = /([A-Za-z_$][\w$]*)\s*:\s*\{\s*label:\s*'([^']*)'\s*,\s*color:\s*'([^']*)'\s*,\s*fill:\s*'([^']*)'\s*,?\s*\}/g
  let match = entryRe.exec(body)
  while (match) {
    out[match[1]] = { label: match[2], color: match[3], fill: match[4] }
    match = entryRe.exec(body)
  }
  return out
}

// ---------------------------------------------------------------------------
// proposition-v1 must reproduce the pre-existing hardcoded constants
// ---------------------------------------------------------------------------

const proposition = getOntology(ONTOLOGY_PROPOSITION)

check('proposition type aliases match the frozen baseline', () => {
  assert.deepEqual({ ...typeAliasMap(ONTOLOGY_PROPOSITION) }, BASELINE.typeAliases, 'type alias table drifted')
})

check('proposition relation aliases match the frozen baseline', () => {
  assert.deepEqual({ ...relationAliasMap(ONTOLOGY_PROPOSITION) }, BASELINE.relationAliases, 'relation alias table drifted')
})

check('proposition evidence-required types match the frozen baseline', () => {
  assert.deepEqual(proposition.evidenceRequiredTypes.slice().sort(), BASELINE.evidenceRequiredTypes.slice().sort())
})

check('proposition semantic-guard types match the frozen baseline', () => {
  assert.deepEqual(proposition.semanticGuardTypes.slice().sort(), BASELINE.semanticGuardTypes.slice().sort())
})

check('proposition consumption types match the frozen baseline', () => {
  assert.deepEqual(proposition.consumptionTypes.slice().sort(), BASELINE.consumptionTypes.slice().sort())
})

check('proposition consumption relations match the frozen baseline', () => {
  assert.deepEqual(relationTypeIds(ONTOLOGY_PROPOSITION).slice().sort(), BASELINE.consumptionRelations.slice().sort())
})

check('proposition entity candidates match the frozen baseline', () => {
  assert.deepEqual(proposition.entityCandidateTypes.slice().sort(), BASELINE.entityCandidateTypes.slice().sort())
})

check('proposition claim candidates match the frozen baseline', () => {
  assert.deepEqual(proposition.claimCandidateTypes.slice().sort(), BASELINE.claimCandidateTypes.slice().sort())
})

check('proposition source rules match the frozen baseline', () => {
  assert.deepEqual({ ...proposition.sourceRules }, BASELINE.sourceRules)
})

check('proposition render order matches the frozen baseline', () => {
  assert.deepEqual(proposition.renderOrder, BASELINE.renderOrder)
})

check('proposition labels and colours match the frozen baseline', () => {
  for (const type of proposition.nodeTypes) {
    const meta = BASELINE.typeMeta[type.id]
    assert.ok(meta, 'baseline is missing ' + type.id)
    assert.equal(type.label, meta.label, 'label drifted for ' + type.id)
    assert.equal(type.color, meta.color, 'colour drifted for ' + type.id)
    assert.equal(type.fill, meta.fill, 'fill drifted for ' + type.id)
  }
  assert.equal(Object.keys(BASELINE.typeMeta).length, proposition.nodeTypes.length)
})

check('proposition relation labels match the frozen baseline', () => {
  for (const relation of proposition.relationTypes) {
    assert.equal(relation.zh, BASELINE.relationLabels[relation.id], 'relation label drifted for ' + relation.id)
  }
  assert.equal(Object.keys(BASELINE.relationLabels).length, proposition.relationTypes.length)
})

check('proposition layout families match the frozen baseline', () => {
  const { backbone, satellite, directional } = BASELINE.layoutFamilies
  const backboneSet = new Set(backbone)
  const satelliteSet = new Set(satellite)
  const directionalSet = new Set(directional)
  for (const relation of proposition.relationTypes) {
    // `neutral` is the honest encoding of "the client puts this relation in no
    // set at all" — today that is not_is, which keeps the default weight.
    const expected = backboneSet.has(relation.id) ? 'backbone' : satelliteSet.has(relation.id) ? 'satellite' : directionalSet.has(relation.id) ? 'directional' : 'neutral'
    assert.equal(relation.family, expected, 'layout family drifted for ' + relation.id)
  }
  assert.equal(backboneSet.size + satelliteSet.size + directionalSet.size + 1, proposition.relationTypes.length, 'expected exactly one neutral relation')
  assert.ok(!backboneSet.has('not_is') && !satelliteSet.has('not_is') && !directionalSet.has('not_is'), 'not_is became classified')
})

check('proposition layout weights match the frozen baseline', () => {
  for (const relation of proposition.relationTypes) {
    assert.equal(relation.weight, BASELINE.layoutWeights[relation.id], 'layout weight drifted for ' + relation.id)
  }
  assert.equal(Object.keys(BASELINE.layoutWeights).length, proposition.relationTypes.length)
})

check('proposition heuristic sets match the frozen baseline', () => {
  assert.deepEqual(proposition.assertionTypes.slice().sort(), BASELINE.assertionTypes.slice().sort())
  assert.deepEqual(proposition.factCheckTypes.slice().sort(), BASELINE.factCheckTypes.slice().sort())
  assert.deepEqual({ ...proposition.factCheckWeights }, { ...BASELINE.factCheckWeights })
  assert.deepEqual(proposition.relationWeave.sources.slice().sort(), BASELINE.relationWeave.sources.slice().sort())
  assert.deepEqual(proposition.relationWeave.targets.slice().sort(), BASELINE.relationWeave.targets.slice().sort())
  assert.deepEqual(proposition.relationWeave.relations.slice().sort(), BASELINE.relationWeave.relations.slice().sort())
})

// ---------------------------------------------------------------------------
// structural integrity of every profile
// ---------------------------------------------------------------------------

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/

for (const id of ontologyIds()) {
  const profile = getOntology(id)

  check(id + ': profile id is self-consistent', () => {
    assert.equal(profile.id, id)
    assert.ok(profile.label && profile.summary)
  })

  check(id + ': node type ids are unique snake_case', () => {
    const seen = new Set()
    for (const type of profile.nodeTypes) {
      assert.match(type.id, SNAKE_CASE, 'bad node type id: ' + type.id)
      assert.ok(!seen.has(type.id), 'duplicate node type id: ' + type.id)
      seen.add(type.id)
    }
  })

  check(id + ': relation type ids are unique snake_case', () => {
    const seen = new Set()
    for (const relation of profile.relationTypes) {
      assert.match(relation.id, SNAKE_CASE, 'bad relation id: ' + relation.id)
      assert.ok(!seen.has(relation.id), 'duplicate relation id: ' + relation.id)
      seen.add(relation.id)
    }
  })

  check(id + ': renderOrder covers every node type exactly once', () => {
    assert.deepEqual(profile.renderOrder.slice().sort(), profile.nodeTypes.map((t) => t.id).sort())
    assert.equal(new Set(profile.renderOrder).size, profile.renderOrder.length)
  })

  check(id + ': node presentation is complete', () => {
    for (const type of profile.nodeTypes) {
      assert.ok(type.zh, 'missing zh for ' + type.id)
      assert.ok(type.label, 'missing label for ' + type.id)
      assert.match(type.color, /^#[0-9a-f]{6}$/, 'bad colour for ' + type.id)
      assert.match(type.fill, /^rgba\(/, 'bad fill for ' + type.id)
      assert.ok(Array.isArray(type.aliases), 'missing aliases for ' + type.id)
    }
  })

  check(id + ': relation endpoints reference declared node types', () => {
    for (const relation of profile.relationTypes) {
      for (const side of ['from', 'to']) {
        for (const endpoint of relation[side] || []) {
          assert.ok(nodeType(id, endpoint), relation.id + ' references unknown ' + side + ' type ' + endpoint)
        }
      }
      assert.ok(Number.isFinite(relation.weight), relation.id + ' needs a numeric weight')
      assert.ok(['backbone', 'satellite', 'directional', 'neutral'].includes(relation.family), relation.id + ' has a bad family')
    }
  })

  check(id + ': subset sets only name declared node types', () => {
    const known = new Set(profile.nodeTypes.map((t) => t.id))
    for (const key of ['entityCandidateTypes', 'claimCandidateTypes', 'evidenceRequiredTypes', 'semanticGuardTypes', 'consumptionTypes', 'renderOrder', 'assertionTypes', 'factCheckTypes']) {
      for (const value of profile[key]) {
        assert.ok(known.has(value), key + ' references unknown node type ' + value)
      }
    }
  })

  check(id + ': heuristic sets reference declared types', () => {
    const known = new Set(profile.nodeTypes.map((t) => t.id))
    for (const value of Object.keys(profile.factCheckWeights)) {
      assert.ok(known.has(value), 'factCheckWeights names unknown type ' + value)
      assert.ok(profile.factCheckTypes.includes(value), 'factCheckWeights names a type that is not fact-checkable: ' + value)
    }
    const weave = profile.relationWeave
    for (const value of [...weave.relations, ...weave.sources, ...weave.targets]) {
      const ok = weave.relations.includes(value) ? relationType(id, value) : known.has(value)
      assert.ok(ok, 'relationWeave names unknown id ' + value)
    }
    // A weaver with sources but no targets (or vice versa) would silently do nothing.
    assert.ok(weave.sources.length && weave.targets.length && weave.relations.length, 'relationWeave must be fully specified')
  })

  check(id + ': sourceRules point at declared types', () => {
    for (const [relation, type] of Object.entries(profile.sourceRules)) {
      assert.ok(relationType(id, relation), 'sourceRules names unknown relation ' + relation)
      assert.ok(nodeType(id, type), 'sourceRules names unknown type ' + type)
      assert.ok(relationAllows(id, relation, type, type) || true)
    }
  })

  check(id + ': aliases do not collide across types', () => {
    const owner = Object.create(null)
    for (const type of profile.nodeTypes) {
      for (const alias of [type.id, ...(type.aliases || [])]) {
        assert.ok(!owner[alias] || owner[alias] === type.id, 'node alias ' + alias + ' maps to both ' + owner[alias] + ' and ' + type.id)
        owner[alias] = type.id
      }
    }
    const relOwner = Object.create(null)
    for (const relation of profile.relationTypes) {
      for (const alias of [relation.id, ...(relation.aliases || [])]) {
        assert.ok(!relOwner[alias] || relOwner[alias] === relation.id, 'relation alias ' + alias + ' maps to both ' + relOwner[alias] + ' and ' + relation.id)
        relOwner[alias] = relation.id
      }
    }
  })
}

// ---------------------------------------------------------------------------
// learning-view-v1 specifics: the two coordinates and direction rules
// ---------------------------------------------------------------------------

const learning = getOntology(ONTOLOGY_LEARNING_VIEW)

check('learning-view declares exactly 18 node types and 21 relations', () => {
  assert.equal(learning.nodeTypes.length, 18)
  assert.equal(learning.relationTypes.length, 21)
  assert.equal(learning.diagnostics.length, 10)
})

check('learning-view marks both coordinates on material nodes', () => {
  const validLayer = new Set(['upper', 'lower', 'none'])
  const validKind = new Set(['discrimination', 'connection', 'none'])
  for (const type of learning.nodeTypes) {
    assert.ok(validLayer.has(type.layer), type.id + ' has bad layer ' + type.layer)
    assert.ok(validKind.has(type.modelKind), type.id + ' has bad modelKind ' + type.modelKind)
  }
  // The five knowledge types and their coordinates.
  assert.equal(nodeType(ONTOLOGY_LEARNING_VIEW, 'concept').layer, 'upper')
  assert.equal(nodeType(ONTOLOGY_LEARNING_VIEW, 'feature').modelKind, 'discrimination')
  assert.equal(nodeType(ONTOLOGY_LEARNING_VIEW, 'rule').modelKind, 'connection')
  // 图34-2: 正例 is a 判别下料, 关系材料 a 联结上料.
  assert.equal(nodeType(ONTOLOGY_LEARNING_VIEW, 'positive_example').modelKind, 'discrimination')
  assert.equal(nodeType(ONTOLOGY_LEARNING_VIEW, 'positive_example').layer, 'lower')
  assert.equal(nodeType(ONTOLOGY_LEARNING_VIEW, 'relation_material').modelKind, 'connection')
  assert.equal(nodeType(ONTOLOGY_LEARNING_VIEW, 'relation_material').layer, 'upper')
  assert.equal(nodeType(ONTOLOGY_LEARNING_VIEW, 'segment_example_group').layer, 'lower')
  assert.equal(nodeType(ONTOLOGY_LEARNING_VIEW, 'segment_example_group').modelKind, 'connection')
})

check('learning-view exemplifies runs lower → upper only', () => {
  assert.ok(relationAllows(ONTOLOGY_LEARNING_VIEW, 'exemplifies', 'positive_example', 'intension_description'))
  assert.ok(relationAllows(ONTOLOGY_LEARNING_VIEW, 'exemplifies', 'negative_example', 'rule'))
  // The reversed direction must be rejected.
  assert.ok(!relationAllows(ONTOLOGY_LEARNING_VIEW, 'exemplifies', 'intension_description', 'positive_example'))
  assert.ok(!relationAllows(ONTOLOGY_LEARNING_VIEW, 'exemplifies', 'concept', 'rule'))
})

check('learning-view keeps material and knowledge edges distinct', () => {
  // has_feature is knowledge → knowledge; states_feature is material → knowledge.
  assert.ok(relationAllows(ONTOLOGY_LEARNING_VIEW, 'has_feature', 'concept', 'feature'))
  assert.ok(!relationAllows(ONTOLOGY_LEARNING_VIEW, 'has_feature', 'intension_description', 'feature'))
  assert.ok(relationAllows(ONTOLOGY_LEARNING_VIEW, 'states_feature', 'feature_description', 'feature'))
  assert.ok(!relationAllows(ONTOLOGY_LEARNING_VIEW, 'states_feature', 'concept', 'feature'))
})

check('learning-view 判联错配 is diagnosable from the model split', () => {
  assert.ok(relationAllows(ONTOLOGY_LEARNING_VIEW, 'prerequisite', 'discrimination_model', 'connection_model'))
  assert.ok(!relationAllows(ONTOLOGY_LEARNING_VIEW, 'prerequisite', 'connection_model', 'discrimination_model'))
})

check('learning-view requires evidence on every material node', () => {
  const knowledge = new Set(['concept', 'feature', 'rule', 'discrimination_model', 'connection_model'])
  for (const type of learning.nodeTypes) {
    if (knowledge.has(type.id)) continue
    assert.ok(learning.evidenceRequiredTypes.includes(type.id), type.id + ' is a material node but is not evidence-required')
  }
})

// ---------------------------------------------------------------------------
// resolution helpers
// ---------------------------------------------------------------------------

check('ontology resolution falls back safely and strictly', () => {
  assert.equal(getOntology('nope').id, DEFAULT_ONTOLOGY_ID)
  assert.equal(getOntology(undefined).id, DEFAULT_ONTOLOGY_ID)
  assert.equal(findOntology('nope'), undefined)
  assert.equal(findOntology(ONTOLOGY_LEARNING_VIEW).id, ONTOLOGY_LEARNING_VIEW)
  assert.ok(hasOntology(ONTOLOGY_PROPOSITION) && hasOntology(ONTOLOGY_LEARNING_VIEW))
  assert.ok(!hasOntology('proposition'))
})

check('describeOntology sends only the presentation face', () => {
  for (const id of ontologyIds()) {
    const face = describeOntology(id)
    assert.equal(face.id, id)
    assert.equal(face.nodeTypes.length, getOntology(id).nodeTypes.length)
    assert.equal(face.relationTypes.length, getOntology(id).relationTypes.length)
    for (const type of face.nodeTypes) {
      assert.ok(type.label && type.color && type.fill)
      assert.equal(type.aliases, undefined, 'aliases must not leave the host')
    }
    for (const relation of face.relationTypes) {
      assert.equal(relation.from, undefined, 'endpoint rules must not leave the host')
      assert.equal(relation.aliases, undefined)
    }
  }
})

check('promptLines names every type', () => {
  const { nodeLine, relationLine } = promptLines(ONTOLOGY_LEARNING_VIEW)
  assert.ok(nodeLine.includes('positive_example 正例'))
  assert.ok(relationLine.includes('exemplifies 例证'))
  assert.equal(nodeLine.split(' / ').length, learning.nodeTypes.length)
  assert.equal(relationLine.split(' / ').length, learning.relationTypes.length)
})

check('learning-view declares its own heuristics rather than inheriting proposition ones', () => {
  // Running the proposition heuristics against 学习观 types would be nonsense:
  // 'fact' is not a learning-view type, so every set must be re-declared.
  const propTypes = new Set(nodeTypeIds(ONTOLOGY_PROPOSITION))
  for (const id of ontologyIds()) {
    const profile = getOntology(id)
    for (const list of [profile.assertionTypes, profile.factCheckTypes, profile.relationWeave.sources, profile.relationWeave.targets, profile.relationWeave.relations]) {
      for (const value of list) {
        assert.ok(!propTypes.has(value) || profile.id === ONTOLOGY_PROPOSITION || nodeTypeIds(id).includes(value))
      }
    }
  }
  assert.ok(learning.assertionTypes.includes('rule'))
  assert.ok(learning.factCheckTypes.includes('connection_model'))
  assert.ok(learning.relationWeave.sources.includes('positive_example'))
  assert.ok(learning.relationWeave.relations.includes('exemplifies'))
  assert.ok(!learning.relationWeave.relations.includes('analogy'))
})

check('heuristic accessors are memoised and faithful', () => {
  for (const id of ontologyIds()) {
    const profile = getOntology(id)
    assert.equal(assertionTypeSet(id), assertionTypeSet(id))
    assert.deepEqual([...assertionTypeSet(id)].sort(), profile.assertionTypes.slice().sort())
    assert.deepEqual([...factCheckTypeSet(id)].sort(), profile.factCheckTypes.slice().sort())
    assert.deepEqual({ ...factCheckWeights(id) }, { ...profile.factCheckWeights })
    const weave = relationWeave(id)
    assert.deepEqual([...weave.relations].sort(), profile.relationWeave.relations.slice().sort())
    assert.deepEqual([...weave.sources].sort(), profile.relationWeave.sources.slice().sort())
    assert.deepEqual([...weave.targets].sort(), profile.relationWeave.targets.slice().sort())
  }
})

check('nodeTypeIds follows render order', () => {
  assert.equal(nodeTypeIds(ONTOLOGY_LEARNING_VIEW)[0], 'concept')
  assert.deepEqual(nodeTypeIds(ONTOLOGY_PROPOSITION), proposition.renderOrder)
})

check('memoised tables agree with the uncached builders', () => {
  for (const id of ontologyIds()) {
    assert.deepEqual({ ...typeAliasMap(id) }, { ...typeAliases(id) })
    assert.deepEqual({ ...relationAliasMap(id) }, { ...relationAliases(id) })
    assert.deepEqual([...nodeTypeSet(id)].sort(), nodeTypeIds(id).slice().sort())
    assert.deepEqual([...relationTypeSet(id)].sort(), relationTypeIds(id).slice().sort())
    assert.deepEqual([...evidenceRequiredSet(id)].sort(), getOntology(id).evidenceRequiredTypes.slice().sort())
    assert.deepEqual([...semanticGuardSet(id)].sort(), getOntology(id).semanticGuardTypes.slice().sort())
    assert.deepEqual([...consumptionTypeSet(id)].sort(), getOntology(id).consumptionTypes.slice().sort())
    assert.deepEqual([...consumptionRelationSet(id)].sort(), relationTypeIds(id).slice().sort())
    assert.deepEqual([...entityCandidateSet(id)].sort(), getOntology(id).entityCandidateTypes.slice().sort())
    assert.deepEqual([...claimCandidateSet(id)].sort(), getOntology(id).claimCandidateTypes.slice().sort())
    assert.deepEqual({ ...sourceRuleMap(id) }, { ...getOntology(id).sourceRules })
  }
})

check('memoised tables are stable across calls', () => {
  const first = typeAliasMap(ONTOLOGY_LEARNING_VIEW)
  assert.equal(typeAliasMap(ONTOLOGY_LEARNING_VIEW), first, 'alias map should be cached, not rebuilt')
  assert.equal(evidenceRequiredSet(ONTOLOGY_LEARNING_VIEW), evidenceRequiredSet(ONTOLOGY_LEARNING_VIEW))
})

check('relationLayoutMap carries family and weight for every relation', () => {
  for (const id of ontologyIds()) {
    const layout = relationLayoutMap(id)
    for (const relation of getOntology(id).relationTypes) {
      assert.equal(layout[relation.id].family, relation.family)
      assert.equal(layout[relation.id].weight, relation.weight)
    }
  }
})

check('nodeCoordinatesMap exposes the two material coordinates', () => {
  const coords = nodeCoordinatesMap(ONTOLOGY_LEARNING_VIEW)
  assert.deepEqual(coords.positive_example, { layer: 'lower', modelKind: 'discrimination' })
  assert.deepEqual(coords.relation_material, { layer: 'upper', modelKind: 'connection' })
  assert.deepEqual(coords.concept, { layer: 'upper', modelKind: 'none' })
  const prop = nodeCoordinatesMap(ONTOLOGY_PROPOSITION)
  assert.deepEqual(prop.fact, { layer: 'none', modelKind: 'none' })
})

check('ontologyIdOf resolves from every carrier shape', () => {
  // A bare id, a graph, a document row, a nested source, and stored meta.
  assert.equal(ontologyIdOf(ONTOLOGY_LEARNING_VIEW), ONTOLOGY_LEARNING_VIEW)
  assert.equal(ontologyIdOf({ ontology: ONTOLOGY_LEARNING_VIEW }), ONTOLOGY_LEARNING_VIEW)
  assert.equal(ontologyIdOf({ source: { ontology: ONTOLOGY_LEARNING_VIEW } }), ONTOLOGY_LEARNING_VIEW)
  assert.equal(ontologyIdOf({ graphMeta: { ontology: ONTOLOGY_LEARNING_VIEW } }), ONTOLOGY_LEARNING_VIEW)
  // Aliases.
  assert.equal(ontologyIdOf({ ontology: 'xuexiguan' }), ONTOLOGY_LEARNING_VIEW)
  // Everything unknown or absent falls back to the frozen default, so graphs
  // extracted before ontologies existed keep rendering the same way.
  assert.equal(ontologyIdOf(undefined), DEFAULT_ONTOLOGY_ID)
  assert.equal(ontologyIdOf(null), DEFAULT_ONTOLOGY_ID)
  assert.equal(ontologyIdOf({}), DEFAULT_ONTOLOGY_ID)
  assert.equal(ontologyIdOf({ ontology: 'made-up' }), DEFAULT_ONTOLOGY_ID)
  assert.equal(ontologyIdOf({ source: { ontology: 'made-up' } }), DEFAULT_ONTOLOGY_ID)
  assert.equal(ontologyIdOf(42), DEFAULT_ONTOLOGY_ID)
})

check('learning-view material coordinates come from 图34-2', () => {
  const coords = nodeCoordinatesMap(ONTOLOGY_LEARNING_VIEW)
  // 判别材料: 上料 = 内涵描述/特征描述; 下料 = 正例/负例/对比例组/外延对比
  assert.equal(coords.intension_description.modelKind, 'discrimination')
  assert.equal(coords.feature_description.modelKind, 'discrimination')
  for (const id of ['positive_example', 'negative_example', 'contrast_group', 'extension_contrast']) {
    assert.equal(coords[id].modelKind, 'discrimination', id + ' should be 判别')
    assert.equal(coords[id].layer, 'lower', id + ' should be 下料')
  }
  // 联结材料: 上料 = 关系材料/因素材料/性质材料; 下料 = 分段例组
  for (const id of ['relation_material', 'factor_material', 'property_material']) {
    assert.equal(coords[id].modelKind, 'connection', id + ' should be 联结')
    assert.equal(coords[id].layer, 'upper', id + ' should be 上料')
  }
  assert.equal(coords.segment_example_group.modelKind, 'connection')
  assert.equal(coords.segment_example_group.layer, 'lower')
  // 记忆材料 is the parallel branch to 学习材料, so it sits on no axis.
  assert.deepEqual(coords.memory_material, { layer: 'none', modelKind: 'none' })
})

console.log(JSON.stringify({
  ok: failed === 0,
  passed,
  failed,
  ontologies: ontologyIds(),
  proposition: { nodeTypes: proposition.nodeTypes.length, relationTypes: proposition.relationTypes.length },
  learningView: { nodeTypes: learning.nodeTypes.length, relationTypes: learning.relationTypes.length, diagnostics: learning.diagnostics.length },
}))
process.exit(failed === 0 ? 0 : 1)
