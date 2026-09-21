import { describe, expect, it, vi } from 'vitest'
import type { PartitionManager } from '../../partitioning/manager'
import type { SharedVectorFieldHandles } from '../../vector/shared-field/types'
import { createSharedVectorStoreHandles, STORE_BLOCK_COUNT } from '../../vector/vector-store/handles'
import {
  closeHeldVectorCopies,
  createHeldVectorCopies,
  holdsVectorField,
  loadHeldVectorCopy,
} from '../../workers/vector-copies'

const DIMENSION = 4
const TEXT_COPY = { has: () => true } as unknown as PartitionManager

function fieldHandles(): SharedVectorFieldHandles {
  return {
    dimension: DIMENSION,
    quantization: 'none',
    metric: 'cosine',
    store: createSharedVectorStoreHandles(DIMENSION, null),
    graph: null,
    filterThreshold: 0.1,
    searchable: true,
  }
}

describe('a worker holding a vector field the main thread has grown by a block', () => {
  it('waits for the handles of the new block before it reads the field in place again', () => {
    const held = createHeldVectorCopies()
    const handles = fieldHandles()
    loadHeldVectorCopy(held, TEXT_COPY, 'embedding', 'embedding-1', handles, 0)

    expect(holdsVectorField(held, 'embedding')).toBe(true)

    Atomics.store(handles.store.header, STORE_BLOCK_COUNT, handles.store.blocks.length + 1)

    expect(holdsVectorField(held, 'embedding')).toBe(false)
  })
})

describe('a worker that drops an index', () => {
  it('closes the vector files of every field copy it holds, so that the engine can delete them', () => {
    const held = createHeldVectorCopies()
    loadHeldVectorCopy(held, TEXT_COPY, 'embedding', 'embedding-1', fieldHandles(), 0)
    loadHeldVectorCopy(held, TEXT_COPY, 'embedding', 'embedding-2', { ...fieldHandles(), searchable: false }, 0)
    const views = [held.fields.get('embedding')?.view, held.builds.get('embedding-2')?.view]
    const closes = views.map(view => (view === undefined ? undefined : vi.spyOn(view, 'close')))

    closeHeldVectorCopies(held)

    for (const close of closes) expect(close).toHaveBeenCalledTimes(1)
    expect(held.fields.size + held.builds.size + held.searchers.size).toBe(0)
  })
})
