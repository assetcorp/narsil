import { countWrite, ErrorCodes, NarsilError, updateDocumentVectors } from '#platform/storage-host'
import type { PartitionInsertOptions } from '../core/partition'
import type { PartitionManager } from '../partitioning/manager'
import type { WAQEntry, WriteAheadQueue } from '../partitioning/write-ahead-queue'
import type { RebalanceContext } from './rebalance-executor'

function applyEntry(manager: PartitionManager, entry: WAQEntry, ctx: RebalanceContext): Promise<void> | undefined {
  const { docId, indexName, partitionDoc, previousPartitionDoc, text, removedSpellings } = entry
  const options: PartitionInsertOptions = { preparedText: text, validate: false }
  if (entry.action === 'remove') {
    manager.remove(docId, removedSpellings, options)
  } else if (partitionDoc === undefined) {
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'A queued write has no prepared document')
  } else if (previousPartitionDoc === undefined) {
    manager.insert(docId, partitionDoc, options)
  } else {
    manager.update(docId, partitionDoc, options, removedSpellings)
  }
  try {
    updateDocumentVectors(docId, entry.vectors, manager.getVectorIndexes(), manager.partitionIdOf(docId))
  } catch (error) {
    const rollback: PartitionInsertOptions = {
      preparedText: { before: text.after, after: text.before },
      validate: false,
    }
    if (previousPartitionDoc === undefined) manager.remove(docId, entry.afterSpellings, rollback)
    else if (entry.action === 'remove') manager.insert(docId, previousPartitionDoc, rollback)
    else manager.update(docId, previousPartitionDoc, rollback, entry.afterSpellings)
    throw error
  }
  if (entry.action === 'remove') {
    return ctx.orchestrator.publishToWorkers({
      type: 'remove',
      indexName,
      docId,
      removedSpellings,
      requestId: `replicate-remove-${docId}`,
    })
  } else if (partitionDoc !== undefined) {
    return ctx.orchestrator.publishToWorkers({
      type: previousPartitionDoc === undefined ? 'insert' : 'update',
      indexName,
      docId,
      document: partitionDoc,
      removedSpellings,
      requestId: `replicate-${entry.action}-${docId}`,
    })
  }
}

async function afterEntry(manager: PartitionManager, entry: WAQEntry, ctx: RebalanceContext): Promise<void> {
  for (const field of entry.vectors.keys()) manager.getVectorIndexes().get(field)?.scheduleBuild()
  try {
    if (entry.action === 'remove') {
      await ctx.pluginRegistry.runHook('afterRemove', { indexName: entry.indexName, docId: entry.docId })
    } else if (entry.document !== undefined) {
      if (entry.action === 'insert') {
        await ctx.pluginRegistry.runHook('afterInsert', {
          indexName: entry.indexName,
          docId: entry.docId,
          document: structuredClone(entry.document),
        })
      } else {
        await ctx.pluginRegistry.runHook('afterUpdate', {
          indexName: entry.indexName,
          docId: entry.docId,
          oldDocument: structuredClone(entry.previousDocument ?? {}),
          newDocument: structuredClone(entry.document),
        })
      }
    }
  } catch (error) {
    console.warn('Queued write plugin hook error:', error instanceof Error ? error.message : String(error))
  }
}

export async function replayQueued(
  manager: PartitionManager,
  queue: WriteAheadQueue,
  ctx: RebalanceContext,
  deferredHooks?: Array<() => Promise<void>>,
): Promise<void> {
  for (;;) {
    const entry = queue.first()
    if (entry === undefined) {
      queue.requireSuccess()
      return
    }
    try {
      if (!(await queue.awaitReady(entry))) continue
      let publication: Promise<void> | undefined
      await countWrite(() =>
        manager.publication.write(() => {
          try {
            queue.requireReplayable()
            publication = applyEntry(manager, entry, ctx)
            queue.complete(entry)
          } catch (error) {
            queue.fail(error)
            throw error
          }
        }),
      )
      await publication
    } catch (error) {
      queue.fail(error)
      throw error
    }
    if (deferredHooks === undefined) await afterEntry(manager, entry, ctx)
    else deferredHooks.push(() => afterEntry(manager, entry, ctx))
  }
}
