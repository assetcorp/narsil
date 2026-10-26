import { createPartitionIndex, type PartitionIndex, type PartitionInsertOptions } from '../core/partition'
import { yieldToEventLoop } from '../engine/orchestration/turn'
import { TEXT_REBUILD_CHUNK_DOCUMENTS, TEXT_REBUILD_SWITCH_BACKLOG_DOCUMENTS } from './constants'
import { resolvePartitionInsertOptions } from './insert-options'
import type { PartitionManager } from './manager'
import type { PartitionWriteLog } from './manager/write-log'

export interface TextRebuildHooks {
  isCurrent(): boolean
  onPartitionBuilt(partitionsBuilt: number): void
  onSwitch(): void
}

interface RebuildPass {
  manager: PartitionManager
  log: PartitionWriteLog
  hooks: TextRebuildHooks
  options: PartitionInsertOptions | undefined
}

function interrupted(pass: RebuildPass): boolean {
  return pass.log.partitionsReplaced || !pass.hooks.isCurrent()
}

async function buildPartition(
  pass: RebuildPass,
  source: PartitionIndex,
  partitionId: number,
): Promise<PartitionIndex | null> {
  const { manager, options } = pass
  const target = createPartitionIndex(partitionId, manager.config.trackPositions ?? true)
  const docIds = [...source.docIds()]
  target.beginBatch()
  for (let start = 0; start < docIds.length; start += TEXT_REBUILD_CHUNK_DOCUMENTS) {
    const end = Math.min(start + TEXT_REBUILD_CHUNK_DOCUMENTS, docIds.length)
    for (let i = start; i < end; i++) {
      const document = manager.getRef(docIds[i])
      if (document !== undefined) target.insert(docIds[i], document, manager.schema, manager.language, options)
    }
    await yieldToEventLoop()
    if (interrupted(pass)) return null
  }
  target.endBatch()
  if (manager.partialWordAnalysis !== null) target.preparePartialWords(manager.partialWordAnalysis)
  return target
}

function applyWrittenDocuments(pass: RebuildPass, built: PartitionIndex[]): void {
  const { manager, options } = pass
  for (const docId of pass.log.takeWrittenDocIds()) {
    for (const partition of built) {
      if (!partition.has(docId)) continue
      partition.remove(docId, manager.schema, manager.language, options)
      break
    }
    const partitionId = manager.partitionIdOf(docId)
    const document = manager.getRef(docId)
    if (partitionId === undefined || document === undefined) continue
    built[partitionId].insert(docId, document, manager.schema, manager.language, options)
  }
}

async function rebuildOnce(pass: RebuildPass): Promise<boolean> {
  const partitionCount = pass.manager.partitionCount
  const built: PartitionIndex[] = []
  for (let partitionId = 0; partitionId < partitionCount; partitionId++) {
    const partition = await buildPartition(pass, pass.manager.getPartition(partitionId), partitionId)
    if (partition === null) return false
    built.push(partition)
    pass.hooks.onPartitionBuilt(built.length)
  }
  while (pass.log.pendingDocuments > TEXT_REBUILD_SWITCH_BACKLOG_DOCUMENTS) {
    applyWrittenDocuments(pass, built)
    await yieldToEventLoop()
    if (interrupted(pass)) return false
  }
  applyWrittenDocuments(pass, built)
  pass.manager.adoptRebuiltPartitions(built)
  pass.hooks.onSwitch()
  return true
}

export async function rebuildTextIndexes(manager: PartitionManager, hooks: TextRebuildHooks): Promise<boolean> {
  const options = resolvePartitionInsertOptions(manager.config, manager.analysis, { validate: false, skipClone: true })
  while (hooks.isCurrent()) {
    const log = manager.openWriteLog()
    try {
      if (await rebuildOnce({ manager, log, hooks, options })) return true
    } finally {
      log.close()
    }
  }
  return false
}
