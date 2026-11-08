import { ErrorCodes, NarsilError } from '../../errors'
import type { SchemaField } from '../../schema/validator'
import type { LanguageModule } from '../../types/language'
import { GrowingSegment } from '../segment-writes/growing'
import type { PreparedSegmentField } from '../segment-writes/prepared-tokens'
import { SegmentRefusal } from '../segment-writes/status'
import { growingSurfaceReader } from '../segment-writes/surface-reader'
import { SurfaceTable } from '../segment-writes/surface-table'
import type { TermTable } from '../term-table'
import { createSpellingTable } from './partial-words/registry'
import { type PreparedText, preparedSurfaces } from './prepared-text'
import type { PartitionReadState } from './read-state'
import { getOrCreateFieldNameIndex, type PartitionInsertOptions, type PartitionState } from './utils'

const segments = new WeakMap<PartitionReadState, { segment: GrowingSegment; terms: TermTable }>()

export function growingKeywordRegions(state: PartitionReadState) {
  return segments.get(state)?.segment.regions() ?? null
}

function seedSurfaces(state: PartitionState, segment: GrowingSegment): void {
  if (state.surfaceRegistry.size() === 0) return
  const table = new SurfaceTable()
  const terms = segment.postings.terms
  for (const [surface, value] of Object.entries(state.surfaceRegistry.serialize())) {
    if (!Array.isArray(value)) continue
    const [count, token] = value
    const ordinal = terms.ids.get(token)
    if (ordinal === undefined) continue
    if (count > 0xffffffff) throw new SegmentRefusal(8)
    const entry = table.strings.header[0]
    table.reserve(entry + 1, table.strings.header[4] + surface.length)
    table.strings.set(surface, entry)
    table.token[entry] = ordinal
    table.count[entry] = count
  }
  segment.surfaces = table
}

function seedFields(state: PartitionState, segment: GrowingSegment): void {
  const fields = state.fieldNameTable.names
  segment.reserveFields(state.docStore.internalIdCapacity(), fields.length)
  segment.fields.documents[0] = state.docStore.count()
  for (let field = 0; field < fields.length; field++) {
    const column = state.docStore.fieldLengthColumn(fields[field])
    if (column !== null)
      segment.fields.values.set(
        column.subarray(0, segment.fields.ordinalCapacity),
        field * segment.fields.ordinalCapacity,
      )
    segment.fields.totals[field] = state.stats.totalFieldLengths[fields[field]] ?? 0
  }
}

export function prepareKeywordSegment(
  state: PartitionState,
  fields: readonly SchemaField[],
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
): GrowingSegment {
  const held = segments.get(state)
  if (held !== undefined && held.terms === state.invertedIdx.livePostings.terms.ids) return held.segment
  const segment = new GrowingSegment(state.invertedIdx.livePostings, state.trackPositions)
  seedFields(state, segment)
  seedSurfaces(state, segment)
  const partial = fields.filter(field => field.partial).map(field => field.path)
  if (partial.length > 0) {
    if (state.docStore.count() > 0 && state.partialWords.spellings() === null)
      state.partialWords.readerFor({ fields: partial, language, options })
    const spellings = createSpellingTable()
    const source = state.partialWords.spellings()
    if (source !== null) spellings.load(source, segment.postings.terms)
    segment.spellings = spellings
  }
  const terms = segment.postings.terms
  const occurrences = new Float64Array(terms.surfaceOccurrences.length)
  if (segment.surfaces !== null)
    for (const entry of segment.surfaces.liveEntries())
      occurrences[segment.surfaces.token[entry]] += segment.surfaces.count[entry]
  segments.set(state, { segment, terms: terms.ids })
  terms.surfaceOccurrences.set(occurrences)
  state.surfaceRegistry.adopt(growingSurfaceReader(segment))
  if (partial.length > 0) state.partialWords.adopt(segment, partial)
  return segment
}

export function keywordFields(
  state: PartitionState,
  prepared: PreparedText,
  schemaFields: readonly SchemaField[],
  ordinal: number,
): { segment: GrowingSegment; fields: PreparedSegmentField[] } {
  const segment = segments.get(state)?.segment
  if (segment === undefined)
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The keyword segment has no prepared publication')
  const fields: PreparedSegmentField[] = []
  for (const [path, text] of prepared.fields) {
    const entry = { field: getOrCreateFieldNameIndex(state.fieldNameTable, path), text: text.records }
    let at = fields.length
    fields.push(entry)
    while (at > 0 && fields[at - 1].field > entry.field) {
      fields[at] = fields[at - 1]
      at--
    }
    fields[at] = entry
  }
  segment.reserveFields(Math.max(ordinal + 1, state.docStore.internalIdCapacity()), state.fieldNameTable.names.length)
  for (const field of schemaFields) {
    const ordinal = state.fieldNameTable.indexMap.get(field.path)
    if (ordinal !== undefined) segment.fields.partial[ordinal] = Number(field.partial === true)
  }
  return { segment, fields }
}

export function discardKeywordSegment(state: PartitionState): void {
  state.surfaceRegistry.detach()
  state.partialWords.detach()
  segments.delete(state)
}

export function keywordCountsFit(state: PartitionState, prepared: PreparedText): boolean {
  const segment = segments.get(state)?.segment
  if (segment === undefined) return true
  const counts = new Map<string, number>()
  for (const field of prepared.fields.values()) {
    for (const [surface, entry] of preparedSurfaces(field)) {
      if (surface === entry.token) continue
      counts.set(surface, (counts.get(surface) ?? 0) + entry.count)
    }
  }
  for (const [surface, added] of counts) {
    const ordinal = segment.surfaces?.strings.get(surface)
    const held = ordinal === undefined ? 0 : (segment.surfaces?.count[ordinal] ?? 0)
    if (added > 0xffffffff - held) return false
  }
  counts.clear()
  if (prepared.partialSpellings !== null) {
    for (const spellings of prepared.partialSpellings.values()) {
      for (const [spelling, added] of spellings) counts.set(spelling, (counts.get(spelling) ?? 0) + added)
    }
  }
  for (const [spelling, added] of counts) {
    const ordinal = segment.spellings?.strings.get(spelling)
    const held = ordinal === undefined ? 0 : (segment.spellings?.count[ordinal] ?? 0)
    if (added > 0xffffffff - held) return false
  }
  return true
}

export function keywordSegmentBytes(state: PartitionState): number {
  return segments.get(state)?.segment.byteLength() ?? 0
}

export function keywordBatch(state: PartitionState, ending: boolean): void {
  segments.get(state)?.segment.batch(ending)
}
