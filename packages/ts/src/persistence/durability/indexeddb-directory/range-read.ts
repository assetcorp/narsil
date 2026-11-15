import { ErrorCodes, NarsilError } from '#platform/storage-host'
import { type BlockMap, type CoveredBlock, type LayoutView, type StoredBlock, sizeOfBlocks } from './block-map'
import type { LogConnection } from './connection'
import { readBlocks, walkBlocks } from './records'

export interface RangeReads {
  readRange(key: string, offset: number, length: number): Promise<Uint8Array>
  byteLength(key: string): Promise<number | null>
}

interface ExtendedLayout {
  blocks: StoredBlock[]
  fetched: Map<number, Uint8Array>
}

function endsBefore(key: string, offset: number, length: number): NarsilError {
  return new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `"${key}" ends before the bytes a read asked for`, {
    key,
    offset,
    length,
  })
}

function isLoadFailure(error: unknown): boolean {
  return error instanceof NarsilError && error.code === ErrorCodes.PERSISTENCE_LOAD_FAILED
}

function assembled(
  key: string,
  covered: readonly CoveredBlock[],
  fetched: ReadonlyMap<number, Uint8Array>,
  offset: number,
  length: number,
): Uint8Array {
  const bytes = new Uint8Array(length)
  for (const block of covered) {
    if (block.length === 0) continue
    const source = block.cached ?? fetched.get(block.n)
    if (source === undefined) throw endsBefore(key, offset, length)
    const from = Math.max(offset, block.start)
    const to = Math.min(offset + length, block.start + block.length)
    bytes.set(source.subarray(from - block.start, to - block.start), from - offset)
  }
  return bytes
}

export function createRangeReads(
  connection: LogConnection,
  blocks: BlockMap,
  readContent: (key: string) => Promise<Uint8Array | null>,
): RangeReads {
  async function extendTo(key: string, view: LayoutView, offset: number, end: number): Promise<ExtendedLayout | null> {
    const known = view.layout === undefined ? [] : view.layout.blocks.slice()
    const fetched = new Map<number, Uint8Array>()
    let size = sizeOfBlocks(known)
    const last = known[known.length - 1]
    const reachedEnd = await connection.read(
      { code: ErrorCodes.PERSISTENCE_LOAD_FAILED, action: `read the blocks of "${key}"` },
      store =>
        walkBlocks(store, key, last === undefined ? null : last.n, (n, bytes) => {
          const start = size
          known.push({ n, length: bytes.byteLength, start })
          size += bytes.byteLength
          if (bytes.byteLength > 0 && start < end && size > offset) fetched.set(n, bytes)
          return size >= end
        }),
    )
    if (reachedEnd === null) return null
    blocks.install(key, view, known, reachedEnd)
    return { blocks: known, fetched }
  }

  async function wholeFileRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    const content = await readContent(key)
    if (content === null || offset + length > content.byteLength) throw endsBefore(key, offset, length)
    return content.slice(offset, offset + length)
  }

  async function blockRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    const end = offset + length
    const view = blocks.viewOf(key)
    let layout: readonly StoredBlock[] | undefined = view.layout?.blocks
    let fetched = new Map<number, Uint8Array>()
    if (view.layout === undefined || (!view.layout.complete && sizeOfBlocks(view.layout.blocks) < end)) {
      const extended = await extendTo(key, view, offset, end)
      layout = extended?.blocks
      if (extended !== null) fetched = extended.fetched
    }
    if (layout === undefined || sizeOfBlocks(layout) < end) {
      if (blocks.generationOf(key) !== view.generation) return wholeFileRange(key, offset, length)
      throw endsBefore(key, offset, length)
    }
    if (length === 0) return new Uint8Array(0)
    const covered = blocks.covering(key, view.generation, layout, offset, length)
    const missing = covered.filter(block => block.length > 0 && block.cached === undefined && !fetched.has(block.n))
    if (missing.length > 0) {
      try {
        const read = await connection.read(
          { code: ErrorCodes.PERSISTENCE_LOAD_FAILED, action: `read "${key}"` },
          store => readBlocks(store, key, missing),
        )
        for (const [n, bytes] of read) fetched.set(n, bytes)
      } catch (error) {
        if (!isLoadFailure(error)) throw error
        blocks.forget(key)
        return wholeFileRange(key, offset, length)
      }
    }
    if (blocks.generationOf(key) !== view.generation) return wholeFileRange(key, offset, length)
    for (const [n, bytes] of fetched) blocks.keep(key, view.generation, n, bytes)
    return assembled(key, covered, fetched, offset, length)
  }

  return {
    async readRange(key: string, offset: number, length: number): Promise<Uint8Array> {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
        throw endsBefore(key, offset, length)
      }
      return blockRange(key, offset, length)
    },

    async byteLength(key: string): Promise<number | null> {
      const view = blocks.viewOf(key)
      if (view.layout?.complete === true) return sizeOfBlocks(view.layout.blocks)
      const extended = await extendTo(key, view, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
      if (blocks.generationOf(key) !== view.generation) return (await readContent(key))?.byteLength ?? null
      return extended === null ? null : sizeOfBlocks(extended.blocks)
    },
  }
}
