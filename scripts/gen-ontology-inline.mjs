#!/usr/bin/env node
/**
 * Inline the ontology profiles into src/index.host.js.
 *
 * Why this exists: the DSH dynamic-package sandbox exposes no `import` and no
 * `require` (only `harness`, `console`, `btoa`/`atob`, `TextEncoder`/`TextDecoder`
 * and cordis services via `ctx`). The host half therefore cannot load
 * ./kg-ontology.mjs at runtime, and the plugin package must stay self-contained
 * rather than depending on sibling files resolving.
 *
 * So src/kg-ontology.mjs stays the AUTHORED source of truth (it is what the
 * tests and the standalone tooling import), and this script copies its profile
 * data into a marked block in the host source. The host half then implements
 * its own thin, memoised lookups over that data — no `await`, no loader, works
 * in the sandbox.
 *
 * Usage:
 *   node scripts/gen-ontology-inline.mjs           # rewrite the block
 *   node scripts/gen-ontology-inline.mjs --check   # exit 1 if it is stale
 *
 * `npm test` runs the --check form, so a profile edit that is not regenerated
 * fails the suite instead of silently shipping a host with stale types.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { diagnoseLearningView, ontologyIds, rawProfiles } from '../src/kg-ontology.mjs'

const HOST_PATH = new URL('../src/index.host.js', import.meta.url)
const OPEN = '      // >>> GENERATED ONTOLOGY DATA — DO NOT EDIT <<<'
const CLOSE = '      // <<< END GENERATED ONTOLOGY DATA <<<'

const checkOnly = process.argv.includes('--check')

function renderBlock() {
  const profiles = rawProfiles()
  const lines = Object.entries(profiles).map(([id, profile]) => {
    // Re-indent the serialised profile to sit inside apply()'s body.
    const body = JSON.stringify(profile, null, 2).split('\n').join('\n      ')
    return `        ${JSON.stringify(id)}: ${body},`
  })
  // The diagnostics are inlined the same way the data is, and for the same
  // reason: the host cannot import, and a second hand-written copy would drift.
  // Taking the source from the module itself keeps one implementation, and the
  // --check mode makes a stale copy a test failure rather than a silent
  // divergence. The function must stay free of closure references to survive
  // this — a captured variable would become a ReferenceError inside the host.
  const diagnoseSource = diagnoseLearningView.toString()
  if (/^export/.test(diagnoseSource)) throw new Error('function source must not carry the export keyword')
  const diagnoseLines = diagnoseSource.split('\n').join('\n      ')
  return [
    OPEN,
    '      // Generated from src/kg-ontology.mjs by `npm run gen:ontology`.',
    '      const ONTOLOGY_PROFILES = Object.freeze({',
    ...lines,
    '      })',
    '',
    '      // Also generated from src/kg-ontology.mjs. Docs: diagnoseLearningView.',
    '      const ONT_DIAGNOSE_LEARNING_VIEW = ' + diagnoseLines,
    CLOSE,
  ].join('\n')
}

const source = readFileSync(HOST_PATH, 'utf8')
const openAt = source.indexOf(OPEN)
const closeAt = source.indexOf(CLOSE)
if (openAt < 0 || closeAt <= openAt) {
  console.error('ontology block markers not found in src/index.host.js')
  process.exit(1)
}
const closeEnd = closeAt + CLOSE.length
const current = source.slice(openAt, closeEnd)
const next = renderBlock()

if (current === next) {
  console.log(JSON.stringify({ ok: true, stale: false, ontologies: ontologyIds(), bytes: next.length }))
  process.exit(0)
}

if (checkOnly) {
  console.error('src/index.host.js ontology block is stale — run `npm run gen:ontology`')
  console.error('  current bytes: ' + current.length + ', expected bytes: ' + next.length)
  process.exit(1)
}

writeFileSync(HOST_PATH, source.slice(0, openAt) + next + source.slice(closeEnd))
console.log(JSON.stringify({ ok: true, stale: true, rewritten: true, ontologies: ontologyIds(), bytes: next.length }))
