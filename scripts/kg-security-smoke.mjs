import { EventEmitter } from 'node:events'
import { deflateRawSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import hostPlugin from '../src/index.host.js'
import * as persistentHost from '../lib/index.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeZip(name, content, declaredUncompressedSize = content.length) {
  const filename = Buffer.from(name)
  const compressed = deflateRawSync(content)
  const local = Buffer.alloc(30 + filename.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc32(content), 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(declaredUncompressedSize, 22)
  local.writeUInt16LE(filename.length, 26)
  filename.copy(local, 30)
  const central = Buffer.alloc(46 + filename.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc32(content), 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(declaredUncompressedSize, 24)
  central.writeUInt16LE(filename.length, 28)
  central.writeUInt32LE(0, 42)
  filename.copy(central, 46)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(local.length + compressed.length, 16)
  return Buffer.concat([local, compressed, central, eocd])
}

async function attachmentSmoke() {
  const base = mkdtempSync('/tmp/dsh-kg-security-')
  const sessionId = 'security-smoke'
  const attachmentRoot = join(base, '.dsh', 'tmp', 'attachments', sessionId)
  const workspaceRoot = join(base, 'workspace')
  const outside = join(base, 'outside.txt')
  mkdirSync(attachmentRoot, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  writeFileSync(join(attachmentRoot, 'safe.txt'), 'safe attachment')
  writeFileSync(outside, 'outside secret')
  writeFileSync(join(workspaceRoot, 'inside.txt'), 'inside workspace')
  symlinkSync(outside, join(attachmentRoot, 'link.txt'))
  symlinkSync(outside, join(workspaceRoot, 'workspace-link.txt'))
  const normalDocx = Buffer.from('<w:document><w:p><w:r><w:t>normal docx</w:t></w:r></w:p></w:document>')
  writeFileSync(join(attachmentRoot, 'normal.docx'), makeZip('word/document.xml', normalDocx))
  writeFileSync(join(attachmentRoot, 'bomb.docx'), makeZip('word/document.xml', Buffer.from('<w:document><w:p><w:r><w:t>bomb</w:t></w:r></w:p></w:document>'), 9 * 1024 * 1024))
  const pending = [
    '==== DSH_PASTE_INPUT_V1 ====',
    attachmentRoot,
    'Attached files',
    '- "safe.txt" (text/plain)',
    '- "normal.docx" (application/vnd.openxmlformats-officedocument.wordprocessingml.document)',
    '- "bomb.docx" (application/vnd.openxmlformats-officedocument.wordprocessingml.document)',
    '- "link.txt" (text/plain)',
    '==== END DSH_PASTE_INPUT ====',
    '<workspace-reference path="inside.txt" kind="file" />',
    '<workspace-reference path="workspace-link.txt" kind="file" />',
  ].join('\n')
  const handlers = new Map()
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  const sessions = new Map([[sessionId, { header: { cwd: workspaceRoot }, events: [] }]])
  hostPlugin().apply({
    get(name) { return name === 'sessions' ? sessions : null },
    interval() { return () => {} },
  })
  try {
    const imported = await handlers.get('document-import')({ sessionId, pending })
    assert(imported && !imported.error, 'document import unexpectedly failed')
    assert(imported.text.includes('safe attachment') && imported.text.includes('inside workspace') && imported.text.includes('normal docx'), 'safe attachment/workspace/DOCX text missing')
    assert(!imported.text.includes('outside secret'), 'symlink target escaped the permitted roots')
    assert(imported.warnings.some((warning) => warning.includes('link.txt')), 'attachment symlink was not rejected')
    assert(imported.warnings.some((warning) => warning.includes('workspace-link.txt')), 'workspace symlink was not rejected')
    assert(imported.warnings.some((warning) => warning.includes('bomb.docx')), 'oversized ZIP expansion was not rejected')
    return { importedFiles: imported.files.length, warnings: imported.warnings.length }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

function invoke(handler, { method = 'GET', url = '/dsh-kg/task-status?taskId=missing', origin } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = origin === undefined ? {} : { origin }
    const headers = {}
    const res = {
      status: 0,
      body: '',
      setHeader(name, value) { headers[name.toLowerCase()] = value },
      writeHead(status) { this.status = status },
      end(value) { this.body = value || ''; resolve({ status: this.status, headers, body: this.body }) },
    }
    Promise.resolve(handler(req, res)).catch(reject)
    process.nextTick(() => req.emit('end'))
  })
}

async function originSmoke() {
  delete process.env.DSH_KG_EXTENSION_ORIGINS
  delete process.env.DSH_KG_ALLOW_LOCAL_ORIGIN
  const routes = []
  const webServer = { register(spec) { routes.push(spec); return () => {} } }
  persistentHost.apply({
    get(name) { return name === 'webServer' ? webServer : null },
    effect(fn) { return fn() },
    interval() { return () => {} },
  })
  const route = routes.find((spec) => spec.path === '/dsh-kg')
  assert(route && typeof route.handler === 'function', 'extension route was not registered')
  const missing = await invoke(route.handler)
  assert(missing.status === 403 && !missing.headers['access-control-allow-origin'], 'missing Origin was accepted')
  const other = await invoke(route.handler, { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
  assert(other.status === 403, 'unlisted extension Origin was accepted')
  const exactOrigin = 'chrome-extension://kffpcpfkpmfkicdnlckdphiplnhlbkof'
  const exact = await invoke(route.handler, { origin: exactOrigin })
  assert(exact.status === 200 && exact.headers['access-control-allow-origin'] === exactOrigin, 'rotated extension Origin was rejected')
  const deniedConsumption = await invoke(route.handler, { method: 'POST', url: '/dsh-kg/graph-query', origin: exactOrigin })
  assert(deniedConsumption.status === 404, 'extension route exposed canonical graph consumption endpoints')
  return { missing: missing.status, other: other.status, exact: exact.status, consumption: deniedConsumption.status }
}

const attachments = await attachmentSmoke()
const origin = await originSmoke()
async function bodyEncodingSmoke() {
  const built = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = built.indexOf('function readBody(req, limit) {')
  const end = built.indexOf('\nfunction writeJson(', start)
  assert(start >= 0 && end > start, 'built request reader missing')
  const readBody = runInNewContext(built.slice(start,end) + '\nreadBody', { Buffer, TextDecoder })
  async function read(chunks, limit) {
    const req = new EventEmitter()
    const result = readBody(req,limit)
    for (const chunk of chunks) req.emit('data',chunk)
    req.emit('end')
    try { return await result } finally {
      assert(req.listenerCount('data') === 0 && req.listenerCount('end') === 0 && req.listenerCount('error') === 0, 'reader leaked listeners')
    }
  }
  const text = JSON.stringify({text:'学习观：前兆 → 后继。\n𠮷与图1-1',files:[]})
  const bytes = Buffer.from(text)
  for (let cut = 1; cut < bytes.length; cut++) {
    assert(await read([bytes.subarray(0,cut),bytes.subarray(cut)],bytes.length) === text, 'UTF-8 corruption at byte ' + cut)
  }
  assert(await read([...bytes].map(byte=>Buffer.from([byte])),bytes.length) === text, 'bytewise request corrupted')
  for (const [chunks,limit] of [[[bytes],bytes.length-1],[[Buffer.from([0xe5,0xad])],10]]) {
    let rejected = false
    try { await read(chunks,limit) } catch { rejected = true }
    assert(rejected,'oversized or invalid UTF-8 body was accepted')
  }
  const large = JSON.stringify({text:'中文跨块与补充字符𠮷\n'.repeat(20000)})
  const largeBytes = Buffer.from(large)
  const chunks = []
  for(let i=0;i<largeBytes.length;i+=65536) chunks.push(largeBytes.subarray(i,i+65536))
  assert(await read(chunks,largeBytes.length) === large,'large UTF-8 request corrupted')
  return {everyByteBoundary:true,bytewise:true,largeBody:true,exactByteLimit:true,invalidUtf8Rejected:true}
}
const bodyEncoding = await bodyEncodingSmoke()
console.log(JSON.stringify({ ok: true, attachments, origin, bodyEncoding }))
