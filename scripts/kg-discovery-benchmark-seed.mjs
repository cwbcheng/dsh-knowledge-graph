import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import { createGraphContract } from '../src/index.host.js'
import { fingerprintDiscoveryGold } from './kg-discovery-benchmark.mjs'

const fail = message => { throw new Error(message) }
const value = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? null : process.argv[i + 1] }
const dbPath = value('db'), fixturePath = value('fixture'), goldPath = value('gold-output')
const base = new URL(value('base-url') || 'http://127.0.0.1:3119')
if (!dbPath || !fixturePath || !goldPath || base.origin !== 'http://127.0.0.1:3119' || base.pathname !== '/') {
  fail('usage: --db ISOLATED_TMP_SQLITE --fixture SOURCE.json --gold-output NEW_GOLD.json [--base-url http://127.0.0.1:3119]')
}
const db = realpathSync(resolve(dbPath))
const tempRoot = realpathSync(tmpdir())
if (!db.startsWith(tempRoot + sep)) fail('refusing a database outside the isolated temporary directory')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const documentId = fixture.graph?.source?.documentId
if (fixture.schemaVersion !== 1 || typeof documentId !== 'string' || !documentId.startsWith('discovery-') ||
    !Array.isArray(fixture.sourceUnits) || !fixture.sourceUnits.length ||
    !Array.isArray(fixture.findings)) fail('invalid synthetic discovery seed')
const endpoint = name => new URL('/api/dsh-knowledge-graph/' + name, base)
async function call(name, body) {
  const result = await fetch(endpoint(name), body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!result.ok) fail(name + ' returned HTTP ' + result.status)
  return result.json()
}
const sourceText = fixture.sourceUnits.map((unit, index) => {
  if (unit.paragraph !== index || typeof unit.text !== 'string' || !unit.text) fail('source units must be contiguous')
  return unit.text
}).join('\n\n')
const canonicalUnits = createGraphContract().splitParagraphs(sourceText)
if (canonicalUnits.length !== fixture.sourceUnits.length ||
    canonicalUnits.some((text, index) => text !== fixture.sourceUnits[index].text)) {
  fail('source units differ from the Host content splitter; refusing to seed misanchored evidence')
}
if (fixture.graph.source.paragraphCount !== canonicalUnits.length) fail('graph source paragraphCount differs from canonical units')
fingerprintDiscoveryGold({ ...fixture, revision: 1 })
const anchored = evidence => Number.isInteger(evidence?.paragraph) &&
  typeof evidence.quote === 'string' && evidence.quote &&
  canonicalUnits[evidence.paragraph]?.includes(evidence.quote)
for (const item of [...fixture.graph.nodes, ...fixture.graph.edges]) {
  if (item.paragraph !== undefined &&
      (!Number.isInteger(item.paragraph) || !canonicalUnits[item.paragraph])) fail('graph paragraph is outside source')
  if (item.quote !== undefined && (!Number.isInteger(item.paragraph) ||
      !canonicalUnits[item.paragraph]?.includes(item.quote))) fail('graph quote is not in source')
  if (!Array.isArray(item.evidence) || !item.evidence.length || !item.evidence.every(anchored)) {
    fail('graph evidence is not in source')
  }
}
if ((await call('task-active')).busy) fail('isolated service is busy; no document was seeded')
const store = await openSqliteStore(db)
try {
  if (store.getDocument(documentId)) fail('synthetic document already exists; refusing overwrite')
  store.saveGraph(fixture.graph, { sourceText, sourceUnits: fixture.sourceUnits })
} finally { store.close() }
const exported = await call('document-export', { documentId })
const loaded = await call('document-load', { documentId })
const plan = await call('verification-plan', { documentId, expectedRevision: 1, canonicalFull: true, mode: 'standard' })
if (exported.error || loaded.error || exported.revision !== 1 || loaded.revision !== 1 ||
    loaded.sourceText !== sourceText || !exported.graph) fail('isolated Host readback differs from the frozen seed')
if (plan.error || plan.coverage?.nodeCount !== exported.graph.nodes.length ||
    plan.coverage?.edgeCount !== exported.graph.edges.length ||
    plan.coverage?.sourceUnitCount !== canonicalUnits.length) fail('isolated Host verification plan differs from the frozen seed')
const gold = { schemaVersion: 1, datasetId: fixture.datasetId,
  description: fixture.description, graph: exported.graph, sourceUnits: fixture.sourceUnits,
  revision: exported.revision, findings: fixture.findings,
  ...(fixture.negativeReview ? { negativeReview: fixture.negativeReview } : {}) }
const goldHash = fingerprintDiscoveryGold(gold)
writeFileSync(goldPath, JSON.stringify(gold, null, 2) + '\n', { flag: 'wx' })
process.stdout.write(JSON.stringify({ documentId, revision: exported.revision,
  nodes: gold.graph.nodes.length, edges: gold.graph.edges.length,
  sourceUnits: gold.sourceUnits.length, goldHash }) + '\n')
