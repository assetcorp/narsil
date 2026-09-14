import { INITIAL_LIST_CAPACITY } from './constants'

export interface DistanceList {
  /** The ordinal of each entry, valid up to {@link DistanceList.size}. */
  ords: Int32Array
  /** The distance measured for each entry, valid up to {@link DistanceList.size}. */
  distances: Float64Array
  /** How many entries the list holds. */
  size: number
}

export interface DistanceHeap extends DistanceList {
  /** True where the greatest distance leaves the heap first. */
  readonly greatestFirst: boolean
  /** The ordinal the last pop removed. */
  topOrd: number
  /** The distance the last pop removed. */
  topDistance: number
}

export interface HNSWWorkspace {
  /** The frontier a layer traversal still has to expand. */
  frontier: DistanceHeap
  /** The best candidates a layer traversal has found. */
  found: DistanceHeap
  /** The ordinals a traversal starts from. */
  entryPoints: Int32Array
  /** How many of those entry points are set. */
  entryPointCount: number
  /** A traversal's results, nearest first. */
  traversal: DistanceList
  /** The candidates the selection rule reads, sorted in place. */
  working: DistanceList
  /** The neighbours a new node takes on each layer, indexed by layer. */
  linkSelections: DistanceList[]
  /** The neighbours of the node whose list is over its cap. */
  pruneCandidates: DistanceList
  /** The neighbours that node keeps. */
  pruneSelection: DistanceList
  /** The candidates offered to a node whose neighbour was removed. */
  repairCandidates: DistanceList
  /** The neighbours that node takes instead. */
  repairSelection: DistanceList
}

function createList(capacity: number): DistanceList {
  return { ords: new Int32Array(capacity), distances: new Float64Array(capacity), size: 0 }
}

function createHeap(greatestFirst: boolean): DistanceHeap {
  return { ...createList(INITIAL_LIST_CAPACITY), greatestFirst, topOrd: -1, topDistance: 0 }
}

export function createHNSWWorkspace(): HNSWWorkspace {
  return {
    frontier: createHeap(false),
    found: createHeap(true),
    entryPoints: new Int32Array(INITIAL_LIST_CAPACITY),
    entryPointCount: 0,
    traversal: createList(INITIAL_LIST_CAPACITY),
    working: createList(INITIAL_LIST_CAPACITY),
    linkSelections: [],
    pruneCandidates: createList(INITIAL_LIST_CAPACITY),
    pruneSelection: createList(INITIAL_LIST_CAPACITY),
    repairCandidates: createList(INITIAL_LIST_CAPACITY),
    repairSelection: createList(INITIAL_LIST_CAPACITY),
  }
}

export function linkSelectionsFor(workspace: HNSWWorkspace, layers: number): DistanceList[] {
  const selections = workspace.linkSelections
  while (selections.length < layers) selections.push(createList(INITIAL_LIST_CAPACITY))
  return selections
}

export function ensureListCapacity(list: DistanceList, needed: number): void {
  if (needed <= list.ords.length) return

  let capacity = list.ords.length === 0 ? INITIAL_LIST_CAPACITY : list.ords.length
  while (capacity < needed) capacity *= 2

  const ords = new Int32Array(capacity)
  ords.set(list.ords)
  list.ords = ords

  const distances = new Float64Array(capacity)
  distances.set(list.distances)
  list.distances = distances
}

export function appendToList(list: DistanceList, ord: number, distance: number): void {
  ensureListCapacity(list, list.size + 1)
  list.ords[list.size] = ord
  list.distances[list.size] = distance
  list.size += 1
}

export function copyList(source: DistanceList, target: DistanceList): void {
  ensureListCapacity(target, source.size)
  target.ords.set(source.ords.subarray(0, source.size))
  target.distances.set(source.distances.subarray(0, source.size))
  target.size = source.size
}

export function sortListByDistance(list: DistanceList): void {
  const { ords, distances } = list
  for (let i = 1; i < list.size; i++) {
    const ord = ords[i]
    const distance = distances[i]
    let j = i - 1
    while (j >= 0 && distances[j] > distance) {
      distances[j + 1] = distances[j]
      ords[j + 1] = ords[j]
      j -= 1
    }
    distances[j + 1] = distance
    ords[j + 1] = ord
  }
}

function heapPrecedes(heap: DistanceHeap, a: number, b: number): boolean {
  return heap.greatestFirst ? heap.distances[a] > heap.distances[b] : heap.distances[a] < heap.distances[b]
}

function swapHeapEntries(heap: DistanceHeap, a: number, b: number): void {
  const ord = heap.ords[a]
  heap.ords[a] = heap.ords[b]
  heap.ords[b] = ord
  const distance = heap.distances[a]
  heap.distances[a] = heap.distances[b]
  heap.distances[b] = distance
}

export function pushHeap(heap: DistanceHeap, ord: number, distance: number): void {
  appendToList(heap, ord, distance)

  let index = heap.size - 1
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (!heapPrecedes(heap, index, parent)) break
    swapHeapEntries(heap, index, parent)
    index = parent
  }
}

export function popHeap(heap: DistanceHeap): boolean {
  if (heap.size === 0) return false

  heap.topOrd = heap.ords[0]
  heap.topDistance = heap.distances[0]
  heap.size -= 1

  if (heap.size > 0) {
    heap.ords[0] = heap.ords[heap.size]
    heap.distances[0] = heap.distances[heap.size]

    let index = 0
    for (;;) {
      const left = 2 * index + 1
      const right = left + 1
      let first = index
      if (left < heap.size && heapPrecedes(heap, left, first)) first = left
      if (right < heap.size && heapPrecedes(heap, right, first)) first = right
      if (first === index) break
      swapHeapEntries(heap, index, first)
      index = first
    }
  }

  return true
}

export function resetHeap(heap: DistanceHeap): void {
  heap.size = 0
}

export function drainHeapNearestFirst(heap: DistanceHeap, list: DistanceList): void {
  const count = heap.size
  ensureListCapacity(list, count)
  list.size = count

  for (let i = count - 1; i >= 0; i--) {
    if (!popHeap(heap)) break
    list.ords[i] = heap.topOrd
    list.distances[i] = heap.topDistance
  }
}

export function setSingleEntryPoint(workspace: HNSWWorkspace, ord: number): void {
  workspace.entryPoints[0] = ord
  workspace.entryPointCount = 1
}

export function setEntryPointsFromList(workspace: HNSWWorkspace, list: DistanceList): void {
  if (list.size > workspace.entryPoints.length) {
    let capacity = workspace.entryPoints.length
    while (capacity < list.size) capacity *= 2
    workspace.entryPoints = new Int32Array(capacity)
  }
  workspace.entryPoints.set(list.ords.subarray(0, list.size))
  workspace.entryPointCount = list.size
}
