import { ErrorCodes, NarsilError } from '../../errors'
import { createGeoIndex, type GeoIndex } from '../../geo/geo-index'
import { validateDocument, validateDocumentStrict } from '../../schema/validator/document'
import { flattenSchema } from '../../schema/validator/schema'
import type { LanguageModule } from '../../types/language'
import type { AnyDocument, FieldType, SchemaDefinition } from '../../types/schema'
import { MAX_TERM_FREQUENCY } from '../constants'
import {
  type BooleanFieldIndex,
  createBooleanIndex,
  createEnumIndex,
  createNumericIndex,
  type EnumFieldIndex,
  type NumericFieldIndex,
} from '../field-index'
import { visitTokens } from '../tokenizer/tokenize'
import { GrowableUint32 } from './growable-uint32'
import { encodeFieldIndexes, type SegmentPayload } from './segment-payload'
import { getNestedValue, type PartitionInsertOptions, tokenizeOptions } from './utils'

export interface SegmentDocument {
  docId: string
  document: AnyDocument
}

const TOKEN_TABLE_START = 1 << 12
const POSTING_LOG_START = 1 << 14
const POSITION_POOL_START = 1 << 16
const FIELD_SCRATCH_START = 1 << 10

interface FieldIndexes {
  numericIndexes: Map<string, NumericFieldIndex>
  booleanIndexes: Map<string, BooleanFieldIndex>
  enumIndexes: Map<string, EnumFieldIndex>
  geoIndexes: Map<string, GeoIndex>
}

function indexOf<T>(indexes: Map<string, T>, fieldPath: string, create: () => T): T {
  let index = indexes.get(fieldPath)
  if (index === undefined) {
    index = create()
    indexes.set(fieldPath, index)
  }
  return index
}

function indexFilterValue(
  indexes: FieldIndexes,
  ordinal: number,
  fieldPath: string,
  fieldType: FieldType,
  value: unknown,
): void {
  if (fieldType === 'number' || fieldType === 'number[]') {
    const index = indexOf(indexes.numericIndexes, fieldPath, createNumericIndex)
    for (const entry of fieldType === 'number' ? [value as number] : (value as number[])) index.insert(ordinal, entry)
  } else if (fieldType === 'boolean' || fieldType === 'boolean[]') {
    const index = indexOf(indexes.booleanIndexes, fieldPath, createBooleanIndex)
    for (const entry of fieldType === 'boolean' ? [value as boolean] : (value as boolean[]))
      index.insert(ordinal, entry)
  } else if (fieldType === 'enum' || fieldType === 'enum[]') {
    const index = indexOf(indexes.enumIndexes, fieldPath, createEnumIndex)
    for (const entry of fieldType === 'enum' ? [value as string] : (value as string[])) index.insert(ordinal, entry)
  } else if (fieldType === 'geopoint') {
    const point = value as { lat: number; lon: number }
    indexOf(indexes.geoIndexes, fieldPath, createGeoIndex).insert(ordinal, point.lat, point.lon)
  }
}

function refuseRepeatedDocIds(documents: readonly SegmentDocument[]): void {
  const seen = new Set<string>()
  for (const { docId } of documents) {
    if (seen.has(docId)) {
      throw new NarsilError(ErrorCodes.DOC_ALREADY_EXISTS, `Document "${docId}" already exists in partition 0`, {
        docId,
        partitionId: 0,
      })
    }
    seen.add(docId)
  }
}

function validateAsAnInsertDoes(
  documents: readonly SegmentDocument[],
  schema: SchemaDefinition,
  options: PartitionInsertOptions | undefined,
): void {
  if (options?.validate === false) return
  for (const { document } of documents) {
    validateDocument(document, schema)
    if (options?.strict) validateDocumentStrict(document as Record<string, unknown>, schema)
  }
}

class TextPostings {
  readonly tokens: string[] = []
  readonly fieldNames: string[] = []
  private readonly tokenIds = new Map<string, number>()
  private readonly fieldNameIndexes = new Map<string, number>()
  private readonly postingsPerToken = new GrowableUint32(TOKEN_TABLE_START)
  private readonly docFrequencyPerToken = new GrowableUint32(TOKEN_TABLE_START)
  private readonly lastDocPerToken = new GrowableUint32(TOKEN_TABLE_START)
  private readonly fieldStampPerToken = new GrowableUint32(TOKEN_TABLE_START)
  private readonly fieldSlotPerToken = new GrowableUint32(TOKEN_TABLE_START)
  private readonly logToken = new GrowableUint32(POSTING_LOG_START)
  private readonly logDoc = new GrowableUint32(POSTING_LOG_START)
  private readonly logFrequency = new GrowableUint32(POSTING_LOG_START)
  private readonly logField = new GrowableUint32(POSTING_LOG_START)
  private readonly logPositionStart = new GrowableUint32(POSTING_LOG_START)
  private readonly positionPool = new GrowableUint32(POSITION_POOL_START)
  private readonly slotToken = new GrowableUint32(FIELD_SCRATCH_START)
  private readonly slotCount = new GrowableUint32(FIELD_SCRATCH_START)
  private readonly slotCursor = new GrowableUint32(FIELD_SCRATCH_START)
  private readonly eventSlot = new GrowableUint32(FIELD_SCRATCH_START)
  private readonly eventPosition = new GrowableUint32(FIELD_SCRATCH_START)
  private fieldStamp = 0

