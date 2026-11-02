import { compareCodePoints } from '../../core/ordering'
import type { ExternalIdTable } from '../../core/partition/frozen/external-ids'
import type { PagedSegmentSnapshot } from '../../core/partition/frozen/paged-snapshot'
import { loadFailed } from './format'
import type { SectionReader } from './section-file'

const VALUE_BYTES = 4
const decoder = new TextDecoder('utf-8', { fatal: true })

function uint32At(reader: SectionReader, index: number): number {
  const bytes = reader.bytesAt(index * VALUE_BYTES, VALUE_BYTES)
  return new DataView(bytes.buffer, bytes.byteOffset, VALUE_BYTES).getUint32(0, true)
}

export function createPagedIdTable(
  snapshot: Pick<PagedSegmentSnapshot, 'documentCount' | 'key' | 'idSampleIds' | 'idSamplePositions'>,
  ids: SectionReader,
  idOffsets: SectionReader,
  idOrder: SectionReader,
): ExternalIdTable {
  const count = snapshot.documentCount
  const { idSampleIds, idSamplePositions, key } = snapshot
  let sampleBytes = idSamplePositions.byteLength
  for (const id of idSampleIds) sampleBytes += id.length

  function idAt(ordinal: number): string {
    const from = uint32At(idOffsets, ordinal)
    const to = uint32At(idOffsets, ordinal + 1)
    if (to < from || to > ids.length)
      loadFailed(`The ID of document ${ordinal} of "${key}" leaves its list`, { ordinal })
    try {
      return decoder.decode(ids.bytesAt(from, to - from))
    } catch {
      return loadFailed(`The ID of document ${ordinal} of "${key}" is not valid UTF-8`, { ordinal })
    }
  }

  function ordinalAtPosition(position: number): number {
    const ordinal = uint32At(idOrder, position)
    if (ordinal >= count) loadFailed(`idOrder of "${key}" names document ${ordinal} of ${count}`, { position })
    return ordinal
  }

  function windowOf(docId: string): { from: number; to: number } {
    let low = 0
    let high = idSampleIds.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (compareCodePoints(idSampleIds[middle], docId) <= 0) low = middle + 1
      else high = middle
    }
    const from = low === 0 ? 0 : idSamplePositions[low - 1]
    const to = low < idSamplePositions.length ? idSamplePositions[low] + 1 : count
    return { from, to: Math.min(to, count) }
  }

  return {
    count,
    bytes: sampleBytes,
    idAt,

    ordinalOf(docId: string): number {
      if (count === 0) return -1
      const window = windowOf(docId)
      let low = window.from
      let high = window.to
      while (low < high) {
        const middle = (low + high) >>> 1
        const ordinal = ordinalAtPosition(middle)
        const order = compareCodePoints(idAt(ordinal), docId)
        if (order === 0) return ordinal
        if (order < 0) low = middle + 1
        else high = middle
      }
      return -1
    },

    sortedOrdinalAt: ordinalAtPosition,

    collectSortedIds(excluded: (ordinal: number) => boolean): string[] {
      const kept: string[] = []
      for (let position = 0; position < count; position++) {
        const ordinal = ordinalAtPosition(position)
        if (!excluded(ordinal)) kept.push(idAt(ordinal))
      }
      return kept
    },
  }
}
