import { describe, expect, it, vi } from 'vitest'
import type { SegmentPayload } from '../../../core/partition/segment-payload'
import {
  awaitReplicationIdle,
  MAX_PENDING_REPLICATION_DOCUMENTS,
  replicateToWorkers,
} from '../../../engine/orchestration/replication'
import { searchViaWorker } from '../../../engine/orchestration/search'
import type { AnyDocument } from '../../../types/schema'
import type { WorkerAction } from '../../../workers/protocol'
import { recordingHarness as makeHarness, settle } from './fixtures'

function insertAction(indexName: string, docId: string, document: AnyDocument, skipClone?: boolean): WorkerAction {
  return { type: 'insert', indexName, docId, document, requestId: `replicate-insert-${docId}`, skipClone }
}

function emptyPayload(documentCount: number): SegmentPayload {
  return {
    documentCount,
    docIds: [],
    fieldNames: [],
    tokens: [],
    postingOffsets: new Uint32Array(1),
    postingDocIds: new Uint32Array(0),
    postingFrequencies: new Uint16Array(0),
    postingFieldIndices: new Uint8Array(0),
    positionOffsets: null,
    positionValues: null,
    fieldLengthNames: [],
    fieldLengthColumns: [],
    totalFieldLengths: {},
    docFrequencies: {},
    surfaceForms: null,
    numeric: [],
    boolean: [],
    enums: [],
    geo: [],
  }
}

function mergeAction(indexName: string, documentCount: number, skipClone?: boolean): WorkerAction {
  const documents: AnyDocument[] = Array.from({ length: documentCount }, (_, i) => ({ id: `doc-${i}` }))
  return {
    type: 'mergeSegments',
    indexName,
    segments: [{ partitionId: 0, payload: emptyPayload(documentCount), documents }],
    requestId: `merge-segments-${indexName}-${documentCount}`,
    skipClone,
  }
}

