#!/usr/bin/env node
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { splitParagraphs, splitParagraphsOffsets, buildSourceManifest } from './paragraphs.mjs'
import { normalizeGraph, mergeBatch, graphContract } from './normalize.mjs'
import { callLLM, modelIdentity } from './llm-client.mjs'
import { openSqliteStore } from '../../src/kg-store.mjs'
import { importGraph } from '../../src/kg-import.mjs'

const CHECKPOINT_VERSION = 2
const hash = value => createHash('sha256').update(value).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = path + '.' + randomUUID() + '.tmp'
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function saveCheckpoint(path, state) {
  const payload = JSON.stringify(state)
  writeJsonAtomic(path, { ...state, checksum: hash(payload) })
}

function loadCheckpoint(path, fingerprint, manifest) {
  const { checksum, ...state } = readJson(path)
  if (checksum !== hash(JSON.stringify(state))) throw new Error('Checkpoint is corrupt or from an unsupported legacy format')
  if (state.version !== CHECKPOINT_VERSION || state.fingerprint !== fingerprint) throw new Error('Checkpoint source, model or extraction contract changed; use a new output path')
  if (!Number.isSafeInteger(state.nextBatch) || state.nextBatch < 0 || state.nextBatch > manifest.batches.length) throw new Error('Invalid checkpoint batch cursor')
  if (!Array.isArray(state.chunks) || state.chunks.length !== manifest.batches.length) throw new Error('Invalid checkpoint chunk manifest')
  for (const [index, chunk] of state.chunks.entries()) {
    if (chunk.chunkId !== manifest.batches[index].chunkId || (index < state.nextBatch ? chunk.status !== 'completed' : !['pending', 'running', 'failed'].includes(chunk.status))) throw new Error('Checkpoint chunk state does not match its cursor')
  }
  if (!Array.isArray(state.nodes) || !Array.isArray(state.edges) || !Array.isArray(state.warnings) || new Set(state.nodes.map(node => node.id)).size !== state.nodes.length) throw new Error('Invalid checkpoint graph')
  if (state.nextBatch > 0 && state.nodes.length === 0) throw new Error('Checkpoint has completed chunks but no retained nodes')
  return state
}

function readSource(pagesPath) {
  const pages = readJson(pagesPath)
  if (!pages || typeof pages !== 'object' || Array.isArray(pages)) throw new Error('pages must be an object keyed by PDF page number')
  const keys = Object.keys(pages).sort((a, b) => Number(a) - Number(b))
  if (!keys.length || keys.some(key => !/^[1-9]\d*$/.test(key) || typeof pages[key] !== 'string')) throw new Error('Invalid OCR pages')
  if (keys.some((key, index) => Number(key) !== index + 1)) throw new Error('OCR pages are missing; finish OCR before extraction')
  const metadataPath = pagesPath + '.source.json'
  const metadata = existsSync(metadataPath) ? readJson(metadataPath) : null
  if (metadata?.pagesSha256 && metadata.pagesSha256 !== hash(readFileSync(pagesPath))) throw new Error('OCR pages do not match their provenance manifest')
  if (metadata && (!['completed', 'unverified'].includes(metadata.status) || metadata.pageCount !== keys.length)) throw new Error('OCR source is incomplete')
  let sourceText = ''
  const pageMap = []
  for (const key of keys) {
    if (sourceText) sourceText += '\n\n'
    const start = sourceText.length
    sourceText += pages[key]
    pageMap.push({ page: Number(key), start, end: sourceText.length })
  }
  if (!sourceText.trim()) throw new Error('OCR source is empty')
  const offsets = splitParagraphsOffsets(sourceText)
  return {
    sourceText,
    provenance: {
      pageMap,
      paragraphPages: offsets.map(unit => pageMap.filter(page => page.start < unit.end && page.end > unit.start).map(page => page.page)),
      ...(metadata ? { ocr: metadata } : { ocr: { status: 'unverified', pageCount: keys.length } }),
    },
  }
}

