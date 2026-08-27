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
 * documents it took alongside the documents it refused. Running this a second time writes every document again under
 * the id it already carries.
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
      message: creation.created
        ? `Created '${INDEX_NAME}' across ${PARTITION_COUNT} partitions and ingested ${result.succeeded.length} documents through ${nodeId}`
        : `'${INDEX_NAME}' already existed, and ${result.succeeded.length} documents were written again through ${nodeId}`,
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
