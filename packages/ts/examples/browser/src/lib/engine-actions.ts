import type { EngineActions } from '@delali/narsil-example-shared'
import { narsilWorker } from '#/worker/bridge'
import { RERANK_ADAPTER_NAME } from '#/worker/local-models'

async function bytesOf(archive: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await archive.arrayBuffer())
}

function nothing(): void {}

export const WORKER_ENGINE_ACTIONS: EngineActions = {
  getDocument: async (indexName, documentId) =>
    (await narsilWorker.call('getDocument', [indexName, documentId])) ?? undefined,
  saveDocument: async (indexName, documentId, document) => {
    await narsilWorker.call('saveDocument', [indexName, documentId, document])
  },
  removeDocument: async (indexName, documentId) => {
    await narsilWorker.call('removeDocument', [indexName, documentId])
  },
  preflight: (indexName, params) => narsilWorker.call('preflight', [indexName, params]),
  getSynonyms: indexName => narsilWorker.call('getSynonyms', [indexName]),
  updateSynonyms: async (indexName, rules) => {
    await narsilWorker.call('updateSynonyms', [indexName, rules])
  },
  changeAnalysis: async (indexName, change) => {
    await narsilWorker.call('changeAnalysis', [indexName, change])
  },
  rebalance: async (indexName, partitionCount) => {
    await narsilWorker.call('rebalance', [indexName, partitionCount])
  },
  updatePartitionConfig: async (indexName, config) => {
    await narsilWorker.call('updatePartitionConfig', [indexName, config])
  },
  compactVectors: async indexName => {
    await narsilWorker.call('compactVectors', [indexName])
  },
  optimizeVectors: async indexName => {
    await narsilWorker.call('optimizeVectors', [indexName])
  },
  snapshot: async indexName =>
    new Blob([await narsilWorker.call('snapshot', [indexName])], { type: 'application/x-tar' }),
  restore: async (indexName, archive) => {
    await narsilWorker.call('restore', [indexName, await bytesOf(archive)])
  },
  exportDocuments: async indexName =>
    new Blob([await narsilWorker.call('exportDocuments', [indexName])], { type: 'application/jsonl' }),
  importDocumentExport: async (indexName, archive) => {
    await narsilWorker.call('importDocumentExport', [indexName, await bytesOf(archive)])
  },
  sync: null,
  groupTotals: true,
  rerankAdapter: RERANK_ADAPTER_NAME,
  onChanged: nothing,
}
