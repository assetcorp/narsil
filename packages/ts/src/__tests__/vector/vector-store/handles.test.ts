import { describe, expect, it } from 'vitest'
import { createSharedGraphHandles } from '../../../vector/hnsw/handles'
import { createSharedVectorStoreHandles } from '../../../vector/vector-store/handles'

function growable(view: ArrayBufferView): boolean {
  const buffer = view.buffer
  return buffer instanceof SharedArrayBuffer ? buffer.growable : buffer.resizable
}

describe('the fixed-size shared records', () => {
  it('lie over buffers that cannot grow, so a view over them never tracks a length', () => {
    const store = createSharedVectorStoreHandles(8, 1)
    const graph = createSharedGraphHandles({ m: 16, mMax0: 32, efConstruction: 200, metric: 'cosine' })

    expect(growable(store.header)).toBe(false)
    expect(growable(store.centroid)).toBe(false)
    expect(growable(graph.header)).toBe(false)
    expect(growable(graph.heldLocks)).toBe(false)
  })
})
