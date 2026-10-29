import { getNestedValue } from '../../../core/partition/utils'
import { schemaFieldsOf } from '../../../schema/validator/schema'
import { MAX_DOCUMENT_ENCODING_DEPTH } from '../../../serialization/constants'
import type { LanguageModule } from '../../../types/language'
import type { AnyDocument, CustomTokenizer, SchemaDefinition } from '../../../types/schema'
import {
  CASE_FOLD_EXPANSION_FACTOR,
  DISTINCT_TERM_HEAP_BYTES,
  DOCUMENT_HEAP_BYTES_PER_ESTIMATED_BYTE,
  DOCUMENT_PROPERTY_HEAP_BYTES,
  DOCUMENT_VALUE_HEAP_BYTES,
  ENUM_VALUE_HEAP_BYTES,
  NORMALIZATION_EXPANSION_FACTOR,
  PARTIAL_SPELLING_HEAP_BYTES,
  PATTERN_RUN_HEAP_BYTES,
  TERM_UNIT_HEAP_BYTES,
  VECTOR_COMPONENT_HEAP_BYTES,
  VECTOR_DOCUMENT_HEAP_BYTES,
} from '../constants'

export interface IndexWriteAnalysis {
  schema: SchemaDefinition
  language: LanguageModule
  customTokenizer?: CustomTokenizer
}

export type DocumentBound = (document: AnyDocument) => number

interface TextFieldBound {
  path: string
  partial: boolean
  pattern: boolean
}

interface VectorFieldBound {
  path: string
  dimension: number
}

const SINGLE_CLASS_REPEATED = /^\[(?:[^\\\]]|\\.)*\]\+$/

function termsPerNormalizedUnit(language: LanguageModule): number {
  const ngramSize = language.tokenizer?.ngramSize
  if (ngramSize !== undefined && ngramSize >= 1) return 1
  const splitPattern = language.tokenizer?.splitPattern
  if (splitPattern === undefined || SINGLE_CLASS_REPEATED.test(splitPattern.source)) return 0.5
  return 1
}

function textsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((element): element is string => typeof element === 'string')
}

function valueCountOf(value: unknown): number {
  if (value === undefined || value === null) return 0
  return Array.isArray(value) ? value.length : 1
}

const NO_VECTOR_PATHS: ReadonlySet<string> = new Set()

function valueHeapBytesOf(value: unknown, depth: number, path: string, vectorPaths: ReadonlySet<string>): number {
  if (typeof value === 'string') {
    return DOCUMENT_VALUE_HEAP_BYTES + value.length * DOCUMENT_HEAP_BYTES_PER_ESTIMATED_BYTE
  }
  if (value === null || typeof value !== 'object' || depth > MAX_DOCUMENT_ENCODING_DEPTH) {
    return DOCUMENT_VALUE_HEAP_BYTES
  }
  if (ArrayBuffer.isView(value)) {
    return DOCUMENT_VALUE_HEAP_BYTES + value.byteLength * DOCUMENT_HEAP_BYTES_PER_ESTIMATED_BYTE
  }
  let bytes = DOCUMENT_VALUE_HEAP_BYTES
  if (Array.isArray(value)) {
    for (const item of value) bytes += valueHeapBytesOf(item, depth + 1, path, NO_VECTOR_PATHS)
    return bytes
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    bytes += DOCUMENT_PROPERTY_HEAP_BYTES + key.length * DOCUMENT_HEAP_BYTES_PER_ESTIMATED_BYTE
    const keyPath = vectorPaths.size === 0 ? '' : path === '' ? key : `${path}.${key}`
    if (vectorPaths.has(keyPath)) continue
    bytes += valueHeapBytesOf((value as Record<string, unknown>)[key], depth + 1, keyPath, vectorPaths)
  }
  return bytes
}

function vectorBytesOf(document: AnyDocument, fields: readonly VectorFieldBound[]): number {
  let bytes = 0
  for (const field of fields) {
    const value = getNestedValue(document, field.path)
    if (value === undefined || value === null) continue
    bytes += VECTOR_DOCUMENT_HEAP_BYTES + field.dimension * VECTOR_COMPONENT_HEAP_BYTES
  }
  return bytes
}

function customTermBytes(text: string, tokenizer: CustomTokenizer, partial: boolean): number {
  let bytes = 0
  const termBytes = DISTINCT_TERM_HEAP_BYTES + (partial ? PARTIAL_SPELLING_HEAP_BYTES : 0)
  for (const { token } of tokenizer.tokenize(text)) {
    bytes += termBytes + token.length * TERM_UNIT_HEAP_BYTES
  }
  return bytes
}

function builtInTermBytes(text: string, termsPerUnit: number, partial: boolean): number {
  const normalizedUnits = text.length * NORMALIZATION_EXPANSION_FACTOR
  const terms = Math.ceil((normalizedUnits + 1) * termsPerUnit)
  const termBytes = DISTINCT_TERM_HEAP_BYTES + (partial ? PARTIAL_SPELLING_HEAP_BYTES : 0)
  return terms * termBytes + normalizedUnits * TERM_UNIT_HEAP_BYTES
}

export function createDocumentBound(analysis: IndexWriteAnalysis): DocumentBound {
  const textFields: TextFieldBound[] = []
  const enumPaths: string[] = []
  const vectorFields: VectorFieldBound[] = []
  for (const field of schemaFieldsOf(analysis.schema)) {
    if (field.base === 'string' || field.base === 'string[]') {
      textFields.push({ path: field.path, partial: field.partial, pattern: field.pattern })
    } else if (field.base === 'enum' || field.base === 'enum[]') {
      enumPaths.push(field.path)
    } else if (field.base === 'vector') {
      vectorFields.push({ path: field.path, dimension: field.dimension })
    }
  }
  const vectorPaths: ReadonlySet<string> = new Set(vectorFields.map(field => field.path))
  const termsPerUnit = termsPerNormalizedUnit(analysis.language)
  const tokenizer = analysis.customTokenizer

  return document => {
    let bytes = valueHeapBytesOf(document, 1, '', vectorPaths) + vectorBytesOf(document, vectorFields)
    for (const field of textFields) {
      for (const text of textsOf(getNestedValue(document, field.path))) {
        bytes +=
          tokenizer === undefined
            ? builtInTermBytes(text, termsPerUnit, field.partial)
            : customTermBytes(text, tokenizer, field.partial)
        if (field.pattern) bytes += text.length * CASE_FOLD_EXPANSION_FACTOR * PATTERN_RUN_HEAP_BYTES
      }
    }
    for (const path of enumPaths) {
      bytes += valueCountOf(getNestedValue(document, path)) * ENUM_VALUE_HEAP_BYTES
    }
    return bytes
  }
}
