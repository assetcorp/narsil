import { type ErrorCode, NarsilError } from '../../errors'
import { reservedHeapBytes, reserveHeapBytes } from '../../runtime/thread-heap'
import { BATCH_CHUNK_SIZE } from '../constants'
import {
  createCountedDocumentBound,
  createDocumentBound,
  type DocumentBound,
  type IndexWriteAnalysis,
} from './document-bound'
import type { MemoryFractions } from './fractions'
import type { MemoryFigures } from './measure'

export const WRITE_WOULD_FILL_MEMORY_REASON = 'write_would_fill_memory'
const WRITE_EXCEEDS_MEMORY_REASON = 'write_exceeds_memory'

export interface ProjectedGroup {
  readonly count: number
  release(): void
}

export type CountExactly = (position: number) => void

export interface WriteProjection {
  boundOf(indexName: string): DocumentBound | null
  countedBoundOf(indexName: string): DocumentBound | null
  takeGroup(
    indexName: string,
    bounds: readonly number[],
    start: number,
    mostDocuments?: number,
    countExactly?: CountExactly,
  ): ProjectedGroup
  takeOne(indexName: string, bound: number): ProjectedGroup
}

export interface WriteRefusalWording {
  code: ErrorCode
  refuser: string
  owner: string
  fillAdvice: string
  details: Readonly<Record<string, unknown>>
}

export interface WriteProjectionOptions {
  refusal: WriteRefusalWording
  fractions: MemoryFractions
  measure: () => MemoryFigures | null
  measureWithoutGarbage: () => MemoryFigures | null
  collections: () => number
  refusedAfterCollection: (figures: MemoryFigures) => void
  analysisOf: (indexName: string) => IndexWriteAnalysis | null
  vectorGrowthBytesOf: (indexName: string, documents: number) => number
  documentTableGrowthBytesOf: (indexName: string, documents: number, pendingDocuments: number) => number
}

interface CachedBound {
  analysis: IndexWriteAnalysis
  bound: DocumentBound
  counted: DocumentBound
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
  const pendingDocuments = new Map<string, number>()
  const { refusal } = options

  function settlePending(indexName: string, count: number): void {
    const remaining = (pendingDocuments.get(indexName) ?? 0) - count
    if (remaining > 0) pendingDocuments.set(indexName, remaining)
    else pendingDocuments.delete(indexName)
  }

  function fittingCount(
    indexName: string,
    figures: MemoryFigures | null,
    groupBounds: readonly number[],
    start: number,
    mostDocuments: number,
    countExactly: CountExactly | undefined,
  ): number {
    const end = Math.min(groupBounds.length, start + mostDocuments)
    if (figures === null) return end - start
    const reserved = reservedHeapBytes()
    const heapRoom = heapRoomIn(figures, options.fractions) - reserved
    const processRoom = processRoomIn(figures, options.fractions) - reserved
    const pending = pendingDocuments.get(indexName) ?? 0
    const mostTableGrowth = options.documentTableGrowthBytesOf(indexName, end - start, pending)
    const mostVectorGrowth = options.vectorGrowthBytesOf(indexName, end - start)
    const fits = (next: number, count: number): boolean => {
      const most = next + mostTableGrowth
      if (most <= heapRoom && most + mostVectorGrowth <= processRoom) return true
      const withTables = next + options.documentTableGrowthBytesOf(indexName, count + 1, pending)
      return withTables <= heapRoom && withTables + options.vectorGrowthBytesOf(indexName, count + 1) <= processRoom
    }
    let taken = 0
    let count = 0
    while (start + count < end) {
      if (!fits(taken + groupBounds[start + count], count)) {
        if (countExactly === undefined) break
        countExactly(start + count)
        if (!fits(taken + groupBounds[start + count], count)) break
      }
      taken += groupBounds[start + count]
      count++
    }
    return count
  }

