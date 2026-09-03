import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMinHeap } from '../../../core/heap'
import type { VectorMetric } from '../../../vector/brute-force'
import { createHNSWIndex, type HNSWSnapshot } from '../../../vector/hnsw'
import {
  addNeighbor,
  createAdjacency,
  createNode,
  exportAdjacency,
  layerArray,
  layerBase,
  replaceNeighbors,
} from '../../../vector/hnsw/adjacency'
import {
  ensureCapacity,
  type HNSWGraphState,
  maxConns,
  nextVisitStamp,
  nodeDistanceByOrd,
  nodeExists,
  nodeMaxLayer,
  randomLevel,
} from '../../../vector/hnsw/shared'
import { createHNSWWorkspace } from '../../../vector/hnsw/workspace'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'
import { seededVector } from './fixtures'

interface Candidate {
  ord: number
  distance: number
}

const M = 6
const EF_CONSTRUCTION = 40
const METRIC: VectorMetric = 'cosine'
const DIMENSION = 12
const VECTOR_COUNT = 320
const RANDOM_SEED = 20260903

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fillStore(): VectorStore {
  const store = createVectorStore()
  for (let i = 0; i < VECTOR_COUNT; i++) {
    store.insert(`doc${i}`, seededVector(DIMENSION, i + 1))
  }
  return store
}

function referenceState(store: VectorStore): HNSWGraphState {
  return {
    dimension: DIMENSION,
    store,
    quantizer: undefined,
    M,
    Mmax0: M * 2,
    efCons: EF_CONSTRUCTION,
    buildMetric: METRIC,
    mL: 1 / Math.log(M),
    adjacency: createAdjacency(M, M * 2),
    tombstones: new Uint8Array(0),
    tombstoneCount: 0,
    nodeCount: 0,
    capacity: 0,
    visited: new Uint32Array(0),
    visitStamp: 0,
    entryPointOrd: -1,
    topLayer: -1,
    workspace: createHNSWWorkspace(),
  }
}

function referenceSearchLayer(
  state: HNSWGraphState,
  ord: number,
  eps: number[],
  ef: number,
  layer: number,
): Candidate[] {
  const neighbors = layerArray(state.adjacency, layer)
  const stamp = nextVisitStamp(state)
  const frontier = createMinHeap<Candidate>((a, b) => a.distance - b.distance)
  const found = createMinHeap<Candidate>((a, b) => b.distance - a.distance)
  let furthest = Number.POSITIVE_INFINITY

  for (const epOrd of eps) {
    if (state.visited[epOrd] === stamp) continue
    state.visited[epOrd] = stamp
    if (!nodeExists(state, epOrd)) continue
    const distance = nodeDistanceByOrd(state, ord, epOrd, METRIC)
    if (distance === Number.POSITIVE_INFINITY) continue
    const pair = { ord: epOrd, distance }
    frontier.push(pair)
    found.push(pair)
    if (found.size > ef) found.pop()
  }
  const top = found.peek()
  if (top) furthest = top.distance

  while (frontier.size > 0) {
    const nearest = frontier.pop()
    if (!nearest || nearest.distance > furthest) break
    const base = layerBase(state.adjacency, nearest.ord, layer)
    if (base === -1) continue
    const count = neighbors[base]
    for (let i = 1; i <= count; i++) {
      const neighborOrd = neighbors[base + i]
      if (state.visited[neighborOrd] === stamp) continue
      state.visited[neighborOrd] = stamp
      if (!nodeExists(state, neighborOrd)) continue
      const distance = nodeDistanceByOrd(state, ord, neighborOrd, METRIC)
      if (distance === Number.POSITIVE_INFINITY) continue
      if (distance < furthest || found.size < ef) {
        const pair = { ord: neighborOrd, distance }
        frontier.push(pair)
        found.push(pair)
        if (found.size > ef) found.pop()
        const newTop = found.peek()
        if (newTop) furthest = newTop.distance
      }
    }
  }

  return found.toSortedArray().reverse()
}

function referenceSelect(state: HNSWGraphState, candidates: Candidate[], cap: number): Candidate[] {
  const working = [...candidates].sort((a, b) => a.distance - b.distance)
  const selected: Candidate[] = []
  for (const candidate of working) {
    if (selected.length >= cap) break
    let accepted = true
    for (const kept of selected) {
      if (candidate.distance >= nodeDistanceByOrd(state, candidate.ord, kept.ord, METRIC)) {
        accepted = false
        break
      }
    }
    if (accepted) selected.push(candidate)
  }
  return selected
}

