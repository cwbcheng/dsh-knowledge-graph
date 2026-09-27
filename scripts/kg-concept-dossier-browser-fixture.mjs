import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-dossier-browser-'))
const database = join(directory, 'graphs.sqlite')
const store = await openSqliteStore(database)
for (const [documentId, title, author, quote, text] of [
  ['dossier-book-a', 'Learning Book', 'Author A', '迁移指将所学应用于新情境。', '迁移'],
  ['dossier-book-b', 'Database Book', 'Author B', '迁移指数据库结构的版本变更。', '迁移'],
  ['dossier-book-c', 'Questionable Book', 'Author C', '原文并没有这个定义。', '迁移'],
]) {
  store.saveGraph({ source: { id: documentId + '-source', documentId, title, author,
    publicationDate: '2020', paragraphCount: 1 }, nodes: [{ id: 'concept', type: 'concept', text,
    paragraph: 0, quote: documentId === 'dossier-book-c' ? '不存在的定义' : quote,
    evidence: [{ documentId, sourceId: documentId + '-source', paragraph: 0,
      quote: documentId === 'dossier-book-c' ? '不存在的定义' : quote }] }], edges: [] },
  { sourceText: quote, sourceUnits: [{ paragraph: 0, text: quote }] })
}
store.close()
console.log(JSON.stringify({ directory, database, documentId: 'dossier-book-a' }))
