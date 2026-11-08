import { LivePostings } from '#platform/live-postings'
import type { SchemaField } from '../../../schema/validator'
import type { NativeFieldTokens } from '../../../vector/native/types/segments'
import { GrowingSegment } from '../../segment-writes/growing'
import { createSpellingTable } from '../partial-words/registry'
import type { PartialSpellings } from '../partial-words/spellings'
import type { PreparedText } from '../prepared-text'
import type { SegmentPayload } from '../segment-payload'

export class SegmentKeywords {
  private readonly segment: GrowingSegment
  private readonly fields: string[] = []
  private readonly fieldIndexes = new Map<string, number>()
  private readonly partial: Set<string>

  constructor(
    fields: readonly SchemaField[],
    private readonly trackPositions: boolean,
  ) {
    this.segment = new GrowingSegment(new LivePostings(), trackPositions)
    this.partial = new Set(fields.filter(field => field.partial).map(field => field.path))
    if (this.partial.size > 0) this.segment.spellings = createSpellingTable()
  }

  add(prepared: PreparedText, ordinal: number): boolean {
    const fields: NativeFieldTokens[] = []
    for (const [path, text] of prepared.fields) {
      let field = this.fieldIndexes.get(path)
      if (field === undefined) {
        field = this.fields.length
        this.fields.push(path)
        this.fieldIndexes.set(path, field)
      }
      fields.push({ field, ...text.records })
    }
    fields.sort((left, right) => left.field - right.field)
    this.segment.reserveFields(ordinal + 1, this.fields.length)
    for (const field of fields)
      this.segment.fields.partial[field.field] = Number(this.partial.has(this.fields[field.field]))
    return this.segment.insert(ordinal, fields, prepared.tokens)
  }

  encode(): Pick<
    SegmentPayload,
    | 'tokens'
    | 'fieldNames'
    | 'postingOffsets'
    | 'postingDocIds'
    | 'postingFrequencies'
    | 'postingFieldIndices'
    | 'positionOffsets'
    | 'positionValues'
    | 'docFrequencies'
    | 'fieldLengthNames'
    | 'fieldLengthColumns'
    | 'totalFieldLengths'
    | 'surfaceForms'
    | 'partialSpellings'
  > {
    const { terms, pool, positions } = this.segment.postings
    let postings = 0
    let positionCount = 0
    for (let token = 0; token < terms.count; token++) {
      postings += terms.lengths[token]
      if (!this.trackPositions || pool.positionStarts === null) continue
      const end = terms.sliceStart[token] + terms.lengths[token]
      for (let row = terms.sliceStart[token]; row < end; row++)
        positionCount += positions.values[pool.positionStarts[row]]
    }
    const postingOffsets = new Uint32Array(terms.count + 1)
    const postingDocIds = new Uint32Array(postings)
    const postingFrequencies = new Uint16Array(postings)
    const postingFieldIndices = new Uint16Array(postings)
    const positionOffsets = this.trackPositions && postings > 0 ? new Uint32Array(postings + 1) : null
    const positionValues = positionOffsets === null ? null : new Uint32Array(positionCount)
    const docFrequencies: Record<string, number> = Object.create(null)
    let row = 0
    let position = 0
    for (let token = 0; token < terms.count; token++) {
      const start = terms.sliceStart[token]
      const length = terms.lengths[token]
      postingOffsets[token] = row
      postingDocIds.set(pool.docIds.subarray(start, start + length), row)
      postingFrequencies.set(pool.frequencies.subarray(start, start + length), row)
      postingFieldIndices.set(pool.fieldIndices.subarray(start, start + length), row)
      if (positionOffsets !== null && positionValues !== null && pool.positionStarts !== null) {
        for (let at = start; at < start + length; at++) {
          const offset = pool.positionStarts[at]
          const count = positions.values[offset]
          positionOffsets[row + at - start] = position
          positionValues.set(positions.values.subarray(offset + 1, offset + 1 + count), position)
          position += count
        }
      }
      row += length
      docFrequencies[terms.tokens[token]] = terms.frequencyAt(token)
    }
    postingOffsets[terms.count] = row
    if (positionOffsets !== null) positionOffsets[row] = position
    const fieldLengthColumns: Uint32Array[] = []
    const totalFieldLengths: Record<string, number> = Object.create(null)
    const lengths = this.segment.fields
    for (let field = 0; field < this.fields.length; field++) {
      const start = field * lengths.ordinalCapacity
      fieldLengthColumns.push(lengths.values.slice(start, start + lengths.documents[0]))
      totalFieldLengths[this.fields[field]] = lengths.totals[field]
    }
    let surfaceForms: SegmentPayload['surfaceForms'] = null
    if (this.segment.surfaces !== null) {
      const table = this.segment.surfaces
      surfaceForms = Object.create(null) as NonNullable<SegmentPayload['surfaceForms']>
      for (const entry of table.liveEntries())
        surfaceForms[table.textAt(entry)] = [table.count[entry], terms.tokens[table.token[entry]]]
    }
    let partialSpellings: PartialSpellings | null = null
    if (this.segment.spellings !== null) {
      const table = this.segment.spellings
      partialSpellings = { fields: [...this.partial], tokens: [], spellings: [], counts: [] }
      for (const entry of table.liveEntries()) {
        partialSpellings.tokens.push(terms.tokens[table.token[entry]])
        partialSpellings.spellings.push(table.textAt(entry))
        partialSpellings.counts.push(table.count[entry])
      }
    }
    return {
      tokens: [...terms.tokens],
      fieldNames: [...this.fields],
      postingOffsets,
      postingDocIds,
      postingFrequencies,
      postingFieldIndices,
      positionOffsets,
      positionValues,
      docFrequencies,
      fieldLengthNames: [...this.fields],
      fieldLengthColumns,
      totalFieldLengths,
      surfaceForms,
      partialSpellings,
    }
  }
}
