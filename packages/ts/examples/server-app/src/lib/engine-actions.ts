import type { TaskRecord } from '@delali/narsil/client'
import type { EngineActions } from '@delali/narsil-example-shared'
import { RERANK_ADAPTER_NAME } from '#/lib/model-names'
import { narsilClient } from '#/lib/narsil/browser-client'

async function finish(task: Promise<TaskRecord>): Promise<void> {
  const accepted = await task
  const record = await narsilClient.waitForTask(accepted.id)
  if (record.status === 'succeeded') return
  throw new Error(record.error?.message ?? `The ${record.type} task ended as ${record.status}`)
}

async function bytesOf(archive: Blob): Promise<Uint8Array> {
  return new Uint8Array(await archive.arrayBuffer())
}

function blobOf(stream: ReadableStream<Uint8Array>, type: string): Promise<Blob> {
  return new Response(stream, { headers: { 'content-type': type } }).blob()
}

export function createHttpEngineActions(onChanged: (indexName: string) => void): EngineActions {
  return {
    getDocument: (indexName, documentId) => narsilClient.get(indexName, documentId),
    saveDocument: async (indexName, documentId, document) => {
      await narsilClient.put(indexName, documentId, document)
    },
    removeDocument: (indexName, documentId) => narsilClient.remove(indexName, documentId),
    preflight: (indexName, params) => narsilClient.preflight(indexName, params),
    getSynonyms: indexName => narsilClient.getSynonyms(indexName),
    updateSynonyms: (indexName, rules) => narsilClient.updateSynonyms(indexName, rules),
    changeAnalysis: (indexName, change) => finish(narsilClient.changeAnalysis(indexName, change)),
    rebalance: (indexName, partitionCount) => finish(narsilClient.rebalance(indexName, partitionCount)),
    updatePartitionConfig: (indexName, config) => narsilClient.updatePartitionConfig(indexName, config),
    compactVectors: indexName => narsilClient.compactVectors(indexName),
    optimizeVectors: indexName => finish(narsilClient.optimizeVectors(indexName)),
    snapshot: async indexName => blobOf(await narsilClient.snapshot(indexName), 'application/x-tar'),
    restore: async (indexName, archive) => finish(narsilClient.restore(indexName, await bytesOf(archive))),
    exportDocuments: async indexName => blobOf(await narsilClient.exportDocuments(indexName), 'application/jsonl'),
    importDocumentExport: async (indexName, archive) =>
      finish(narsilClient.importDocumentExport(indexName, await bytesOf(archive))),
    sync: {
      getSync: indexName => narsilClient.getSync(indexName),
      updateSync: (indexName, enabled) => narsilClient.updateSync(indexName, { enabled }),
    },
    groupTotals: false,
    rerankAdapter: RERANK_ADAPTER_NAME,
    onChanged,
  }
}