function userPrompt(title, batch, index, count, acc) {
  const digest = Array.from(acc.nodes.values()).slice(-24).map(node => node.id + '|' + node.type + '|' + node.text.slice(0, 160)).join('\n')
  return '资料标题：' + title + '\n当前批次：' + (index + 1) + '/' + count + '\n'
    + batch.units.map(unit => '[P' + unit.num + '] ' + unit.text).join('\n')
    + (digest ? '\n\n已有节点（引用已有节点时只在边中使用其 ID；nodes 仅声明本批新节点）：\n' + digest : '')
}

function assembleGraph(title, sourceText, manifest, provenance, state) {
  const completed = state.chunks.filter(chunk => chunk.status === 'completed').length
  const failed = state.chunks.filter(chunk => chunk.status === 'failed')
  const warnings = [...state.warnings, ...failed.map(chunk => chunk.chunkId + ':failed:' + chunk.error)]
  const status = completed === state.chunks.length ? (warnings.length ? 'succeeded_with_warnings' : 'succeeded') : (failed.length ? 'failed' : 'partial')
  return {
    summary: state.summary || '',
    warnings,
    generation: { invariantVersion: 2, status, sourceAudit: 'ocr-text', completedChunks: completed, chunkCount: state.chunks.length, nodeCount: state.nodes.length, edgeCount: state.edges.length },
    source: {
      id: manifest.sourceId, documentId: manifest.documentId, title,
      chars: sourceText.length, paragraphCount: manifest.paragraphCount,
      chunkCount: manifest.chunkCount, sectionCount: manifest.sectionCount,
      sections: manifest.sections.map(section => ({ ...section, summary: state.chunks.filter(chunk => chunk.sectionIds.includes(section.id)).map(chunk => chunk.summary || '').filter(Boolean).join(' ') })),
      ...provenance,
    },
    sourceText,
    nodes: state.nodes,
    edges: state.edges,
    staging: { chunks: state.chunks },
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = {}
  const flags = new Set(['resume', 'restart', 'import'])
  const values = new Set(['pages', 'out', 'title', 'db', 'max-batches', 'expected-revision'])
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2)
    if (!argv[i].startsWith('--') || (!flags.has(key) && !values.has(key))) throw new Error('Unknown argument: ' + argv[i])
    if (flags.has(key)) args[key] = true
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Missing value for --' + key)
      args[key] = argv[++i]
    }
  }
  if (!args.pages || !args.out) throw new Error('usage: kg-extract.mjs --pages FILE --out FILE [--resume] [--import --db FILE --expected-revision N]')
  if (args.resume && args.restart) throw new Error('--resume and --restart are mutually exclusive')
  if (args.import && !args.db && !process.env.DSH_KG_DB) throw new Error('Import requires an explicit --db or DSH_KG_DB')
  const outPath = resolve(args.out), checkpointPath = outPath + '.partial.json'
  const title = args.title || basename(args.pages).replace(/\.json$/i, '')
  const { sourceText, provenance } = readSource(resolve(args.pages))
  const paras = splitParagraphs(sourceText)
  const manifest = buildSourceManifest(title, sourceText, paras)
  const maxBatches = args['max-batches'] === undefined ? manifest.batches.length : Number(args['max-batches'])
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) throw new Error('--max-batches must be a positive integer')
  const expectedRevision = args['expected-revision'] === undefined ? undefined : Number(args['expected-revision'])
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('--expected-revision must be a non-negative integer')
  const contractHash = hash(readFileSync(new URL('../../src/index.host.js', import.meta.url)))
  const fingerprint = hash(JSON.stringify({ version: CHECKPOINT_VERSION, contractHash, title, sourceText, provenance, model: modelIdentity(), maxTokens: 8000, temperature: 0.2, prompt: graphContract.systemPrompt, chunks: manifest.batches }))
  if (!args.resume && !args.restart && (existsSync(checkpointPath) || existsSync(outPath))) throw new Error('Output already exists; use --resume or an explicit --restart')
  const state = args.resume ? loadCheckpoint(checkpointPath, fingerprint, manifest) : {
    version: CHECKPOINT_VERSION, fingerprint, nextBatch: 0, nodes: [], edges: [], warnings: [], summary: '',
    chunks: manifest.batches.map(batch => ({ ...batch, units: undefined, status: 'pending', nodeIds: [], edgeCount: 0, warnings: [], summary: '' })),
  }
  const acc = { nodes: new Map(state.nodes.map(node => [node.id, node])), edges: state.edges, warnings: state.warnings, edgeKeys: new Set(state.edges.map(edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation)), nodeKeys: new Map() }
  const restoredGate = graphContract.validateGraphInvariants({ nodes: state.nodes, edges: state.edges }, sourceText)
  if (restoredGate.blockingIssues.length) throw new Error('Checkpoint graph failed canonical validation')
  saveCheckpoint(checkpointPath, state)

  for (let index = state.nextBatch; index < Math.min(manifest.batches.length, maxBatches); index++) {
    const batch = manifest.batches[index]
    const context = { ...manifest, chunkId: batch.chunkId, paragraphTexts: paras }
    const chunk = state.chunks[index]
    chunk.status = 'running'
    delete chunk.error
    saveCheckpoint(checkpointPath, state)
    let accepted = null, lastError = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await callLLM({ system: graphContract.systemPrompt, user: userPrompt(title, batch, index, manifest.batches.length, acc) + (lastError ? '\n修复反馈：' + lastError : ''), maxTokens: 8000, temperature: 0.2 })
        const norm = normalizeGraph(raw, paras.length, new Set(acc.nodes.keys()), context)
        if (norm.error || !norm.nodes.length) throw new Error(norm.error || 'Batch produced no nodes')
        const gate = graphContract.validateGraphInvariants(norm, sourceText, { extraNodes: acc.nodes, normalizationWarnings: norm.warnings })
        if (gate.blockingIssues.length) throw new Error(gate.blockingIssues.map(issue => issue.code).join(', '))
        accepted = norm
        break
      } catch (error) {
        lastError = String(error.message || error).slice(0, 1200)
      }
    }
    if (!accepted) {
      chunk.status = 'failed'
      chunk.error = lastError
      saveCheckpoint(checkpointPath, state)
      break
    }
    mergeBatch(accepted, acc, index)
    state.nodes = Array.from(acc.nodes.values())
    state.edges = acc.edges
    state.warnings = acc.warnings
    state.summary = accepted.summary || state.summary
    Object.assign(chunk, { status: 'completed', summary: accepted.summary, nodeIds: accepted.nodes.map(node => node.id), edgeCount: accepted.edges.length, warnings: accepted.warnings })
    state.nextBatch = index + 1
    saveCheckpoint(checkpointPath, state)
    console.log('[kg-extract] completed ' + state.nextBatch + '/' + manifest.batches.length)
  }

  const graph = assembleGraph(title, sourceText, manifest, provenance, state)
  const finalGate = graphContract.validateGraphInvariants(graph, sourceText)
  graph.generation.invariantErrors = finalGate.blockingIssues.length
  if (finalGate.blockingIssues.length) {
    graph.generation.status = 'failed'
    graph.warnings.push(...finalGate.blockingIssues.map(issue => 'final_invariant:' + issue.code))
  }
  writeJsonAtomic(outPath, graph)
  console.log('[kg-extract] ' + graph.generation.status + ': ' + graph.nodes.length + ' nodes, ' + graph.edges.length + ' edges')
  if (!['succeeded', 'succeeded_with_warnings'].includes(graph.generation.status)) {
    process.exitCode = graph.generation.status === 'failed' ? 1 : 2
    return graph
  }
  if (args.import) {
    const dbPath = resolve(args.db || process.env.DSH_KG_DB)
    const store = await openSqliteStore(dbPath)
    try {
      const receipt = state.importReceipt
      const current = store.getDocument(manifest.documentId)
      const graphHash = hash(JSON.stringify(graph))
      if (receipt && receipt.dbPath === dbPath && receipt.graphHash === graphHash && current && receipt.revision === store.getDocumentRevision(manifest.documentId) && receipt.canonicalHash === hash(JSON.stringify(current))) {
        console.log('[kg-extract] already imported revision ' + receipt.revision)
        return graph
      }
      const result = importGraph(store, graph, { title, expectedRevision })
      state.importReceipt = { dbPath, graphHash, revision: result.revision, canonicalHash: hash(JSON.stringify(store.getDocument(manifest.documentId))) }
      saveCheckpoint(checkpointPath, state)
      console.log('[kg-extract] imported revision ' + result.revision)
    } finally { store.close() }
  }
  return graph
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error('[kg-extract] ' + error.message); process.exitCode = 1 })
}
