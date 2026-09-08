import { createGraphContract } from '../../src/index.host.js'

export const graphContract = createGraphContract()
export const { normalizeGraph, exactOrUniqueTypographicQuote } = graphContract
export const VALID_NODE_TYPES = new Set(graphContract.nodeTypes)
export const VALID_RELATIONS = new Set(graphContract.relations)

export function mergeBatch(batch, acc, batchIndex) {
  // Model IDs are batch-local. Rewrite endpoints before admitting new nodes;
  // an edge can still refer to an existing ID not declared in this batch.
  graphContract.renumberNewIds(batch, acc)
  acc.nodeKeys ||= new Map()
  graphContract.mergeBatch(batch, acc, batchIndex)
  acc.ids = Array.from(acc.nodes.keys())
}
