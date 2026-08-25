import { INDEX_NAME, PARTITION_COUNT } from '../topology'
import { loadCorpus } from './corpus'
import { callNode } from './node-client'
import type { ProvisionResult } from './probe-types'

const BATCH_SIZE = 200
const INDEX_ALREADY_EXISTS = 'INDEX_ALREADY_EXISTS'

interface BatchResponse {
  succeeded?: unknown
  failed?: unknown
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

export async function provisionIndex(nodeId: string): Promise<ProvisionResult> {
  const created = await callNode(nodeId, 'POST', '/indexes', {
    name: INDEX_NAME,
    config: { schema: { text: 'string', topic: 'enum' } },
  })

  if (!created.ok && created.failure?.code !== INDEX_ALREADY_EXISTS) {
    return {
      indexCreated: false,
      documentsIngested: 0,
      documentsFailed: 0,
      message: `Creating '${INDEX_NAME}' failed: ${created.failure?.message ?? 'unknown error'}`,
    }
  }

  const documents = loadCorpus()
  let ingested = 0
  let failed = 0

  for (let offset = 0; offset < documents.length; offset += BATCH_SIZE) {
    const chunk = documents.slice(offset, offset + BATCH_SIZE)
    const result = await callNode<BatchResponse>(nodeId, 'POST', `/indexes/${INDEX_NAME}/documents/_batch`, {
      documents: chunk,
    })
    if (!result.ok) {
      return {
        indexCreated: created.ok,
        documentsIngested: ingested,
        documentsFailed: failed + chunk.length,
        message: `Ingest stopped at document ${offset}: ${result.failure?.message ?? 'unknown error'}`,
      }
    }
    ingested += countOf(result.value?.succeeded)
    failed += countOf(result.value?.failed)
  }

  return {
    indexCreated: created.ok,
    documentsIngested: ingested,
    documentsFailed: failed,
    message: created.ok
      ? `Created '${INDEX_NAME}' across ${PARTITION_COUNT} partitions and ingested ${ingested} documents through ${nodeId}`
      : `'${INDEX_NAME}' already existed, and ${ingested} documents were written again through ${nodeId}`,
  }
}
