import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import hostPlugin, { createGraphContract } from '../src/index.host.js'
import { prepareMarkdownBundle, localAssetPath } from '../src/kg-markdown.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'
const contract = createGraphContract()
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const file = {path:'images/a.png',mediaType:'image/png',data:png}
const text = '# 正文\n\n温度升高。\n\n![示意图](images/a.png)\n\n门是蓝色的。\n\n![重复][fig]\n\n[fig]: images/a.png\n\n```md\n![](missing.png)\n```'
const plan = prepareMarkdownBundle({text,files:[file]},contract.splitParagraphsOffsets(text))
assert.equal(plan.references,2)
assert.equal(plan.assets.length,1)
assert.equal(plan.assets[0].paragraphs.length,2)
const inlineText = '前面的说明。\n![图](images/a.png)\n图1-1 示例'
const inlineOffsets = contract.splitParagraphsOffsets(inlineText)
const inlinePlan = prepareMarkdownBundle({text:inlineText,files:[file]},inlineOffsets)
assert.equal(inlinePlan.assets[0].paragraphs[0], inlineOffsets.findIndex(p => inlineText.slice(p.start,p.end).includes('![图]')))
for (const path of ['../secret.png','%2e%2e/secret.png','https://example.com/a.png','C:\\secret.png','/etc/passwd','images/%00.png']) assert.throws(()=>localAssetPath(path))
assert.throws(()=>prepareMarkdownBundle({text,files:[]},contract.splitParagraphsOffsets(text)),/缺少/)
assert.throws(()=>prepareMarkdownBundle({text,files:[file,file]},contract.splitParagraphsOffsets(text)),/重复/)
const handlers=new Map(), stored=new Map()
let saved=0
let visualCalls=0
globalThis.harness={handle(name,fn){handlers.set(name,fn)}}
hostPlugin().apply({get(name){return name==='attachments'?{
  async saveImages(inputs){return inputs.map(input=>{const ref={attachmentId:'md-'+ ++saved,mediaType:input.mediaType,bytes:input.data.length,width:1,height:1};stored.set(ref.attachmentId,{ref,data:input.data});return ref})},
  async readImage(ref){return stored.get(ref.attachmentId)},
}:name==='kgExtractor'?{
  extractImages:async args=>{visualCalls++;assert.equal(args.images[0].id,'figure-1');return {images:[{imageIndex:1,summary:'图中展示 A 到 B 的箭头。',units:[{kind:'diagram',text:'关系：A → B；图中依据：可见箭头。'}],warnings:[]}] }},
  extractChunk:async args=>{if(visualCalls){assert(args.prompt.includes('本批内容是 AI 对已保存图片的视觉转写'));assert(args.prompt.includes('候选结论保持待复核'));return {summary:'视觉材料',nodes:[{id:'v1',text:'A 指向 B',type:'fact',quote:'关系：A → B；图中依据：可见箭头。',paragraph:3}],edges:[]}}assert(args.prompt.includes('禁止猜测图中内容'));return {summary:'fixture',nodes:[{id:'n1',text:'温度升高',type:'fact',quote:'温度升高',paragraph:1}],edges:[]}},
}:null},interval(){return()=>{}}})
const imported=await handlers.get('markdown-import')({text,files:[file]})
assert(imported.bundleId,JSON.stringify(imported))
assert.equal(saved,1)
const mismatch=await handlers.get('extract')({text:text+'changed',markdownBundleId:imported.bundleId})
assert(mismatch.error)
const started=await handlers.get('extract')({text,markdownBundleId:imported.bundleId})
assert(started.taskId,JSON.stringify(started))
let result
for(let i=0;i<500;i++){result=await handlers.get('task-status')({taskId:started.taskId});if(result.status!=='running')break;await new Promise(r=>setTimeout(r,5))}
assert.equal(result.status,'succeeded',JSON.stringify(result.error))
assert.equal(result.result.source.visualSource.kind,'markdown-assets')
assert.deepEqual(result.result.source.visualSource.images[0].paragraphs,plan.assets[0].paragraphs)
assert.equal(result.result.source.visualSource.images[0].interpretationStatus,'not_requested')
const loaded=await handlers.get('image-load')({documentId:result.result.source.documentId,imageId:'figure-1',expectedRevision:result.result.revision})
assert.equal(loaded.data,png)
const missing=await handlers.get('image-load')({documentId:result.result.source.documentId,imageId:'figure-2'})
assert(missing.error)
const visualAppend = await handlers.get('append-extract')({
  documentId: result.result.source.documentId, expectedRevision: result.result.revision,
  imageIds: ['figure-1'], text: '',
})
assert(visualAppend.taskId, 'existing Markdown figures must admit an explicit visual interpretation task: '+JSON.stringify(visualAppend))
let visualResult
for(let i=0;i<500;i++){visualResult=await handlers.get('task-status')({taskId:visualAppend.taskId});if(visualResult.status!=='running')break;await new Promise(r=>setTimeout(r,5))}
assert.equal(visualResult.status,'succeeded',JSON.stringify(visualResult.error))
const visualGraph=visualResult.result
const visualNode=visualGraph.nodes.find(node=>node.text==='A 指向 B')
assert(visualNode,'the visually encoded relationship must become a graph node')
assert.equal(visualNode.entailmentStatus,'unverified','model interpretation must not self-certify visual truth')
assert(visualNode.paragraph>=contract.splitParagraphs(text).length,'image evidence must be anchored to appended, labelled visual transcription')
assert.equal(visualGraph.source.visualSource.images.length,1,'existing attachment metadata must not be replaced')
assert.deepEqual(visualGraph.source.visualSource.images[0].paragraphs,plan.assets[0].paragraphs,'original Markdown image anchors must survive')
assert.equal(visualGraph.source.visualSource.images[0].interpretationStatus,'ai_unverified')
assert.equal(visualGraph.source.visualSource.images[0].startParagraph,visualNode.paragraph-2)
assert.equal(visualGraph.source.visualSource.images[0].endParagraph,visualNode.paragraph)
const exported=await handlers.get('document-export')({documentId:visualGraph.source.documentId,includeSourceText:true})
assert(exported.sourceText.startsWith(text),'visual interpretation must preserve the original Markdown source')
assert(exported.sourceText.includes('【AI 视觉转写；非原书文字，待对照原图复核】'),'derived source must retain its warning outside UI')
assert(exported.sourceText.includes('【图示关系】关系：A → B；图中依据：可见箭头。'))
const callsAfterSuccess=visualCalls
for(const attempt of [
  {imageIds:['figure-1'],expectedRevision:visualGraph.revision},
  {imageIds:['foreign'],expectedRevision:visualGraph.revision},
  {imageIds:['figure-1','figure-1'],expectedRevision:visualGraph.revision},
  {imageIds:['figure-1'],expectedRevision:result.result.revision},
  {imageIds:['figure-1'],expectedRevision:visualGraph.revision,text:'forged source'},
]){
  const rejected=await handlers.get('append-extract')({documentId:visualGraph.source.documentId,text:'',...attempt})
  assert(rejected.error,JSON.stringify(attempt))
}
assert.equal(visualCalls,callsAfterSuccess,'invalid or duplicate selections must not spend a vision request')

