#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { defaultStorePath, openSqliteStore } from '../src/kg-store.mjs'

function usage() {
  console.error(`Knowledge graph SQLite CLI

Commands:
  init              --db FILE
  import-graph      --db FILE --input GRAPH.json [--title TITLE]
  list-documents    --db FILE [--limit N]
  show-document     --db FILE --id DOCUMENT_ID
  list-candidates   --db FILE [--document ID] [--kind entity|claim|all] [--status candidate|accepted|rejected|all] [--limit N]
  set-candidate     --db FILE --kind entity|claim --id ID --status candidate|accepted|rejected
  save-checkpoint   --db FILE --input CHECKPOINT.json [--run-id ID] [--status STATUS]
  load-checkpoint   --db FILE --run-id ID

Input files may be replaced with - to read JSON from stdin.
`)
}

function parseArgs(argv) {
  const command = argv[0] || ''
  const args = { _: command }
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { args[key] = next; i += 1 }
    else args[key] = true
  }
  return args
}

function required(args, key) {
  const value = typeof args[key] === 'string' ? args[key].trim() : ''
  if (!value) throw new Error('missing --' + key)
  return value
}

function numberArg(args, key, fallback) {
  const value = Number(args[key])
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}

function readJson(filename) {
  const raw = filename === '-' ? readFileSync(0, 'utf8') : readFileSync(filename, 'utf8')
  try { return JSON.parse(raw) } catch (error) { throw new Error('invalid JSON in ' + filename + ': ' + error.message) }
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

const args = parseArgs(process.argv.slice(2))
if (!args._ || args._ === '--help' || args._ === '-h' || args.help || args.h) {
  usage()
  process.exit(args._ ? 0 : 1)
}

let store
try {
  const dbPath = typeof args.db === 'string' && args.db.trim() ? args.db.trim() : defaultStorePath()
  store = await openSqliteStore(dbPath)
  switch (args._) {
    case 'init':
      print({ ok: true, db: dbPath })
      break
    case 'import-graph': {
      const graph = readJson(required(args, 'input'))
      print({ ok: true, ...store.saveGraph(graph, { title: args.title }) })
      break
    }
    case 'list-documents':
      print(store.listDocuments(numberArg(args, 'limit', 50)))
      break
    case 'show-document':
      print(store.getDocument(required(args, 'id')) || { error: 'document_not_found' })
      break
    case 'list-candidates':
      print(store.listCandidates({
        documentId: args.document,
        kind: args.kind || 'all',
        status: args.status || 'candidate',
        limit: numberArg(args, 'limit', 50),
      }))
      break
    case 'set-candidate': {
      const result = store.updateCandidate(required(args, 'kind'), required(args, 'id'), required(args, 'status'))
      print(result || { error: 'candidate_not_found' })
      break
    }
    case 'save-checkpoint': {
      const checkpoint = readJson(required(args, 'input'))
      print({ ok: true, ...store.saveCheckpoint(checkpoint, { runId: args['run-id'], status: args.status }) })
      break
    }
    case 'load-checkpoint':
      print(store.loadCheckpoint(required(args, 'run-id')) || { error: 'checkpoint_not_found' })
      break
    default:
      usage()
      process.exitCode = 1
  }
} catch (error) {
  console.error('[kg-cli] ' + (error && error.message ? error.message : String(error)))
  process.exitCode = 1
} finally {
  if (store) store.close()
}
