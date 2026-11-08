import type { DocIdMap } from '../../core/doc-id-tables/types'
import type { PartitionIndex, PartitionInsertOptions } from '../../core/partition'
import type { CompositePartition } from '../../core/partition/composite'
import type { RemovedSpellings } from '../../core/partition/frozen/surface-slot'
import { writePartitionDocument } from '../../core/partition/rollover'
import { ErrorCodes, NarsilError } from '../../errors'
import type { LanguageModule } from '../../types/language'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import type { StatePins } from './state-pins'
import type { PartitionManager } from './types'
import type { WriteLogRecorder } from './write-log'

interface DocumentWriteSource {
  docPartitionMap: DocIdMap<number>
  writeLogs: WriteLogRecorder
  pins: StatePins
  config(): IndexConfig
  language(): LanguageModule
  partitionAt(partitionId: number): PartitionIndex
  asCompositePartition(partitionId: number): CompositePartition
  locate(docId: string): number | undefined
  route(docId: string): number
  resolveOptions(options: PartitionInsertOptions | undefined): PartitionInsertOptions | undefined
}

function publish(
  source: DocumentWriteSource,
  partitionId: number,
  docId: string,
  document: AnyDocument,
  options: PartitionInsertOptions | undefined,
  updating: boolean,
  removed?: RemovedSpellings,
): void {
  writePartitionDocument(
    source.partitionAt(partitionId),
    docId,
    document,
    source.config().schema,
    source.language(),
    options,
    updating,
    removed,
    () => source.asCompositePartition(partitionId),
  )
}

export function createDocumentWrites(source: DocumentWriteSource): Pick<PartitionManager, 'insert' | 'update'> {
  return {
    insert(docId, document, options): void {
      const partitionId = source.route(docId)
      source.pins.beforeWrite(docId)
      publish(source, partitionId, docId, document, source.resolveOptions(options), false)
      source.docPartitionMap.set(docId, partitionId)
      source.writeLogs.documentWritten(docId)
    },

    update(docId, document, options, removed): void {
      const partitionId = source.locate(docId)
      if (partitionId === undefined)
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in any partition`, { docId })
      source.pins.beforeWrite(docId)
      publish(source, partitionId, docId, document, source.resolveOptions(options), true, removed)
      source.docPartitionMap.set(docId, partitionId)
      source.writeLogs.documentWritten(docId)
    },
  }
}