async function persistentVisualAppend() {
  const dir = mkdtempSync('/tmp/dsh-kg-markdown-vision-')
  const dbPath = join(dir, 'graph.sqlite')
  const previousDb = process.env.DSH_KG_DB
  process.env.DSH_KG_DB = dbPath
  const routes = [], cleanups = [], attachments = new Map()
  let visualRequests = 0
  const extractor = {
    async extractImages({ images }) {
      visualRequests++
      assert.equal(images.length, 1)
      assert(attachments.has(images[0].attachment.attachmentId), 'visual task must reference the stored attachment')
      return { images: [{ imageIndex: 1, summary: 'A 指向 B', units: [{ kind: 'diagram', text: '关系：A → B；图中依据：可见箭头。' }] }] }
    },
    async extractChunk({ prompt }) {
      if (visualRequests) {
        assert(prompt.includes('本批内容是 AI 对已保存图片的视觉转写'))
      return { summary: '视觉关系', nodes: [{ id: 'visual', type: 'fact', text: 'A 指向 B', quote: '关系：A → B；图中依据：可见箭头。', paragraph: 3 }], edges: [] }
      }
      return { summary: '正文', nodes: [{ id: 'text', type: 'fact', text: '温度升高', quote: '温度升高', paragraph: 1 }], edges: [] }
    },
  }
  function invoke(api, endpoint, payload) {
    return new Promise((resolve, reject) => {
      const request = new EventEmitter()
      request.method = endpoint === 'task-status' ? 'GET' : 'POST'
      request.url = '/api/dsh-knowledge-graph/' + endpoint + (endpoint === 'task-status' ? '?taskId=' + encodeURIComponent(payload.taskId) : '')
      request.headers = { 'content-type': 'application/json' }
      const response = { status: 0, writeHead(code) { this.status = code }, setHeader() {},
        end(body) { resolve(body ? JSON.parse(body) : {}) } }
      Promise.resolve(api(request, response)).catch(reject)
      process.nextTick(() => { request.emit('data', Buffer.from(JSON.stringify(payload))); request.emit('end') })
    })
  }
  async function settled(api, taskId) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const result = await invoke(api, 'task-status', { taskId })
      if (result.status !== 'running') return result
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('persistent visual task did not settle')
  }
  try {
    const plugin = await import('../lib/index.js?markdown-visual=' + Date.now())
    plugin.apply({ get(name) {
      if (name === 'webServer') return { register(spec) { routes.push(spec); return () => {} } }
      if (name === 'kgExtractor') return extractor
      if (name === 'attachments') return {
        async saveImages(inputs) { return inputs.map((input, index) => {
          const ref = { attachmentId: 'persistent-md-' + (attachments.size + index + 1), mediaType: input.mediaType,
            bytes: input.data.length, width: 1, height: 1 }
          attachments.set(ref.attachmentId, { ref, data: input.data })
          return ref
        }) },
        async readImage(ref) { return attachments.get(ref.attachmentId) },
      }
      return null
    }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
    interval() { return () => {} } })
    const api = routes.find(route => route.path === '/api/dsh-knowledge-graph')?.handler
    assert(api, 'persistent markdown API route missing')
    const imported = await invoke(api, 'markdown-import', { text, files: [file] })
    assert(imported.bundleId)
    const initial = await invoke(api, 'extract', { title: 'Markdown visual fixture', text, markdownBundleId: imported.bundleId })
    assert(initial.taskId)
    const first = await settled(api, initial.taskId)
    assert.equal(first.status, 'succeeded', JSON.stringify(first.error))
    const documentId = first.result.source.documentId
    const append = await invoke(api, 'append-extract', { documentId, expectedRevision: first.result.revision, imageIds: ['figure-1'] })
    assert(append.taskId, JSON.stringify(append))
    const second = await settled(api, append.taskId)
    assert.equal(second.status, 'succeeded', JSON.stringify(second.error))
    const store = await openSqliteStore(dbPath)
    try {
      const persisted = store.getDocument(documentId)
      const image = persisted.source.visualSource.images[0]
      assert.equal(image.interpretationStatus, 'ai_unverified')
      assert.deepEqual(image.paragraphs, plan.assets[0].paragraphs)
      assert(persisted.sourceText.startsWith(text), 'SQLite append must preserve original Markdown')
      assert(persisted.nodes.some(node => node.text === 'A 指向 B' && node.entailmentStatus === 'unverified' &&
        node.paragraph >= image.startParagraph && node.paragraph <= image.endParagraph))
      assert(persisted.nodes.some(node => node.text === '温度升高'), 'visual append must not replace older nodes')
    } finally { store.close() }
    assert.equal(visualRequests, 1)
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
    if (previousDb === undefined) delete process.env.DSH_KG_DB
    else process.env.DSH_KG_DB = previousDb
    rmSync(dir, { recursive: true, force: true })
  }
}
await persistentVisualAppend()
console.log(JSON.stringify({ok:true,referenceStyle:true,repeatedAssetDedup:true,codeExcluded:true,pathTraversalRejected:true,immutableBundle:true,extractionAndImageLoad:true,visualAppend:true,sourcePreserved:true,revisionFence:true,persistentVisualAppend:true}))
