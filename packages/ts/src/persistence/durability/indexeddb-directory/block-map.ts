import { INDEXEDDB_BLOCK_BYTES, INDEXEDDB_CACHED_BLOCKS } from '../constants'

export interface BlockLength {
  n: number
  length: number
}

export interface StoredBlock extends BlockLength {
  start: number
}

export interface CoveredBlock extends StoredBlock {
  cached: Uint8Array | undefined
}

export interface BlockLayout {
  blocks: readonly StoredBlock[]
  complete: boolean
}

export interface LayoutView {
  generation: number
  changes: number
  layout: BlockLayout | undefined
}

interface KeyState {
  generation: number
  epoch: number
  changes: number
  blocks: StoredBlock[] | undefined
  complete: boolean
}

interface CachedBlock {
  generation: number
  bytes: Uint8Array
}

export interface BlockMap {
  viewOf(key: string): LayoutView
  generationOf(key: string): number
  install(key: string, view: LayoutView, blocks: StoredBlock[], reachedEnd: boolean): void
  forget(key: string): void
  begin(key: string): number
  settle(key: string, epoch: number, lengths: readonly BlockLength[] | undefined): void
  appendEpochOf(key: string): number
  appended(key: string, epoch: number, lengths: readonly BlockLength[]): void
  covering(
    key: string,
    generation: number,
    blocks: readonly StoredBlock[],
    offset: number,
    length: number,
  ): CoveredBlock[]
  keep(key: string, generation: number, n: number, bytes: Uint8Array): void
}

export function laidOut(lengths: readonly BlockLength[]): StoredBlock[] {
  const blocks: StoredBlock[] = []
  let start = 0
  for (const { n, length } of lengths) {
    blocks.push({ n, length, start })
    start += length
  }
  return blocks
}

export function sizeOfBlocks(blocks: readonly StoredBlock[]): number {
  const last = blocks[blocks.length - 1]
  return last === undefined ? 0 : last.start + last.length
}

function firstBlockAt(blocks: readonly StoredBlock[], offset: number): number {
  let low = 0
  let high = blocks.length - 1
  while (low < high) {
    const middle = (low + high + 1) >>> 1
    if (blocks[middle].start <= offset) low = middle
    else high = middle - 1
  }
  return low
}

function blockNumbered(blocks: readonly StoredBlock[], n: number): StoredBlock | undefined {
  let low = 0
  let high = blocks.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const block = blocks[middle]
    if (block.n === n) return block
    if (block.n < n) low = middle + 1
    else high = middle - 1
  }
  return undefined
}

function mergedBlocks(
  known: StoredBlock[],
  complete: boolean,
  lengths: readonly BlockLength[],
): StoredBlock[] | undefined {
  let merged = known
  for (const { n, length } of lengths) {
    const last = merged[merged.length - 1]
    if (last === undefined) return undefined
    if (n > last.n) {
      if (complete) merged.push({ n, length, start: last.start + last.length })
      continue
    }
    if (n === 0 && merged.length === 1 && last.length === 0) {
      if (!complete) return undefined
      merged = [{ n: 0, length, start: 0 }]
      continue
    }
    const existing = blockNumbered(merged, n)
    if (existing === undefined || existing.length !== length) return undefined
  }
  return merged
}

export function createBlockMap(): BlockMap {
  const states = new Map<string, KeyState>()
  const cache = new Map<string, CachedBlock>()
  let counter = 0

  function next(): number {
    counter += 1
    return counter
  }

  function stateOf(key: string): KeyState {
    const known = states.get(key)
    if (known !== undefined) return known
    const created: KeyState = { generation: next(), epoch: next(), changes: 0, blocks: undefined, complete: false }
    states.set(key, created)
    return created
  }

  function cacheKeyOf(key: string, n: number): string {
    return `${n}\u0000${key}`
  }

  function invalidate(state: KeyState): void {
    state.generation = next()
    state.changes += 1
    state.blocks = undefined
    state.complete = false
  }

  return {
    viewOf(key) {
      const state = stateOf(key)
      const layout = state.blocks === undefined ? undefined : { blocks: state.blocks, complete: state.complete }
      return { generation: state.generation, changes: state.changes, layout }
    },

    generationOf: key => stateOf(key).generation,

    install(key, view, blocks, reachedEnd) {
      const state = stateOf(key)
      if (state.generation !== view.generation) return
      const complete = reachedEnd && state.changes === view.changes
      const current = state.blocks
      if (current !== undefined && (state.complete || (!complete && blocks.length <= current.length))) return
      state.blocks = blocks
      state.complete = complete
    },

    forget: key => invalidate(stateOf(key)),

    begin(key) {
      const state = stateOf(key)
      invalidate(state)
      state.epoch = next()
      return state.epoch
    },

    settle(key, epoch, lengths) {
      const state = stateOf(key)
      if (state.epoch !== epoch) return
      invalidate(state)
      if (lengths === undefined) return
      state.blocks = laidOut(lengths)
      state.complete = true
    },

    appendEpochOf: key => stateOf(key).epoch,

    appended(key, epoch, lengths) {
      const state = stateOf(key)
      if (state.epoch !== epoch) return
      state.changes += 1
      if (state.blocks === undefined) return
      const merged = mergedBlocks(state.blocks, state.complete, lengths)
      if (merged === undefined) invalidate(state)
      else state.blocks = merged
    },

    covering(key, generation, blocks, offset, length) {
      const covered: CoveredBlock[] = []
      const end = offset + length
      for (let at = firstBlockAt(blocks, offset); at < blocks.length; at++) {
        const block = blocks[at]
        if (block.start >= end && covered.length > 0) break
        const cacheKey = cacheKeyOf(key, block.n)
        const entry = cache.get(cacheKey)
        const cached =
          entry !== undefined && entry.generation === generation && entry.bytes.byteLength === block.length
            ? entry.bytes
            : undefined
        if (cached !== undefined) {
          cache.delete(cacheKey)
          cache.set(cacheKey, { generation, bytes: cached })
        }
        covered.push({ ...block, cached })
        if (block.start + block.length >= end) break
      }
      return covered
    },

    keep(key, generation, n, bytes) {
      if (bytes.byteLength > INDEXEDDB_BLOCK_BYTES || stateOf(key).generation !== generation) return
      const cacheKey = cacheKeyOf(key, n)
      cache.delete(cacheKey)
      cache.set(cacheKey, { generation, bytes })
      while (cache.size > INDEXEDDB_CACHED_BLOCKS) {
        const oldest = cache.keys().next()
        if (oldest.done === true) break
        cache.delete(oldest.value)
      }
    },
  }
}
