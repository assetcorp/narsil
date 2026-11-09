import { schemaFieldsOf } from '../../../schema/validator'
import type { LanguageModule } from '../../../types/language'
import type { SchemaDefinition } from '../../../types/schema'
import type { FrozenSegment } from '../frozen'
import { prepareRemovalText, removedSurfaceSpellings } from '../frozen/removal-text'
import type { RemovedSpellings } from '../frozen/surface-slot'
import { type PreparedText, prepareDocumentText, preparedSurfaces } from '../prepared-text'
import type { PartitionInsertOptions } from '../utils'

const UNREAD_DOCUMENT_TEXT: PreparedText = { fieldLengths: {}, tokens: [], partialSpellings: null, fields: new Map() }

export function prepareFrozenText(
  owner: FrozenSegment,
  docId: string,
  schema: SchemaDefinition,
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
): PreparedText | undefined {
  const stored = owner.docStore.get(docId)
  if (stored === undefined) return undefined
  const fields = schemaFieldsOf(schema)
  const prepared =
    options?.preparedText?.before ??
    (options?.customTokenizer === undefined && options?.onPreparedText === undefined
      ? UNREAD_DOCUMENT_TEXT
      : prepareDocumentText(stored.fields, fields, language, options))
  return prepareRemovalText(
    prepared,
    stored.fields,
    fields.filter(field => field.base === 'string' || field.base === 'string[]').map(field => field.path),
    language,
    options,
  )
}

export function preparedRemovedSpellings(before: PreparedText | undefined): RemovedSpellings | undefined {
  if (before === undefined) return undefined
  if (before.removalSpellings !== undefined) return removedSurfaceSpellings(before)
  const spellings: string[] = []
  for (const field of before.fields.values()) {
    for (const [spelling, value] of preparedSurfaces(field)) {
      if (spelling === value.token) continue
      for (let count = 0; count < value.count; count++) spellings.push(spelling)
    }
  }
  return spellings
}

export function withPreviousText(
  options: PartitionInsertOptions | undefined,
  before: PreparedText | undefined,
): PartitionInsertOptions | undefined {
  return before === undefined
    ? options
    : {
        ...options,
        preparedText: { ...options?.preparedText, before },
        onPreparedText: change => options?.onPreparedText?.({ ...change, before }),
      }
}
