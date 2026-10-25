import type { SurfaceTableData } from '../../core/partition/frozen/surface-table'
import type { PartialWordTableData } from '../../core/partition/partial-words/types'
import { bytesFrom, float64sFrom, uint32sFrom } from './little-endian'
import {
  corrupt,
  requireBytes,
  requireCount,
  requireList,
  requireRecord,
  requireString,
  requireStrings,
} from './raw-fields'
import type { KeywordSegmentArrays } from './types'
import {
  requireBelow,
  requireNonZero,
  requireOffsets,
  requireOrdinals,
  requireRunsAscend,
  requireSpellingEntriesAscend,
  requireStrictlyAscending,
  requireUtf8Entries,
  requireValuesAscendWithoutNaN,
  requireWithin,
} from './validate'

const LATITUDE_LIMIT = 90
const LONGITUDE_LIMIT = 180
const CODE_POINTS_PER_RUN = 3

export interface ColumnContext {
  documentCount: number
  shared: boolean
}

function uint32Column(raw: Record<string, unknown>, key: string, name: string, context: ColumnContext): Uint32Array {
  return uint32sFrom(requireBytes(raw[key], `${name}.${key}`, 4), context.shared)
}

function ordinalColumn(raw: Record<string, unknown>, key: string, name: string, context: ColumnContext): Uint32Array {
  const values = uint32Column(raw, key, name, context)
  requireOrdinals(values, context.documentCount, `${name}.${key}`)
  return values
}

function eachColumn(raw: unknown, name: string): Array<{ column: Record<string, unknown>; label: string }> {
  return requireList(raw, name).map((entry, at) => {
    const column = requireRecord(entry, `${name}[${at}]`)
    return { column, label: `${name}[${at}]` }
  })
}

export function decodeFieldLengths(
  raw: unknown,
  context: ColumnContext,
): Pick<KeywordSegmentArrays, 'fieldLengthNames' | 'fieldLengthColumns' | 'totalFieldLengths'> {
  const fieldLengthNames: string[] = []
  const fieldLengthColumns: Uint32Array[] = []
  const totalFieldLengths: Record<string, number> = Object.create(null)
  for (const { column, label } of eachColumn(raw, 'fieldLengths')) {
    const field = requireString(column.field, `${label}.field`)
    const lengths = uint32Column(column, 'lengths', label, context)
    requireCount(lengths.length, context.documentCount, `${label}.lengths`)
    let total = 0
    for (let at = 0; at < lengths.length; at++) total += lengths[at]
    fieldLengthNames.push(field)
    fieldLengthColumns.push(lengths)
    totalFieldLengths[field] = (totalFieldLengths[field] ?? 0) + total
  }
  return { fieldLengthNames, fieldLengthColumns, totalFieldLengths }
}

export function decodeValueColumns(
  raw: unknown,
  name: string,
  context: ColumnContext,
): KeywordSegmentArrays['numeric'] {
  return eachColumn(raw, name).map(({ column, label }) => {
    const fieldPath = requireString(column.field, `${label}.field`)
    const docIds = ordinalColumn(column, 'documents', label, context)
    const values = float64sFrom(requireBytes(column.values, `${label}.values`, 8), context.shared)
    requireCount(values.length, docIds.length, `${label}.values`)
    requireValuesAscendWithoutNaN(values, `${label}.values`)
    return { fieldPath, docIds, values }
  })
}

export function decodeBooleanColumns(raw: unknown, context: ColumnContext): KeywordSegmentArrays['boolean'] {
  return eachColumn(raw, 'boolean').map(({ column, label }) => ({
    fieldPath: requireString(column.field, `${label}.field`),
    trueDocs: ordinalColumn(column, 'trueDocuments', label, context),
    falseDocs: ordinalColumn(column, 'falseDocuments', label, context),
  }))
}

export function decodeEnumColumns(raw: unknown, context: ColumnContext): KeywordSegmentArrays['enums'] {
  return eachColumn(raw, 'enum').map(({ column, label }) => {
    const fieldPath = requireString(column.field, `${label}.field`)
    const values = requireStrings(column.values, `${label}.values`)
    if (new Set(values).size !== values.length) corrupt(`${label}.values names a value twice`, { field: label })
    const offsets = uint32Column(column, 'offsets', label, context)
    const docIds = ordinalColumn(column, 'documents', label, context)
    requireCount(offsets.length, values.length + 1, `${label}.offsets`)
    requireOffsets(offsets, docIds.length, `${label}.offsets`)
    return { fieldPath, values, offsets, docIds }
  })
}

