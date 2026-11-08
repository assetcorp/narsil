import { ErrorCodes, NarsilError } from '../../../errors'
import { createLoadedGeoIndex } from '../../../geo/geo-code'
import type { GeoIndex } from '../../../geo/geo-index'
import { validateDocument, validateDocumentStrict } from '../../../schema/validator/document'
import { type BaseFieldType, isWordIndexedBase } from '../../../schema/validator/field-type'
import { schemaFieldsOf } from '../../../schema/validator/schema'
import type { LanguageModule } from '../../../types/language'
import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import {
  type BooleanFieldIndex,
  createBooleanIndex,
  createEnumIndex,
  createNumericIndex,
  type EnumFieldIndex,
  type NumericFieldIndex,
} from '../../field-index'
import { patternIndexOf } from '../../pattern-index/host'
import type { PatternIndexWriter } from '../../pattern-index/types'
import { SegmentRefusal } from '../../segment-writes/status'
import { prepareDocumentText } from '../prepared-text'
import { encodeFieldIndexes } from '../segment-field-indexes'
import type { SegmentPayload } from '../segment-payload'
import { getNestedValue, type PartitionInsertOptions } from '../utils'
import { recordValueSize } from '../value-sizes'
import { SegmentKeywords } from './keywords'

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
    indexOf(indexes.geoIndexes, fieldPath, createLoadedGeoIndex).insert(ordinal, point.lat, point.lon)
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

function emptyFilters(): FieldIndexes {
  return {
    numericIndexes: new Map(),
    booleanIndexes: new Map(),
    enumIndexes: new Map(),
    geoIndexes: new Map(),
    patternIndexes: new Map(),
    sizeIndexes: new Map(),
  }
}

export interface BuiltSegmentPayload {
  payload: SegmentPayload
  documents: readonly SegmentDocument[]
}

export function buildSegmentPayloads(
  documents: readonly SegmentDocument[],
  schema: SchemaDefinition,
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  trackPositions: boolean,
): BuiltSegmentPayload[] {
  refuseRepeatedDocIds(documents)
  validateAsAnInsertDoes(documents, schema, options)

  const fields = schemaFieldsOf(schema)
  let keywords = new SegmentKeywords(fields, trackPositions)
  let filters = emptyFilters()
  let start = 0
  const outputs: BuiltSegmentPayload[] = []
  const finish = (end: number): void => {
    const members = documents.slice(start, end)
    const identity = Int32Array.from({ length: members.length }, (_, ordinal) => ordinal)
    outputs.push({
      documents: members,
      payload: {
        documentCount: members.length,
        docIds: members.map(entry => entry.docId),
        ...keywords.encode(),
        ...encodeFieldIndexes(filters, identity),
      },
    })
  }
  for (let at = 0; at < documents.length; at++) {
    const document = documents[at].document as Record<string, unknown>
    const text = prepareDocumentText(document, fields, language, options)
    if (!keywords.add(text, at - start)) {
      if (at === start) throw new SegmentRefusal(8)
      finish(at)
      start = at
      keywords = new SegmentKeywords(fields, trackPositions)
      filters = emptyFilters()
      if (!keywords.add(text, 0)) throw new SegmentRefusal(8)
    }
    const ordinal = at - start
    for (const { path: fieldPath, base: fieldType, pattern } of fields) {
      const value = getNestedValue(document, fieldPath)
      if (value === undefined || value === null) continue
      recordValueSize(filters.sizeIndexes, ordinal, fieldPath, fieldType, value)
      if (pattern) patternIndexOf(filters.patternIndexes, fieldPath).add(ordinal, value)
      if (!isWordIndexedBase(fieldType)) indexFilterValue(filters, ordinal, fieldPath, fieldType, value)
    }
  }

  if (start < documents.length || outputs.length === 0) finish(documents.length)
  return outputs
}

export function buildSegmentPayload(
  documents: readonly SegmentDocument[],
  schema: SchemaDefinition,
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  trackPositions: boolean,
): SegmentPayload {
  const outputs = buildSegmentPayloads(documents, schema, language, options, trackPositions)
  const first = outputs[0]
  if (outputs.length !== 1 || first === undefined) throw new SegmentRefusal(8)
  return first.payload
}
