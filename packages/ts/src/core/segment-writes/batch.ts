import type { NativeSegmentCore } from '../../vector/native/types/segments'
import { PostingPlan } from './postings'
import { readBatch } from './regions'
import { SegmentRefusal } from './status'
import { TokenPlan } from './tokens'
import { prepareVacuum } from './vacuum'

export const beginBatch: NativeSegmentCore['beginBatch'] = input => {
  try {
    const segment = readBatch(input)
    const tokens = new TokenPlan(segment, [], true)
    const postings = new PostingPlan(segment, 0, tokens, true)
    const vacuum = prepareVacuum(segment)
    if (vacuum === null) postings.publish()
    else vacuum.publish()
    return 0
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}

export const endBatch: NativeSegmentCore['endBatch'] = beginBatch
