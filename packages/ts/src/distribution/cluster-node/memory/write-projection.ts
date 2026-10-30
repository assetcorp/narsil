import { BATCH_CHUNK_SIZE } from '../../../engine/constants'
import { ErrorCodes, NarsilError } from '../../../errors'
import { reservedHeapBytes, reserveHeapBytes } from '../../../runtime/thread-heap'
import { createDocumentBound, type DocumentBound, type IndexWriteAnalysis } from './document-bound'
import type { MemoryFractions } from './fractions'
import type { MemoryFigures } from './measure'

export const WRITE_WOULD_FILL_MEMORY_REASON = 'write_would_fill_memory'
const WRITE_EXCEEDS_MEMORY_REASON = 'write_exceeds_memory'

export interface ProjectedGroup {
  readonly count: number
  release(): void
}

export interface WriteProjection {
  boundOf(indexName: string): DocumentBound | null
  takeGroup(indexName: string, bounds: readonly number[], start: number): ProjectedGroup
  takeOne(indexName: string, bound: number): ProjectedGroup
}

export interface WriteProjectionOptions {
  nodeId: string
  fractions: MemoryFractions
  measure: () => MemoryFigures | null
  measureWithoutGarbage: () => MemoryFigures | null
  collections: () => number
  refusedAfterCollection: (figures: MemoryFigures) => void
  analysisOf: (indexName: string) => IndexWriteAnalysis | null
  vectorGrowthBytesOf: (indexName: string, documents: number) => number
}

interface CachedBound {
  analysis: IndexWriteAnalysis
  bound: DocumentBound
}

const UNPROJECTED: ProjectedGroup = { count: 0, release: () => {} }

function heapRoomIn(figures: MemoryFigures, fractions: MemoryFractions): number {
  return fractions.heapBlock * figures.heapLimitBytes - figures.heapBytes - figures.youngHeapBytes
}

function processRoomIn(figures: MemoryFigures, fractions: MemoryFractions): number {
  return fractions.processBlock * figures.processLimitBytes - figures.processBytes - figures.youngReserveBytes
}

export function createWriteProjection(options: WriteProjectionOptions): WriteProjection {
  const bounds = new Map<string, CachedBound>()

  function fittingCount(
    indexName: string,
    figures: MemoryFigures | null,
    groupBounds: readonly number[],
    start: number,
  ): number {
    const end = Math.min(groupBounds.length, start + BATCH_CHUNK_SIZE)
    if (figures === null) return end - start
    const reserved = reservedHeapBytes()
    const heapRoom = heapRoomIn(figures, options.fractions) - reserved
    const processRoom = processRoomIn(figures, options.fractions) - reserved
    const mostGrowth = options.vectorGrowthBytesOf(indexName, end - start)
    let taken = 0
    let count = 0
    while (start + count < end) {
      const next = taken + groupBounds[start + count]
      if (next > heapRoom) break
      if (next + mostGrowth > processRoom && next + options.vectorGrowthBytesOf(indexName, count + 1) > processRoom)
        break
      taken = next
      count++
    }
    return count
  }

  function reserve(indexName: string, groupBounds: readonly number[], start: number, count: number): ProjectedGroup {
    let bytes = count === 0 ? 0 : options.vectorGrowthBytesOf(indexName, count)
    for (let index = start; index < start + count; index++) bytes += groupBounds[index]
    const reservation = reserveHeapBytes(bytes)
    return { count, release: () => reservation.release() }
  }

  function blockBytesOf(figures: MemoryFigures): number {
    return Math.floor(options.fractions.heapBlock * figures.heapLimitBytes)
  }

  function exceedsMemory(indexName: string, bound: number, blockBytes: number): NarsilError {
    return new NarsilError(
      ErrorCodes.CLUSTER_WRITE_BLOCKED,
      `Node '${options.nodeId}' refuses this document for index '${indexName}' because indexing it can take up to ${bound} bytes, more than the ${blockBytes} bytes that the node allows its heap even when idle. Split the document into smaller documents.`,
      { reason: WRITE_EXCEEDS_MEMORY_REASON, indexName, nodeId: options.nodeId, documentBytes: bound, blockBytes },
    )
  }

  function wouldFillMemory(
    indexName: string,
    bound: number,
    figures: MemoryFigures,
    heapBytesBeforeCollection: number,
    collectedGarbage: boolean,
  ): NarsilError {
    const projected = reservedHeapBytes()
    return new NarsilError(
      ErrorCodes.CLUSTER_WRITE_BLOCKED,
      `Node '${options.nodeId}' refuses this document for index '${indexName}' because indexing it can take up to ${bound} bytes, which with the ${projected} bytes that writes in progress can take would pass the node's memory block. Retry once the writes in progress finish, or add memory to the cluster.`,
      {
        reason: WRITE_WOULD_FILL_MEMORY_REASON,
        indexName,
        nodeId: options.nodeId,
        documentBytes: bound,
        projectedBytes: projected,
        heapBytes: figures.heapBytes,
        youngHeapBytes: figures.youngHeapBytes,
        heapBytesBeforeCollection,
        collectedGarbage,
        processBytes: figures.processBytes,
        youngCeilingBytes: figures.youngCeilingBytes,
        youngReserveBytes: figures.youngReserveBytes,
        blockBytes: blockBytesOf(figures),
      },
    )
  }

  function takeGroup(indexName: string, groupBounds: readonly number[], start: number): ProjectedGroup {
    if (start >= groupBounds.length) return UNPROJECTED
    const measured = options.measure()
    if (measured === null)
      return reserve(indexName, groupBounds, start, fittingCount(indexName, null, groupBounds, start))
    if (groupBounds[start] > blockBytesOf(measured)) {
      throw exceedsMemory(indexName, groupBounds[start], blockBytesOf(measured))
    }
    let figures = measured
    let count = fittingCount(indexName, figures, groupBounds, start)
    if (count > 0) return reserve(indexName, groupBounds, start, count)
    const collectionsBefore = options.collections()
    figures = options.measureWithoutGarbage() ?? figures
    count = fittingCount(indexName, figures, groupBounds, start)
    if (count > 0) return reserve(indexName, groupBounds, start, count)
    const collected = options.collections() !== collectionsBefore
    if (collected) options.refusedAfterCollection(figures)
    throw wouldFillMemory(indexName, groupBounds[start], figures, measured.heapBytes, collected)
  }

  return {
    boundOf(indexName) {
      const analysis = options.analysisOf(indexName)
      if (analysis === null) return null
      const cached = bounds.get(indexName)
      if (
        cached !== undefined &&
        cached.analysis.schema === analysis.schema &&
        cached.analysis.language === analysis.language &&
        cached.analysis.customTokenizer === analysis.customTokenizer
      ) {
        return cached.bound
      }
      const bound = createDocumentBound(analysis)
      bounds.set(indexName, { analysis, bound })
      return bound
    },
    takeGroup,
    takeOne: (indexName, bound) => takeGroup(indexName, [bound], 0),
  }
}
