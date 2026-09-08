#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { openSqliteStore } from '../../src/kg-store.mjs'
import { prepareGraphImport, importGraph } from '../../src/kg-import.mjs'

async function main() {
  const { values: args } = parseArgs({ options: {
    graph: { type: 'string' }, db: { type: 'string' }, title: { type: 'string' },
    'expected-revision': { type: 'string' }, 'dry-run': { type: 'boolean' },
  } })
  if (!args.graph) throw new Error('usage: kg-import-and-verify.mjs --graph FILE [--db FILE] [--expected-revision N] [--dry-run]')
  const input = JSON.parse(readFileSync(args.graph, 'utf8'))
  const prepared = prepareGraphImport(input)
  const expectedRevision = args['expected-revision'] === undefined ? undefined : Number(args['expected-revision'])
  if (args['dry-run']) {
    console.log(JSON.stringify({ dryRun: true, documentId: prepared.graph.source.documentId, nodes: prepared.graph.nodes.length, edges: prepared.graph.edges.length, issues: prepared.validation.issues }, null, 2))
    return
  }
  if (!args.db && !process.env.DSH_KG_DB) throw new Error('Import requires an explicit --db or DSH_KG_DB')
  const store = await openSqliteStore(args.db || process.env.DSH_KG_DB)
  try {
    const imported = importGraph(store, input, { title: args.title, expectedRevision })
    const counts = { grounded: 0, unsupported: 0, candidate: 0 }
    for (const node of prepared.graph.nodes) counts[node.groundingStatus]++
    console.log(JSON.stringify({ imported, grounding: counts, entailmentStatus: 'unverified' }, null, 2))
  } finally { store.close() }
}
main().catch(error => { console.error('[kg-import] ' + error.message); process.exitCode = 1 })
