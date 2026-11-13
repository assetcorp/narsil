import { ErrorCodes, NarsilError } from '../../errors'
import { WRITE_MEMORY_FIGURES_MAX_AGE_MS } from './constants'
import { createDocumentTableGrowth } from './document-tables'
import { applyInGroups, type GroupedWriteProjection, reserveForDocument } from './grouped-writes'
import { readRecentEngineMemoryFigures } from './measure'
import { createMeasuredWriteBlock } from './measured-block'
import { vectorGrowthBytesOf, writeAnalysisOf } from './write-analysis'
import type { MemoryWriteBlock, MemoryWriteBlockDeps } from './write-block-types'
import { createWriteProjection, WRITE_WOULD_FILL_MEMORY_REASON } from './write-projection'

export { checkWriteMemory, validateMemorySettings } from './write-block'

function refusedAfter(indexName: string, docId: string, refusedDocId: string): NarsilError {
  return new NarsilError(
    ErrorCodes.MEMORY_WRITE_BLOCKED,
    `The engine refuses document '${docId}' for index '${indexName}' because document '${refusedDocId}' before it in the batch would not fit in the engine's memory. Retry the refused documents once the writes in progress finish.`,
    { reason: WRITE_WOULD_FILL_MEMORY_REASON, indexName, docId, refusedDocId },
  )
}

export function createMemoryWriteBlock(deps: MemoryWriteBlockDeps): MemoryWriteBlock | undefined {
  if (deps.capacityScope !== 'index') return undefined
  const measured = createMeasuredWriteBlock(deps.settings)
  const { monitor } = measured
  const projection = createWriteProjection({
    refusal: {
      code: ErrorCodes.MEMORY_WRITE_BLOCKED,
      refuser: 'The engine',
      owner: 'the engine',
      fillAdvice: 'Retry once the writes in progress finish, or remove documents to free memory.',
      details: {},
    },
    fractions: measured.fractions,
    measure: () => readRecentEngineMemoryFigures(WRITE_MEMORY_FIGURES_MAX_AGE_MS),
    measureWithoutGarbage: () => monitor.measureWithoutGarbage(),
    collections: () => monitor.collections(),
    refusedAfterCollection: figures => monitor.refusedAfterCollection(figures),
    analysisOf: indexName => writeAnalysisOf(deps.source, indexName),
    vectorGrowthBytesOf: (indexName, documents) => vectorGrowthBytesOf(deps.source, indexName, documents),
    documentTableGrowthBytesOf: createDocumentTableGrowth(deps.source),
  })
  const grouped: GroupedWriteProjection = {
    boundOf: indexName => projection.boundOf(indexName),
    countedBoundOf: indexName => projection.countedBoundOf(indexName),
    takeGroup: (indexName, bounds, start, mostDocuments, countExactly) =>
      projection.takeGroup(indexName, bounds, start, mostDocuments, countExactly),
    refusedAfter,
  }

  return {
    refuseWhileFull: measured.refuseWhileFull,
    memoryReleased: measured.memoryReleased,
    grouping: {
      reserveFor: (indexName, document) => reserveForDocument(grouped, indexName, document),
      applyInGroups: (indexName, write) => applyInGroups(grouped, indexName, write),
    },
  }
}
