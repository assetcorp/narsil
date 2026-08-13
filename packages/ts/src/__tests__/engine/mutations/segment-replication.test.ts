import { describe, expect, it } from 'vitest'
import type { SegmentPayload } from '../../../core/partition/segment-payload'
import type { SegmentReplicationDeps } from '../../../engine/mutations/segment-replication'
import { replicateAsSegments } from '../../../engine/mutations/segment-replication'
import type { BuiltSegment, SegmentBuildRequest } from '../../../engine/orchestration/segments'
import type { AnyDocument } from '../../../types/schema'
import type { WorkerAction } from '../../../workers/protocol'

interface Recorded {
  deps: SegmentReplicationDeps
  buildRequests: SegmentBuildRequest[]
  replicated: WorkerAction[]
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

function makeDeps(workers: number, partitionCount: number): Recorded {
  const buildRequests: SegmentBuildRequest[] = []
  const replicated: WorkerAction[] = []

  const deps = {
    orchestrator: {
      segmentBuildConcurrency: (): number => workers,
      buildSegments: async (requests: SegmentBuildRequest[]): Promise<BuiltSegment[] | null> => {
        buildRequests.push(...requests)
        return requests.map(request => ({
          partitionId: request.partitionId,
          payload: emptyPayload(request.documents.length),
          documents: request.documents,
        }))
      },
      replicateToWorkers: async (action: WorkerAction): Promise<void> => {
        replicated.push(action)
      },
    },
    requireIndex: () => ({
      config: { schema: { title: 'string' as const }, language: 'english' },
      language: { name: 'english', revision: '1', stemmer: null, stopWords: new Set<string>() },
      embeddingAdapter: null,
      embeddingAdapterName: null,
      vectorFieldPaths: new Set<string>(),
    }),
    requireManager: () => ({ partitionCount }),
  } as unknown as SegmentReplicationDeps

  return { deps, buildRequests, replicated }
}

function documents(count: number): { docIds: string[]; docs: AnyDocument[] } {
  const docIds = Array.from({ length: count }, (_, i) => `doc-${String(i).padStart(4, '0')}`)
  const docs = docIds.map(id => ({ id, title: `title for ${id}` }) as AnyDocument)
  return { docIds, docs }
}

describe('replicateAsSegments', () => {
  it('declines a batch smaller than the segment threshold', async () => {
    const recorded = makeDeps(4, 1)
    const { docIds, docs } = documents(63)

    expect(await replicateAsSegments(recorded.deps, 'prose', docIds, docs, undefined)).toBe(false)
    expect(recorded.buildRequests).toHaveLength(0)
    expect(recorded.replicated).toHaveLength(0)
  })

  it('declines when no worker copies exist', async () => {
    const recorded = makeDeps(0, 1)
    const { docIds, docs } = documents(500)

    expect(await replicateAsSegments(recorded.deps, 'prose', docIds, docs, undefined)).toBe(false)
    expect(recorded.buildRequests).toHaveLength(0)
  })

  it('sends every document to exactly one segment', async () => {
    const recorded = makeDeps(4, 1)
    const { docIds, docs } = documents(500)

    expect(await replicateAsSegments(recorded.deps, 'prose', docIds, docs, undefined)).toBe(true)

    const sent = recorded.buildRequests.flatMap(request => request.action.documents.map(entry => entry.docId))
    expect(sent.slice().sort()).toEqual(docIds.slice().sort())
    expect(new Set(sent).size).toBe(docIds.length)
  })

  it('spreads the work across the available worker copies', async () => {
    const recorded = makeDeps(4, 1)
    const { docIds, docs } = documents(500)

    await replicateAsSegments(recorded.deps, 'prose', docIds, docs, undefined)

    expect(recorded.buildRequests.length).toBe(4)
    for (const request of recorded.buildRequests) {
      expect(request.action.documents.length).toBeGreaterThan(0)
    }
  })

  it('keeps each segment inside one partition', async () => {
    const recorded = makeDeps(2, 4)
    const { docIds, docs } = documents(600)

    await replicateAsSegments(recorded.deps, 'prose', docIds, docs, undefined)

    expect(recorded.buildRequests.length).toBeGreaterThan(1)
    const partitionsSeen = new Set(recorded.buildRequests.map(request => request.partitionId))
    expect(partitionsSeen.size).toBe(4)
    for (const request of recorded.buildRequests) {
      expect(request.action.documents.length).toBe(request.documents.length)
    }
  })

  it('broadcasts one merge action carrying every segment', async () => {
    const recorded = makeDeps(4, 1)
    const { docIds, docs } = documents(500)

    await replicateAsSegments(recorded.deps, 'prose', docIds, docs, undefined)

    expect(recorded.replicated).toHaveLength(1)
    const action = recorded.replicated[0]
    expect(action.type).toBe('mergeSegments')
    if (action.type !== 'mergeSegments') return
    expect(action.segments.length).toBe(recorded.buildRequests.length)
    const merged = action.segments.reduce((total, segment) => total + segment.documents.length, 0)
    expect(merged).toBe(500)
  })

  it('carries the caller’s skipClone choice to the builder', async () => {
    const recorded = makeDeps(2, 1)
    const { docIds, docs } = documents(200)

    await replicateAsSegments(recorded.deps, 'prose', docIds, docs, true)

    for (const request of recorded.buildRequests) {
      expect(request.action.options).toEqual({ skipClone: true })
    }
  })
})
