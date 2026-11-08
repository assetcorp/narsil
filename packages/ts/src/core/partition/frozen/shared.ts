import type { SerializedSurfaceForms } from '../../../types/internal'
import { wrapEncodedDocumentTable } from './document-source'
import { wrapExternalIdTable } from './external-ids'
import { assembleFrozenSegment, type FrozenSegment } from './index'
import type { SharedSegmentSnapshot } from './shared-snapshot'
import { decodeSurfaceTable } from './surface-table'
import { wrapFrozenTokenTable } from './token-table'

export function createSharedFrozenSegment(
  snapshot: SharedSegmentSnapshot,
  survivingSurfaceForms?: SerializedSurfaceForms,
): FrozenSegment {
  const tokenTable = wrapFrozenTokenTable(snapshot.tokenTable)
  return assembleFrozenSegment(
    snapshot.segmentId,
    {
      ...snapshot,
      tokenTable,
      idTable: wrapExternalIdTable(snapshot.idTable),
      documentTable: snapshot.documentTable,
      readSurfaceForms: () => (snapshot.surfaceTable === null ? null : decodeSurfaceTable(snapshot.surfaceTable)),
      docFrequencies: () => {
        const frequencies: Record<string, number> = Object.create(null)
        for (let at = 0; at < tokenTable.size; at++) {
          frequencies[tokenTable.tokenAt(at)] = tokenTable.documentFrequencyAt(at)
        }
        return frequencies
      },
    },
    wrapEncodedDocumentTable(snapshot.documentTable),
    snapshot,
    snapshot.partialWords,
    survivingSurfaceForms,
  )
}