describe('replicateToWorkers', () => {
  it('returns before any worker acknowledges the dispatch', async () => {
    const harness = makeHarness(2, ['prose'])

    await replicateToWorkers(harness.state, insertAction('prose', 'a', { id: 'a' }))

    await settle()
    expect(harness.dispatched.length).toBe(2)
    harness.releaseAll()
    await awaitReplicationIdle(harness.state, 'prose')
  })

  it('dispatches actions for one index in the order they were enqueued', async () => {
    const harness = makeHarness(1, ['prose'])
    const seen: string[] = []

    await replicateToWorkers(harness.state, insertAction('prose', 'first', { id: 'first' }))
    await replicateToWorkers(harness.state, insertAction('prose', 'second', { id: 'second' }))
    await replicateToWorkers(harness.state, insertAction('prose', 'third', { id: 'third' }))

    while (seen.length < 3) {
      await settle()
      const entry = harness.dispatched.shift()
      if (entry === undefined) continue
      if (entry.action.type === 'insert') seen.push(entry.action.docId)
      entry.resolve()
    }

    expect(seen).toEqual(['first', 'second', 'third'])
    await awaitReplicationIdle(harness.state, 'prose')
  })

  it('drops nothing after a failed dispatch and keeps the warn-only contract', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const harness = makeHarness(1, ['prose'])

    await replicateToWorkers(harness.state, insertAction('prose', 'broken', { id: 'broken' }))
    await replicateToWorkers(harness.state, insertAction('prose', 'after', { id: 'after' }))

    await settle()
    const first = harness.dispatched.shift()
    expect(first).toBeDefined()
    first?.reject(new Error('worker unavailable'))

    await settle()
    const second = harness.dispatched.shift()
    expect(second).toBeDefined()
    if (second?.action.type === 'insert') {
      expect(second.action.docId).toBe('after')
    }
    second?.resolve()

    await awaitReplicationIdle(harness.state, 'prose')
    expect(warnSpy.mock.calls.some(call => String(call[0]).includes('Worker replication failed'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('applies backpressure once pending documents exceed the cap', async () => {
    const harness = makeHarness(1, ['prose'])

    await replicateToWorkers(harness.state, mergeAction('prose', MAX_PENDING_REPLICATION_DOCUMENTS))

    let secondEnqueued = false
    const second = replicateToWorkers(harness.state, mergeAction('prose', 1)).then(() => {
      secondEnqueued = true
    })

    await settle()
    expect(secondEnqueued).toBe(false)

    harness.releaseAll()
    await second
    expect(secondEnqueued).toBe(true)

    harness.releaseAll()
    await awaitReplicationIdle(harness.state, 'prose')
  })

  it('sends the document as it was at enqueue time even when the caller mutates it afterwards', async () => {
    const harness = makeHarness(1, ['prose'])
    const document: AnyDocument = { id: 'a', title: 'original' }

    await replicateToWorkers(harness.state, insertAction('prose', 'a', document))
    document.title = 'mutated'

    await settle()
    const entry = harness.dispatched.shift()
    expect(entry).toBeDefined()
    if (entry?.action.type === 'insert') {
      expect(entry.action.document.title).toBe('original')
    }
    entry?.resolve()
    await awaitReplicationIdle(harness.state, 'prose')
  })

  it('shares the caller document when skipClone was requested', async () => {
    const harness = makeHarness(1, ['prose'])
    const document: AnyDocument = { id: 'a', title: 'original' }

    await replicateToWorkers(harness.state, insertAction('prose', 'a', document, true))

    await settle()
    const entry = harness.dispatched.shift()
    expect(entry).toBeDefined()
    if (entry?.action.type === 'insert') {
      expect(entry.action.document).toBe(document)
    }
    entry?.resolve()
    await awaitReplicationIdle(harness.state, 'prose')
  })

  it('does nothing before a worker pool exists', async () => {
    const harness = makeHarness(1, ['prose'])
    harness.state.workerPool = null

    await replicateToWorkers(harness.state, insertAction('prose', 'a', { id: 'a' }))

    expect(harness.state.replicationQueues.size).toBe(0)
    expect(harness.dispatched.length).toBe(0)
  })

  it('sends nothing for an index that holds no worker copies', async () => {
    const harness = makeHarness(1, ['prose'])

    await replicateToWorkers(harness.state, insertAction('verse', 'a', { id: 'a' }))

    expect(harness.state.replicationQueues.size).toBe(0)
    expect(harness.dispatched.length).toBe(0)
  })

  it('holds a write back while the copies of its index are loading and sends it once they are in place', async () => {
    const harness = makeHarness(1, [])
    const buffered: WorkerAction[] = []
    harness.state.copyLoadBuffers.set('prose', buffered)

    await replicateToWorkers(harness.state, insertAction('prose', 'a', { id: 'a' }))

    expect(harness.dispatched.length).toBe(0)
    expect(buffered).toHaveLength(1)
    expect(buffered[0].type).toBe('insert')
  })
})

describe('searchViaWorker freshness barrier', () => {
  it('falls back to the main thread while replication is pending and serves again once drained', async () => {
    const harness = makeHarness(1, ['prose'])

    await replicateToWorkers(harness.state, insertAction('prose', 'a', { id: 'a' }))

    const blocked = await searchViaWorker(harness.state, 'prose', { term: 'a' })
    expect(blocked).toBeNull()

    await settle()
    harness.releaseAll()
    await awaitReplicationIdle(harness.state, 'prose')

    const served = searchViaWorker(harness.state, 'prose', { term: 'a' })
    await settle()
    const entry = harness.dispatched.shift()
    expect(entry).toBeDefined()
    expect(entry?.action.type).toBe('query')
    entry?.resolve({ scored: [], totalMatched: 0 })
    expect(await served).toEqual({ scored: [], totalMatched: 0 })
  })
})

describe('awaitReplicationIdle', () => {
  it('resolves only after every queued dispatch has been acknowledged', async () => {
    const harness = makeHarness(2, ['prose', 'verse'])

    await replicateToWorkers(harness.state, insertAction('prose', 'a', { id: 'a' }))
    await replicateToWorkers(harness.state, insertAction('verse', 'b', { id: 'b' }))

    let drained = false
    const drain = awaitReplicationIdle(harness.state).then(() => {
      drained = true
    })

    await settle()
    expect(drained).toBe(false)

    harness.releaseAll()
    await settle()
    harness.releaseAll()
    await drain
    expect(drained).toBe(true)
    expect(harness.state.replicationQueues.size).toBe(0)
  })
})
