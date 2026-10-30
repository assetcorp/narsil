import { collectAndReturnPages, collectYoungGeneration } from '#platform/idle-heap-cleanup'
import type { NodeMemoryReport } from '../distribution/coordinator/types'
import {
  REFUSAL_COLLECTION_MIN_INTERVAL_MS,
  REFUSAL_COLLECTION_TIME_MULTIPLE,
  REFUSAL_YOUNG_COLLECTION_MIN_INTERVAL_MS,
} from './constants'

export interface HeapReservation {
  release(): void
}

export type RefusedMemoryFigures = Omit<NodeMemoryReport, 'full'> & {
  youngHeapBytes: number
  heapCommittedBytes: number
  youngCeilingBytes: number
  youngReserveBytes: number
}

const refusalListeners = new Set<(figures: RefusedMemoryFigures) => void>()
let reservedBytes = 0
let admittedBytes = 0
let lastYoungCollectionAt = Number.NEGATIVE_INFINITY

export function reservedHeapBytes(): number {
  return reservedBytes
}

export function admittedHeapBytes(): number {
  return admittedBytes
}

export function admitHeapBytes(bytes: number): void {
  admittedBytes += bytes
}

export function chargeHeapBytes(bytes: number): void {
  reservedBytes += bytes
  if (bytes > 0) admittedBytes += bytes
}

export function reserveHeapBytes(bytes: number): HeapReservation {
  reservedBytes += bytes
  admittedBytes += bytes
  let released = false
  return {
    release() {
      if (released) return
      released = true
      reservedBytes -= bytes
    },
  }
}

export function onRefusalAfterCollection(listener: (figures: RefusedMemoryFigures) => void): () => void {
  refusalListeners.add(listener)
  return () => {
    refusalListeners.delete(listener)
  }
}

export function reportRefusalAfterCollection(figures: RefusedMemoryFigures): void {
  for (const listener of refusalListeners) listener(figures)
}

function refusalCollector(): () => boolean {
  let lastCollectionAt = Number.NEGATIVE_INFINITY
  let intervalMs = REFUSAL_COLLECTION_MIN_INTERVAL_MS
  return () => {
    const startedAt = performance.now()
    if (startedAt - lastCollectionAt < intervalMs) return false
    lastCollectionAt = startedAt
    if (!collectAndReturnPages()) return false
    intervalMs = Math.max(
      REFUSAL_COLLECTION_MIN_INTERVAL_MS,
      (performance.now() - startedAt) * REFUSAL_COLLECTION_TIME_MULTIPLE,
    )
    return true
  }
}

export const collectGarbageBeforeRefusal = refusalCollector()

export const collectGarbageBeforeAnswerRefusal = refusalCollector()

export function collectYoungGenerationBeforeRefusal(): boolean {
  const startedAt = performance.now()
  if (startedAt - lastYoungCollectionAt < REFUSAL_YOUNG_COLLECTION_MIN_INTERVAL_MS) return false
  lastYoungCollectionAt = startedAt
  return collectYoungGeneration()
}
