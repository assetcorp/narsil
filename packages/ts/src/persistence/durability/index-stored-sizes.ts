import type { IndexStoredSizes } from '../../engine/stored-sizes'
import type { StoredBytes } from './stored-bytes'

export interface LoggedBytes {
  bytes: number
  bytesByPartition: number[]
}

export interface TrackedStoredSizes extends IndexStoredSizes {
  savedBytes: number | undefined
  logBytes: number | undefined
  vectorSavedBytes: number | undefined
  saved: StoredBytes | null
  savedBytesByPartition: number[]
  measuring: boolean
  held: boolean
  recorded: number | undefined
  logged: LoggedBytes | null
  known: boolean
  readonly tracksLog: boolean
}

export interface StoredSizesRecord {
  of(indexName: string): TrackedStoredSizes
  setSaved(indexName: string, saved: StoredBytes | null): void
  setMeasuring(indexName: string, measuring: boolean): void
  hold(indexName: string): TrackedStoredSizes
  forget(indexName: string): void
  drop(indexName: string): void
}

export function refreshStoredSizes(sizes: TrackedStoredSizes): void {
  const known = sizes.saved !== null || (!sizes.measuring && sizes.held)
  sizes.known = known
  if (known) {
    sizes.savedBytes = sizes.saved?.bytes ?? 0
    sizes.vectorSavedBytes = sizes.saved?.vectorBytes ?? 0
    sizes.logBytes = sizes.tracksLog ? (sizes.logged?.bytes ?? 0) : undefined
    return
  }
  sizes.savedBytes = sizes.measuring ? undefined : sizes.recorded
  sizes.vectorSavedBytes = undefined
  sizes.logBytes = undefined
}

function savedBytesByPartitionOf(saved: StoredBytes | null): number[] {
  const byPartition: number[] = []
  if (saved === null) return byPartition
  for (const { partitionId, bytes } of saved.partitions) byPartition[partitionId] = bytes
  return byPartition
}

function createTrackedSizes(tracksLog: boolean): TrackedStoredSizes {
  const sizes: TrackedStoredSizes = {
    savedBytes: undefined,
    logBytes: undefined,
    vectorSavedBytes: undefined,
    saved: null,
    savedBytesByPartition: [],
    measuring: false,
    held: false,
    recorded: undefined,
    logged: null,
    known: false,
    tracksLog,
    addTo(stats) {
      if (!sizes.known) return
      const saved = sizes.savedBytesByPartition
      const logged = sizes.tracksLog ? (sizes.logged?.bytesByPartition ?? []) : null
      for (const partition of stats) {
        partition.savedBytes = saved[partition.partitionId] ?? 0
        if (logged !== null) partition.logBytes = logged[partition.partitionId] ?? 0
      }
    },
    recordSavedBytes(bytes) {
      sizes.recorded = bytes
      refreshStoredSizes(sizes)
    },
  }
  return sizes
}

export function createStoredSizesRecord(tracksLog: boolean): StoredSizesRecord {
  const sizesByIndex = new Map<string, TrackedStoredSizes>()

  function of(indexName: string): TrackedStoredSizes {
    let sizes = sizesByIndex.get(indexName)
    if (sizes === undefined) {
      sizes = createTrackedSizes(tracksLog)
      sizesByIndex.set(indexName, sizes)
    }
    return sizes
  }

  function forget(indexName: string): void {
    const sizes = sizesByIndex.get(indexName)
    if (sizes === undefined) return
    sizes.saved = null
    sizes.savedBytesByPartition = []
    sizes.measuring = false
    sizes.held = false
    refreshStoredSizes(sizes)
  }

  return {
    of,
    setSaved(indexName, saved) {
      const sizes = of(indexName)
      sizes.saved = saved
      sizes.savedBytesByPartition = savedBytesByPartitionOf(saved)
      refreshStoredSizes(sizes)
    },
    setMeasuring(indexName, measuring) {
      const sizes = of(indexName)
      sizes.measuring = measuring
      refreshStoredSizes(sizes)
    },
    hold(indexName) {
      const sizes = of(indexName)
      if (!sizes.held) {
        sizes.held = true
        refreshStoredSizes(sizes)
      }
      return sizes
    },
    forget,
    drop(indexName) {
      forget(indexName)
      sizesByIndex.delete(indexName)
    },
  }
}
