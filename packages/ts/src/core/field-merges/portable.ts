import { createFieldMerge, documentsOf, SegmentRefusal, storedPlan, uint32 } from '#platform/segment-merge-host'
import type { NativeFieldMergeCore, NativeFieldMergeSource } from '../../vector/native/types/field-merge'
import { dictionaryPlan } from './dictionary'
import type { FieldMergePlan } from './regions'
import { booleanPlan, rowPlan } from './rows'

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

let planned: NativeFieldMergeCore | null = null

function plannedFieldMerge(): NativeFieldMergeCore {
  planned ??= createFieldMerge(plan)
  return planned
}

export const measureFieldMerge: NativeFieldMergeCore['measureFieldMerge'] = (...args) =>
  plannedFieldMerge().measureFieldMerge(...args)

export const writeFieldMerge: NativeFieldMergeCore['writeFieldMerge'] = (...args) =>
  plannedFieldMerge().writeFieldMerge(...args)
