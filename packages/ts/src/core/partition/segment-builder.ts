import { ErrorCodes, NarsilError } from '../../errors'
import { createGeoIndex, type GeoIndex } from '../../geo/geo-index'
import { validateDocument, validateDocumentStrict } from '../../schema/validator/document'
import { type BaseFieldType, isWordIndexedBase } from '../../schema/validator/field-type'
import { schemaFieldsOf } from '../../schema/validator/schema'
import type { LanguageModule } from '../../types/language'
import type { AnyDocument, SchemaDefinition } from '../../types/schema'
import {
  type BooleanFieldIndex,
  createBooleanIndex,
  createEnumIndex,
  createNumericIndex,
  type EnumFieldIndex,
  type NumericFieldIndex,
} from '../field-index'
import { patternIndexOf } from '../pattern-index/host'
import type { PatternIndexWriter } from '../pattern-index/types'
import { visitTokens } from '../tokenizer/tokenize'
import { SEGMENT_TOKEN_TABLE_START } from './constants'
import { GrowableUint32 } from './growable-uint32'
import { encodeFieldIndexes } from './segment-field-indexes'
import type { SegmentPayload } from './segment-payload'
import { TextPostings } from './segment-postings'
import { getNestedValue, type PartitionInsertOptions, tokenizeOptions } from './utils'
import { recordValueSize } from './value-sizes'

export interface SegmentDocument {
  docId: string
  document: AnyDocument
}

interface FieldIndexes {
  numericIndexes: Map<string, NumericFieldIndex>
  booleanIndexes: Map<string, BooleanFieldIndex>
  enumIndexes: Map<string, EnumFieldIndex>
  geoIndexes: Map<string, GeoIndex>
  patternIndexes: Map<string, PatternIndexWriter>
  sizeIndexes: Map<string, NumericFieldIndex>
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
  fieldType: BaseFieldType,
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
    validateDocument(document, schema, options?.patternValueLimit)
    if (options?.strict) validateDocumentStrict(document as Record<string, unknown>, schema)
  }
}

class SurfaceCounts {
  private readonly ids = new Map<string, number>()
  private readonly surfaces: string[] = []
  private readonly tokens: string[] = []
  private readonly counts = new GrowableUint32(SEGMENT_TOKEN_TABLE_START)

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

  const fields = schemaFieldsOf(schema)
  const tokenizing = tokenizeOptions(options)
  const postings = new TextPostings(trackPositions)
  const surfaces = new SurfaceCounts()
  const lengths = new FieldLengths(documents.length)
  const filters: FieldIndexes = {
    numericIndexes: new Map(),
    booleanIndexes: new Map(),
    enumIndexes: new Map(),
    geoIndexes: new Map(),
    patternIndexes: new Map(),
    sizeIndexes: new Map(),
  }

  let positionOffset = 0
  const addToken = (token: string, position: number, surface: string | undefined): void => {
    postings.addToken(token, positionOffset + position)
    surfaces.count(surface, token)
  }

  for (let ordinal = 0; ordinal < documents.length; ordinal++) {
    const document = documents[ordinal].document as Record<string, unknown>
    for (const { path: fieldPath, base: fieldType, pattern } of fields) {
      const value = getNestedValue(document, fieldPath)
      if (value === undefined || value === null) continue
      recordValueSize(filters.sizeIndexes, ordinal, fieldPath, fieldType, value)
      if (pattern) patternIndexOf(filters.patternIndexes, fieldPath).add(ordinal, value)
      if (!isWordIndexedBase(fieldType)) {
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
