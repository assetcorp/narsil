import {
  createPartitionIndex,
  createPatternWorkMeter,
  decode,
  prepareDocumentVectors,
  validQueryFilter,
} from '#platform/storage-host'
import type { PartitionInsertOptions } from '../core/partition/utils'
import type { FilterExpression } from '../types/filters'
import type { LanguageModule } from '../types/language'
import type { AnyDocument, SchemaDefinition } from '../types/schema'
import type { DocumentTest } from './derive'

export interface FilterIndexShape {
  schema: SchemaDefinition
  language: LanguageModule
  insertOptions: PartitionInsertOptions | undefined
  vectorFieldPaths: ReadonlySet<string>
}

const PROBE_DOCUMENT_ID = 'narsil-change-filter-probe'

function topLevelFieldsOf(expression: FilterExpression, into: Set<string>): void {
  if (expression.fields !== undefined) {
    for (const path of Object.keys(expression.fields)) {
      const dot = path.indexOf('.')
      into.add(dot === -1 ? path : path.slice(0, dot))
    }
  }
  for (const nested of expression.and ?? []) topLevelFieldsOf(nested, into)
  for (const nested of expression.or ?? []) topLevelFieldsOf(nested, into)
  if (expression.not !== undefined) topLevelFieldsOf(expression.not, into)
}

function projected(document: AnyDocument, fields: ReadonlySet<string>): AnyDocument {
  const kept: Record<string, unknown> = {}
  for (const field of fields) {
    if (Object.hasOwn(document, field)) kept[field] = (document as Record<string, unknown>)[field]
  }
  return kept as AnyDocument
}

export function validChangeFilter(filter: unknown, schema: SchemaDefinition): FilterExpression {
  const valid = validQueryFilter(filter as FilterExpression, schema)
  return valid ?? {}
}

export function createDocumentTest(shape: FilterIndexShape, filter: FilterExpression): DocumentTest {
  const fields = new Set<string>()
  topLevelFieldsOf(filter, fields)
  const probe = createPartitionIndex(0, false)
  return bytes => {
    const document = decode(bytes) as AnyDocument
    const { partitionDoc } = prepareDocumentVectors(projected(document, fields), shape.vectorFieldPaths)
    try {
      probe.insert(PROBE_DOCUMENT_ID, partitionDoc as AnyDocument, shape.schema, shape.language, shape.insertOptions)
      return probe.applyFilters(filter, shape.schema, createPatternWorkMeter()).has(PROBE_DOCUMENT_ID)
    } finally {
      probe.clear()
    }
  }
}
