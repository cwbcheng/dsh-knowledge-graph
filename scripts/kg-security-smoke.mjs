import { EventEmitter } from 'node:events'
import { deflateRawSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  const exact = await invoke(route.handler, { origin: 'chrome-extension://kffpcpfkpmfkicdnlckdphiplnhlbkof' })
  assert(exact.status === 200 && exact.headers['access-control-allow-origin'] === 'chrome-extension://kffpcpfkpmfkicdnlckdphiplnhlbkof', 'rotated extension Origin was rejected')
  return { missing: missing.status, other: other.status, exact: exact.status }
}

const attachments = await attachmentSmoke()
const origin = await originSmoke()
console.log(JSON.stringify({ ok: true, attachments, origin }))
