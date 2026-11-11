import { schemaFieldsOf } from '../../../schema/validator'
import type { LanguageModule } from '../../../types/language'
import type { SchemaDefinition } from '../../../types/schema'
import type { FrozenSegment, FrozenTombstone } from '../frozen'
import type { RemovedSpellings } from '../frozen/surface-slot'
import { type PreparedText, prepareDocumentText } from '../prepared-text'
import type { PartitionInsertOptions } from '../utils'

export interface FrozenOwnerRemoval {
  readonly before: PreparedText | undefined
  readonly tombstone: FrozenTombstone | undefined
}

function preparedBefore(
  owner: FrozenSegment,
  docId: string,
  schema: SchemaDefinition,
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
): PreparedText | undefined {
  if (options?.preparedText?.before !== undefined) return options.preparedText.before
  if (options?.customTokenizer === undefined) return undefined
  const stored = owner.docStore.get(docId)
  return stored === undefined
    ? undefined
    : prepareDocumentText(stored.fields, schemaFieldsOf(schema), language, options)
}

export function prepareOwnerRemoval(
  owner: FrozenSegment,
  docId: string,
  schema: SchemaDefinition,
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  removedSpellings: RemovedSpellings | undefined,
): FrozenOwnerRemoval {
  const before = preparedBefore(owner, docId, schema, language, options)
  const tombstone = owner.prepareTombstone(docId, removedSpellings, { language, options, text: before })
  options?.onRemovedSpellings?.(tombstone?.spellings ?? removedSpellings)
  options?.onPreparedText?.({ before })
  return { before, tombstone }
}
