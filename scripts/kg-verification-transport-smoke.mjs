import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { gunzipSync, gzipSync } from 'node:zlib'
import { Context, Service } from '@deepseek-ai/cordis'
import * as persistentPlugin from '../lib/index.js'
import { encodeVerificationRequest } from './verification-wire.mjs'

const routes = new Map()
const ctx = new Context()
class TestTimer extends Service {
  constructor(context) {
    super(context, 'timer')
    context.mixin('timer', ['interval'])
  }
  interval() { return () => {} }
}

async function post(body, headers = {}) {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body)
  const middle = Math.min(bytes.length, 13)
  const req = Readable.from([bytes.subarray(0, middle), bytes.subarray(middle)])
  req.method = 'POST'
  req.url = '/api/dsh-knowledge-graph/verify-graph'
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  let status
  let response
  await routes.get('/api/dsh-knowledge-graph').handler(req, {
    writeHead(code) { status = code },
    end(json) { response = JSON.parse(json) },
  })
  return { status, response }
}

try {
  await ctx.plugin(TestTimer)
  ctx.provide('webServer', {
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
  })
  const plugin = ctx.plugin(persistentPlugin)
  await plugin.await()

  const payload = {
    text: '原文事实。', mode: 'quick',
    graph: { nodes: [{ id: 'n1', type: 'fact', text: '原文事实', quote: '原文事实', paragraph: 0 }], edges: [] },
  }
  const small = await encodeVerificationRequest(payload)
  assert.equal(small.headers['Content-Encoding'], undefined)
  const smallResult = await post(small.body, small.headers)
  assert.equal(smallResult.status, 200)
  assert.equal(smallResult.response.report.metrics.checkedNodes, 1)

  const large = { ...payload, transportPadding: '资料'.repeat(900000) }
  const largeJson = JSON.stringify(large)
  assert(Buffer.byteLength(largeJson) > 4 * 1024 * 1024)
  const encoded = await encodeVerificationRequest(large)
  assert.equal(encoded.headers['Content-Encoding'], 'gzip')
  assert.deepEqual(JSON.parse(gunzipSync(encoded.body)), large)
  const compressedResult = await post(encoded.body, encoded.headers)
  assert.equal(compressedResult.status, 200)
  assert.equal(compressedResult.response.report.metrics.checkedNodes, 1)

  const plainOversize = await post(largeJson)
  assert.equal(plainOversize.status, 413)
  assert.equal(plainOversize.response.error.code, 'body_too_large')
  const bomb = await post(gzipSync('x'.repeat(33 * 1024 * 1024)), { 'content-encoding': 'gzip' })
  assert.equal(bomb.status, 413)
  assert.equal(bomb.response.error.code, 'body_too_large')
  const corrupt = await post(Buffer.from('not gzip'), { 'content-encoding': 'gzip' })
  assert.equal(corrupt.status, 400)
  assert.equal(corrupt.response.error.code, 'invalid_encoding')
  const unsupported = await post('{}', { 'content-encoding': 'br' })
  assert.equal(unsupported.status, 415)
  assert.equal(unsupported.response.error.code, 'unsupported_encoding')

  console.log(JSON.stringify({ ok: true, rawBytes: Buffer.byteLength(largeJson), gzipBytes: encoded.body.byteLength, guarded: true }))
} finally {
  await ctx.fiber.dispose()
  assert.equal(routes.size, 0)
}
