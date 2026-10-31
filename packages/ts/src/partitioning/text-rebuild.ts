import type { ResolvedAnalysis } from '../analysis/registry'
import { createPartitionIndex, type PartitionIndex, type PartitionInsertOptions } from '../core/partition'
import type { PartialWordAnalysis } from '../core/partition/partial-words/spellings'
import { yieldToEventLoop } from '../engine/orchestration/turn'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'
import { TEXT_REBUILD_CHUNK_DOCUMENTS, TEXT_REBUILD_SWITCH_BACKLOG_DOCUMENTS } from './constants'
import { resolvePartialWordAnalysis, resolvePartitionInsertOptions } from './insert-options'
import type { PartitionManager } from './manager'
import type { PartitionWriteLog } from './manager/write-log'

export interface TextRebuildHooks {
  isCurrent(): boolean
  onPartitionBuilt(partitionsBuilt: number): void
  onSwitch(): void
  runSwitch?(swap: () => boolean): Promise<boolean>
  holdBeforeSwitch?(keepCurrent: () => boolean): Promise<boolean>
}

export interface TextRebuildTarget {
  config: IndexConfig
  language: LanguageModule
  analysis: ResolvedAnalysis
  partialWordAnalysis: PartialWordAnalysis | null
}

export function textRebuildTargetOf(
  config: IndexConfig,
  language: LanguageModule,
  analysis: ResolvedAnalysis,
): TextRebuildTarget {
  return { config, language, analysis, partialWordAnalysis: resolvePartialWordAnalysis(config, language, analysis) }
}

interface RebuildPass {
  manager: PartitionManager
  log: PartitionWriteLog
  hooks: TextRebuildHooks
  language: LanguageModule
  partialWordAnalysis: PartialWordAnalysis | null
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
  const { manager, language, options } = pass
  const target = createPartitionIndex(partitionId, manager.config.trackPositions ?? true)
  const docIds = [...source.docIds()]
  target.beginBatch()
  for (let start = 0; start < docIds.length; start += TEXT_REBUILD_CHUNK_DOCUMENTS) {
    const end = Math.min(start + TEXT_REBUILD_CHUNK_DOCUMENTS, docIds.length)
    for (let i = start; i < end; i++) {
      const document = manager.getRef(docIds[i])
      if (document !== undefined) target.insert(docIds[i], document, manager.schema, language, options)
    }
    await yieldToEventLoop()
    if (interrupted(pass)) return null
  }
  target.endBatch()
  if (pass.partialWordAnalysis !== null) target.preparePartialWords(pass.partialWordAnalysis)
  return target
}

function applyWrittenDocuments(pass: RebuildPass, built: PartitionIndex[]): void {
  const { manager, language, options } = pass
  for (const docId of pass.log.takeWrittenDocIds()) {
    for (const partition of built) {
      if (!partition.has(docId)) continue
      partition.remove(docId, manager.schema, language, options)
      break
    }
    const partitionId = manager.partitionIdOf(docId)
    const document = manager.getRef(docId)
    if (partitionId === undefined || document === undefined) continue
    built[partitionId].insert(docId, document, manager.schema, language, options)
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
  const keepCurrent = (): boolean => {
    if (interrupted(pass)) return false
    applyWrittenDocuments(pass, built)
    return true
  }
  if (pass.hooks.holdBeforeSwitch !== undefined && !(await pass.hooks.holdBeforeSwitch(keepCurrent))) return false
  const swap = (): boolean => {
    if (interrupted(pass)) return false
    applyWrittenDocuments(pass, built)
    pass.manager.adoptRebuiltPartitions(built)
    pass.hooks.onSwitch()
    return true
  }
  return pass.hooks.runSwitch === undefined ? swap() : pass.hooks.runSwitch(swap)
}

export async function rebuildTextIndexes(
  manager: PartitionManager,
  hooks: TextRebuildHooks,
  target?: TextRebuildTarget,
): Promise<boolean> {
  const options = resolvePartitionInsertOptions(
    target?.config ?? manager.config,
    target?.analysis ?? manager.analysis,
    {
      validate: false,
      skipClone: true,
    },
  )
  const language = target?.language ?? manager.language
  const partialWordAnalysis = target === undefined ? manager.partialWordAnalysis : target.partialWordAnalysis
  while (hooks.isCurrent()) {
    const log = manager.openWriteLog()
    try {
      if (await rebuildOnce({ manager, log, hooks, language, partialWordAnalysis, options })) return true
    } finally {
      log.close()
    }
  }
  return false
}
