import { describe, expect, it } from 'vitest'
import { buildSegments, type SegmentBuildRequest } from '../../../engine/orchestration/segments'
import { recordingHarness } from './fixtures'

function requestFor(batch: number): SegmentBuildRequest {
  const documents = [{ title: `document ${batch}` }]
  return {
    partitionId: 0,
    documents,
    action: {
      type: 'buildSegment',
      indexName: 'docs',
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

    harness.releaseAll()
    await Promise.all(builds)
  })
})
