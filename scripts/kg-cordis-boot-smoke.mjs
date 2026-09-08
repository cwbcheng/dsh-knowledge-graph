import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import hostPlugin, { createGraphContract } from '../src/index.host.js'
import * as persistentPlugin from '../lib/index.js'

const cordisModule = process.env.KG_TEST_CORDIS_MODULE || '@deepseek-ai/cordis'
const { Context, Service } = await import(cordisModule)
const cordisVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve(cordisModule)), 'utf8')).version
const ctx = new Context()
const timers = new Set()
const routes = new Map()
const handlers = new Map()
const previousHarness = globalThis.harness

// Only the external services are doubles; plugin loading, injection checks,
// effects and disposal use the real Cordis registry and context proxy.
class TestTimer extends Service {
  constructor(ctx) {
    super(ctx, 'timer')
    ctx.mixin('timer', ['interval'])
  }
  interval(callback, delay) {
    return this.ctx.effect(() => {
      const id = setInterval(callback, delay)
      timers.add(id)
      return () => { clearInterval(id); timers.delete(id) }
    })
  }
}

async function statusThroughRoute() {
  const route = routes.get('/api/dsh-knowledge-graph')
  assert(route, 'The persistent plugin must register its canonical route')
  let response
  await route.handler(
    { method: 'GET', url: '/api/dsh-knowledge-graph/task-status?taskId=missing', headers: {} },
    { writeHead(status) { assert.equal(status, 200) }, end(body) { response = JSON.parse(body) } },
  )
  assert.deepEqual(response, { status: 'not_found' })
}

try {
  await ctx.plugin(TestTimer)
  ctx.provide('webServer', {
    register(route) {
      assert(!routes.has(route.path), 'Reload must not leak duplicate routes')
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  })

  const negative = ctx.plugin({
    name: 'kg-undeclared-context-negative-control',
    inject: ['timer'],
    apply(ctx) { void ctx.graphContractOnly },
  })
  await assert.rejects(() => negative.await(), /cannot get property "graphContractOnly" without inject/)
  await negative.dispose()

  const persistent = ctx.plugin(persistentPlugin)
  await persistent.await()
  assert.equal(routes.size, 2)
  assert.equal(timers.size, 1)
  await statusThroughRoute()
  await persistent.restart()
  assert.equal(routes.size, 2)
  assert.equal(timers.size, 1)
  await statusThroughRoute()
  await persistent.dispose()
  assert.equal(routes.size, 0)
  assert.equal(timers.size, 0)

  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  const dynamic = ctx.plugin(hostPlugin())
  await dynamic.await()
  assert(handlers.has('extract') && handlers.has('task-status'))
  assert.equal((await handlers.get('task-status')({ taskId: 'missing' })).status, 'not_found')
  assert.equal(timers.size, 1)
  await dynamic.dispose()
  assert.equal(timers.size, 0)

  globalThis.harness = { handle() { throw new Error('Headless contracts must not register RPC handlers') } }
  const contract = createGraphContract()
  assert(Object.isFrozen(contract))
  assert.equal(typeof contract.normalizeGraph, 'function')
  assert(contract.splitParagraphs('Alpha source.').length > 0)
  assert.equal(timers.size, 0)

  console.log(JSON.stringify({
    ok: true, cordisVersion, strictInjectionNegativeControl: true,
    persistentBoot: true, dynamicBoot: true, reloadAndDisposal: true, headlessContract: true,
  }))
} finally {
  globalThis.harness = previousHarness
  await ctx.fiber.dispose()
  assert.equal(timers.size, 0)
  assert.equal(routes.size, 0)
}
