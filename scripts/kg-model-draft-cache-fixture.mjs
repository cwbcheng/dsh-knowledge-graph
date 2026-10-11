import assert from 'node:assert/strict'
import { draftDiagnosisView } from './kg-model-draft-diagnosis-fixture.mjs'

// Instrument only the generated cache-read path, not shared validation or IO.
export function draftCacheView(source, harness, options = {}) {
  const work = { parses: 0, validations: 0 }
  const parse = /JSON\.parse\((?:globalThis\.sessionStorage\?\.getItem\(key\)|raw) \|\| 'null'\)/g
  assert.equal([...source.matchAll(parse)].length, 1)
  source = source.replace(parse, call => '(console.info("draft_cache_parse"), ' + call + ')')
  const validate = 'MODEL_STRUCTURE_TOOLS.validateShape(cached.spec)'
  assert.equal(source.split(validate).length, 2)
  source = source.replace(validate, '(console.info("draft_cache_validate"), ' + validate + ')')
  const view = draftDiagnosisView(source, harness, { ...options, console: { ...console,
    info(marker, ...args) {
      if (marker === 'draft_cache_parse') work.parses++
      else if (marker === 'draft_cache_validate') work.validations++
      else console.info(marker, ...args)
    },
  } })
  return Object.assign(view, { work })
}

export async function reloadDraftCache(view) {
  view.props.active = false; view.render(); await view.settle()
  view.props.active = true; view.render(); await view.settle(); await view.flushDebounce()
}
