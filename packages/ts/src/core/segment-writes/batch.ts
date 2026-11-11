import type { NativeGrowingSegment } from '../../vector/native/types/segments'
import { acquirePostingPlan, releasePostingPlan } from './postings'
import { readSegmentView } from './regions'
import { preparePostingRepack } from './repack'
import { SegmentRefusal } from './status'
import { acquireTokenPlan, releaseTokenPlan } from './tokens'
import { prepareVacuum } from './vacuum'

export function beginBatch(input: NativeGrowingSegment, generation: number): number {
  try {
    const segment = readSegmentView(input, generation)
    const tokens = acquireTokenPlan(segment, [], true)
    try {
      const postings = acquirePostingPlan(segment, 0, tokens, true)
      try {
        const vacuum = prepareVacuum(segment) ?? preparePostingRepack(segment)
        if (vacuum === null) postings.publish()
        else vacuum.publish()
      } finally {
        releasePostingPlan(postings)
      }
    } finally {
      releaseTokenPlan(tokens)
    }
    return 0
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}

export const endBatch = beginBatch
