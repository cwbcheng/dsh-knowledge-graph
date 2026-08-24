import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import hostPlugin from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function makeAttachments() {
  const stored = new Map()
  const calls = []
  return {
    calls,
    imageLimits: {
      maxImageBytes: 20 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 200 * 1024 * 1024,
      maxImagePixels: 64_000_000,
      maxImageDimension: 8192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    async saveImages(inputs) {
      calls.push(inputs.map((input) => ({ mediaType: input.mediaType, name: input.name, bytes: input.data.length })))
      return inputs.map((input, index) => {
        const ref = {
          attachmentId: 'attachment-image-smoke-' + (stored.size + index + 1),
          mediaType: input.mediaType,
          bytes: input.data.length,
          width: 1,
          height: 1,
          name: input.name,
        }
        stored.set(ref.attachmentId, { ref, data: new Uint8Array(input.data) })
        return ref
      })
    },
    async readImage(ref) {
      const value = stored.get(ref.attachmentId)
      if (!value) throw new Error('missing attachment')
      return value
    },
  }
}

function streamText(value) {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text: typeof value === 'string' ? value : JSON.stringify(value) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

function visionLlm(expectedInstruction = '') {
  const requests = []
  const control = { blockGraph: false, metadataCalls: 0 }
  return {
    requests,
    control,
    listProviders() { control.metadataCalls += 1; return [{ id: 'vision', name: 'Vision' }] },
    async listModels() { control.metadataCalls += 1; return [{ id: 'vision-model', name: 'Vision Model', inputModalities: ['text', 'image'] }] },
    async resolveModelInfo(provider, model) { control.metadataCalls += 1; return { provider, id: model, name: model, inputModalities: ['text', 'image'] } },
    stream(request) {
      requests.push(request)
      const content = request && request.messages && request.messages[0] && Array.isArray(request.messages[0].content) ? request.messages[0].content : []
      if (content.some((block) => block && block.type === 'image')) {
        assert(content.filter((block) => block && block.type === 'image').length === 1, 'vision call lost an uploaded image block')
        assert(String(content.find((block) => block && block.type === 'image').attachment.attachmentId).startsWith('attachment-image-smoke-'), 'vision call did not use the durable attachment reference')
        if (expectedInstruction) assert(content.filter((block) => block && block.type === 'text').map((block) => block.text).join('\n').includes(expectedInstruction), 'vision call omitted the optional user instruction text')
        return streamText({
          images: [{
            imageIndex: 1,
            summary: '图片包含季度销售表和数据处理流程图。',
            units: [
              { kind: 'text', text: '季度销售额为 120 万元。' },
              { kind: 'table', text: '表格“季度销售”：列为“季度、销售额”；第一季度为 120 万元。' },
              { kind: 'diagram', text: '流程图显示：采集数据 → 分析数据 → 生成报告。' },
            ],
            warnings: [],
          }],
        })
      }
      if (String(request.system || '').includes('解释覆盖复核器')) return streamText({ nodes: [], edges: [] })
      if (String(request.system || '').includes('关系编织')) return streamText({ edges: [] })
      if (String(request.system || '').includes('摘要合并引擎')) return streamText({ summary: '图片展示季度销售数据与处理流程' })
      if (control.blockGraph) {
        let resolveNext = null
        return {
          [Symbol.asyncIterator]() { return this },
          next() { return new Promise((resolve) => { resolveNext = resolve }) },
          return() { if (resolveNext) { resolveNext({ done: true }); resolveNext = null }; return Promise.resolve({ done: true }) },
        }
      }
      const prompt = content.filter((block) => block && block.type === 'text').map((block) => block.text).join('\n')
      const paragraphMatch = Array.from(prompt.matchAll(/\[P(\d+)\]\s*([^\n]*)/g)).find((match) => match[2].includes('季度销售额为 120 万元'))
      assert(paragraphMatch, 'graph prompt did not contain the canonical visual transcript')
      const paragraph = Number(paragraphMatch[1])
      return streamText({
        summary: '图片展示季度销售数据与处理流程',
        nodes: [{ id: 'n1', type: 'fact', text: '季度销售额为 120 万元', quote: '季度销售额为 120 万元。', paragraph }],
        edges: [],
      })
    },
  }
}

async function waitTask(handlers, taskId, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await sleep(10)
  }
  throw new Error('image task did not settle: ' + taskId)
}

function mountHost({ llm, attachments }) {
  const handlers = new Map()
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  hostPlugin().apply({
    get(name) {
      if (name === 'llm') return llm
      if (name === 'attachments') return attachments
      return null
    },
    interval() { return () => {} },
  })
  return handlers
}

const attachments = makeAttachments()
const llm = visionLlm('请关注表格中的数值与流程图连线')
const handlers = mountHost({ llm, attachments })
const catalog = await handlers.get('list-models')({})
assert(catalog.providers[0].models[0].inputModalities.includes('image'), 'dynamic model catalog omitted image capability metadata')

const metadataCallsBeforeInvalid = llm.control.metadataCalls
const invalid = await handlers.get('extract')({ images: [{ name: 'bad.png', mediaType: 'image/png', data: 'not-base64' }] })
assert(invalid && invalid.error && invalid.error.code === 'image_invalid' && invalid.error.details.reason === 'INVALID_IMAGE_BASE64', 'invalid image base64 was not rejected before task creation')
assert(llm.control.metadataCalls === metadataCallsBeforeInvalid, 'malformed image occupied model discovery before local validation')

const started = await handlers.get('extract')({
  title: '季度经营图片',
  text: '请关注表格中的数值与流程图连线。',
  images: [{ name: 'quarter.png', mediaType: 'image/png', data: pngBase64 }],
})
assert(started && started.taskId, 'image extraction with optional text did not start')
const terminal = await waitTask(handlers, started.taskId)
assert(terminal.status === 'succeeded' && terminal.result && terminal.result.nodes.length === 1, 'image extraction with optional text did not succeed: ' + JSON.stringify(terminal))
assert(attachments.calls.length === 1 && attachments.calls[0][0].bytes > 0, 'image bytes were not admitted through the attachment service')
assert(llm.requests.length >= 2 && llm.requests[0].messages[0].content.some((block) => block.type === 'image'), 'first model request was not multimodal')
assert(llm.requests.every((request) => request.provider === 'vision' && request.model === 'vision-model'), 'dynamic preflight-selected image model was not retained by the task')
assert(!llm.requests.slice(1).some((request) => request.messages[0].content.some((block) => block.type === 'image')), 'raw image leaked into graph-generation retries instead of using the canonical transcript')

const documentId = terminal.result.source.documentId
const loaded = await handlers.get('document-load')({ documentId })
assert(loaded && loaded.sourceText.includes('请关注表格中的数值与流程图连线。') && loaded.sourceText.includes('【表格】') && loaded.sourceText.includes('【图示关系】'), 'canonical source lost optional text, table, or diagram transcription')
const visualSource = loaded.graph && loaded.graph.source && loaded.graph.source.visualSource
assert(visualSource && visualSource.kind === 'image-derived' && visualSource.images.length === 1, 'canonical source lost visual provenance')
assert(visualSource.images[0].startParagraph > 0, 'optional user text was not kept outside the image paragraph range')
assert(visualSource.images[0].startParagraph <= terminal.result.nodes[0].paragraph && visualSource.images[0].endParagraph >= terminal.result.nodes[0].paragraph, 'visual paragraph range does not cover image-derived evidence')
assert(!JSON.stringify(loaded).includes(pngBase64), 'document-load exposed raw image base64')

const imageLoaded = await handlers.get('image-load')({ documentId, imageId: 'image-1', expectedRevision: loaded.revision })
assert(imageLoaded && imageLoaded.data === pngBase64 && imageLoaded.mediaType === 'image/png', 'authenticated canonical image could not be loaded')
const wrongImage = await handlers.get('image-load')({ documentId, imageId: 'image-2' })
assert(wrongImage && wrongImage.error && wrongImage.error.code === 'not_found', 'image-load allowed an image outside canonical source metadata')
const forgedCheckpoint = await handlers.get('extract')({
  text: '伪造恢复正文', documentId,
  checkpoint: {
    version: 2, taskKind: 'extract', documentId, baseRevision: loaded.revision,
    imageSource: { version: 1, kind: 'image-derived', images: [{ id: 'image-forged', attachment: { attachmentId: 'attachment-image-smoke-1', mediaType: 'image/png', bytes: 68, width: 1, height: 1 } }] },
    graph: { nodes: [], edges: [] }, nextBatchIndex: 0,
  },
})
assert(forgedCheckpoint && forgedCheckpoint.error && forgedCheckpoint.error.code === 'checkpoint_invalid', 'caller-controlled visual checkpoint was accepted as attachment ownership')

const textOnlyAttachments = makeAttachments()
const textOnlyLlm = {
  listProviders() { return [{ id: 'text', name: 'Text' }] },
  async listModels() { return [{ id: 'text-model', name: 'Text Model', inputModalities: ['text'] }] },
  async resolveModelInfo(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'] } },
  stream() { throw new Error('text-only model stream must not be called with images') },
}
const textOnlyHandlers = mountHost({ llm: textOnlyLlm, attachments: textOnlyAttachments })
const unsupported = await textOnlyHandlers.get('extract')({ images: [{ name: 'quarter.png', mediaType: 'image/png', data: pngBase64 }], model: { provider: 'text', model: 'text-model' } })
assert(unsupported && unsupported.error && unsupported.error.code === 'model_image_unsupported', 'text-only model was not rejected with a typed capability error before admission: ' + JSON.stringify(unsupported))
assert(textOnlyAttachments.calls.length === 0, 'declared text-only model caused an image to be durably admitted before rejection')

const unknownAttachments = makeAttachments()
const unknownLlm = {
  async resolveModelInfo(provider, model) { return { provider, id: model, name: model } },
  stream() {
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: '{' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_CONTENT', message: 'images are unsupported', status: 400 } } }
    })()
  },
}
const unknownHandlers = mountHost({ llm: unknownLlm, attachments: unknownAttachments })
const unknownStarted = await unknownHandlers.get('extract')({ images: [{ name: 'quarter.png', mediaType: 'image/png', data: pngBase64 }], model: { provider: 'unknown', model: 'unknown-model' } })
assert(unknownStarted && unknownStarted.taskId, 'unknown-capability image model was not allowed a provider-level attempt')
const unknownUnsupported = await waitTask(unknownHandlers, unknownStarted.taskId)
assert(unknownUnsupported.status === 'failed' && unknownUnsupported.error.code === 'model_image_unsupported', 'provider UNSUPPORTED_CONTENT was not preserved as model_image_unsupported')
assert(unknownAttachments.calls.length === 1, 'unknown-capability provider attempt did not use an admitted attachment ref')
const textUnsupportedStarted = await unknownHandlers.get('extract')({ text: '纯文本资料。', model: { provider: 'unknown', model: 'unknown-model' } })
assert(textUnsupportedStarted && textUnsupportedStarted.taskId, 'text-only UNSUPPORTED_CONTENT regression task did not start')
const textUnsupported = await waitTask(unknownHandlers, textUnsupportedStarted.taskId)
assert(textUnsupported.status === 'failed' && textUnsupported.error.code !== 'model_image_unsupported', 'text-only UNSUPPORTED_CONTENT was mislabeled as an image capability error')

