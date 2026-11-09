import { ErrorCodes, NarsilError } from '../../errors'
import type { LanguageModule } from '../../types/language'
import type { AnyDocument, SchemaDefinition } from '../../types/schema'
import { type CompositePartition, createCompositePartition, isCompositePartition } from './composite'
import { preparedRemovedSpellings } from './composite/prepared-text'
import { createFrozenSegment } from './frozen'
import type { RemovedSpellings } from './frozen/surface-slot'
import { partitionStateOf } from './index'
import type { PartitionIndex } from './partition-index'
import { SegmentFull } from './segment-full'
import type { PartitionInsertOptions } from './utils'

export interface WrittenPartitionDocument {
  partition: PartitionIndex
  stored: AnyDocument
}

export function writePartitionDocument(
  partition: PartitionIndex,
  docId: string,
  document: AnyDocument,
  schema: SchemaDefinition,
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
  updating = false,
  removed?: RemovedSpellings,
  wrap?: () => CompositePartition,
): WrittenPartitionDocument {
  const write = (): AnyDocument =>
    updating
      ? partition.update(docId, document, schema, language, options, removed)
      : partition.insert(docId, document, schema, language, options)
  try {
    return { partition, stored: write() }
  } catch (error) {
    if (!(error instanceof SegmentFull)) throw error
    options = { ...options, preparedText: error.text }
    removed = preparedRemovedSpellings(error.text.before) ?? removed
    const composite =
      wrap?.() ??
      (isCompositePartition(partition)
        ? partition
        : createCompositePartition(partition.partitionId, partitionStateOf(partition).trackPositions, partition, {
            language,
            options,
          }))
    if (composite.freezeLiveTail(createFrozenSegment) === null)
      throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'An empty keyword segment refused a complete document')
    partition = composite
    return { partition, stored: write() }
  }
}