export function decodeGeopointColumns(raw: unknown, context: ColumnContext): KeywordSegmentArrays['geo'] {
  return eachColumn(raw, 'geopoint').map(({ column, label }) => {
    const fieldPath = requireString(column.field, `${label}.field`)
    const docIds = ordinalColumn(column, 'documents', label, context)
    const latitudes = float64sFrom(requireBytes(column.latitudes, `${label}.latitudes`, 8), context.shared)
    const longitudes = float64sFrom(requireBytes(column.longitudes, `${label}.longitudes`, 8), context.shared)
    requireCount(latitudes.length, docIds.length, `${label}.latitudes`)
    requireCount(longitudes.length, docIds.length, `${label}.longitudes`)
    requireWithin(latitudes, -LATITUDE_LIMIT, LATITUDE_LIMIT, `${label}.latitudes`)
    requireWithin(longitudes, -LONGITUDE_LIMIT, LONGITUDE_LIMIT, `${label}.longitudes`)
    return { fieldPath, docIds, latitudes, longitudes }
  })
}

export function decodePatternColumns(raw: unknown, context: ColumnContext): KeywordSegmentArrays['pattern'] {
  return eachColumn(raw, 'pattern').map(({ column, label }) => {
    const fieldPath = requireString(column.field, `${label}.field`)
    const docIds = ordinalColumn(column, 'documents', label, context)
    requireStrictlyAscending(docIds, 0, docIds.length, `${label}.documents`)
    const runs = uint32sFrom(requireBytes(column.runs, `${label}.runs`, 4 * CODE_POINTS_PER_RUN), context.shared)
    requireRunsAscend(runs, `${label}.runs`)
    const offsets = uint32Column(column, 'offsets', label, context)
    const postings = ordinalColumn(column, 'postings', label, context)
    requireCount(offsets.length, runs.length / CODE_POINTS_PER_RUN + 1, `${label}.offsets`)
    requireOffsets(offsets, postings.length, `${label}.offsets`)
    for (let run = 0; run + 1 < offsets.length; run++) {
      requireStrictlyAscending(postings, offsets[run], offsets[run + 1], `${label}.postings`)
    }
    return { fieldPath, docIds, runs, offsets, postings }
  })
}

export function decodeSurfaceForms(raw: unknown, context: ColumnContext): SurfaceTableData | null {
  if (raw === null || raw === undefined) return null
  const column = requireRecord(raw, 'surfaceForms')
  const blob = bytesFrom(requireBytes(column.text, 'surfaceForms.text', 1), context.shared)
  const offsets = uint32Column(column, 'offsets', 'surfaceForms', context)
  const counts = uint32Column(column, 'counts', 'surfaceForms', context)
  requireCount(offsets.length, counts.length * 2 + 1, 'surfaceForms.offsets')
  requireOffsets(offsets, blob.length, 'surfaceForms.offsets')
  requireUtf8Entries(blob, offsets, 'surfaceForms.text')
  return counts.length === 0 ? null : { blob, offsets, counts }
}

export function decodePartialWords(
  raw: unknown,
  tokenCount: number,
  context: ColumnContext,
): PartialWordTableData | null {
  if (raw === null || raw === undefined) return null
  const column = requireRecord(raw, 'partialWords')
  const fields = requireStrings(column.fields, 'partialWords.fields')
  const spellings = bytesFrom(requireBytes(column.text, 'partialWords.text', 1), context.shared)
  const spellingOffsets = uint32Column(column, 'offsets', 'partialWords', context)
  const spellingTokens = uint32Column(column, 'tokens', 'partialWords', context)
  const spellingCounts = uint32Column(column, 'counts', 'partialWords', context)
  const entries = spellingTokens.length
  requireCount(spellingOffsets.length, entries + 1, 'partialWords.offsets')
  requireCount(spellingCounts.length, entries, 'partialWords.counts')
  requireOffsets(spellingOffsets, spellings.length, 'partialWords.offsets')
  requireUtf8Entries(spellings, spellingOffsets, 'partialWords.text')
  requireBelow(spellingTokens, tokenCount, 'partialWords.tokens')
  requireNonZero(spellingCounts, 'partialWords.counts')
  requireSpellingEntriesAscend(spellings, spellingOffsets, spellingTokens, 'partialWords')

  const runs = uint32sFrom(requireBytes(column.runs, 'partialWords.runs', 4 * CODE_POINTS_PER_RUN), context.shared)
  requireRunsAscend(runs, 'partialWords.runs')
  const runOffsets = uint32Column(column, 'runOffsets', 'partialWords', context)
  const runEntries = uint32Column(column, 'runEntries', 'partialWords', context)
  requireCount(runOffsets.length, runs.length / CODE_POINTS_PER_RUN + 1, 'partialWords.runOffsets')
  requireOffsets(runOffsets, runEntries.length, 'partialWords.runOffsets')
  requireBelow(runEntries, entries, 'partialWords.runEntries')
  for (let run = 0; run + 1 < runOffsets.length; run++) {
    requireStrictlyAscending(runEntries, runOffsets[run], runOffsets[run + 1], 'partialWords.runEntries')
  }
  return { fields, spellings, spellingOffsets, spellingTokens, spellingCounts, runs, runOffsets, runEntries }
}
