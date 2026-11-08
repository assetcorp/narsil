import {
  POSITION_POOL_START_VALUES,
  POSTING_POOL_START_ENTRIES,
  TERM_TABLE_START_CAPACITY,
} from '../inverted-index/constants'
import { SURFACE_TABLE_START_CAPACITY } from './constants'
import type { GrowingSegment } from './growing'
import type { SurfaceTable } from './surface-table'

function trimStrings(table: SurfaceTable): void {
  const count = Math.max(SURFACE_TABLE_START_CAPACITY, table.strings.header[0])
  const token = table.token.slice(0, count)
  const counts = table.count.slice(0, count)
  table.strings.trim(SURFACE_TABLE_START_CAPACITY)
  table.token = token
  table.count = counts
}

export function trimSegment(segment: GrowingSegment): void {
  try {
    const { terms, pool, positions } = segment.postings
    const count = Math.max(TERM_TABLE_START_CAPACITY, terms.count)
    const columns = {
      sliceStart: terms.sliceStart.slice(0, count),
      sliceClass: terms.sliceClass.slice(0, count),
      lengths: terms.lengths.slice(0, count),
      docFrequency: terms.docFrequency.slice(0, count),
      deadDocuments: terms.deadDocuments.slice(0, count),
      totalTermFrequency: terms.totalTermFrequency.slice(0, count),
      surfaceOccurrences: terms.surfaceOccurrences.slice(0, count),
      revision: terms.revision.slice(0, count),
      flags: terms.flags.slice(0, count),
    }
    terms.ids.trim(TERM_TABLE_START_CAPACITY)
    Object.assign(terms, columns)
    const end = Math.max(POSTING_POOL_START_ENTRIES, pool.end)
    const postings = {
      docIds: pool.docIds.slice(0, end),
      frequencies: pool.frequencies.slice(0, end),
      fieldIndices: pool.fieldIndices.slice(0, end),
      positionStarts: pool.positionStarts?.slice(0, end) ?? null,
    }
    Object.assign(pool, postings)
    positions.values = positions.values.slice(0, Math.max(POSITION_POOL_START_VALUES, positions.end))
    if (segment.surfaces !== null) trimStrings(segment.surfaces)
    const spellings = segment.spellings
    if (spellings !== null) {
      trimStrings(spellings)
      spellings.codePoints = spellings.codePoints.slice(0, spellings.count.length)
      spellings.runs.trim()
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
  }
}
