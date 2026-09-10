import { describe, expect, it } from 'vitest'
import {
  createSharedGraphHandles,
  GRAPH_LOCK,
  GRAPH_WRITERS_WAITING,
  HELD_GRAPH_WAITING,
  HELD_WORDS_PER_THREAD,
} from '../../../vector/hnsw/handles'
import { lockGraphShared, openGraphLocks, releaseLocksHeldBy, unlockGraphShared } from '../../../vector/hnsw/locks'

const DEAD_SLOT = 2

describe('a thread that dies while it queues for the whole graph', () => {
  it('leaves the queue empty, so a search takes the graph again', () => {
    const handles = createSharedGraphHandles({ m: 16, mMax0: 32, efConstruction: 200, metric: 'cosine' })
    const dead = openGraphLocks(handles, DEAD_SLOT)
    Atomics.store(dead.held, DEAD_SLOT * HELD_WORDS_PER_THREAD + HELD_GRAPH_WAITING, 1)
    Atomics.add(handles.header, GRAPH_WRITERS_WAITING, 1)

    releaseLocksHeldBy(handles, DEAD_SLOT)

    const reader = openGraphLocks(handles, 0)
    lockGraphShared(reader)
    expect(Atomics.load(handles.header, GRAPH_LOCK)).toBe(1)
    unlockGraphShared(reader)
    expect(Atomics.load(handles.header, GRAPH_WRITERS_WAITING)).toBe(0)
  })
})
