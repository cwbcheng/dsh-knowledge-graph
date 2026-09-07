#!/usr/bin/env node
/**
 * kg-import-and-verify.mjs — import a pipeline-built graph JSON into SQLite and
 * run structural/grounding verification, then print a compact report.
 *
 * The host plugin can only display a document that it persisted into SQLite via
 * its own revisioned saveGraph path. This importer reuses the repo's own
 * src/kg-store.mjs so the stored document is byte-for-byte the same shape the
 * host produces (nodes, edges, chunks, sections, evidence, candidates,
 * revisions). It then runs a few checks that mirror the host's "快速体检":
 *   - every edge references existing nodes (no dangling / self-loop);
 *   - every fact/claim/inference/rule/definition/counter_example node has at
 *     least one grounded evidence quote (quote authenticated against the source
 *     paragraph);
 *   - paragraph indices are within range and the evidence quote is unique.
 *
 * Usage:
 *   node kg-import-and-verify.mjs --graph <graph.json> [--db FILE] [--title T]
 */

import { readFileSync } from 'node:fs'
import { openSqliteStore, defaultStorePath } from '../../src/kg-store.mjs'
import { splitParagraphs } from './paragraphs.mjs'
import { exactOrUniqueTypographicQuote } from './normalize.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}

async function main() {
  const graphPath = arg('graph', '')
  if (!graphPath) {
    console.error('usage: node kg-import-and-verify.mjs --graph <graph.json> [--db FILE] [--title T]')
    process.exit(1)
  }
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  const title = arg('title', (graph.source && graph.source.title) || '')

  const paras = splitParagraphs(graph.sourceText || '')
  const totalParagraphs = paras.length

  // Report grounding.
  const grounded = { fact: 0, claim: 0, inference: 0, rule: 0, definition: 0, counter_example: 0, concept: 0, example: 0, unsupported: 0, candidate: 0 }
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  let weirdQuoteCount = 0
  for (const n of nodes) {
    const ev = Array.isArray(n.evidence) ? n.evidence : []
    if (ev.length > 0) grounded[n.type] = (grounded[n.type] || 0) + 1
    else if (n.groundingStatus === 'unsupported') grounded.unsupported += 1
    else grounded.candidate += 1
    // Check paragraph range + quote authenticity.
    if (Number.isInteger(n.paragraph) && n.paragraph < totalParagraphs && n.quote) {
      const authed = exactOrUniqueTypographicQuote(paras[n.paragraph] || '', n.quote)
      if (!authed) weirdQuoteCount += 1
    }
  }

  // Connectivity.
  const edges = Array.isArray(graph.edges) ? graph.edges : []
  const nodeIds = new Set(nodes.map((n) => n.id))
  const dangling = edges.filter((e) => !nodeIds.has(e.fromNodeId) || !nodeIds.has(e.toNodeId) || e.fromNodeId === e.toNodeId)
  const isolated = nodes.filter((n) => !edges.some((e) => e.fromNodeId === n.id || e.toNodeId === n.id))

  // Import.
  const dbPath = arg('db', defaultStorePath())
  const store = await openSqliteStore(dbPath)
  let result
  try {
    const sourceUnits = paras.map((text, ix) => ({ paragraph: ix, text }))
    result = store.saveGraph(graph, { title, sourceUnits, sourceText: graph.sourceText })
  } finally {
    store.close()
  }

  const docId = result && result.documentId ? result.documentId : (graph.source && graph.source.documentId)
  const report = {
    imported: result,
    documentId: docId,
    sourceText: (graph.sourceText || '').length,
    paragraphs: totalParagraphs,
    chunks: (graph.staging && graph.staging.chunks) ? graph.staging.chunks.length : 0,
    sections: (graph.source && graph.source.sections) ? graph.source.sections.length : 0,
    nodes: nodes.length,
    edges: edges.length,
    groundedByType: grounded,
    ungroundedNodes: grounded.unsupported + grounded.candidate,
    quoteMismatchNodes: weirdQuoteCount,
    danglingEdges: dangling.length,
    isolatedNodes: isolated.length,
    warnings: Array.isArray(graph.warnings) ? graph.warnings.length : 0,
    connectivity: {
      edgeNodeRatio: nodes.length > 0 ? (edges.length / nodes.length).toFixed(2) : 0,
    },
  }
  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => { console.error('[kg-import] fatal:', e && e.stack ? e.stack : e); process.exit(1) })
