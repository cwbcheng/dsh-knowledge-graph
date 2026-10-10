import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { modelCitationFixture } from './kg-model-citation-locator-fixture.mjs'

// Canonical legacy endpoints retain explicit directions and complete evidence.
// This isolated fixture exercises unsaved direction edits, never live data.
export function modelRefreshFixture() {
  const fixture = modelCitationFixture({ third: true })
  for (const node of fixture.graph.nodes) if (node.type === 'connection_model') delete node.modelStructure
  return fixture
}

export function modelRefreshSource(source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')) {
  const start = source.indexOf('        const refreshConnectionModels = async')
  const end = source.indexOf('        const importConnectionModels =', start)
  assert(start >= 0 && end > start, 'Production refresh receiver boundary')
  return source.slice(start, end)
}

export function modelRefreshReceiver(environment) {
  return new Function(...Object.keys(environment), modelRefreshSource() + '\nreturn refreshConnectionModels')(...Object.values(environment))
}