function invoke(handler, { method = 'POST', url, payload } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = { 'content-type': 'application/json' }
    const res = {
      status: 0, body: '', headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value },
      writeHead(status) { this.status = status },
      end(value) { this.body = value || ''; resolve({ status: this.status, body: this.body, headers: { ...this.headers } }) },
    }
    Promise.resolve(handler(req, res)).catch(reject)
    process.nextTick(() => {
      if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)))
      req.emit('end')
    })
  })
}
async function post(api, endpoint, payload) {
  const response = await invoke(api, { url: '/api/dsh-knowledge-graph/' + endpoint, payload })
  return response.body ? JSON.parse(response.body) : {}
}
async function waitHttpTask(api, taskId, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const response = await invoke(api, { method: 'GET', url: '/api/dsh-knowledge-graph/task-status?taskId=' + encodeURIComponent(taskId) })
    const status = response.body ? JSON.parse(response.body) : {}
    if (status.status !== 'running') return status
    await sleep(10)
  }
  throw new Error('persistent image task did not settle: ' + taskId)
}
async function persistentImageSmoke() {
  const dir = mkdtempSync('/tmp/dsh-kg-image-')
  const dbPath = join(dir, 'image.sqlite')
  const previousDb = process.env.DSH_KG_DB
  process.env.DSH_KG_DB = dbPath
  const persistentAttachments = makeAttachments()
  const persistentLlm = visionLlm()
  const routes = []
  const cleanups = []
  try {
    const persistentHost = await import('../lib/index.js?image-smoke=' + Date.now())
    persistentHost.apply({
      get(name) {
        if (name === 'webServer') return { register(spec) { routes.push(spec); return () => {} } }
        if (name === 'llm') return persistentLlm
        if (name === 'attachments') return persistentAttachments
        return null
      },
      effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
      interval() { return () => {} },
    })
    const route = routes.find((spec) => spec.path === '/api/dsh-knowledge-graph')
    assert(route && typeof route.handler === 'function', 'persistent image API route missing')
    const api = route.handler
    const persistentCatalog = await post(api, 'list-models', {})
    assert(persistentCatalog.providers[0].models[0].inputModalities.includes('image'), 'persistent model catalog omitted image capability metadata')
    const started = await post(api, 'extract', {
      title: '持久化图片', text: '',
      images: [{ name: 'quarter.png', mediaType: 'image/png', data: pngBase64 }],
      model: { provider: 'vision', model: 'vision-model' },
    })
    assert(started && started.taskId, 'persistent image-only extraction did not start: ' + JSON.stringify(started))
    const terminalStatus = await waitHttpTask(api, started.taskId)
    assert(terminalStatus.status === 'succeeded', 'persistent image-only extraction failed: ' + JSON.stringify(terminalStatus))
    const persistentDocumentId = terminalStatus.result && terminalStatus.result.source && terminalStatus.result.source.documentId
    const persisted = await post(api, 'document-load', { documentId: persistentDocumentId })
    assert(persisted && persisted.graph && persisted.graph.source.visualSource.images.length === 1, 'SQLite document lost visual provenance')
    assert(persisted.sourceText.includes('【表格】') && !JSON.stringify(persisted).includes(pngBase64), 'SQLite document lost transcript or exposed image bytes')
    const persistedImageResponse = await invoke(api, { url: '/api/dsh-knowledge-graph/image-load', payload: { documentId: persistentDocumentId, imageId: 'image-1', expectedRevision: persisted.revision } })
    const persistedImage = persistedImageResponse.body ? JSON.parse(persistedImageResponse.body) : {}
    assert(persistedImage && persistedImage.data === pngBase64, 'persistent canonical-membership image-load failed')
    assert(persistedImageResponse.headers['cache-control'] === 'no-store' && persistedImageResponse.headers.pragma === 'no-cache', 'raw image response did not disable caching')
    const forged = await post(api, 'extract', {
      text: '伪造恢复正文', documentId: persistentDocumentId,
      checkpoint: {
        version: 2, taskKind: 'extract', documentId: persistentDocumentId, baseRevision: persisted.revision,
        imageSource: { version: 1, kind: 'image-derived', images: [{ id: 'image-forged', attachment: { attachmentId: 'attachment-image-smoke-1', mediaType: 'image/png', bytes: 68, width: 1, height: 1 } }] },
        graph: { nodes: [], edges: [] }, nextBatchIndex: 0,
      },
    })
    assert(forged && forged.error && forged.error.code === 'checkpoint_invalid', 'persistent route accepted caller-controlled visual checkpoint ownership')
    persistentLlm.control.blockGraph = true
    const checkpointStarted = await post(api, 'extract', {
      title: '图片 checkpoint', text: '',
      images: [{ name: 'checkpoint.png', mediaType: 'image/png', data: pngBase64 }],
      model: { provider: 'vision', model: 'vision-model' },
    })
    assert(checkpointStarted && checkpointStarted.taskId, 'checkpoint-window image task did not start')
    let runningCheckpoint = null
    let lastCheckpointStatus = null
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await invoke(api, { method: 'GET', url: '/api/dsh-knowledge-graph/task-status?includeCheckpoint=1&taskId=' + encodeURIComponent(checkpointStarted.taskId) })
      const status = response.body ? JSON.parse(response.body) : {}
      lastCheckpointStatus = status
      const checkpoint = status.checkpoint || (status.progress && status.progress.checkpoint)
      if (status.status === 'running' && checkpoint && checkpoint.imageSource) { runningCheckpoint = checkpoint; break }
      await sleep(10)
    }
    assert(runningCheckpoint && runningCheckpoint.nextBatchIndex === 0 && runningCheckpoint.imageSource.images.length === 1, 'visual transcript was not checkpointed before graph generation: ' + JSON.stringify(lastCheckpointStatus))
    assert(!JSON.stringify(runningCheckpoint).includes(pngBase64), 'visual checkpoint exposed raw image base64')
    const cancel = await post(api, 'task-cancel', { taskId: checkpointStarted.taskId })
    assert(cancel && cancel.status === 'cancelling', 'checkpoint-window image task cancellation was not acknowledged')
    const cancelled = await waitHttpTask(api, checkpointStarted.taskId)
    assert(cancelled.status === 'cancelled', 'checkpoint-window image task did not settle as cancelled')
    persistentLlm.control.blockGraph = false
    const checkpointStore = await openSqliteStore(dbPath)
    const cancelledRun = checkpointStore.loadCheckpoint(checkpointStarted.taskId)
    assert(cancelledRun && cancelledRun.sourceText.includes('【图片 1'), 'persisted visual checkpoint lost its canonical transcript')
    checkpointStore.saveCheckpoint(runningCheckpoint, {
      runId: checkpointStarted.taskId,
      status: 'running',
      title: '图片 checkpoint',
      sourceText: cancelledRun.sourceText,
    })
    checkpointStore.close()
    const recoveryRoutes = []
    const recoveryCleanups = []
    const recoveryLlm = visionLlm()
    const recoveryHost = await import('../lib/index.js?image-recovery-smoke=' + Date.now())
    recoveryHost.apply({
      get(name) {
        if (name === 'webServer') return { register(spec) { recoveryRoutes.push(spec); return () => {} } }
        if (name === 'llm') return recoveryLlm
        if (name === 'attachments') return persistentAttachments
        return null
      },
      effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') recoveryCleanups.push(cleanup); return cleanup },
      interval() { return () => {} },
    })
    const recoveryRoute = recoveryRoutes.find((spec) => spec.path === '/api/dsh-knowledge-graph')
    assert(recoveryRoute && typeof recoveryRoute.handler === 'function', 'recovery image API route missing')
    const resumed = await post(recoveryRoute.handler, 'resume-extract', { runId: checkpointStarted.taskId, model: { provider: 'vision', model: 'vision-model' } })
    assert(resumed && resumed.taskId === checkpointStarted.taskId && resumed.resumed === true, 'server-owned visual checkpoint did not resume by runId')
    const recovered = await waitHttpTask(recoveryRoute.handler, resumed.taskId)
    assert(recovered.status === 'succeeded' && recovered.result.source.visualSource.images.length === 1, 'visual checkpoint resume did not publish the graph')
    const recoveredImage = await post(recoveryRoute.handler, 'image-load', { documentId: recovered.result.source.documentId, imageId: 'image-1', expectedRevision: recovered.result.revision })
    assert(recoveredImage && recoveredImage.data === pngBase64, 'resumed visual graph lost its authenticated original image')
    assert(recoveryLlm.requests.length >= 1 && !recoveryLlm.requests.some((request) => request.messages[0].content.some((block) => block.type === 'image')), 'visual checkpoint resume resent the original image instead of consuming the persisted transcript')
    for (const cleanup of recoveryCleanups.reverse()) { try { cleanup() } catch (error) {} }
    const databaseBytes = readFileSync(dbPath)
    assert(!databaseBytes.includes(Buffer.from(pngBase64)), 'raw image base64 was persisted into SQLite')
    return { images: persisted.graph.source.visualSource.images.length, modelCalls: persistentLlm.requests.length }
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch (error) {} }
    if (previousDb === undefined) delete process.env.DSH_KG_DB
    else process.env.DSH_KG_DB = previousDb
    rmSync(dir, { recursive: true, force: true })
  }
}

const persistent = await persistentImageSmoke()
const generatedClient = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert(generatedClient.includes("rpc('image-load'"), 'persistent client did not rewrite image-load through HTTP RPC')
assert(!generatedClient.includes('host.call('), 'persistent client retained an undefined dynamic host.call reference')

console.log(JSON.stringify({
  ok: true,
  images: visualSource.images.length,
  sourceParagraphs: loaded.graph.source.paragraphCount,
  modelCalls: llm.requests.length,
  unsupported: unsupported.error.code,
  persistent,
}))