  constructor(private readonly trackPositions: boolean) {}

  beginField(): void {
    this.fieldStamp++
    this.slotToken.clear()
    this.slotCount.clear()
    this.eventSlot.clear()
    this.eventPosition.clear()
  }

  get fieldLength(): number {
    return this.eventSlot.length
  }

  private tokenIdOf(token: string): number {
    const known = this.tokenIds.get(token)
    if (known !== undefined) return known
    const id = this.tokens.length
    this.tokenIds.set(token, id)
    this.tokens.push(token)
    this.postingsPerToken.ensureIndex(id)
    this.docFrequencyPerToken.ensureIndex(id)
    this.lastDocPerToken.ensureIndex(id)
    this.fieldStampPerToken.ensureIndex(id)
    this.fieldSlotPerToken.ensureIndex(id)
    return id
  }

  addToken(token: string, position: number): void {
    const id = this.tokenIdOf(token)
    let slot: number
    if (this.fieldStampPerToken.values[id] === this.fieldStamp) {
      slot = this.fieldSlotPerToken.values[id]
      this.slotCount.values[slot]++
    } else {
      slot = this.slotToken.length
      this.fieldStampPerToken.values[id] = this.fieldStamp
      this.fieldSlotPerToken.values[id] = slot
      this.slotToken.push(id)
      this.slotCount.push(1)
    }
    this.eventSlot.push(slot)
    this.eventPosition.push(position)
  }

  private recordFieldPositions(): void {
    const events = this.eventSlot.length
    const poolBase = this.positionPool.length
    this.positionPool.reserve(events)
    this.slotCursor.clear()
    let cursor = poolBase
    for (let slot = 0; slot < this.slotToken.length; slot++) {
      this.slotCursor.push(cursor)
      this.logPositionStart.push(cursor)
      cursor += this.slotCount.values[slot]
    }
    for (let event = 0; event < events; event++) {
      const slot = this.eventSlot.values[event]
      this.positionPool.values[this.slotCursor.values[slot]++] = this.eventPosition.values[event]
    }
    this.positionPool.length = poolBase + events
  }

  endField(ordinal: number, fieldPath: string): void {
    let fieldIndex = this.fieldNameIndexes.get(fieldPath)
    if (fieldIndex === undefined) {
      fieldIndex = this.fieldNames.length
      this.fieldNames.push(fieldPath)
      this.fieldNameIndexes.set(fieldPath, fieldIndex)
    }
    if (this.trackPositions) this.recordFieldPositions()
    for (let slot = 0; slot < this.slotToken.length; slot++) {
      const id = this.slotToken.values[slot]
      this.logToken.push(id)
      this.logDoc.push(ordinal)
      this.logFrequency.push(this.slotCount.values[slot])
      this.logField.push(fieldIndex)
      this.postingsPerToken.values[id]++
      if (this.lastDocPerToken.values[id] !== ordinal + 1) {
        this.lastDocPerToken.values[id] = ordinal + 1
        this.docFrequencyPerToken.values[id]++
      }
    }
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
  > {
    const tokenCount = this.tokens.length
    const postings = this.logToken.length
    const postingOffsets = new Uint32Array(tokenCount + 1)
    for (let t = 0; t < tokenCount; t++) postingOffsets[t + 1] = postingOffsets[t] + this.postingsPerToken.values[t]
    const writeCursor = postingOffsets.slice(0, tokenCount)
    const postingDocIds = new Uint32Array(postings)
    const postingFrequencies = new Uint16Array(postings)
    const postingFieldIndices = new Uint8Array(postings)
    const logRowOfPosting = new Uint32Array(postings)
    for (let row = 0; row < postings; row++) {
      const target = writeCursor[this.logToken.values[row]]++
      const frequency = this.logFrequency.values[row]
      postingDocIds[target] = this.logDoc.values[row]
      postingFrequencies[target] = frequency > MAX_TERM_FREQUENCY ? MAX_TERM_FREQUENCY : frequency
      postingFieldIndices[target] = this.logField.values[row]
      logRowOfPosting[target] = row
    }

    let positionOffsets: Uint32Array | null = null
    let positionValues: Uint32Array | null = null
    if (this.trackPositions && postings > 0) {
      positionOffsets = new Uint32Array(postings + 1)
      positionValues = new Uint32Array(this.positionPool.length)
      let cursor = 0
      for (let target = 0; target < postings; target++) {
        const row = logRowOfPosting[target]
        const start = this.logPositionStart.values[row]
        const count = this.logFrequency.values[row]
        positionOffsets[target] = cursor
        positionValues.set(this.positionPool.values.subarray(start, start + count), cursor)
        cursor += count
      }
      positionOffsets[postings] = cursor
    }

    const docFrequencies: Record<string, number> = Object.create(null)
    for (let t = 0; t < tokenCount; t++) docFrequencies[this.tokens[t]] = this.docFrequencyPerToken.values[t]

    return {
      tokens: this.tokens,
      fieldNames: this.fieldNames,
      postingOffsets,
      postingDocIds,
      postingFrequencies,
      postingFieldIndices,
      positionOffsets,
      positionValues,
      docFrequencies,
    }
  }
}

class SurfaceCounts {
  private readonly ids = new Map<string, number>()
  private readonly surfaces: string[] = []
  private readonly tokens: string[] = []
  private readonly counts = new GrowableUint32(TOKEN_TABLE_START)