  function reserve(indexName: string, groupBounds: readonly number[], start: number, count: number): ProjectedGroup {
    if (count === 0) return UNPROJECTED
    const pending = pendingDocuments.get(indexName) ?? 0
    let bytes =
      options.vectorGrowthBytesOf(indexName, count) + options.documentTableGrowthBytesOf(indexName, count, pending)
    for (let index = start; index < start + count; index++) bytes += groupBounds[index]
    const reservation = reserveHeapBytes(bytes)
    pendingDocuments.set(indexName, pending + count)
    let released = false
    return {
      count,
      release: () => {
        if (released) return
        released = true
        reservation.release()
        settlePending(indexName, count)
      },
    }
  }

  function blockBytesOf(figures: MemoryFigures): number {
    return Math.floor(
      Math.min(
        options.fractions.heapBlock * figures.heapLimitBytes,
        options.fractions.processBlock * figures.processLimitBytes,
      ),
    )
  }

  function exceedsMemory(indexName: string, bound: number, blockBytes: number): NarsilError {
    return new NarsilError(
      refusal.code,
      `${refusal.refuser} refuses this document for index '${indexName}' because indexing it can take up to ${bound} bytes, more than the ${blockBytes} bytes that ${refusal.owner} allows its memory even when idle. Split the document into smaller documents.`,
      { reason: WRITE_EXCEEDS_MEMORY_REASON, indexName, ...refusal.details, documentBytes: bound, blockBytes },
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
      refusal.code,
      `${refusal.refuser} refuses this document for index '${indexName}' because indexing it can take up to ${bound} bytes, which with the ${projected} bytes that writes in progress can take would pass ${refusal.owner}'s memory block. ${refusal.fillAdvice}`,
      {
        reason: WRITE_WOULD_FILL_MEMORY_REASON,
        indexName,
        ...refusal.details,
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

  function takeGroup(
    indexName: string,
    groupBounds: readonly number[],
    start: number,
    mostDocuments = BATCH_CHUNK_SIZE,
    countExactly?: CountExactly,
  ): ProjectedGroup {
    if (start >= groupBounds.length) return UNPROJECTED
    const measured = options.measure()
    if (measured === null) {
      const unmeasured = fittingCount(indexName, null, groupBounds, start, mostDocuments, countExactly)
      return reserve(indexName, groupBounds, start, unmeasured)
    }
    const blockBytes = blockBytesOf(measured)
    if (groupBounds[start] > blockBytes) countExactly?.(start)
    if (groupBounds[start] > blockBytes) throw exceedsMemory(indexName, groupBounds[start], blockBytes)
    let figures = measured
    let count = fittingCount(indexName, figures, groupBounds, start, mostDocuments, countExactly)
    if (count > 0) return reserve(indexName, groupBounds, start, count)
    const collectionsBefore = options.collections()
    figures = options.measureWithoutGarbage() ?? figures
    count = fittingCount(indexName, figures, groupBounds, start, mostDocuments, countExactly)
    if (count > 0) return reserve(indexName, groupBounds, start, count)
    const collected = options.collections() !== collectionsBefore
    if (collected) options.refusedAfterCollection(figures)
    throw wouldFillMemory(indexName, groupBounds[start], figures, measured.heapBytes, collected)
  }

  function cachedBoundsOf(indexName: string): CachedBound | null {
    const analysis = options.analysisOf(indexName)
    if (analysis === null) return null
    const cached = bounds.get(indexName)
    if (
      cached !== undefined &&
      cached.analysis.schema === analysis.schema &&
      cached.analysis.language === analysis.language &&
      cached.analysis.customTokenizer === analysis.customTokenizer
    ) {
      return cached
    }
    const fresh = { analysis, bound: createDocumentBound(analysis), counted: createCountedDocumentBound(analysis) }
    bounds.set(indexName, fresh)
    return fresh
  }

  return {
    boundOf: indexName => cachedBoundsOf(indexName)?.bound ?? null,
    countedBoundOf: indexName => cachedBoundsOf(indexName)?.counted ?? null,
    takeGroup,
    takeOne: (indexName, bound) => takeGroup(indexName, [bound], 0),
  }
}
