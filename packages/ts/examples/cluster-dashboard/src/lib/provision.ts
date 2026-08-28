import type { BatchResult } from '@delali/narsil'
import { ErrorCodes, NarsilError } from '@delali/narsil/client'
import { INDEX_NAME, PARTITION_COUNT } from '../topology'
import { loadCorpus } from './corpus'
import { failureOf, nodeClient } from './node-client'
import type { ProvisionResult } from './probe-types'

const INDEX_SCHEMA = { text: 'string', topic: 'enum' }
const INGEST_TIMEOUT_MS = 120_000

function alreadyExists(error: unknown): boolean {
  return error instanceof NarsilError && error.code === ErrorCodes.INDEX_ALREADY_EXISTS
}

function duplicateCountOf(result: BatchResult): number {
  return result.failed.filter(entry => entry.error.code === ErrorCodes.DOC_ALREADY_EXISTS).length
}

function ingestMessage(nodeId: string, created: boolean, result: BatchResult): string {
  const written = result.succeeded.length
  if (created) {
    return `Created '${INDEX_NAME}' across ${PARTITION_COUNT} partitions and ingested ${written} documents through ${nodeId}`
  }
  const duplicates = duplicateCountOf(result)
  if (written === 0 && duplicates === result.failed.length) {
    return `'${INDEX_NAME}' already holds all ${duplicates} documents, so ${nodeId} kept every one of them as it stands`
  }
  return `'${INDEX_NAME}' already existed, and ${nodeId} wrote ${written} documents while it refused ${result.failed.length}`
}

async function createIndexIfMissing(nodeId: string): Promise<{ created: boolean; failure: string | null }> {
  try {
    await nodeClient(nodeId).createIndex(INDEX_NAME, { schema: INDEX_SCHEMA })
    return { created: true, failure: null }
  } catch (error) {
    if (alreadyExists(error)) {
      return { created: false, failure: null }
    }
    return { created: false, failure: failureOf(error).message }
  }
}

/**
 * Creates the dashboard's index on one node and writes the sample corpus through it.
 *
 * The cluster spreads the index over its partitions as the controller allocates them, and the node answers with the
 * documents it took alongside the documents it refused. A write carries the id the corpus gives each answer, and an
 * insert refuses an id the index already holds, so a second run leaves the documents as they are.
 *
 * @param nodeId - The node the dashboard sends the creation and the writes to.
 * @returns What the run created, how many documents it wrote, and the line the panel shows.
 */
export async function provisionIndex(nodeId: string): Promise<ProvisionResult> {
  const creation = await createIndexIfMissing(nodeId)
  if (creation.failure !== null) {
    return {
      indexCreated: false,
      documentsIngested: 0,
      documentsFailed: 0,
      message: `Creating '${INDEX_NAME}' failed: ${creation.failure}`,
    }
  }

  const documents = loadCorpus()
  try {
    const result = await nodeClient(nodeId).insertBatch(INDEX_NAME, documents, undefined, {
      timeoutMs: INGEST_TIMEOUT_MS,
    })
    return {
      indexCreated: creation.created,
      documentsIngested: result.succeeded.length,
      documentsFailed: result.failed.length,
      message: ingestMessage(nodeId, creation.created, result),
    }
  } catch (error) {
    const failure = failureOf(error)
    return {
      indexCreated: creation.created,
      documentsIngested: 0,
      documentsFailed: 0,
      message: `Ingest through ${nodeId} failed under ${failure.code}, so how many of the ${documents.length} documents reached the cluster is unknown: ${failure.message}`,
    }
  }
}
