import type { NativeSegmentCore } from '../../vector/native/types/segments'
import { acquirePostingPlan, releasePostingPlan } from './postings'
import { readBatch } from './regions'
import { SegmentRefusal } from './status'
import { acquireTokenPlan, releaseTokenPlan } from './tokens'
import { prepareVacuum } from './vacuum'

export const beginBatch: NativeSegmentCore['beginBatch'] = input => {
  try {
    const segment = readBatch(input)
    const tokens = acquireTokenPlan(segment, [], true)
    try {
      const postings = acquirePostingPlan(segment, 0, tokens, true)
      try {
        const vacuum = prepareVacuum(segment)
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

export const endBatch: NativeSegmentCore['endBatch'] = beginBatch
