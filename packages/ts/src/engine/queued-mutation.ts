import {
  ErrorCodes,
  NarsilError,
  prepareDocumentText,
  prepareDocumentVectors,
  prepareRemovalText,
  removedSurfaceSpellings,
  schemaFieldsOf,
  validateDocument,
  validateDocumentStrict,
} from '#platform/storage-host'
import type { PartitionManager } from '../partitioning/manager'
import type { BufferedMutation, QueuedWrite, WriteAheadQueue } from '../partitioning/write-ahead-queue'
import type { AnyDocument } from '../types/schema'

export function bufferPreparedMutation(
  queue: WriteAheadQueue,
  manager: PartitionManager,
  entry: BufferedMutation,
  vectorFieldPaths: Set<string>,
  awaitsDurability: boolean,
): QueuedWrite {
  queue.assertWritable()
  const previous = queue.latest(entry.docId)
  const previousDocument = previous === undefined ? manager.get(entry.docId) : previous.document
  if (entry.action === 'insert' && previousDocument !== undefined) {
    throw new NarsilError(ErrorCodes.DOC_ALREADY_EXISTS, `Document "${entry.docId}" already exists`)
  }
  if (entry.action === 'remove' && previousDocument === undefined) {
    throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${entry.docId}" not found`)
  }
  const document = entry.document === undefined ? undefined : structuredClone(entry.document)
  const { options, language } = manager.textAnalysis
  if (document !== undefined) {
    validateDocument(document, manager.schema, options?.patternValueLimit)
    if (options?.strict) validateDocumentStrict(document, manager.schema)
  }
  const fields = schemaFieldsOf(manager.schema)
  const surfaceFields = fields
    .filter(field => field.base === 'string' || field.base === 'string[]')
    .map(field => field.path)
  const prepareText = (value: AnyDocument) =>
    prepareRemovalText(prepareDocumentText(value, fields, language, options), value, surfaceFields, language, options)
  const before = previousDocument === undefined ? undefined : (previous?.text.after ?? prepareText(previousDocument))
  const after = document === undefined ? undefined : prepareText(document)
  const partitionDoc = document === undefined ? undefined : prepareDocumentVectors(document, vectorFieldPaths)
  const vectors = new Map<string, Float32Array | null>()
  for (const field of vectorFieldPaths) vectors.set(field, partitionDoc?.extractedVectors.get(field) ?? null)
  return queue.push(
    structuredClone({
      ...entry,
      document,
      partitionDoc: partitionDoc?.partitionDoc,
      previousDocument,
      previousPartitionDoc:
        previousDocument === undefined
          ? undefined
          : (previous?.partitionDoc ?? prepareDocumentVectors(previousDocument, vectorFieldPaths).partitionDoc),
      text: { before, after },
      vectors,
      removedSpellings: before === undefined ? [] : (previous?.afterSpellings ?? removedSurfaceSpellings(before)),
      afterSpellings: after === undefined ? [] : removedSurfaceSpellings(after),
    }),
    awaitsDurability,
  )
}