  count(surface: string | undefined, token: string): void {
    if (surface === undefined || surface.length === 0) return
    const known = this.ids.get(surface)
    if (known !== undefined) {
      this.counts.values[known]++
      return
    }
    const id = this.surfaces.length
    this.ids.set(surface, id)
    this.surfaces.push(surface)
    this.tokens.push(token)
    this.counts.ensureIndex(id)
    this.counts.values[id] = 1
  }

  encode(): SegmentPayload['surfaceForms'] {
    if (this.surfaces.length === 0) return null
    const forms: NonNullable<SegmentPayload['surfaceForms']> = Object.create(null)
    for (let s = 0; s < this.surfaces.length; s++) forms[this.surfaces[s]] = [this.counts.values[s], this.tokens[s]]
    return forms
  }
}

class FieldLengths {
  readonly names: string[] = []
  readonly columns: Uint32Array[] = []
  private readonly indexes = new Map<string, number>()
  private readonly totals: number[] = []

  constructor(private readonly documentCount: number) {}

  record(ordinal: number, fieldPath: string, length: number): void {
    let index = this.indexes.get(fieldPath)
    if (index === undefined) {
      index = this.names.length
      this.names.push(fieldPath)
      this.indexes.set(fieldPath, index)
      this.columns.push(new Uint32Array(this.documentCount))
      this.totals.push(0)
    }
    this.columns[index][ordinal] = length
    this.totals[index] += length
  }

  totalsByName(): Record<string, number> {
    const totals: Record<string, number> = {}
    for (let f = 0; f < this.names.length; f++) totals[this.names[f]] = this.totals[f]
    return totals
  }
}

export function buildSegmentPayload(
  documents: readonly SegmentDocument[],
  schema: SchemaDefinition,
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  trackPositions: boolean,
): SegmentPayload {
  refuseRepeatedDocIds(documents)
  validateAsAnInsertDoes(documents, schema, options)

  const fields = Object.entries(flattenSchema(schema))
  const tokenizing = tokenizeOptions(options)
  const postings = new TextPostings(trackPositions)
  const surfaces = new SurfaceCounts()
  const lengths = new FieldLengths(documents.length)
  const filters: FieldIndexes = {
    numericIndexes: new Map(),
    booleanIndexes: new Map(),
    enumIndexes: new Map(),
    geoIndexes: new Map(),
  }

  let positionOffset = 0
  const addToken = (token: string, position: number, surface: string | undefined): void => {
    postings.addToken(token, positionOffset + position)
    surfaces.count(surface, token)
  }

  for (let ordinal = 0; ordinal < documents.length; ordinal++) {
    const document = documents[ordinal].document as Record<string, unknown>
    for (const [fieldPath, fieldType] of fields) {
      const value = getNestedValue(document, fieldPath)
      if (value === undefined || value === null) continue
      if (fieldType !== 'string' && fieldType !== 'string[]') {
        indexFilterValue(filters, ordinal, fieldPath, fieldType, value)
        continue
      }
      postings.beginField()
      positionOffset = 0
      for (const text of fieldType === 'string' ? [value as string] : (value as string[])) {
        visitTokens(text, language, tokenizing, addToken)
        positionOffset = postings.fieldLength
      }
      postings.endField(ordinal, fieldPath)
      lengths.record(ordinal, fieldPath, postings.fieldLength)
    }
  }

  const identity = new Int32Array(documents.length)
  for (let ordinal = 0; ordinal < identity.length; ordinal++) identity[ordinal] = ordinal

  return {
    documentCount: documents.length,
    docIds: documents.map(entry => entry.docId),
    ...postings.encode(),
    fieldLengthNames: lengths.names,
    fieldLengthColumns: lengths.columns,
    totalFieldLengths: lengths.totalsByName(),
    surfaceForms: surfaces.encode(),
    ...encodeFieldIndexes(filters, identity),
  }
}
