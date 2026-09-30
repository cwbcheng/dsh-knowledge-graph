import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteStore } from '../src/kg-store.mjs'
import { connectionFixture } from './kg-connection-model-fixture-data.mjs'

export const learnerResponse = {
  inputs: '本次行驶 7 km，没有附加收费。', mapping: '3 km 内固定收费；其余里程每 km 加 2 元。',
  outputs: '需要支付的费用。', boundary: '仅适用于这个简化计价模型；夜间加价尚不确定。',
  scenario: '今天在白天乘车到一个 7 km 外的新地点。', prediction: '我预测费用为 18 元。',
  check: '核对账单中基础费用与超出里程收费，若有额外收费则模型条件不满足。', sourceExposure: 'unsure',
}
export const learnerReview = { diagnosis: 'boundary', reflection: '简化模型不包含夜间加价，原预测应限于无附加费用的情境。',
  nextCheck: '收集一次含附加收费的账单，对比偏差是否来自遗漏的条件。', selfRating: 'uncertain' }

export async function modelLearningHarness({ legacy = false, fixture = connectionFixture() } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'kg-model-learning-'))
  const database = join(directory, 'graph.sqlite'), document = fixture
  if (legacy) {
    const db = new DatabaseSync(database)
    db.exec(`CREATE TABLE learning_attempts (attempt_id TEXT PRIMARY KEY, document_id TEXT NOT NULL,
      base_revision INTEGER NOT NULL, task_id TEXT NOT NULL, task_kind TEXT NOT NULL, task_json TEXT NOT NULL,
      answer TEXT NOT NULL, scenario TEXT NOT NULL DEFAULT '', self_rating TEXT NOT NULL, created_at INTEGER NOT NULL)`)
    db.prepare('INSERT INTO learning_attempts VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1)').run('legacy', document.documentId,
      'distinction:old', 'distinction', JSON.stringify({ id: 'distinction:old', kind: 'distinction', origin: 'derived_exercise_not_source', references: [] }),
      'Old learner answer', '', 'uncertain')
    db.close()
  }
  const store = await openSqliteStore(database)
  store.saveGraph(document.graph, { sourceText: document.sourceText, sourceUnits: document.sourceUnits })
  const previousDb = process.env.DSH_KG_DB
  process.env.DSH_KG_DB = database
  const host = await import('../lib/index.js')
  const routes = []
  host.apply({ get: name => name === 'webServer' ? { register: route => { routes.push(route); return () => {} } } : null,
    effect: fn => fn(), interval: () => () => {} })
  const handler = routes.find(route => route.path === '/api/dsh-knowledge-graph').handler
  const post = (body, method = 'learning-mode') => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'; req.url = '/api/dsh-knowledge-graph/' + method; req.headers = {}
    const res = { setHeader() {}, writeHead() {}, end(data) { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } } }
    handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
  const stop = () => {
    store.close()
    if (previousDb === undefined) delete process.env.DSH_KG_DB
    else process.env.DSH_KG_DB = previousDb
    rmSync(directory, { recursive: true, force: true })
  }
  return { database, directory, document, store, post, handler, stop }
}
