import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDiscoveryEngineIdentity, verifyDiscoverySnapshot } from './kg-discovery-benchmark-live.mjs'
import { hostBuildSha256 } from '../lib/index.js'
import { acquireBenchmarkCaptureLock, saveBenchmarkCapture } from './kg-benchmark-capture-atomic.mjs'

const gold = JSON.parse(readFileSync(new URL('./fixtures/kg-discovery-gold-zh-v2.json', import.meta.url), 'utf8'))
const generatedHost = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const identityLine = `export const hostBuildSha256 = '${hostBuildSha256}'\n`
assert(generatedHost.startsWith(identityLine), 'generated Host must embed its runtime identity')
const buildHash = createHash('sha256').update(generatedHost.slice(identityLine.length))
for (const source of ['kg-store.mjs', 'kg-markdown.mjs', 'kg-ontology.mjs']) {
  buildHash.update('\0').update(source).update('\0')
    .update(readFileSync(new URL('../lib/' + source, import.meta.url)))
}
assert.equal(buildHash.digest('hex'), hostBuildSha256, 'runtime identity must match all generated Host modules')
assert.deepEqual(verifyDiscoveryEngineIdentity({ hostBuildSha256 }), { hostBuildSha256 })
assert.throws(() => verifyDiscoveryEngineIdentity({ hostBuildSha256: '0'.repeat(64) }), /runtime build differs/,
  'a stale service must not be attributed the local prompt version')
assert.throws(() => verifyDiscoveryEngineIdentity({}), /runtime build differs/,
  'an older Host without build identity must fail before model admission')
const sourceText = gold.sourceUnits.map(unit => unit.text).join('\n\n')
const exported = { graph: gold.graph, revision: gold.revision }
const loaded = { sourceText, revision: gold.revision }
const plan = { coverage: { nodeCount: gold.graph.nodes.length, edgeCount: gold.graph.edges.length,
  sourceUnitCount: gold.sourceUnits.length, batchCount: 1 } }
assert.deepEqual(verifyDiscoverySnapshot(gold, exported, loaded, plan), {
  graph: gold.graph, sourceUnits: gold.sourceUnits, revision: gold.revision,
})
const dir = mkdtempSync(join(tmpdir(), 'kg-discovery-capture-'))
try {
  const output = join(dir, 'raw.json')
  writeFileSync(output, JSON.stringify({ revision: 1 }))
  writeFileSync(output + '.pending', 'orphaned interrupted bytes')
  saveBenchmarkCapture(output, { revision: 2, pending: { taskId: 'already-admitted' } })
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')),
    { revision: 2, pending: { taskId: 'already-admitted' } })
  assert.equal(readFileSync(output + '.pending', 'utf8'), 'orphaned interrupted bytes')
  assert.equal(statSync(output).mode & 0o777, 0o600, 'raw model captures must remain private')
  const release = acquireBenchmarkCaptureLock(output)
  assert.equal(statSync(output + '.lock').mode & 0o777, 0o600)
  assert.throws(() => acquireBenchmarkCaptureLock(output), /capture is locked/)
  release()
  const releaseAgain = acquireBenchmarkCaptureLock(output)
  releaseAgain()
} finally { rmSync(dir, { recursive: true, force: true }) }
for (const [actualGold, actualExport, actualLoad, actualPlan] of [
  [{ ...gold, sourceUnits: gold.sourceUnits.map((unit, index) => index === 0
    ? { ...unit, text: unit.text.replace('提高，研究', '提高；研究') } : unit) }, exported, loaded, plan],
  [gold, { ...exported, graph: { ...gold.graph, nodes: gold.graph.nodes.slice(1) } }, loaded, plan],
  [gold, { ...exported, revision: gold.revision + 1 }, loaded, plan],
  [gold, exported, { ...loaded, sourceText: sourceText + '修改' }, plan],
  [gold, exported, loaded, { coverage: { ...plan.coverage, sourceUnitCount: plan.coverage.sourceUnitCount - 1 } }],
]) assert.throws(() => verifyDiscoverySnapshot(actualGold, actualExport, actualLoad, actualPlan),
  /splitter|snapshot/, 'a changed graph, source, revision or coverage must block model admission')
console.log(JSON.stringify({ frozenSnapshotRequired: true, staleSourceRejected: true,
  staleGraphRejected: true, partialPlanRejected: true, orphanCannotBlockCapture: true,
  privateCaptureMode: true, exclusiveCaptureLock: true }))
