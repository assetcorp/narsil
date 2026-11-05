import type { NarsilClient } from '../../client/client'
import type { RequestOptions } from '../../client/options'
import { ClientErrorCodes, ErrorCodes, NarsilError } from '../../errors'
import type { QueuedWrite, UploadOutcome } from './types'

const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 413, 422])

export interface UploadBatch {
  outcomes: UploadOutcome[]
  failure: unknown | null
}

function refusedBy(error: unknown): error is NarsilError {
  if (!(error instanceof NarsilError)) return false
  const status = error.details.status
  return typeof status === 'number' && REFUSED_STATUSES.has(status)
}

export function latestWrites(writes: readonly QueuedWrite[]): QueuedWrite[] {
  const latest = new Map<string, QueuedWrite>()
  for (const write of writes) {
    const held = latest.get(write.documentId)
    if (held === undefined || held.sequence < write.sequence) latest.set(write.documentId, write)
  }
  return [...latest.values()].sort((a, b) => a.sequence - b.sequence)
}

async function sendOne(
  client: NarsilClient,
  indexName: string,
  write: QueuedWrite,
  options: RequestOptions,
): Promise<void> {
  if (write.document !== null) {
    await client.put(indexName, write.documentId, write.document, undefined, options)
    return
  }
  try {
    await client.remove(indexName, write.documentId, undefined, options)
  } catch (error) {
    if (!(error instanceof NarsilError) || error.code !== ErrorCodes.DOC_NOT_FOUND) throw error
  }
}

export async function sendThroughServer(
  client: NarsilClient,
  indexName: string,
  writes: readonly QueuedWrite[],
  options: () => Promise<RequestOptions>,
): Promise<UploadBatch> {
  const outcomes: UploadOutcome[] = []
  for (const write of writes) {
    try {
      await sendOne(client, indexName, write, await options())
      outcomes.push({ accepted: true })
    } catch (error) {
      if (!refusedBy(error)) return { outcomes, failure: error }
      outcomes.push({ accepted: false, error })
    }
  }
  return { outcomes, failure: null }
}

export async function sendThroughBackend(
  upload: (writes: readonly QueuedWrite[]) => Promise<UploadOutcome[]>,
  writes: readonly QueuedWrite[],
): Promise<UploadBatch> {
  let outcomes: unknown
  try {
    outcomes = await upload(writes)
  } catch (error) {
    return { outcomes: [], failure: error }
  }
  if (!Array.isArray(outcomes) || outcomes.length !== writes.length) {
    return {
      outcomes: [],
      failure: new NarsilError(
        ClientErrorCodes.CLIENT_INVALID_RESPONSE,
        `The upload function returned ${Array.isArray(outcomes) ? outcomes.length : 'no'} outcomes for ${writes.length} writes`,
      ),
    }
  }
  for (const outcome of outcomes as unknown[]) {
    const valid =
      outcome !== null &&
      typeof outcome === 'object' &&
      ((outcome as UploadOutcome).accepted === true ||
        ((outcome as UploadOutcome).accepted === false &&
          (outcome as { error?: unknown }).error instanceof NarsilError))
    if (!valid) {
      return {
        outcomes: [],
        failure: new NarsilError(
          ClientErrorCodes.CLIENT_INVALID_RESPONSE,
          'Each outcome of the upload function must be { accepted: true } or { accepted: false, error }',
        ),
      }
    }
  }
  return { outcomes: outcomes as UploadOutcome[], failure: null }
}
