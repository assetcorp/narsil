import type { AnyDocument } from '../../../types/schema'
import { documentValueBytes } from '../../document-store'
import { cloneProjected, type ResolvedProjection } from '../../projection'
import { getNestedValue } from '../utils'
import type { FrozenDocumentSource } from './document-source'

/**
 * Reads documents from an in-memory array, which a segment built in this
 * process holds.
 *
 * @param documents - The documents in ordinal order.
 * @returns A source whose `byteLength` estimates the resident size of every
 * document.
 */
export function wrapDocumentArray(documents: ReadonlyArray<AnyDocument>): FrozenDocumentSource {
  let residentBytes = 0
  for (const document of documents) {
    residentBytes += documentValueBytes(document)
  }
  return {
    count: documents.length,
    byteLength: residentBytes,
    docAt(ordinal: number): AnyDocument {
      return documents[ordinal]
    },
    readAt(ordinal: number): AnyDocument {
      return documents[ordinal]
    },
    fieldReader(fieldPath: string): (ordinal: number) => unknown {
      return ordinal => getNestedValue(documents[ordinal] as Record<string, unknown>, fieldPath)
    },
    projectedAt(ordinal: number, projection?: ResolvedProjection): AnyDocument {
      return cloneProjected(documents[ordinal] as Record<string, unknown>, projection)
    },
  }
}
