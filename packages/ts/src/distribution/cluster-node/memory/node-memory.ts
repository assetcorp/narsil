import { collectAndReturnPages } from '#platform/idle-heap-cleanup'
import type { ClusterCoordinator, IndexPartitionBytes, NodeRegistration } from '../../coordinator/types'
import {
  DEFAULT_BLOCK_WRITES_ABOVE,
  DEFAULT_IN_FLIGHT_WRITE_FRACTION,
  DEFAULT_RESUME_WRITES_BELOW,
  FULL_MEMORY_COLLECTION_INTERVAL_MS,
  MEMORY_SAMPLE_INTERVAL_MS,
  WRITE_MEMORY_SAMPLE_MAX_AGE_MS,
} from '../constants'
import type { ClusterLocalEngine } from '../local-engine'
import type { ClusterMemoryConfig } from '../types'
import { readMemoryFigures } from './measure'
import { createMemoryMonitor } from './monitor'
import { collectPartitionBytes } from './partition-bytes'
import { createNodeMemoryView, type NodeMemoryView } from './write-block'
import { createWritePressure, type WritePressure } from './write-pressure'

export interface NodeMemoryReporting {
  view: NodeMemoryView
  writePressure: WritePressure
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
  const monitor = createMemoryMonitor({
    blockWritesAbove: options.config?.blockWritesAbove ?? DEFAULT_BLOCK_WRITES_ABOVE,
    resumeWritesBelow: options.config?.resumeWritesBelow ?? DEFAULT_RESUME_WRITES_BELOW,
    intervalMs: MEMORY_SAMPLE_INTERVAL_MS,
    collectionIntervalMs: FULL_MEMORY_COLLECTION_INTERVAL_MS,
    read: readMemoryFigures,
    collectGarbage: collectAndReturnPages,
    onFullChange: options.onFullChange,
  })

  const view = createNodeMemoryView({
    coordinator: options.coordinator,
    localNodeId: options.registration.nodeId,
    localIsFull: monitor.isFull,
  })

  const heapLimitBytes = readMemoryFigures()?.heapLimitBytes ?? Number.POSITIVE_INFINITY
  const writePressure = createWritePressure({
    nodeId: options.registration.nodeId,
    limitBytes: Math.floor(
      heapLimitBytes * (options.config?.inFlightWriteFraction ?? DEFAULT_IN_FLIGHT_WRITE_FRACTION),
    ),
    beforeAdmit: () => monitor.sampleIfOlderThan(WRITE_MEMORY_SAMPLE_MAX_AGE_MS),
  })

  return {
    view,
    writePressure,
    async start() {
      monitor.start()
      await view.start()
    },
    stop() {
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
