import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-reading-map-browser-'))
const database = join(directory, 'graph.sqlite')
const documentId = 'reading-map-browser-fixture'
const sourceId = 'reading-map-browser-source'
const sourceUnits = Array.from({ length: 850 }, (_, paragraph) => `Paragraph ${paragraph + 1}: grounded statement ${paragraph + 1}.`)
const nodes = sourceUnits.map((quote, paragraph) => ({
  id: 'n' + paragraph,
  type: paragraph % 17 === 0 ? 'concept' : paragraph % 11 === 0 ? 'claim' : 'fact',
  text: paragraph === 849 ? 'Late chapter claim: final grounded statement' : `Knowledge entry ${paragraph + 1}`,
  quote, paragraph,
  evidence: [{ documentId, sourceId, paragraph, quote }],
  sectionId: paragraph < 400 ? 'chapter-one' : 'chapter-two',
  sectionTitle: paragraph < 400 ? 'First topic' : 'Second topic',
  groundingStatus: 'grounded', entailmentStatus: paragraph === 401 ? 'unsupported' : 'unverified',
}))
nodes[0].text = 'Shared concept'
nodes[400].type = 'concept'
nodes[400].text = 'Shared concept'
nodes[401].type = 'claim'
nodes.push({ id: 'unassigned', type: 'claim', text: 'Unassigned without an original quotation',
  paragraph: -1, quote: '', evidence: [], groundingStatus: 'candidate', entailmentStatus: 'unverified' })
const graph = { source: { id: sourceId, documentId, title: 'Isolated multi-topic book',
  paragraphCount: sourceUnits.length, sectionCount: 2, sections: [
    { id: 'chapter-one', title: 'First topic', startParagraph: 0, endParagraph: 399 },
    { id: 'chapter-two', title: 'Second topic', startParagraph: 400, endParagraph: 849 },
  ] }, nodes, edges: [
    { fromNodeId: 'n0', toNodeId: 'n1', relation: 'supports' },
    { fromNodeId: 'n400', toNodeId: 'n401', relation: 'supports' },
    { fromNodeId: 'n0', toNodeId: 'n401', relation: 'supports' },
  ] }
const store = await openSqliteStore(database)
try { store.saveGraph(graph, { sourceText: sourceUnits.join('\n\n'), sourceUnits }) }
finally { store.close() }
console.log(JSON.stringify({ directory, database, documentId, nodes: nodes.length, topics: 3, revision: 1 }))
