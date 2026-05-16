import { createHNSWIndex } from '../hnsw'
import {
  calibrateAndQuantizeAll,
  ESTIMATED_MS_PER_TOMBSTONE,
  ESTIMATED_MS_PER_VECTOR_REBUILD,
  liveSize,
  type MaintenanceStatus,
  recalibrateFromStore,
  type VectorIndexState,
  yieldToEventLoop,
} from './shared'

export function compact(state: VectorIndexState): void {
  if (state.tombstones.size === 0) return

  if (state.hnsw) {
    state.hnsw.compactTombstones()
  }

  for (const docId of state.tombstones) {
    state.store.remove(docId)
    state.buffer.delete(docId)
    if (state.sq8) {
      state.sq8.remove(docId)
    }
  }

  state.tombstones.clear()

  if (state.sq8?.isCalibrated() && state.store.size > 0) {
    recalibrateFromStore(state)
  }
}

export async function optimize(state: VectorIndexState): Promise<void> {
  if (state.pendingBuild) {
    await state.pendingBuild
  }

  compact(state)

  const live = liveSize(state)
  if (live === 0) {
    if (state.hnsw) {
      state.hnsw.clear()
      state.hnsw = null
    }
    state.buffer.clear()
    if (state.sq8) {
      state.sq8.clear()
    }
    return
  }

  if (state.sq8) {
    calibrateAndQuantizeAll(state)
  }

  const newHnsw = createHNSWIndex(state.dimension, state.store, state.hnswConfig, state.sq8 ?? undefined)
  const liveDocIds: string[] = []
  for (const [docId] of state.store.entries()) {
    if (state.tombstones.has(docId)) continue
    liveDocIds.push(docId)
  }

  const CHUNK_SIZE = 100
  for (let i = 0; i < liveDocIds.length; i++) {
    newHnsw.insertNode(liveDocIds[i])
    if ((i + 1) % CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }

  state.hnsw = newHnsw
  state.buffer.clear()

  if (state.sq8 && state.store.size > 0) {
    recalibrateFromStore(state)
  }
}

export function maintenanceStatus(state: VectorIndexState): MaintenanceStatus {
  const storeSize = state.store.size
  const tombstoneRatio = storeSize > 0 ? state.tombstones.size / storeSize : 0
  const graphCount = state.hnsw ? 1 : 0
  const estimatedCompactMs = Math.round(state.tombstones.size * ESTIMATED_MS_PER_TOMBSTONE * state.dimensionScale)
  const estimatedOptimizeMs = Math.round(storeSize * ESTIMATED_MS_PER_VECTOR_REBUILD * state.dimensionScale)

  return {
    tombstoneRatio,
    graphCount,
    bufferSize: state.buffer.size,
    building: state.building,
    estimatedCompactMs,
    estimatedOptimizeMs,
  }
}

export function estimateMemoryBytes(state: VectorIndexState): number {
  const count = state.store.size
  if (count === 0 && state.tombstones.size === 0 && state.buffer.size === 0) return 0

  let bytes = state.store.estimateMemory(state.dimension)

  const TOMBSTONE_SET_OVERHEAD = 64
  const TOMBSTONE_ENTRY_COST = 72
  bytes += TOMBSTONE_SET_OVERHEAD + state.tombstones.size * TOMBSTONE_ENTRY_COST

  const BUFFER_SET_OVERHEAD = 64
  const BUFFER_ENTRY_COST = 72
  bytes += BUFFER_SET_OVERHEAD + state.buffer.size * BUFFER_ENTRY_COST

  if (state.hnsw) {
    const HNSW_NODE_OBJ = 48
    const MAP_ENTRY = 72
    const MAP_OVERHEAD = 64
    const CONN_ARRAY_HEADER = 32
    const SET_OVERHEAD = 64
    const SET_ENTRY_COST = 72

    const m = state.hnsw.m
    const avgLayers = m > 1 ? m / (m - 1) : 1
    const avgConnsLayer0 = m
    const avgConnsUpper = Math.ceil(m / 2)

    const connMemPerNode =
      CONN_ARRAY_HEADER +
      (SET_OVERHEAD + avgConnsLayer0 * SET_ENTRY_COST) +
      Math.max(0, avgLayers - 1) * (SET_OVERHEAD + avgConnsUpper * SET_ENTRY_COST)

    const hnswNodeCount = state.hnsw.size + state.hnsw.tombstoneCount
    const perHnswNode = MAP_ENTRY + HNSW_NODE_OBJ + connMemPerNode
    bytes += MAP_OVERHEAD + hnswNodeCount * perHnswNode
  }

  if (state.sq8?.isCalibrated()) {
    const sqCount = state.sq8.size
    const MAP_OVERHEAD_SQ = 64
    const MAP_ENTRY_SQ = 72
    const UINT8_ARRAY_HEADER = 64
    const PER_VECTOR_METADATA = 8 * 3
    const GLOBAL_CALIBRATION = 8 * 5

    bytes += 4 * (MAP_OVERHEAD_SQ + sqCount * MAP_ENTRY_SQ)
    bytes += sqCount * (UINT8_ARRAY_HEADER + state.dimension + PER_VECTOR_METADATA)
    bytes += GLOBAL_CALIBRATION
  }

  return Math.round(bytes)
}
