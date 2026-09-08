import assert from 'node:assert/strict'
import hostPlugin, { createGraphContract } from '../src/index.host.js'
import { prepareMarkdownBundle, localAssetPath } from '../src/kg-markdown.mjs'
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
globalThis.harness={handle(name,fn){handlers.set(name,fn)}}
hostPlugin().apply({get(name){return name==='attachments'?{
  async saveImages(inputs){return inputs.map(input=>{const ref={attachmentId:'md-'+ ++saved,mediaType:input.mediaType,bytes:input.data.length,width:1,height:1};stored.set(ref.attachmentId,{ref,data:input.data});return ref})},
  async readImage(ref){return stored.get(ref.attachmentId)},
}:name==='kgExtractor'?{extractChunk:async args=>{assert(args.prompt.includes('禁止猜测图中内容'));return {summary:'fixture',nodes:[{id:'n1',text:'温度升高',type:'fact',quote:'温度升高',paragraph:1}],edges:[]}}}:null},interval(){return()=>{}}})
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
console.log(JSON.stringify({ok:true,referenceStyle:true,repeatedAssetDedup:true,codeExcluded:true,pathTraversalRejected:true,immutableBundle:true,extractionAndImageLoad:true}))
