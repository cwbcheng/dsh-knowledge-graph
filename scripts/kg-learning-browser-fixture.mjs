import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-learning-browser-'))
const database = join(directory, 'graphs.sqlite')
const store = await openSqliteStore(database)
const documentId = 'learning-browser-fixture'
const sourceId = 'learning-browser-source'
const paragraphs = ['迁移是把学过的知识用于不同情境。', '机械重复是在相同情境中重做原步骤。',
  '迁移需要识别新情境中的关键特征。']
const node = (id, type, paragraph) => ({ id, type, text: paragraphs[paragraph], paragraph,
  quote: paragraphs[paragraph], evidence: [{ documentId, sourceId, paragraph, quote: paragraphs[paragraph] }] })
store.saveGraph({ source: { documentId, id: sourceId, title: 'Learning Exercise Book', paragraphCount: 3 },
  nodes: [node('transfer', 'concept', 0), node('repetition', 'concept', 1), node('rule', 'rule', 2)],
  edges: [{ fromNodeId: 'transfer', toNodeId: 'rule', relation: 'supports' }] },
{ sourceText: paragraphs.join('\n\n'), sourceUnits: paragraphs.map((text, paragraph) => ({ text, paragraph })) })
store.close()
console.log(JSON.stringify({ directory, database, documentId }))
