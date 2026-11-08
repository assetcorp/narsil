import type { NativeFieldMergeSource } from '../../vector/native/types/field-merge'
import { SegmentRefusal } from '../segment-writes/status'
import { dictionaryPlan } from './dictionary'
import { createFieldMerge } from './operations'
import { documentsOf, type FieldMergePlan, uint32 } from './regions'
import { booleanPlan, rowPlan } from './rows'
import { storedPlan } from './stored'

function plan(kind: number, sources: readonly NativeFieldMergeSource[], count: number): FieldMergePlan {
  uint32(count)
  const documents = documentsOf(sources, count)
  switch (kind) {
    case 1:
      return rowPlan(sources, false)
    case 2:
      return booleanPlan(documents)
    case 3:
      return dictionaryPlan(sources, false)
    case 4:
      return rowPlan(sources, true)
    case 5:
      return storedPlan(sources, documents)
    case 6:
      return dictionaryPlan(sources, true)
    default:
      throw new SegmentRefusal(1)
  }
}

export const { measureFieldMerge, writeFieldMerge } = createFieldMerge(plan)
