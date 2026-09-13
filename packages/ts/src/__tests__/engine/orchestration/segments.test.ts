import { describe, expect, it } from 'vitest'
import type { SegmentPayload } from '../../../core/partition/segment-payload'
import { buildSegments, type SegmentBuildRequest } from '../../../engine/orchestration/segments'
import type { BuiltSegmentResult } from '../../../workers/protocol'
import { recordingHarness } from './fixtures'

function requestFor(batch: number): SegmentBuildRequest {
  const documents = [{ title: `document ${batch}` }]
  return {
    partitionId: 0,
    documents,
    action: {
      type: 'buildSegment',
      indexName: 'docs',
      segmentId: `segment-${batch}`,
      documents: documents.map((document, i) => ({ docId: `${batch}-${i}`, document })),
      requestId: `build-segment-docs-${batch}`,
    },
  }
}

describe('buildSegments', () => {
  it('spreads the builds of batches in flight across the workers', async () => {
    const harness = recordingHarness(3, ['docs'])

    const builds = [0, 1, 2].map(batch => buildSegments(harness.state, [requestFor(batch)]))
    await Promise.resolve()

    const workerIds = harness.dispatched.map(dispatch => dispatch.workerId)
    expect(new Set(workerIds).size).toBe(3)

    for (const dispatch of harness.dispatched) {
      const built: BuiltSegmentResult = { kind: 'payload', payload: emptyPayload() }
      dispatch.resolve(built)
    }
    const results = await Promise.all(builds)
    expect(results.map(result => result?.[0]?.segmentId)).toEqual(['segment-0', 'segment-1', 'segment-2'])
  })
})

function emptyPayload(): SegmentPayload {
  return {
    documentCount: 0,
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
