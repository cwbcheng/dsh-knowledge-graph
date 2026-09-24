import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = client.indexOf('      async function loadCanonicalImageUrlClient(')
const end = client.indexOf('      // ---- manual model selection', start)
assert(start >= 0 && end > start, 'canonical image loader must remain testable')
const blobs = []
const urlApi = { createObjectURL(blob) { blobs.push(blob); return 'blob:fixture-' + blobs.length } }
const createLoader = crypto => new Function('globalThis', 'URL', 'Blob', 'atob',
  client.slice(start, end) + '; return loadCanonicalImageUrlClient')(
  { crypto }, urlApi, Blob, atob)

const bytes = Buffer.from('unchanged-image-bytes')
const attachmentId = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const image = { id: 'figure-7-7', attachment: { attachmentId } }
const documentId = 'fixture-document'
const reply = (data = bytes, extra = {}) => ({ documentId, imageId: image.id,
  revision: 5, mediaType: 'image/png', data: data.toString('base64'), ...extra })
const requests = []
const requestImage = response => async args => {
  requests.push({ method: 'image-load', args })
  return response
}

const load = createLoader(webcrypto)
const url = await load(image, documentId, 4, requestImage(reply()))
assert.equal(url, 'blob:fixture-1')
assert.deepEqual(Buffer.from(await blobs[0].arrayBuffer()), bytes)
assert.deepEqual(requests.at(-1), { method: 'image-load', args: { documentId, imageId: image.id } },
  'an immutable attachment is not invalidated by an unrelated graph revision')

await assert.rejects(load(image, documentId, 4, requestImage(reply(Buffer.from('replacement')))),
  /图片内容已更新/)
assert.equal(blobs.length, 1, 'a replaced image must not be displayed')
await assert.rejects(load(image, documentId, 4, requestImage(reply(bytes, { imageId: 'different-image' }))),
  /图片响应与当前资料不一致/)

const legacy = { id: image.id, attachment: { attachmentId: 'legacy-image-id' } }
await assert.rejects(load(legacy, documentId, 4,
  requestImage({ error: { code: 'revision_conflict', message: '图片所属文档 revision 已更新' } })), /revision 已更新/)
assert.equal(requests.at(-1).args.expectedRevision, 4,
  'images without a verifiable identity retain the revision fence')

const noCrypto = createLoader(undefined)
await noCrypto(image, documentId, 4, requestImage(reply()))
assert.equal(requests.at(-1).args.expectedRevision, 4,
  'browsers without WebCrypto retain the revision fence')
console.log(JSON.stringify({ ok: true, unrelatedRevisionAllowed: true, replacementRejected: true,
  legacyRevisionFence: true, cryptoFallbackFence: true }))