function referencePrune(state: HNSWGraphState, ord: number, layer: number): void {
  const base = layerBase(state.adjacency, ord, layer)
  if (base === -1) return
  const cap = maxConns(state, layer)
  const neighbors = layerArray(state.adjacency, layer)
  const count = neighbors[base]
  if (count <= cap) return
  const held: Candidate[] = []
  for (let i = 1; i <= count; i++) {
    const connOrd = neighbors[base + i]
    held.push({ ord: connOrd, distance: nodeDistanceByOrd(state, ord, connOrd, METRIC) })
  }
  const kept = referenceSelect(state, held, cap).map(c => c.ord)
  replaceNeighbors(state.adjacency, ord, layer, kept, kept.length)
}

function referenceInsert(state: HNSWGraphState, docId: string): void {
  const ord = state.store.getOrdinal(docId)
  if (ord === undefined) throw new Error(`no vector for ${docId}`)
  ensureCapacity(state, ord + 1)
  const level = randomLevel(state.mL)
  createNode(state.adjacency, ord, level)
  state.nodeCount++
  if (state.entryPointOrd === -1) {
    state.entryPointOrd = ord
    state.topLayer = level
    return
  }

  let eps = [state.entryPointOrd]
  for (let layer = state.topLayer; layer > level; layer--) {
    const nearest = referenceSearchLayer(state, ord, eps, 1, layer)
    if (nearest.length > 0) eps = [nearest[0].ord]
  }
  for (let layer = Math.min(level, state.topLayer); layer >= 0; layer--) {
    const candidates = referenceSearchLayer(state, ord, eps, EF_CONSTRUCTION, layer)
    for (const neighbor of referenceSelect(state, candidates, maxConns(state, layer))) {
      addNeighbor(state.adjacency, ord, layer, neighbor.ord)
      if (layer <= nodeMaxLayer(state, neighbor.ord)) {
        addNeighbor(state.adjacency, neighbor.ord, layer, ord)
        referencePrune(state, neighbor.ord, layer)
      }
    }
    if (candidates.length > 0) eps = candidates.map(c => c.ord)
  }
  if (level > state.topLayer) {
    state.entryPointOrd = ord
    state.topLayer = level
  }
}

function buildWithReference(store: VectorStore): HNSWSnapshot {
  const state = referenceState(store)
  for (let i = 0; i < VECTOR_COUNT; i++) referenceInsert(state, `doc${i}`)
  return {
    dimension: DIMENSION,
    m: M,
    efConstruction: EF_CONSTRUCTION,
    metric: METRIC,
    adjacency: exportAdjacency(state.adjacency),
    tombstones: state.tombstones.slice(),
    tombstoneCount: state.tombstoneCount,
    nodeCount: state.nodeCount,
    capacity: state.capacity,
    entryPointOrd: state.entryPointOrd,
    topLayer: state.topLayer,
  }
}

function buildWithBuilder(store: VectorStore): HNSWSnapshot {
  const index = createHNSWIndex(DIMENSION, store, { m: M, efConstruction: EF_CONSTRUCTION, metric: METRIC })
  for (let i = 0; i < VECTOR_COUNT; i++) index.insertNode(`doc${i}`)
  return index.exportSnapshot()
}

describe('the typed-array builder against a plain-object reference of the same rule', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('produces the same graph from the same vectors and the same levels', () => {
    const store = fillStore()

    vi.spyOn(Math, 'random').mockImplementation(seededRandom(RANDOM_SEED))
    const reference = buildWithReference(store)

    vi.spyOn(Math, 'random').mockImplementation(seededRandom(RANDOM_SEED))
    const built = buildWithBuilder(store)

    expect(built.nodeCount).toBe(VECTOR_COUNT)
    expect(built.entryPointOrd).toBe(reference.entryPointOrd)
    expect(built.topLayer).toBe(reference.topLayer)
    expect(built.adjacency.nodeLevels).toEqual(reference.adjacency.nodeLevels)
    expect(built.adjacency.level0).toEqual(reference.adjacency.level0)
    expect(built.adjacency.upperBase).toEqual(reference.adjacency.upperBase)
    expect(built.adjacency.upper).toEqual(reference.adjacency.upper)
  })
})
