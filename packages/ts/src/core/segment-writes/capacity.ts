import type { LivePostings } from '#platform/live-postings'
import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { sliceCapacity, sliceClassFor } from '../inverted-index/pools'
import { storedText } from '../stored-values/text'
import type { SurfaceTable } from './surface-table'

export interface DocumentCapacity {
  terms: Map<string, number>
  surfaces: Set<string>
  spellings: Set<string>
  positions: number
}

export function documentCapacity(fields: readonly NativeFieldTokens[], partial: Uint8Array): DocumentCapacity {
  const terms = new Map<string, number>()
  const surfaces = new Set<string>()
  const spellings = new Set<string>()
  let positions = 0
  for (const field of fields) {
    const seen = new Set<string>()
    for (let at = 0; at < field.tokens.length; at += 8) {
      const token = storedText(field.units, field.tokens[at + 1], field.tokens[at + 2])
      seen.add(token)
      const spelling =
        field.tokens[at + 3] === 0xffffffff || field.tokens[at + 4] === 0
          ? token
          : storedText(field.units, field.tokens[at + 3], field.tokens[at + 4])
      if (spelling !== token) surfaces.add(spelling)
      if (partial[field.field] !== 0) spellings.add(spelling)
    }
    for (const token of seen) terms.set(token, (terms.get(token) ?? 0) + 1)
    positions += field.tokens.length / 8 + seen.size
  }
  return { terms, surfaces, spellings, positions }
}

export function reservePostings(postings: LivePostings, document: DocumentCapacity, positions: boolean): void {
  const columns = postings.terms
  let count = columns.ids.header[0]
  let units = columns.ids.header[4]
  let entries = postings.pool.end
  for (const [token, added] of document.terms) {
    const ordinal = columns.ids.get(token)
    if (ordinal === undefined) {
      count++
      units += token.length
      entries += sliceCapacity(sliceClassFor(added))
      continue
    }
    const needed = columns.lengths[ordinal] + added
    if (needed > sliceCapacity(columns.sliceClass[ordinal])) entries += sliceCapacity(sliceClassFor(needed))
  }
  columns.reserve(count, units)
  postings.pool.prepareWrite(entries)
  if (positions) postings.positions.prepareWrite(postings.positions.end + document.positions)
}

export function reserveStrings(table: SurfaceTable, strings: ReadonlySet<string>): void {
  let count = table.strings.header[0]
  let units = table.strings.header[4]
  for (const text of strings) {
    if (table.strings.has(text)) continue
    count++
    units += text.length
  }
  table.reserve(count, units)
}
