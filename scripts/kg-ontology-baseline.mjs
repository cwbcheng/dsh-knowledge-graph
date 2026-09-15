#!/usr/bin/env node
/**
 * Regenerate scripts/fixtures/proposition-v1-baseline.json.
 *
 * The fixture is a FROZEN snapshot of the constants that used to be hardcoded in
 * src/index.host.js and src/index.client.js. The ontology smoke test compares
 * the live proposition-v1 profile against it, which is what makes "existing
 * documents keep extracting and rendering identically" a checkable claim rather
 * than a promise.
 *
 * Ontology-owned values now come from src/kg-ontology.mjs (the authored source
 * of truth); presentation values still come from the client source, because the
 * client keeps its own built-in fallback table for payloads with no ontology.
 *
 * Run this ONLY as part of a deliberate, reviewed ontology change. Running it to
 * make a failing test pass defeats the point of the fixture.
 *
 *   node scripts/kg-ontology-baseline.mjs > scripts/fixtures/proposition-v1-baseline.json
 */

import { readFileSync } from 'node:fs'

import { getOntology } from '../src/kg-ontology.mjs'

const CLIENT = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const profile = getOntology('proposition-v1')

function block(source, start, openCh, closeCh) {
  const at = source.indexOf(start); if (at < 0) throw new Error('missing ' + start)
  const open = source.indexOf(openCh, at); let d = 0, end = -1
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === openCh) d += 1
    else if (source[i] === closeCh) { d -= 1; if (d === 0) { end = i; break } }
  }
  return source.slice(open + 1, end)
}
function map(source, name) {
  const body = block(source, 'const ' + name + ' = {', '{', '}')
  const out = {}
  for (const line of body.split('\n')) {
    for (const part of line.replace(/\/\/.*$/, '').trim().split(',')) {
      const t = part.trim(); if (!t) continue
      const m = /^(?:'([^']*)'|"([^"]*)"|([^\s:',]+))\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\s:',{}]+))$/.exec(t)
      if (m) out[m[1] ?? m[2] ?? m[3]] = m[4] ?? m[5] ?? m[6]
    }
  }
  return out
}
function arr(source, name) {
  const body = block(source, 'const ' + name + ' = [', '[', ']')
  return body.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}
function setArr(source, name) {
  const body = block(source, 'const ' + name + ' = new Set([', '[', ']')
  return body.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

const typeMeta = {}
{
  const body = block(CLIENT, 'const TYPE_META = {', '{', '}')
  const re = /([A-Za-z_$][\w$]*)\s*:\s*\{\s*label:\s*'([^']*)'\s*,\s*color:\s*'([^']*)'\s*,\s*fill:\s*'([^']*)'\s*,?\s*\}/g
  let m; while ((m = re.exec(body))) typeMeta[m[1]] = { label: m[2], color: m[3], fill: m[4] }
}
const weights = {}
{
  const body = block(CLIENT, 'const layeredRelationWeights = {', '{', '}')
  for (const line of body.split('\n')) { const m = /^\s*([A-Za-z_$][\w$]*):\s*(\d+)\s*,?\s*$/.exec(line); if (m) weights[m[1]] = Number(m[2]) }
}

// Flatten the profile's alias tables the way the pre-refactor constants were
// shaped: one flat string→string map per side.
const flatAliases = (list) => {
  const out = {}
  for (const entry of list) {
    out[entry.id] = entry.id
    for (const alias of entry.aliases || []) out[alias] = entry.id
  }
  return out
}

const out = {
  _comment: 'Frozen baseline of the constants that were hardcoded in src/index.host.js and src/index.client.js before the ontology profile refactor. proposition-v1 must never drift from this file: it is what guarantees existing graphs keep extracting and rendering identically. Regenerate only with a deliberate, reviewed ontology change.',
  typeAliases: flatAliases(profile.nodeTypes),
  relationAliases: flatAliases(profile.relationTypes),
  evidenceRequiredTypes: profile.evidenceRequiredTypes,
  semanticGuardTypes: profile.semanticGuardTypes,
  consumptionTypes: profile.consumptionTypes,
  // Derived rather than declared: every relation of a profile is consumable, and
  // both the host and the client build this set from the relation table.
  consumptionRelations: profile.relationTypes.map((relation) => relation.id),
  entityCandidateTypes: profile.entityCandidateTypes,
  claimCandidateTypes: profile.claimCandidateTypes,
  sourceRules: { ...profile.sourceRules },
  renderOrder: profile.renderOrder,
  typeMeta,
  relationLabels: map(CLIENT, 'REL_LABEL'),
  layoutFamilies: {
    backbone: [...new Set(setArr(CLIENT, 'reasoningRelations'))],
    satellite: setArr(CLIENT, 'satelliteRelations'),
    directional: setArr(CLIENT, 'directionalRelations'),
  },
  layoutWeights: weights,
  assertionTypes: profile.assertionTypes,
  factCheckTypes: profile.factCheckTypes,
  factCheckWeights: { ...profile.factCheckWeights },
  relationWeave: {
    relations: profile.relationWeave.relations,
    sources: profile.relationWeave.sources,
    targets: profile.relationWeave.targets,
  },
}
console.log(JSON.stringify(out, null, 2))
