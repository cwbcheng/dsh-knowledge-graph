import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const dynamicSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const nativeSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  .replace("'./kg-store.mjs'", JSON.stringify(new URL('../lib/kg-store.mjs', import.meta.url).href))
async function loadHash(source, dynamic = false) {
  const marker = '      function stableHashHost('
  assert.equal(source.split(marker).length, 2)
  const instrumented = source.replace(marker, '      return { sha256HexHost, stableHashHost }\n' + marker)
  const module = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))
  return (dynamic ? module.default() : module).apply({ get() { return null } })
}
const dynamic = await loadHash(dynamicSource, true)
// The server path must actually bypass the interpreted implementation, not
// merely produce the right digest through the same expensive fallback.
const fallback = 'const bytes = new TextEncoder().encode(text)'
assert.equal(nativeSource.split(fallback).length, 2)
const native = await loadHash(nativeSource.replace(fallback, "throw new Error('persistent hashing reached the interpreted fallback');\n" + fallback))
const vectors = new Map([
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
])
for (const [value, expected] of vectors) {
  assert.equal(dynamic.sha256HexHost(value), expected)
  assert.equal(native.sha256HexHost(value), expected)
}
let seed = 91923
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
const inputs = [null, undefined, false, true, 0, -0, NaN, Infinity, 42n,
  '\u4e2d\u6587\uff21\uff22\uff23', '\u00e9', 'e\u0301', '\ufefftext\r\ntext\n', '\0a\0',
  '\ud800', '\udc00', '\ud800\ud800', '\udc00\ud800', '\ud800X\udc00', '\ud83d\ude80', {}, ['a', 1],
  ...[1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1024].flatMap(size => ['x'.repeat(size), '\u4e2d'.repeat(size)]),
]
for (let i = 0; i < 256; i++) {
  let value = ''
  for (let j = 0, length = random() % 512; j < length; j++) value += String.fromCharCode(random() % 65536)
  inputs.push(value)
}
for (const value of inputs) {
  const text = String(value == null ? '' : value)
  const expected = createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')
  assert.equal(dynamic.sha256HexHost(value), expected, 'dynamic UTF-8 hashing must match the native byte digest')
  assert.equal(native.sha256HexHost(value), expected, 'persistent identities must retain exact UTF-8/null coercion semantics')
  assert.equal(native.stableHashHost(value), dynamic.stableHashHost(value), 'truncated evidence/chunk identities must remain compatible')
}
for (const api of [dynamic, native]) {
  let coercions = 0
  assert.equal(api.sha256HexHost({ toString() { coercions++; return 'abc' } }), vectors.get('abc'))
  assert.equal(coercions, 1, 'coerce the input exactly once')
  assert.throws(() => api.sha256HexHost({ toString() { throw new Error('coercion failed') } }), /coercion failed/)
  assert.notEqual(api.sha256HexHost('\u00e9'), api.sha256HexHost('e\u0301'), 'hashing must not normalize source text')
}
const binding = "const nativeSha256HexHost = text => createHash('sha256').update(text, 'utf8').digest('hex')"
assert.equal(nativeSource.split(binding).length, 2)
const failedNative = await loadHash(nativeSource.replace(binding, "const nativeSha256HexHost = () => { throw new Error('native hash failure') }"))
assert.throws(() => failedNative.sha256HexHost('abc'), /native hash failure/, 'a native failure must not silently change the identity path')
console.log(JSON.stringify({ ok: true, knownVectors: vectors.size, parityCases: inputs.length, nativePathUsed: true,
  malformedUtf16: true, noNormalization: true, identityCompatibility: true, failureVisible: true }))
