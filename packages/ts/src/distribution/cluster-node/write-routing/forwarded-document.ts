import { ErrorCodes, NarsilError } from '../../../errors'
import { decode } from '../../../serialization/msgpack'
import { restoreVectorFields } from '../../../serialization/vector-field-bytes'
import type { AnyDocument } from '../../../types/schema'
import { isRecord } from '../../payload-guards'
import type { BatchWrite } from './batch-write'
import { WHOLE_DOCUMENT } from './numbered-write'
import type { WriteRoutingDeps } from './types'

const NO_VECTOR_FIELDS: ReadonlySet<string> = new Set()

export type StoredMerge = (stored: AnyDocument | undefined) => AnyDocument

export type ForwardedReplacement = AnyDocument | StoredMerge

function withVectorValues(
  deps: WriteRoutingDeps,
  indexName: string,
  documentId: string,
  document: Record<string, unknown>,
): Record<string, unknown> {
  try {
    restoreVectorFields(document, deps.vectorFieldPathsOf?.(indexName) ?? NO_VECTOR_FIELDS)
  } catch (err) {
    throw new NarsilError(
      ErrorCodes.DOC_VALIDATION_FAILED,
      `Forwarded document '${documentId}' holds a vector that is not a whole number of float32 values: ${err instanceof Error ? err.message : String(err)}`,
      { documentId },
    )
  }
  return document
}

export function decodeForwardedDocument(
  deps: WriteRoutingDeps,
  indexName: string,
  bytes: Uint8Array,
  documentId: string,
): AnyDocument {
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch (err) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Forwarded document could not be decoded: ${String(err)}`, {
      documentId,
    })
  }
  if (!isRecord(decoded)) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'A forwarded document must be a MessagePack map', {
      documentId,
    })
  }
  return withVectorValues(deps, indexName, documentId, decoded) as AnyDocument
}

export function forwardedReplacementOf(
  deps: WriteRoutingDeps,
  indexName: string,
  documentId: string,
  document: Uint8Array | null,
  updateFields: Record<string, unknown> | null,
): ForwardedReplacement {
  if (document !== null) return decodeForwardedDocument(deps, indexName, document, documentId)
  if (updateFields === null) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      'Invalid ForwardPayload: update requires a document or updateFields',
    )
  }
  const fields = withVectorValues(deps, indexName, documentId, updateFields)
  return stored => {
    if (stored === undefined) {
      throw new NarsilError(
        ErrorCodes.DOC_NOT_FOUND,
        `Document '${documentId}' does not exist in index '${indexName}'`,
        { indexName, documentId },
      )
    }
    return { ...stored, ...fields }
  }
}

export function replacementFor(replacement: ForwardedReplacement, stored: AnyDocument | undefined): AnyDocument {
  return typeof replacement === 'function' ? replacement(stored) : replacement
}

export async function sizeStoredMerges(
  deps: WriteRoutingDeps,
  indexName: string,
  writes: readonly BatchWrite<AnyDocument>[],
): Promise<void> {
  if (!writes.some(write => write.mergeWithStored !== undefined)) return
  if ((deps.writeProjection?.boundOf(indexName) ?? null) === null) return
  for (const write of writes) {
    if (write.mergeWithStored === undefined) continue
    const stored = await deps.engine.get(indexName, write.docId, WHOLE_DOCUMENT)
    if (stored !== undefined) write.value = write.mergeWithStored(stored)
  }
}
