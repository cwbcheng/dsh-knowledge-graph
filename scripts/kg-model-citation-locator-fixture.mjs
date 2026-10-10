import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { modelSourceTableFixture } from './kg-model-source-table-fixture-data.mjs'

export function modelCitationFixture({ dense = false, anchor = 1, peer = true, long = false } = {}) {
  const fixture = modelSourceTableFixture({ dense, peer })
  if (long) {
    const unit = fixture.sourceUnits[1], oldQuote = unit.text
    unit.text = '长引文的完整条件：只适用于所述范围，不能据此保证其他情境。'.repeat(100) + '\n' + oldQuote
    for (const item of [...fixture.graph.nodes, ...fixture.graph.edges]) {
      if (item.quote === oldQuote) item.quote = unit.text
      for (const evidence of item.evidence || []) if (evidence.quote === oldQuote) evidence.quote = unit.text
    }
    fixture.sourceText = fixture.sourceUnits.map(unit => unit.text).join('\n\n')
  }
  const from = fixture.sourceUnits[1], to = fixture.sourceUnits[anchor]
  const move = value => Array.isArray(value) ? value.map(move) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === 'paragraph' && item === from.paragraph ? to.paragraph : key === 'quote' && item === from.text ? to.text : move(item)])) : value
  fixture.graph = move(fixture.graph)
  return fixture
}

// Exercise the real workbench receiver, including node-window loads and fences.
export function modelCitationLocatorSource(source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')) {
  const start = source.indexOf('        const locateConsumptionReference = async')
  const end = source.indexOf('        const refreshConnectionModels = async', start)
  assert(start >= 0 && end > start)
  return source.slice(start, end)
}

export function modelCitationLocator(environment) {
  return new Function(...Object.keys(environment), modelCitationLocatorSource() + '\nreturn locateConsumptionReference')(...Object.values(environment))
}

export function modelCitationBrowserNavigatorSource() {
  return `function createCitationNavigator(view, report, outside) {
    const resultView = KGViewer.makeView(outside ? {...view.graph,nodes:[],edges:[]} : view.graph, view.sourceText), fullText = view.sourceText;
    const currentResultRef = {current:resultView}, paragraphLocateSeqRef = {current:0}, graphRevisionRef = {current:view.graph.revision}, graphCommitQueueRef = {current:Promise.resolve()};
    let readingParagraph=-1, focusedNodeId=null, scrollTarget='', windowLoads=0;
    const loadGraphDocument=async args=>{windowLoads++;return rpc('document-load',args)}, makeView=KGViewer.makeView;
    const setResultView=()=>{}, setContentScope=()=>{}, navigateWorkspace=()=>{}, setChapterFilter=()=>{}, graphViewMetadata=()=>null, chapterSectionsOf=graph=>graph.source.sections||[];
    const setGraphQueryDraft=()=>{}, setGraphPageDraft=()=>{}, setSelectedNodeId=id=>{focusedNodeId=id}, setSelectedEdgeId=()=>{}, setFocusReq=update=>update({seq:0});
    const setActivePara=id=>{readingParagraph=id}, setFlashPara=()=>{}, ctx={timeout:fn=>fn()}, scrollElIntoCenter=element=>{scrollTarget=element.id};
    ${modelCitationLocatorSource()}
    return async reference=>{if(await locateConsumptionReference(reference))report({...reference,readingParagraph,focusedNodeId,scrollTarget,windowLoads})};
  }`
}
