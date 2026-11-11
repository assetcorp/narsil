import { loadWorkerCopies } from '../engine/worker-copies-code'
import type { PartitionManager } from '../partitioning/manager'
import type { WorkerAction } from './protocol'
import type * as Segments from './segment-actions'

export type SegmentAction = Extract<
  WorkerAction,
  {
    type:
      | 'buildSegment'
      | 'mergeSegments'
      | 'attachSegments'
      | 'compactSegments'
      | 'swapSegments'
      | 'freezeLiveTail'
      | 'adoptDiskSegments'
  }
>

export function isSegmentAction(action: WorkerAction): action is SegmentAction {
  return (
    action.type === 'buildSegment' ||
    action.type === 'mergeSegments' ||
    action.type === 'attachSegments' ||
    action.type === 'compactSegments' ||
    action.type === 'swapSegments' ||
    action.type === 'freezeLiveTail' ||
    action.type === 'adoptDiskSegments'
  )
}

export function growPartitionsTo(manager: PartitionManager, partitionId: number): void {
  manager.growToSavedPartitionCount(partitionId + 1)
}

export const runSegmentAction: typeof Segments.runSegmentAction = async (...args) => {
  const code = await loadWorkerCopies()
  return code.runSegmentAction(...args)
}
