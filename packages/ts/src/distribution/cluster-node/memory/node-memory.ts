import { collectAndReturnPages } from '#platform/idle-heap-cleanup'
import { addBackgroundAdmission } from '../../../runtime/background-memory'
import {
  collectGarbageBeforeRefusal,
  collectYoungGenerationBeforeRefusal,
  onRefusalAfterCollection,
  reservedHeapBytes,
} from '../../../runtime/thread-heap'
import type { ClusterCoordinator, IndexPartitionBytes, NodeRegistration } from '../../coordinator/types'
import {
  DEFAULT_IN_FLIGHT_WRITE_FRACTION,
  FULL_MEMORY_COLLECTION_INTERVAL_MS,
  MEMORY_SAMPLE_INTERVAL_MS,
  WRITE_MEMORY_SAMPLE_MAX_AGE_MS,
} from '../constants'
import type { ClusterLocalEngine } from '../local-engine'
import type { ClusterMemoryConfig } from '../types'
import { memoryFractionsOf } from './fractions'
import { readMemoryFigures, readRecentMemoryFigures } from './measure'
import { createMemoryMonitor } from './monitor'
import { collectPartitionBytes } from './partition-bytes'
import { createNodeMemoryView, type NodeMemoryView } from './write-block'
import { createWritePressure, type WritePressure } from './write-pressure'
import { createWriteProjection, type WriteProjection } from './write-projection'

export interface NodeMemoryReporting {
  view: NodeMemoryView
  writePressure: WritePressure
  writeProjection: WriteProjection
  currentRegistration(): NodeRegistration
  start(): Promise<void>
  stop(): void
}

export interface NodeMemoryReportingOptions {
  registration: NodeRegistration
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  config: ClusterMemoryConfig | undefined
  onFullChange: () => void
}

function partitionBytesOf(engine: ClusterLocalEngine): IndexPartitionBytes[] {
  try {
    return collectPartitionBytes(engine)
  } catch {
    return []
  }
}

export function createNodeMemoryReporting(options: NodeMemoryReportingOptions): NodeMemoryReporting {
  const fractions = memoryFractionsOf(options.config)
  const monitor = createMemoryMonitor({
    fractions,
    intervalMs: MEMORY_SAMPLE_INTERVAL_MS,
    collectionIntervalMs: FULL_MEMORY_COLLECTION_INTERVAL_MS,
    read: readMemoryFigures,
    collectGarbage: collectAndReturnPages,
    collectGarbageBeforeRefusal,
    collectYoungGenerationBeforeRefusal,
    onFullChange: options.onFullChange,
  })

  const view = createNodeMemoryView({
    coordinator: options.coordinator,
    localNodeId: options.registration.nodeId,
    localIsFull: monitor.isFull,
  })

  const writeProjection = createWriteProjection({
    nodeId: options.registration.nodeId,
    fractions,
    measure: readRecentMemoryFigures,
    measureWithoutGarbage: () => monitor.measureWithoutGarbage(),
    collections: () => monitor.collections(),
    refusedAfterCollection: figures => monitor.refusedAfterCollection(figures),
    analysisOf: indexName => options.engine.writeAnalysisOf(indexName),
    vectorGrowthBytesOf: (indexName, documents) => options.engine.vectorGrowthBytesOf(indexName, documents),
  })

  const heapLimitBytes = readMemoryFigures()?.heapLimitBytes ?? Number.POSITIVE_INFINITY
  const writePressure = createWritePressure({
    nodeId: options.registration.nodeId,
    limitBytes: Math.floor(
      heapLimitBytes * (options.config?.inFlightWriteFraction ?? DEFAULT_IN_FLIGHT_WRITE_FRACTION),
    ),
    beforeAdmit: () => monitor.sampleIfOlderThan(WRITE_MEMORY_SAMPLE_MAX_AGE_MS),
  })

  let stopHearingRefusals: (() => void) | null = null
  let stopAdmitting: (() => void) | null = null

  function admitsBackgroundBytes(bytes: number): boolean {
    const figures = readRecentMemoryFigures()
    if (figures === null) return true
    return (
      bytes <=
      fractions.processBlock * figures.processLimitBytes -
        figures.processBytes -
        figures.youngReserveBytes -
        reservedHeapBytes()
    )
  }

  return {
    view,
    writePressure,
    writeProjection,
    async start() {
      monitor.start()
      stopHearingRefusals ??= onRefusalAfterCollection(figures => monitor.refusedAfterCollection(figures))
      stopAdmitting ??= addBackgroundAdmission(admitsBackgroundBytes)
      await view.start()
    },
    stop() {
      stopHearingRefusals?.()
      stopHearingRefusals = null
      stopAdmitting?.()
      stopAdmitting = null
      monitor.stop()
      view.stop()
    },
    currentRegistration() {
      const registration: NodeRegistration = { ...options.registration }
      const memory = monitor.report()
      if (memory !== null) {
        registration.memory = { ...memory }
      }
      const partitionBytes = partitionBytesOf(options.engine)
      if (partitionBytes.length > 0) {
        registration.partitionBytes = partitionBytes
      }
      return registration
    },
  }
}
