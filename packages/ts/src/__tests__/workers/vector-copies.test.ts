import { describe, expect, it } from 'vitest'
import type { PartitionManager } from '../../partitioning/manager'
import type { SharedVectorFieldHandles } from '../../vector/shared-field/types'
import { createSharedVectorStoreHandles, STORE_BLOCK_COUNT } from '../../vector/vector-store/handles'
import { createHeldVectorCopies, holdsVectorField, loadHeldVectorCopy } from '../../workers/vector-copies'

const DIMENSION = 4
const TEXT_COPY = { has: () => true } as unknown as PartitionManager

function fieldHandles(): SharedVectorFieldHandles {
  return {
    dimension: DIMENSION,
    quantization: 'none',
    store: createSharedVectorStoreHandles(DIMENSION, false),
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
